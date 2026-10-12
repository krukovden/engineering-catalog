# projects.ps1 - the projects this machine works in. Run by the assistant, never by hand.
#
# A project is what a person can paste: a board link, code links, and an optional alias.
# Everything else - organization, project, team, the team's area path, each repository's
# remote - is read from those links and proven against Azure DevOps before it is saved.
#
#   -List                                   every project, and which one is current
#   -Add -BoardUrl <url> [-CodeUrl <url>,...] [-Alias <name>]
#                                           also completes an older project (one set up
#                                           before board links existed) named by -Alias
#   -Use <alias>                            make it the current project
#   -Remove <alias>                         forget it (cloned code stays on disk)
#
# The board link may be any page of the project: a board, a backlog at any level
# (items, features, epics), a sprint taskboard/backlog/capacity page, a work item, a query.
# The team comes from the page when it names one, from the work item's area when it is a
# work item, and is the project's default team otherwise.
#
# Projects live in config.json's contexts (alias = context name; current = activeContext),
# so every other script keeps reading organization and project exactly as before.
# Output is one JSON line. Exit codes: 0 ok, 3 needs a PAT first, 1 error (nothing saved).

param(
  [switch]$List,
  [switch]$Add,
  [string]$Use,
  [string]$Remove,
  [string]$BoardUrl,
  [string[]]$CodeUrl = @(),
  [string]$Alias
)
$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot "common.ps1")

function Out-Json($object, $code) {
  $object | ConvertTo-Json -Depth 8 -Compress
  exit $code
}
function Out-Error($message) { Out-Json ([ordered]@{ outcome = "error"; detail = $message }) 1 }

try { Assert-Windows } catch { Out-Error "$_" }
$modes = @($List, $Add, [bool]$Use, [bool]$Remove) | Where-Object { $_ }
if (@($modes).Count -ne 1) { Out-Error "Pass exactly one of -List, -Add, -Use <alias>, -Remove <alias>." }

function Read-Config {
  if (Test-Path -LiteralPath (Get-ConfigPath)) {
    $c = Get-AssistantConfig
    return [ordered]@{
      version       = 1
      activeContext = Get-Prop $c "activeContext"
      contexts      = @(@(Get-Prop $c "contexts" @()) | Where-Object { $_ })
    }
  }
  return [ordered]@{ version = 1; activeContext = $null; contexts = @() }
}

function Find-Context($config, $name) {
  @($config.contexts | Where-Object { $_.name -eq $name })[0]
}

# Workspaces the QA skill recorded, by project alias. Read-only and optional: older projects
# keep their cloned repositories only there, and a list that showed "no code" for them would
# be wrong.
$workspaceRepos = @{}
$workspaceConfig = Join-Path (Join-Path $env:USERPROFILE ".qa-ado-work-item") "config.json"
if (Test-Path -LiteralPath $workspaceConfig) {
  try {
    foreach ($w in @((Get-Content -LiteralPath $workspaceConfig -Raw -Encoding UTF8 | ConvertFrom-Json).contexts)) {
      if ($w -and $w.name) { $workspaceRepos[$w.name] = @(@(Get-Prop $w "repositories" @()) | ForEach-Object { $_ }) }
    }
  } catch { }
}

function Show-Project($ctx, $current) {
  $repos = @(@(Get-Prop $ctx "repositories" @()) | ForEach-Object { [ordered]@{ name = $_.name; remoteUrl = $_.remoteUrl } })
  if ($workspaceRepos.ContainsKey($ctx.name)) {
    foreach ($w in $workspaceRepos[$ctx.name]) {
      if (@($repos | Where-Object { $_.remoteUrl -eq $w.remoteUrl }).Count -eq 0) { $repos += [ordered]@{ name = $w.name; remoteUrl = $w.remoteUrl } }
    }
  }
  [ordered]@{
    alias        = $ctx.name
    current      = ($ctx.name -eq $current)
    organization = $ctx.organization
    project      = $ctx.project
    team         = Get-Prop $ctx "team"
    areaPath     = Get-Prop $ctx "areaPath"
    boardUrl     = Get-Prop $ctx "boardUrl"
    # Set up before board links existed: work items would land in the project root, not on
    # a team's board, until the user gives the board link (-Add -Alias <this> -BoardUrl ...).
    needsBoard   = -not (Get-Prop $ctx "boardUrl")
    repositories = $repos
  }
}

# --- List -------------------------------------------------------------------------------
if ($List) {
  $config = Read-Config
  Out-Json ([ordered]@{
    outcome  = "ok"
    current  = $config.activeContext
    projects = @($config.contexts | ForEach-Object { Show-Project $_ $config.activeContext })
  }) 0
}

# --- Use / Remove -----------------------------------------------------------------------
if ($Use -or $Remove) {
  $config = Read-Config
  $name = if ($Use) { $Use } else { $Remove }
  $ctx = Find-Context $config $name
  if (-not $ctx) {
    Out-Error "No project named '$name'. Known: $((@($config.contexts | ForEach-Object { $_.name })) -join ', ')"
  }
  if ($Use) {
    $config.activeContext = $ctx.name
    Save-AssistantConfig -Config $config
    Out-Json ([ordered]@{ outcome = "ok"; current = $ctx.name; project = (Show-Project $ctx $ctx.name) }) 0
  }
  $config.contexts = @($config.contexts | Where-Object { $_.name -ne $ctx.name })
  if ($config.activeContext -eq $ctx.name) {
    $config.activeContext = if (@($config.contexts).Count -gt 0) { @($config.contexts)[0].name } else { $null }
  }
  Save-AssistantConfig -Config $config
  Out-Json ([ordered]@{ outcome = "ok"; removed = $ctx.name; current = $config.activeContext }) 0
}

# --- Add --------------------------------------------------------------------------------
if (-not $BoardUrl) { Out-Error "-Add needs -BoardUrl." }
$board = ConvertFrom-AdoUrl -Url $BoardUrl
if (-not $board) { Out-Error "Not an Azure DevOps project link: $BoardUrl. Open the project's board, backlog or sprint in the browser and copy the address bar." }
$org = $board.Organization

if (-not (Test-Path -LiteralPath (Get-SecretPath))) {
  Out-Json ([ordered]@{ outcome = "needs-pat"; organization = $org; detail = "No PAT is stored yet. Run pat.ps1 -Prepare -Organization $org, then add the project again." }) 3
}

$config = Read-Config
if ($Alias) {
  $Alias = $Alias.Trim()
  if ($Alias -match '[\\/:*?"<>|]') { Out-Error "The alias '$Alias' cannot contain \ / : * ? `" < > |" }
}

try {
  $projectInfo = Invoke-AdoRest -Organization $org -Path "_apis/projects/$([Uri]::EscapeDataString($board.Project))"
}
catch {
  if ("$_" -notmatch "\(HTTP 404\)") { Out-Error "$_" }
  $names = @()
  try { $names = @(@((Invoke-AdoRest -Organization $org -Path "_apis/projects" -Query @{ '$top' = 500 }).value) | ForEach-Object { $_.name } | Sort-Object) } catch { }
  Out-Error "Project '$($board.Project)' not found in $org.$(if ($names) { " Projects this PAT can see: $($names -join ', ')" })"
}
$project = $projectInfo.name
$projectPath = [Uri]::EscapeDataString($project)

function Get-TeamArea($teamName) {
  $values = Invoke-AdoRest -Organization $org -Path "$projectPath/$([Uri]::EscapeDataString($teamName))/_apis/work/teamsettings/teamfieldvalues"
  return $values
}

$team = $null
$areaPath = $null
$teamSource = $null
if ($board.Team) {
  try {
    $team = (Invoke-AdoRest -Organization $org -Path "_apis/projects/$projectPath/teams/$([Uri]::EscapeDataString($board.Team))").name
    $teamSource = "link"
  }
  catch {
    if ("$_" -notmatch "\(HTTP 404\)") { Out-Error "$_" }
    $teams = @(@((Invoke-AdoRest -Organization $org -Path "_apis/projects/$projectPath/teams" -Query @{ '$top' = 500 }).value) | ForEach-Object { $_.name } | Sort-Object)
    Out-Error "Team '$($board.Team)' not found in $project. Teams: $($teams -join ', ')"
  }
}
elseif ($board.WorkItemId) {
  # A work item link names no team; its area does. Pick the team whose area covers it most
  # closely, so the project lands on the board the item actually lives on.
  try {
    $item = Invoke-AdoRest -Organization $org -Path "_apis/wit/workitems/$($board.WorkItemId)" -Query @{ fields = "System.AreaPath,System.TeamProject" }
  }
  catch { Out-Error "Work item $($board.WorkItemId) could not be read in $project. $_" }
  $itemArea = $item.fields.'System.AreaPath'
  $best = $null; $bestLength = -1
  foreach ($t in @((Invoke-AdoRest -Organization $org -Path "_apis/projects/$projectPath/teams" -Query @{ '$top' = 500 }).value)) {
    try { $values = Get-TeamArea $t.name } catch { continue }
    foreach ($v in @($values.values)) {
      $covers = ($itemArea -eq $v.value) -or ($v.includeChildren -and $itemArea.StartsWith("$($v.value)\"))
      if ($covers -and $v.value.Length -gt $bestLength) { $best = $t.name; $bestLength = $v.value.Length }
    }
  }
  if ($best) { $team = $best; $teamSource = "work item $($board.WorkItemId)" }
  else { $areaPath = $itemArea }
}
if (-not $team) {
  $team = $projectInfo.defaultTeam.name
  if (-not $teamSource) { $teamSource = "project default" }
}
if (-not $areaPath) {
  try { $areaPath = (Get-TeamArea $team).defaultValue } catch { $areaPath = $null }
}

if (-not $Alias) { $Alias = $team }
# An existing project without a board link is an older one: the links complete it, in place.
# It must name the same organization and project, or this is a different project after all.
$existing = Find-Context $config $Alias
$upgrade = $false
if ($existing) {
  if (Get-Prop $existing "boardUrl") {
    Out-Error "A project named '$Alias' already exists. Pick another alias, or remove the old one first."
  }
  if ($existing.organization.TrimEnd('/') -ne $org -or $existing.project -ne $project) {
    Out-Error "'$Alias' is $($existing.organization) / $($existing.project), but the link is $org / $project. Give a different alias to add it as a new project."
  }
  $upgrade = $true
}

$repositories = @()
$warnings = @()
# Under `powershell -File`, "-CodeUrl a,b" arrives as one string; split it here so every
# link counts however the caller passed them. Encoded URLs hold no spaces or commas.
$codeLinks = @($CodeUrl | ForEach-Object { $_ -split '[,;\s]+' } | Where-Object { $_ })
foreach ($url in $codeLinks) {
  $code = ConvertFrom-AdoUrl -Url $url
  if (-not $code -or -not $code.Repository) { $warnings += "Not a repository link, skipped: $url"; continue }
  if ($code.Organization -ne $org) { $warnings += "Repository is in another organization ($($code.Organization)); one PAT covers one organization. Skipped: $url"; continue }
  try {
    $repo = Invoke-AdoRest -Organization $org -Path "$([Uri]::EscapeDataString($code.Project))/_apis/git/repositories/$([Uri]::EscapeDataString($code.Repository))"
    if (@($repositories | Where-Object { $_.remoteUrl -eq $repo.remoteUrl }).Count -eq 0) {
      $repositories += [ordered]@{ name = $repo.name; project = $repo.project.name; remoteUrl = $repo.remoteUrl; webUrl = $repo.webUrl }
    }
  }
  catch {
    if ("$_" -match "rejected the PAT") { Out-Error "$_" }
    $warnings += "Repository '$($code.Repository)' was not found in $($code.Project), or this PAT cannot read it. Skipped: $url"
  }
}

$canonicalBoard = "$org/$projectPath/_boards/board/t/$([Uri]::EscapeDataString($team))"
# A PSCustomObject, like every context read back from disk, so Get-Prop sees its fields.
$newContext = New-Object PSObject -Property ([ordered]@{
  name         = $Alias
  organization = $org
  project      = $project
  team         = $team
  areaPath     = $areaPath
  boardUrl     = $canonicalBoard
  repositories = $repositories
})
if ($upgrade) {
  # Keep any repositories it already had; the new links add to them.
  foreach ($r in @(Get-Prop $existing "repositories" @())) {
    if (@($repositories | Where-Object { $_.remoteUrl -eq $r.remoteUrl }).Count -eq 0) { $newContext.repositories = @($newContext.repositories) + $r }
  }
  $config.contexts = @($config.contexts | ForEach-Object { if ($_.name -eq $Alias) { $newContext } else { $_ } })
}
else {
  $config.contexts = @($config.contexts) + $newContext
}
# A new project becomes current only when it is the first: adding one must never silently
# redirect where the next work item goes.
if (-not $config.activeContext) { $config.activeContext = $Alias }
if (-not (Test-Path -LiteralPath (Get-StateRoot))) { New-Item -ItemType Directory -Path (Get-StateRoot) -Force | Out-Null }
Save-AssistantConfig -Config $config
Install-GitHelper -ScriptRoot $scriptRoot | Out-Null

$result = [ordered]@{
  outcome    = "ok"
  upgraded   = $upgrade
  added      = (Show-Project $newContext $config.activeContext)
  teamSource = $teamSource
  current    = $config.activeContext
  warnings   = @($warnings)
}
# When qa-ado-work-item is installed beside this skill, name the exact command that sets up
# the project's workspace (clones the code links, sets the default area). Optional: with
# no such sibling there is simply no next step, and that skill also creates the workspace
# the first time it is used.
$skillsRoot = Split-Path (Split-Path $scriptRoot -Parent) -Parent
$workspaceScript = Join-Path (Join-Path (Join-Path $skillsRoot "qa-ado-work-item") "scripts") "setup-workspace.ps1"
if (Test-Path -LiteralPath $workspaceScript) {
  $result.next = "Run now, in this turn: powershell -NoProfile -ExecutionPolicy Bypass -File `"$workspaceScript`" -ContextName `"$Alias`" -NoPrompt"
}
Out-Json $result 0

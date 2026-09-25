# setup-workspace.ps1 — once per context: pick the repositories, clone them, record the
# workspace. Run it locally in Windows PowerShell after the ado-credentials setup.
#
# Reads the organization, project and credential from %USERPROFILE%\.ado-credentials\
# (written by the `ado-credentials` skill's setup) and creates (or adds to)
# %USERPROFILE%\.qa-ado-work-item\config.json with the workspace root, the repositories
# selected, an empty systems list, the defaults and the field allow list.
#
# Every answer can be supplied as a parameter, so a second machine can be set up the same
# way twice. No secret is touched here: git clones through the askpass helper the
# credentials setup installed.
#
# Exit codes: 0 = ok, 1 = error.

param(
  [string]$ContextName,
  [string]$Workspace,
  [string[]]$Repositories,
  [switch]$SkipClone,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot "common.ps1")
Assert-Windows

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git for Windows is required but was not found on PATH."
}

# The context must already exist on the credentials side: that is where the organization
# and project live, and the credential was proven there. This script adds what QA needs.
$credentialsConfig = Get-CredentialsConfig
if (-not $ContextName) {
  $known = @(Get-Prop $credentialsConfig "contexts" @()) | ForEach-Object { $_.name }
  $active = Get-Prop $credentialsConfig "activeContext"
  $ContextName = (Read-Host "Context name [$active] (known: $($known -join ', '))").Trim()
  if (-not $ContextName) { $ContextName = $active }
}
$credentials = Resolve-AdoContext -Config $credentialsConfig -Name $ContextName
$ContextName = $credentials.name
$Organization = $credentials.organization
$Project = $credentials.project
Write-Host "Context '$ContextName': $Organization / $Project"

# Existing config is merged, never replaced. Overwriting it used to delete every other
# context on the machine, which made the multi-context workflow impossible to reach.
$config = $null
if (Test-Path -LiteralPath (Get-ConfigPath)) { $config = Get-AssistantConfig }
$existingContexts = @()
if ($config) { $existingContexts = @(Get-Prop $config "contexts" @()) }
if (@($existingContexts | Where-Object { $_.name -eq $ContextName }).Count -gt 0 -and -not $Force) {
  throw "Context '$ContextName' already has a workspace. Re-run with -Force to replace just that context."
}

if (-not $Workspace) {
  $default = Join-Path (Join-Path $env:USERPROFILE "QA-Workspaces") $ContextName
  $Workspace = (Read-Host "Workspace folder [$default]").Trim()
  if (-not $Workspace) { $Workspace = $default }
}
New-Item -ItemType Directory -Path $Workspace -Force | Out-Null
# Resolve to an absolute path: a relative -Workspace (". " for "clone beside this folder")
# would be written into the config and then re-resolve against whatever directory a later
# script happened to run from.
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path

Write-Host "Listing repositories in $Project..."
$repoResponse = Invoke-AdoRest -Organization $Organization -Project $Project -Path "_apis/git/repositories"
$available = @($repoResponse.value | Sort-Object name)
if ($available.Count -eq 0) { throw "The project reports no Git repositories." }

if ($Repositories) {
  $selected = @()
  foreach ($name in $Repositories) {
    $match = @($available | Where-Object { $_.name -eq $name })[0]
    if (-not $match) { throw "Repository '$name' is not in project '$Project'." }
    $selected += $match
  }
}
else {
  Write-Host "Available repositories:"
  for ($i = 0; $i -lt $available.Count; $i++) { Write-Host ("  [{0}] {1}" -f ($i + 1), $available[$i].name) }
  $selection = (Read-Host "Repository numbers separated by commas, or * for all").Trim()
  if ($selection -eq "*") { $selected = $available }
  else {
    $selected = @()
    foreach ($part in ($selection -split ',')) {
      $token = $part.Trim()
      if (-not $token) { continue }
      $index = 0
      if (-not [int]::TryParse($token, [ref]$index)) { throw "'$token' is not a repository number." }
      if ($index -lt 1 -or $index -gt $available.Count) { throw "Repository number $index is out of range." }
      $selected += $available[$index - 1]
    }
  }
}
if ($selected.Count -eq 0) { throw "No repository selected." }

$askpass = Write-GitAskpass
$repoConfigs = @()
foreach ($repo in $selected) {
  $path = Join-Path $Workspace $repo.name
  if (-not $SkipClone -and -not (Test-Path -LiteralPath (Join-Path $path ".git"))) {
    Write-Host "Cloning $($repo.name)..."
    $env:GIT_ASKPASS = $askpass
    $env:GIT_TERMINAL_PROMPT = "0"
    try {
      & git clone -- $repo.remoteUrl $path
      if ($LASTEXITCODE -ne 0) { throw "Clone failed for $($repo.name)." }
    }
    finally {
      Remove-Item Env:GIT_ASKPASS -ErrorAction SilentlyContinue
      Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
    }
  }
  $repoConfigs += [ordered]@{ name = $repo.name; remoteUrl = $repo.remoteUrl; path = $path }
}

# No organization or project here: those belong to the credentials config and are joined
# in by name at run time, so a renamed project is fixed in one place.
$newContext = [ordered]@{
  name          = $ContextName
  workspaceRoot = $Workspace
  repositories  = $repoConfigs
  systems       = @()
  defaults      = [ordered]@{ workItemType = "Bug"; parentId = $null; areaPath = $null; iterationPath = $null }
  # The publisher refuses any field outside this list. Widen it only after confirming the
  # reference name with `query-ado.ps1 -Action Fields -Type <type>` — a field the
  # project's process does not carry is rejected by Azure DevOps at create time.
  allowedFields = @(
    "System.Title", "System.Description", "System.AreaPath", "System.IterationPath",
    "System.Tags", "Microsoft.VSTS.TCM.ReproSteps",
    "Microsoft.VSTS.TCM.SystemInfo", "Microsoft.VSTS.Common.AcceptanceCriteria",
    "Microsoft.VSTS.Common.Priority", "Microsoft.VSTS.Common.Severity"
  )
}

$kept = @($existingContexts | Where-Object { $_.name -ne $ContextName })
$config = [ordered]@{
  version  = 1
  contexts = @($kept + $newContext)
}
Save-AssistantConfig -Config $config
New-Item -ItemType Directory -Path (Get-DraftRoot) -Force | Out-Null

Write-Host ""
Write-Host "Workspace setup complete."
Write-Host "  Config:      $(Get-ConfigPath)"
Write-Host "  Workspace:   $Workspace"
Write-Host "  Drafts:      $(Get-DraftRoot)"
Write-Host "  Contexts:    $((@($kept + $newContext) | ForEach-Object { $_.name }) -join ', ')"
Write-Host ""
Write-Host "Add environments, simulators, and test rigs to the context's systems array when needed."

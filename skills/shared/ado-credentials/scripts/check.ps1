# check.ps1 — preflight: is an Azure DevOps credential present, and does it still work?
# Prints one JSON line {outcome, detail, steps[]} and exits 0 ok / 3 absent / 4 expired / 1 error.
#
# "Present" is decided by the state folder; "works" is decided by Azure DevOps itself —
# the project is read with the stored PAT. A PAT that exists but is rejected reports
# `expired`, never `absent`, because the fix is different (new PAT, not first-time setup).
# -RequireAz: the caller runs `az` (ado-branch, ado-pull-request), so a working PAT alone is
# not ok. REST-only callers (qa-ado-work-item, ado-board) omit it and need no Azure CLI.
param([string]$ContextName, [switch]$RequireAz)
$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "common.ps1")

# `missing` tells the assistant which conversation to start: "pat" -> the PAT hand-over
# (pat.ps1), "project" -> adding a project (projects.ps1). Both are run by the assistant;
# the steps below are what the person reads.
$patSteps = @(
  "I will open Notepad with an empty file.",
  "In Azure DevOps open User settings -> Personal access tokens -> New Token. Scopes: Code (Read) and Work Items (Read & write).",
  "Paste the token into Notepad, save, close Notepad, and tell me 'done'. Never paste it into this chat.")
$projectSteps = @(
  "Send me the link to your board (any board, backlog or sprint page of the project) and, optionally, links to the code repositories.")

function Out-Result($outcome, $detail, $steps, $code, $missing = $null) {
  $o = [ordered]@{ outcome = $outcome; detail = $detail; steps = @($steps) }
  if ($missing) { $o.missing = $missing }
  # A pasted PAT left on disk in plain text is the one state this skill must never leave
  # quietly: pat.ps1 -Import consumes and deletes it.
  try {
    if (Test-Path -LiteralPath (Get-PastePath)) { $o.warnings = @("A PAT paste file is still on disk: $(Get-PastePath). Run pat.ps1 -Import to store it and delete the file.") }
  } catch { }
  $o | ConvertTo-Json -Compress
  exit $code
}

# Same az readiness probe as check.sh, same detail and steps text, so both platforms report
# one outcome for one situation. Returns $null when az is ready, else @{ detail; steps }.
function Test-AzReady {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
      return @{ detail = "az CLI not installed"; steps = @("Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli", "Then run: az login", "Then run: az extension add --name azure-devops") }
    }
    az account show -o none 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      return @{ detail = "not logged in to az"; steps = @("Run: az login  (or: az login --use-device-code)", "Then re-run this check") }
    }
    az extension show --name azure-devops -o none 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      return @{ detail = "azure-devops extension missing"; steps = @("Run: az extension add --name azure-devops", "Then re-run this check") }
    }
    $cfg = @(az devops configure --list 2>$null)
    $org = $cfg | ForEach-Object { if ($_ -match '^\s*organization\s*=\s*(.+)$') { $Matches[1].Trim() } } | Select-Object -First 1
    $proj = $cfg | ForEach-Object { if ($_ -match '^\s*project\s*=\s*(.+)$') { $Matches[1].Trim() } } | Select-Object -First 1
    if (-not $org -or -not $proj) {
      return @{ detail = "no default organization/project"; steps = @("Run: az devops configure --defaults organization=https://dev.azure.com/<ORG> project=<PROJECT>") }
    }
    return $null
  }
  finally { $ErrorActionPreference = $prev }
}

# Even the platform refusal is reported on the contract, so a caller never has to parse
# an exception text to learn why there is no JSON line.
try { Assert-Windows }
catch { Out-Result "error" "$_" @("On macOS/Linux run: sh `"<SKILL_DIR>/scripts/check.sh`"") 1 }

if (-not (Test-Path -LiteralPath (Get-SecretPath))) {
  Out-Result "absent" "No protected PAT under $(Get-StateRoot)." $patSteps 3 "pat"
}

$expiredSteps = @("The stored PAT is rejected by Azure DevOps: it expired, was revoked, or lacks a scope. A new one is needed.") + $patSteps

# The PAT is present but no project names where to use it: that is a setup gap, not a
# network problem, and the steps must say so.
try {
  if (-not (Test-Path -LiteralPath (Get-ConfigPath))) { throw "holds no contexts" }
  $config = Get-AssistantConfig
  $context = Resolve-AdoContext -Config $config -Name $ContextName
}
catch {
  if ("$_" -match "not found|No context specified|holds no contexts") {
    Out-Result "absent" "No Azure DevOps project is configured$(if ($ContextName) { " under the name '$ContextName'" })." $projectSteps 3 "project"
  }
  Out-Result "error" "$_" @("The config under $(Get-StateRoot) could not be read.") 1
}

try {
  $project = Invoke-AdoRest -Organization $context.organization -Path "_apis/projects/$([Uri]::EscapeDataString($context.project))"
  # A real project answer carries an id. Anything else (an HTML page, an empty body)
  # means the request was not authenticated, whatever the status code said.
  if ($null -eq $project -or $null -eq $project.PSObject.Properties["id"] -or -not $project.id) {
    Out-Result "expired" "Azure DevOps answered without a project id for $($context.organization) / $($context.project); the PAT was not accepted." $expiredSteps 4 "pat"
  }
  # A valid PAT is not enough for a caller that runs az (SKILL.md, Azure CLI readiness).
  $az = if ($RequireAz) { Test-AzReady } else { $null }
  if ($az) { Out-Result "absent" $az.detail $az.steps 3 "az" }
  Out-Result "ok" "sign-in works for $($context.organization) / $($project.name) as context '$($context.name)'; permissions are checked when a skill first uses them." @() 0
}
catch {
  if ("$_" -match "rejected the PAT") {
    Out-Result "expired" "$_" $expiredSteps 4 "pat"
  }
  Out-Result "error" "$_" @("Check network access to Azure DevOps and re-run.") 1
}

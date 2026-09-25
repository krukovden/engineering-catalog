# check.ps1 — preflight: is an Azure DevOps credential present, and does it still work?
# Prints one JSON line {outcome, detail, steps[]} and exits 0 ok / 3 absent / 4 expired / 1 error.
#
# "Present" is decided by the state folder; "works" is decided by Azure DevOps itself —
# the project is read with the stored PAT. A PAT that exists but is rejected reports
# `expired`, never `absent`, because the fix is different (new PAT, not first-time setup).
param([string]$ContextName)
$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "common.ps1")

$setup = 'powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>/scripts/setup.ps1"'

function Out-Result($outcome, $detail, $steps, $code) {
  [ordered]@{ outcome = $outcome; detail = $detail; steps = @($steps) } | ConvertTo-Json -Compress
  exit $code
}

# Even the platform refusal is reported on the contract, so a caller never has to parse
# an exception text to learn why there is no JSON line.
try { Assert-Windows }
catch { Out-Result "error" "$_" @("On macOS/Linux run: sh `"<SKILL_DIR>/scripts/check.sh`"") 1 }

if (-not (Test-Path -LiteralPath (Get-SecretPath)) -or -not (Test-Path -LiteralPath (Get-ConfigPath))) {
  Out-Result "absent" "No protected PAT or config under $(Get-StateRoot)." @(
    "Create a PAT in Azure DevOps with scopes Code (Read) and Work Items (Read & write).",
    "In a local PowerShell window (never in chat) run: $setup",
    "Re-run this check.") 3
}

$expiredSteps = @(
  "The PAT exists but Azure DevOps rejects it - it expired, was revoked, or lacks a scope.",
  "Create a new PAT (Code Read, Work Items Read & write), then run: $setup",
  "Re-run this check.")

# The config is present but may not name the context asked for: that is a setup gap,
# not a network problem, and the steps must say so.
try {
  $config = Get-AssistantConfig
  $context = Resolve-AdoContext -Config $config -Name $ContextName
}
catch {
  if ("$_" -match "not found|No context specified|holds no contexts") {
    $wanted = if ($ContextName) { $ContextName } else { "<name>" }
    Out-Result "absent" "$_" @(
      "In a local PowerShell window (never in chat) run: $setup -ContextName $wanted",
      "Re-run this check.") 3
  }
  Out-Result "error" "$_" @("The config under $(Get-StateRoot) could not be read; re-run $setup to rewrite it.") 1
}

try {
  $project = Invoke-AdoRest -Organization $context.organization -Path "_apis/projects/$([Uri]::EscapeDataString($context.project))"
  # A real project answer carries an id. Anything else (an HTML page, an empty body)
  # means the request was not authenticated, whatever the status code said.
  if ($null -eq $project -or $null -eq $project.PSObject.Properties["id"] -or -not $project.id) {
    Out-Result "expired" "Azure DevOps answered without a project id for $($context.organization) / $($context.project); the PAT was not accepted." $expiredSteps 4
  }
  Out-Result "ok" "Reached $($context.organization) / $($project.name) as context '$($context.name)'." @() 0
}
catch {
  if ("$_" -match "rejected the PAT") {
    Out-Result "expired" "$_" $expiredSteps 4
  }
  Out-Result "error" "$_" @("Check network access to Azure DevOps and re-run.") 1
}

# setup.ps1 — first-run credential setup. Run it locally in Windows PowerShell, never in chat.
#
# Creates (or adds to) %USERPROFILE%\.ado-credentials\config.json, protects the PAT with
# Windows DPAPI, proves the credential works against the organization and project, and
# installs git's credential helper (git-askpass.cmd + get-pat.ps1) beside them.
#
# Every answer except the PAT can be supplied as a parameter, so a second machine can be
# set up the same way twice. The PAT is only ever read from a masked prompt: a parameter
# would put it in the command line, the console history, and any transcript.
#
# This script knows nothing about workspaces, repositories, or drafts. Skills that need
# those keep their own state folder and read the organization and project from here.
#
# Exit codes: 0 = ok, 1 = error.

param(
  [string]$Organization,
  [string]$Project,
  [string]$ContextName,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot "common.ps1")
Assert-Windows

$stateRoot = Get-StateRoot
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null

# The PAT lives in this folder. Strip inherited access and grant only the current
# account, so another profile on a shared machine cannot read it.
if (Get-Command icacls.exe -ErrorAction SilentlyContinue) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $stateRoot /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
}

$secretPath = Get-SecretPath
if ((Test-Path -LiteralPath $secretPath) -and -not $Force) {
  Write-Host "A protected PAT already exists. Press Enter to keep it, or type a new one."
  $entered = Read-Host "PAT (blank = keep existing)" -AsSecureString
  if ($entered.Length -gt 0) { $entered | Export-Clixml -LiteralPath $secretPath -Force }
}
else {
  Write-Host "Enter the Azure DevOps PAT. Input is masked; never paste it into AI chat."
  Write-Host "Least privilege: Code (Read) and Work Items (Read & write)."
  $entered = Read-Host "PAT" -AsSecureString
  if ($entered.Length -eq 0) { throw "No PAT entered." }
  $entered | Export-Clixml -LiteralPath $secretPath -Force
}

if (-not $Organization) { $Organization = Read-Host "Organization URL (for example https://dev.azure.com/ORG)" }
$Organization = $Organization.Trim().TrimEnd('/')
if ($Organization -notmatch '^https?://') { throw "Organization must be a full URL, e.g. https://dev.azure.com/ORG" }

if (-not $Project) { $Project = Read-Host "Project name" }
$Project = $Project.Trim()
if (-not $Project) { throw "Project name is required." }

if (-not $ContextName) { $ContextName = Read-Host "Short context name (for example Acme-QA)" }
$ContextName = $ContextName.Trim()
if (-not $ContextName) { throw "Context name is required." }

# Existing config is merged, never replaced. Overwriting it used to delete every other
# context on the machine, which made the multi-context workflow impossible to reach.
$config = $null
if (Test-Path -LiteralPath (Get-ConfigPath)) { $config = Get-AssistantConfig }
$existingContexts = @()
if ($config) { $existingContexts = @(Get-Prop $config "contexts" @()) }
if (@($existingContexts | Where-Object { $_.name -eq $ContextName }).Count -gt 0 -and -not $Force) {
  throw "Context '$ContextName' already exists. Re-run with -Force to replace just that context."
}

# Prove the credential against the real thing before recording anything: the project
# must resolve, and the work item types must list (that is the Work Items scope).
Write-Host "Checking Azure DevOps access..."
$projectInfo = Invoke-AdoRest -Organization $Organization -Path "_apis/projects/$([Uri]::EscapeDataString($Project))"
Write-Host "  Project OK: $($projectInfo.name)"
$typeList = Invoke-AdoRest -Organization $Organization -Project $Project -Path "_apis/wit/workitemtypes"
$typeNames = @(@($typeList.value) | ForEach-Object { $_.name })
Write-Host "  Work item types: $($typeNames -join ', ')"

# Git must never prompt: an interactive credential dialog hangs an agent forever. The
# helper lives in the state folder, next to its own copy of get-pat.ps1, so it keeps
# working if this skill is moved, updated, or uninstalled.
$getPatSource = Join-Path $scriptRoot "get-pat.ps1"
$getPatTarget = Join-Path $stateRoot "get-pat.ps1"
Copy-Item -LiteralPath $getPatSource -Destination $getPatTarget -Force
$askpass = Join-Path $stateRoot "git-askpass.cmd"
$askpassContent = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$getPatTarget`" `"%~1`"`r`n"
Set-Content -LiteralPath $askpass -Value $askpassContent -Encoding Ascii

$newContext = [ordered]@{
  name         = $ContextName
  organization = $Organization
  project      = $projectInfo.name
}

$kept = @($existingContexts | Where-Object { $_.name -ne $ContextName })
$config = [ordered]@{
  version       = 1
  activeContext = $ContextName
  contexts      = @($kept + $newContext)
}
Save-AssistantConfig -Config $config

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Config:        $(Get-ConfigPath)"
Write-Host "  Protected PAT: $(Get-SecretPath)"
Write-Host "  Git helper:    $askpass"
Write-Host "  Contexts:      $((@($kept + $newContext) | ForEach-Object { $_.name }) -join ', ')"
Write-Host ""
Write-Host "Skills that need a workspace (cloned repositories, defaults) have their own setup; run it next."

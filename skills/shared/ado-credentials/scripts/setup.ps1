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
  [string]$ProjectUrl,
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

# A newly typed PAT is written before it can be proven (every request reads it from disk),
# so the one it replaces is set aside first. Any failure from here on, a mistyped PAT
# included, puts the previous one back: a typo must never cost a working credential.
$secretPath = Get-SecretPath
$patBackup = $null
$patWasAbsent = $false
trap {
  if ($patBackup -and (Test-Path -LiteralPath $patBackup)) {
    Move-Item -LiteralPath $patBackup -Destination $secretPath -Force
    Write-Host "The PAT you typed was not kept; the previous one is still in place."
  }
  elseif ($patWasAbsent -and (Test-Path -LiteralPath $secretPath)) {
    Remove-Item -LiteralPath $secretPath -Force
  }
  break
}
function Save-NewPat($secure) {
  if (Test-Path -LiteralPath $secretPath) {
    $script:patBackup = "$secretPath.previous"
    Copy-Item -LiteralPath $secretPath -Destination $script:patBackup -Force
  }
  else { $script:patWasAbsent = $true }
  $secure | Export-Clixml -LiteralPath $secretPath -Force
}

if ((Test-Path -LiteralPath $secretPath) -and -not $Force) {
  Write-Host "A protected PAT already exists. Press Enter to keep it, or type a new one."
  $entered = Read-Host "PAT (blank = keep existing)" -AsSecureString
  if ($entered.Length -gt 0) { Save-NewPat $entered }
}
else {
  Write-Host "Enter the Azure DevOps PAT. Input is masked; never paste it into AI chat."
  Write-Host "Least privilege: Code (Read) and Work Items (Read & write)."
  $entered = Read-Host "PAT" -AsSecureString
  if ($entered.Length -eq 0) { throw "No PAT entered." }
  Save-NewPat $entered
}

# The organization and project come from one URL the user copies from the browser.
# -Organization with -Project still works for scripted setups, but is checked: a project
# appended to the organization URL reaches Azure DevOps as a 401 that looks like a dead PAT.
if ($ProjectUrl) {
  $parsed = ConvertFrom-AdoProjectUrl -Url $ProjectUrl
  if (-not $parsed) { throw "Not an Azure DevOps project URL: $ProjectUrl. Expected https://dev.azure.com/ORG/PROJECT/..." }
  $Organization = $parsed.Organization
  $Project = $parsed.Project
}
elseif (-not ($Organization -and $Project)) {
  Write-Host "Open the project in Azure DevOps in your browser (the board or backlog will do)"
  Write-Host "and copy the address bar, for example https://dev.azure.com/ORG/PROJECT/_boards/..."
  while ($true) {
    $urlInput = Read-Host "Project URL"
    $parsed = ConvertFrom-AdoProjectUrl -Url $urlInput
    if ($parsed) { break }
    Write-Host "That is not a project URL. It must start with https://dev.azure.com/ORG/PROJECT"
  }
  $Organization = $parsed.Organization
  $Project = $parsed.Project
  Write-Host "  Organization: $Organization"
  Write-Host "  Project:      $Project"
}
else {
  $Organization = $Organization.Trim().TrimEnd('/')
  $Project = $Project.Trim()
  if ($Organization -notmatch '^https?://') { throw "Organization must be a full URL, e.g. https://dev.azure.com/ORG" }
  if ($Organization -match '^https?://dev\.azure\.com/[^/]+/.') {
    throw "Organization URL must stop at the organization (https://dev.azure.com/ORG), got $Organization. Pass the whole project URL as -ProjectUrl instead."
  }
}

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
try {
  $projectInfo = Invoke-AdoRest -Organization $Organization -Path "_apis/projects/$([Uri]::EscapeDataString($Project))"
}
catch {
  if ("$_" -notmatch "\(HTTP 404\)") { throw }
  # A 404 means the PAT works but the name is not a project; most often a team name.
  # Name the projects the PAT can see, so the next attempt is not another guess.
  $names = @()
  try {
    $list = Invoke-AdoRest -Organization $Organization -Path "_apis/projects" -Query @{ '$top' = 500 }
    $names = @(@($list.value) | ForEach-Object { $_.name } | Sort-Object)
  } catch { }
  $message = "Project '$Project' not found in $Organization. A team name is not a project; teams live inside a project."
  if ($names.Count -gt 0) { $message += "`nProjects this PAT can see: $($names -join ', ')" }
  throw $message
}
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
if ($patBackup) { Remove-Item -LiteralPath $patBackup -Force -ErrorAction SilentlyContinue }
$patBackup = $null
$patWasAbsent = $false

Write-Host ""
Write-Host "Setup complete."
Write-Host "  Config:        $(Get-ConfigPath)"
Write-Host "  Protected PAT: $(Get-SecretPath)"
Write-Host "  Git helper:    $askpass"
Write-Host "  Contexts:      $((@($kept + $newContext) | ForEach-Object { $_.name }) -join ', ')"
Write-Host ""
Write-Host "Skills that need a workspace (cloned repositories, defaults) have their own setup; run it next."

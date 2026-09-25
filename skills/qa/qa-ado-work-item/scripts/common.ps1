# common.ps1 — dot-sourced by every other script in this skill.
#
# Single source of truth for the state paths, the config files, the DPAPI-protected PAT,
# and the ONE entry point that talks to Azure DevOps. Nothing in this file prompts the
# user, writes to a source repository, or performs an Azure DevOps write.
#
# Two state folders, one contract:
#   %USERPROFILE%\.ado-credentials\   written by the `ado-credentials` skill's setup —
#                                     the protected PAT, git's askpass helper, and the
#                                     organization/project of every context.
#   %USERPROFILE%\.qa-ado-work-item\  this skill's own — workspace root, repositories,
#                                     systems, defaults and allow list per context, plus
#                                     the drafts.
# Contexts are joined by name. This skill never reaches into the ado-credentials skill's
# directory; the folder under the user profile is the only thing shared.
#
# Azure DevOps is reached over the REST API, not the `az` CLI. The CLI added a second
# install prerequisite, a second auth path, and output that shifts between CLI versions
# and between shells (Git Bash rewrites /paths on Windows). REST is one contract with a
# stable shape, so every script here sends the same request every run.

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 negotiates TLS 1.0 by default; Azure DevOps requires 1.2+.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$script:AdoPat = $null

function Assert-Windows {
  # The PAT is protected with Windows DPAPI (Export-Clixml of a SecureString), which
  # only unwraps for the same Windows user on the same machine. There is no equivalent
  # on macOS or Linux, so refuse there rather than silently storing a weaker secret.
  if ($env:OS -ne "Windows_NT") {
    throw "This skill runs on Windows only - its PAT protection uses Windows DPAPI."
  }
}

# ---------------------------------------------------------------- credentials state
# Owned by the ado-credentials skill. Read here, never written.

function Get-CredentialsRoot {
  Join-Path $env:USERPROFILE ".ado-credentials"
}

function Get-CredentialsConfigPath { Join-Path (Get-CredentialsRoot) "config.json" }
function Get-SecretPath            { Join-Path (Get-CredentialsRoot) "ado-pat.xml" }

function Get-CredentialsConfig {
  $path = Get-CredentialsConfigPath
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Credentials config not found at $path. Run the ado-credentials preflight and its setup first."
  }
  Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

# The organization and project for a context, from the credentials config. With no name
# given, falls back to that config's activeContext.
function Resolve-AdoContext {
  param([Parameter(Mandatory = $true)]$Config, [string]$Name)
  $contexts = @(Get-Prop $Config "contexts" @())
  if ($contexts.Count -eq 0) { throw "Credentials config holds no contexts. Run the ado-credentials setup." }
  if (-not $Name) { $Name = Get-Prop $Config "activeContext" }
  # With several contexts and no name given, guessing would silently file a work item
  # against the wrong project. Make the caller choose.
  if (-not $Name) {
    throw "No context specified and no activeContext set. Known contexts: $(($contexts | ForEach-Object { $_.name }) -join ', ')"
  }
  $context = @($contexts | Where-Object { $_.name -eq $Name })[0]
  if (-not $context) {
    throw "Context '$Name' not found in the credentials config. Known contexts: $(($contexts | ForEach-Object { $_.name }) -join ', ')"
  }
  return $context
}

# ---------------------------------------------------------------- this skill's state

function Get-StateRoot {
  Join-Path $env:USERPROFILE ".qa-ado-work-item"
}

function Get-ConfigPath { Join-Path (Get-StateRoot) "config.json" }
function Get-DraftRoot  { Join-Path (Get-StateRoot) "drafts" }

# Property access that tolerates an absent key. ConvertFrom-Json returns PSCustomObject,
# where a missing property is $null under normal mode but throws under StrictMode — this
# keeps every caller reading optional draft/config keys the same way.
function Get-Prop {
  param($Object, [string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

# ConvertTo-Json serialises a one-element array as a bare object. The Azure DevOps
# work-item API only accepts a JSON *array* of patch operations, so a draft carrying a
# single field would be rejected. Always emit an array.
function ConvertTo-JsonArray {
  param([object[]]$InputObject, [int]$Depth = 12)
  if ($null -eq $InputObject -or $InputObject.Count -eq 0) { return "[]" }
  $json = ($InputObject | ConvertTo-Json -Depth $Depth)
  if ($InputObject.Count -eq 1) { return "[$json]" }
  return $json
}

function Get-AssistantConfig {
  $path = Get-ConfigPath
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Workspace config not found at $path. Run scripts\setup-workspace.ps1 first."
  }
  Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Save-AssistantConfig {
  param([Parameter(Mandatory = $true)]$Config)
  $path = Get-ConfigPath
  New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
  $Config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding UTF8
}

# One context as the rest of this skill sees it: organization and project from the
# credentials config, everything else from the workspace config, joined by name.
# $Config is this skill's workspace config; the credentials config is read here.
function Resolve-AssistantContext {
  param([Parameter(Mandatory = $true)]$Config, [string]$Name)
  $credentials = Resolve-AdoContext -Config (Get-CredentialsConfig) -Name $Name
  $contexts = @(Get-Prop $Config "contexts" @())
  $workspace = @($contexts | Where-Object { $_.name -eq $credentials.name })[0]
  if (-not $workspace) {
    throw "Context '$($credentials.name)' has credentials but no workspace - run scripts\setup-workspace.ps1"
  }
  return [pscustomobject][ordered]@{
    name          = $credentials.name
    organization  = $credentials.organization
    project       = $credentials.project
    workspaceRoot = Get-Prop $workspace "workspaceRoot"
    repositories  = @(Get-Prop $workspace "repositories" @())
    systems       = @(Get-Prop $workspace "systems" @())
    defaults      = Get-Prop $workspace "defaults"
    allowedFields = @(Get-Prop $workspace "allowedFields" @())
  }
}

function Get-AdoPat {
  if ($script:AdoPat) { return $script:AdoPat }
  $secretPath = Get-SecretPath
  if (-not (Test-Path -LiteralPath $secretPath)) {
    throw "Protected PAT not found at $secretPath. Run the ado-credentials setup."
  }
  $secure = Import-Clixml -LiteralPath $secretPath
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $script:AdoPat = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  return $script:AdoPat
}

function Get-AdoAuthHeader {
  $bytes = [Text.Encoding]::ASCII.GetBytes(":" + (Get-AdoPat))
  return @{ Authorization = "Basic " + [Convert]::ToBase64String($bytes) }
}

<#
.SYNOPSIS
  The only path to Azure DevOps. Returns the parsed response object.
.PARAMETER Path
  API path below the org (and project, when -Project is given), e.g. "_apis/wit/workitems/42".
#>
function Invoke-AdoRest {
  param(
    [Parameter(Mandatory = $true)][string]$Organization,
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Project,
    [string]$Method = "Get",
    [string]$ApiVersion = "7.1",
    $Body,
    [string]$ContentType = "application/json",
    [hashtable]$Query
  )
  $uri = $Organization.TrimEnd('/')
  if ($Project) { $uri += "/" + [Uri]::EscapeDataString($Project) }
  $uri += "/" + $Path.TrimStart('/')
  $pairs = @("api-version=$ApiVersion")
  if ($Query) {
    # Values are escaped; keys are not. Azure DevOps system parameters are spelled `$top`
    # and `$expand`, and percent-encoding the `$` is not reliably decoded back.
    foreach ($key in $Query.Keys) {
      $pairs += ("{0}={1}" -f $key, [Uri]::EscapeDataString([string]$Query[$key]))
    }
  }
  $uri += "?" + ($pairs -join "&")

  $arguments = @{
    Method      = $Method
    Uri         = $uri
    Headers     = (Get-AdoAuthHeader)
    ContentType = $ContentType
    ErrorAction = "Stop"
  }
  if ($null -ne $Body) {
    $json = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 12 }
    $arguments.Body = [Text.Encoding]::UTF8.GetBytes($json)
  }

  $result = $null
  try {
    $result = Invoke-RestMethod @arguments
  }
  catch {
    # Azure DevOps puts the actionable part ("work item type 'Buug' does not exist") in
    # the response body, which the default exception text drops. Surface it — a caller
    # that only sees "400 Bad Request" cannot tell a typo from an outage.
    $status = $null
    $detail = ""
    $response = $_.Exception.Response
    if ($response) {
      try { $status = [int]$response.StatusCode } catch { }
      try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $detail = $reader.ReadToEnd()
        $reader.Close()
      } catch { }
    }
    # A PAT that is expired or missing a scope answers with a sign-in page, not JSON.
    if ($detail -match "Azure DevOps Services \| Sign In" -or $status -eq 203 -or $status -eq 401) {
      throw "Azure DevOps rejected the PAT (expired, revoked, or missing a scope). Run the ado-credentials preflight and follow its steps. [$Method $uri]"
    }
    $message = "Azure DevOps request failed"
    if ($status) { $message += " (HTTP $status)" }
    $message += ": $Method $uri"
    if ($detail) { $message += "`n$($detail.Substring(0, [Math]::Min(600, $detail.Length)))" }
    throw $message
  }

  # Invoke-RestMethod does not throw on 203, nor on a followed redirect to the sign-in
  # page: it hands the HTML back as a [string]. Reading a property off that string yields
  # $null, and a caller would carry on as if the PAT worked. Same message as the catch path.
  if ($result -is [string] -and $result -match "Azure DevOps Services \| Sign In") {
    throw "Azure DevOps rejected the PAT (expired, revoked, or missing a scope). Run the ado-credentials preflight and follow its steps. [$Method $uri]"
  }
  return $result
}

# Exit with a message on stderr and a specific code. Write-Error cannot be used for this:
# with $ErrorActionPreference = "Stop" it raises a terminating error, so the script dies
# with code 1 and the exit code that carries the actual meaning is never reached.
function Exit-WithMessage {
  param([Parameter(Mandatory = $true)][string]$Message, [Parameter(Mandatory = $true)][int]$Code)
  [Console]::Error.WriteLine($Message)
  exit $Code
}

# Git must never prompt: an interactive credential dialog hangs the agent forever. The
# helper is written by the ado-credentials setup into its state folder; this skill only
# points git at it.
function Write-GitAskpass {
  $askpass = Join-Path (Get-CredentialsRoot) "git-askpass.cmd"
  if (-not (Test-Path -LiteralPath $askpass)) {
    throw "Git credential helper not found at $askpass. Run the ado-credentials setup first."
  }
  return $askpass
}

# common.ps1 — dot-sourced by every other script in this skill.
#
# Single source of truth for the state paths, the config file, the DPAPI-protected PAT,
# and the ONE entry point that talks to Azure DevOps. Nothing in this file prompts the
# user or performs an Azure DevOps write.
#
# The state folder (%USERPROFILE%\.ado-credentials) is the contract with every other
# skill that needs Azure DevOps: they read the organization and project from config.json
# there and unwrap the same protected PAT. No skill reaches into this skill's directory.
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
  # On macOS/Linux the preflight is scripts\check.sh, which checks the az CLI instead.
  if ($env:OS -ne "Windows_NT") {
    throw "This script runs on Windows only - its PAT protection uses Windows DPAPI. On macOS/Linux run scripts\check.sh."
  }
}

function Get-StateRoot {
  Join-Path $env:USERPROFILE ".ado-credentials"
}

function Get-ConfigPath { Join-Path (Get-StateRoot) "config.json" }
function Get-SecretPath { Join-Path (Get-StateRoot) "ado-pat.xml" }

# Property access that tolerates an absent key. ConvertFrom-Json returns PSCustomObject,
# where a missing property is $null under normal mode but throws under StrictMode — this
# keeps every caller reading optional config keys the same way.
function Get-Prop {
  param($Object, [string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

function Get-AssistantConfig {
  $path = Get-ConfigPath
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Config not found at $path. Run scripts\setup.ps1 first."
  }
  Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Save-AssistantConfig {
  param([Parameter(Mandatory = $true)]$Config)
  $path = Get-ConfigPath
  New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
  $Config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding UTF8
}

function Resolve-AdoContext {
  param([Parameter(Mandatory = $true)]$Config, [string]$Name)
  $contexts = @(Get-Prop $Config "contexts" @())
  if ($contexts.Count -eq 0) { throw "Config holds no contexts. Run scripts\setup.ps1." }
  if (-not $Name) { $Name = Get-Prop $Config "activeContext" }
  # With several contexts and no name given, guessing would silently check — or let a
  # consumer write — against the wrong organization. Make the caller choose.
  if (-not $Name) {
    throw "No context specified and no activeContext set. Known contexts: $(($contexts | ForEach-Object { $_.name }) -join ', ')"
  }
  $context = @($contexts | Where-Object { $_.name -eq $Name })[0]
  if (-not $context) {
    throw "Context '$Name' not found. Known contexts: $(($contexts | ForEach-Object { $_.name }) -join ', ')"
  }
  return $context
}

function Get-AdoPat {
  if ($script:AdoPat) { return $script:AdoPat }
  $secretPath = Get-SecretPath
  if (-not (Test-Path -LiteralPath $secretPath)) {
    throw "Protected PAT not found at $secretPath. Run scripts\setup.ps1."
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
    # Azure DevOps puts the actionable part in the response body, which the default
    # exception text drops. Surface it — a caller that only sees "400 Bad Request" cannot
    # tell a typo from an outage.
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
    # check.ps1 matches on "rejected the PAT" to report `expired` rather than `error`.
    if ($detail -match "Azure DevOps Services \| Sign In" -or $status -eq 203 -or $status -eq 401) {
      throw "Azure DevOps rejected the PAT (expired, revoked, or missing a scope). Re-run scripts\setup.ps1. [$Method $uri]"
    }
    $message = "Azure DevOps request failed"
    if ($status) { $message += " (HTTP $status)" }
    $message += ": $Method $uri"
    if ($detail) { $message += "`n$($detail.Substring(0, [Math]::Min(600, $detail.Length)))" }
    throw $message
  }

  # Invoke-RestMethod does not throw on 203, nor on a followed redirect to the sign-in
  # page: it hands the HTML back as a [string]. Reading a property off that string yields
  # $null, and a caller would report a dead PAT as "ok". Same message as the catch path,
  # so check.ps1 routes both to `expired`.
  if ($result -is [string] -and $result -match "Azure DevOps Services \| Sign In") {
    throw "Azure DevOps rejected the PAT (expired, revoked, or missing a scope). Re-run scripts\setup.ps1. [$Method $uri]"
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

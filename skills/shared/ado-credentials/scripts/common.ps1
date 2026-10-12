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
# Plain-text hand-over file: exists only between pat.ps1 -Prepare and -Import.
function Get-PastePath { Join-Path (Get-StateRoot) "paste-pat-here.txt" }

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
      throw "Azure DevOps rejected the PAT (expired, revoked, or missing a scope). A new one is needed (pat.ps1). [$Method $uri]"
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
    throw "Azure DevOps rejected the PAT (expired, revoked, or missing a scope). A new one is needed (pat.ps1). [$Method $uri]"
  }
  # Invoke-RestMethod also hands back raw text when the JSON holds a property name it cannot
  # turn into a PowerShell property. Work item types do: a process's state transitions carry
  # one keyed "" (the transition into the first state). Every caller reading .value would
  # then see nothing, and the type check would reject every type. Rename that key and parse.
  if ($result -is [string] -and $result.TrimStart().StartsWith("{")) {
    $result = ($result -replace '(?<!\\)"":', '"(empty)":') | ConvertFrom-Json
  }
  return $result
}

<#
.SYNOPSIS
  Reads whatever Azure DevOps address a person copied from the browser - a board, a
  backlog, a sprint, a work item, a query, a repository - and returns what it names:
  Organization (URL), Project, Team, WorkItemId, Repository. Absent parts are $null.
  Returns $null when the address names no project at all.
.DESCRIPTION
  People copy the page they happen to be on, so every common page shape is accepted and
  reduced to the same few facts. The project is always the path segment right after the
  organization; a team appears in one of several places depending on the page:
    _boards/board/t/<team>/...           board
    _backlogs/backlog/<team>/...         backlog (any level: items, features, epics)
    _sprints/<view>/<team>/...           taskboard, sprint backlog, capacity, analytics
    <project>/<team>/_backlogs/...       the older layout, team before the hub
  A work item id comes from _workitems/edit/<id> or from ?workitem=<id> on a board. A
  repository comes from _git/<repo> (also the project-less _git form and SSH remotes).
#>
function ConvertFrom-AdoUrl {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Url)
  $text = $Url.Trim()
  $result = [ordered]@{ Organization = $null; Project = $null; Team = $null; WorkItemId = $null; Repository = $null }

  # SSH remotes are not URIs: git@ssh.dev.azure.com:v3/ORG/PROJECT/REPO and the legacy
  # ORG@vs-ssh.visualstudio.com:v3/ORG/PROJECT/REPO.
  $ssh = [regex]::Match($text, '^[^@\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3/([^/]+)/([^/]+)/([^/?#]+)$')
  if ($ssh.Success) {
    $result.Organization = "https://dev.azure.com/" + $ssh.Groups[1].Value
    $result.Project = [Uri]::UnescapeDataString($ssh.Groups[2].Value)
    $result.Repository = [Uri]::UnescapeDataString($ssh.Groups[3].Value)
    return [pscustomobject]$result
  }

  $uri = $null
  if (-not [Uri]::TryCreate($text, [UriKind]::Absolute, [ref]$uri)) { return $null }
  if ($uri.Scheme -ne "https" -and $uri.Scheme -ne "http") { return $null }
  $segments = @($uri.AbsolutePath.Split('/') | Where-Object { $_ } | ForEach-Object { [Uri]::UnescapeDataString($_) })
  $hostName = $uri.Host.ToLowerInvariant()

  if ($hostName -eq "dev.azure.com") {
    if ($segments.Count -lt 2) { return $null }
    $result.Organization = "https://dev.azure.com/" + $segments[0]
    $segments = @($segments | Select-Object -Skip 1)
  }
  elseif ($hostName.EndsWith(".visualstudio.com")) {
    # The legacy host carries the organization in the host name, sometimes followed by
    # the old DefaultCollection segment.
    $result.Organization = "https://" + $hostName
    if ($segments.Count -gt 0 -and $segments[0] -eq "DefaultCollection") { $segments = @($segments | Select-Object -Skip 1) }
    if ($segments.Count -lt 1) { return $null }
  }
  else { return $null }

  # A repository named like its project can be addressed without the project: ORG/_git/REPO.
  if ($segments[0] -eq "_git" -and $segments.Count -ge 2) {
    $result.Project = $segments[1]
    $result.Repository = $segments[1]
    return [pscustomobject]$result
  }
  # Organization-level pages (_settings, _usersSettings, ...) name no project.
  if ($segments[0].StartsWith("_")) { return $null }
  $result.Project = $segments[0]

  $i = 1
  if ($segments.Count -gt 1 -and -not $segments[1].StartsWith("_")) { $result.Team = $segments[1]; $i = 2 }
  $at = { param($n) if ($i + $n -lt $segments.Count) { $segments[$i + $n] } else { $null } }
  $hub = & $at 0
  switch ($hub) {
    "_boards" {
      if ((& $at 1) -eq "board" -and (& $at 2) -eq "t" -and (& $at 3)) { $result.Team = & $at 3 }
    }
    "_backlogs" {
      if ((& $at 1) -eq "backlog" -and (& $at 2) -and -not $result.Team) { $result.Team = & $at 2 }
    }
    "_sprints" {
      if (@("taskboard", "backlog", "capacity", "analytics", "retrospectives") -contains (& $at 1) -and (& $at 2)) { $result.Team = & $at 2 }
    }
    "_workitems" {
      $id = & $at 2
      if ((& $at 1) -eq "edit" -and $id -match '^\d+$') { $result.WorkItemId = [int]$id }
    }
    "_git" {
      if (& $at 1) { $result.Repository = & $at 1 }
    }
  }
  $query = [regex]::Match($uri.Query, '[?&](?:workitem|id)=(\d+)')
  if (-not $result.WorkItemId -and $query.Success) { $result.WorkItemId = [int]$query.Groups[1].Value }
  return [pscustomobject]$result
}

# Organization and project only: what setup.ps1 needs from a pasted address.
function ConvertFrom-AdoProjectUrl {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Url)
  $parsed = ConvertFrom-AdoUrl -Url $Url
  if (-not $parsed) { return $null }
  return [pscustomobject]@{ Organization = $parsed.Organization; Project = $parsed.Project }
}

# Only the current account may read the state folder: it holds the PAT. Granted by SID,
# not by name, so an account name icacls cannot map never leaves the folder stripped of
# inheritance with no grant at all.
function Protect-StateFolder {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Get-Command icacls.exe -ErrorAction SilentlyContinue)) { return }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $Path /inheritance:r /grant:r "*${sid}:(OI)(CI)F" | Out-Null
}

# Git must never prompt: an interactive credential dialog hangs an agent forever. The
# helper lives in the state folder, next to its own copy of get-pat.ps1, so it keeps
# working if this skill is moved, updated, or uninstalled. Returns the helper's path.
function Install-GitHelper {
  param([Parameter(Mandatory = $true)][string]$ScriptRoot)
  $stateRoot = Get-StateRoot
  $getPatTarget = Join-Path $stateRoot "get-pat.ps1"
  Copy-Item -LiteralPath (Join-Path $ScriptRoot "get-pat.ps1") -Destination $getPatTarget -Force
  $askpass = Join-Path $stateRoot "git-askpass.cmd"
  $content = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$getPatTarget`" `"%~1`"`r`n"
  Set-Content -LiteralPath $askpass -Value $content -Encoding Ascii
  return $askpass
}

# Exit with a message on stderr and a specific code. Write-Error cannot be used for this:
# with $ErrorActionPreference = "Stop" it raises a terminating error, so the script dies
# with code 1 and the exit code that carries the actual meaning is never reached.
function Exit-WithMessage {
  param([Parameter(Mandatory = $true)][string]$Message, [Parameter(Mandatory = $true)][int]$Code)
  [Console]::Error.WriteLine($Message)
  exit $Code
}

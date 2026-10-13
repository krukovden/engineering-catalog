# pat.ps1 - hand the PAT over without it ever passing through chat. Run by the assistant.
#
#   -Prepare  creates an empty paste file in the state folder (readable only by this
#             account) and opens it in Notepad. The person pastes the PAT, saves, closes.
#   -Import   reads the file, protects the PAT with DPAPI, proves it against Azure DevOps,
#             and deletes the file - always, whatever the outcome. A PAT that does not work
#             is never kept over one that does.
#
# The PAT value is never printed, never passed as an argument, and never read by the
# assistant: only this script opens the file. Output is one JSON line:
#   { "outcome": "waiting" | "ok" | "empty" | "rejected" | "stored-unverified" | "error",
#     "detail": "...", "steps": [] }
# Exit codes: 0 waiting/ok/stored-unverified, 3 empty (file still waiting), 4 rejected, 1 error.

param(
  [switch]$Prepare,
  [switch]$Import,
  # Where to prove the PAT when no project is configured yet, e.g. https://dev.azure.com/ORG.
  [string]$Organization
)
$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot "common.ps1")

function Out-Result($outcome, $detail, $steps, $code) {
  [ordered]@{ outcome = $outcome; detail = $detail; steps = @($steps) } | ConvertTo-Json -Compress
  exit $code
}

try { Assert-Windows } catch { Out-Result "error" "$_" @() 1 }
if ($Prepare -eq $Import) { Out-Result "error" "Pass exactly one of -Prepare or -Import." @() 1 }

$stateRoot = Get-StateRoot
$pastePath = Get-PastePath
$secretPath = Get-SecretPath

if ($Prepare) {
  if (-not (Test-Path -LiteralPath $stateRoot)) {
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    Protect-StateFolder -Path $stateRoot
  }
  # The organization rides along in the file, so -Import proves the token against it
  # even when the assistant does not repeat -Organization.
  $header = @(
    "# Paste your Azure DevOps Personal Access Token on the line below, save (Ctrl+S) and close Notepad.",
    "# Lines starting with # are ignored. This file is deleted as soon as the token is stored.")
  if ($Organization) { $header += "# organization: $($Organization.TrimEnd('/'))" }
  $header += ""
  Set-Content -LiteralPath $pastePath -Value $header -Encoding Ascii
  try { Start-Process -FilePath "notepad.exe" -ArgumentList "`"$pastePath`"" } catch { }
  $tokensPage = if ($Organization) { "$($Organization.TrimEnd('/'))/_usersSettings/tokens" } else { "Azure DevOps -> User settings -> Personal access tokens" }
  Out-Result "waiting" "Notepad is open on $pastePath." @(
    "Create a token at: $tokensPage (New Token; scopes: Code - Read, Work Items - Read & write; pick an expiry you are allowed to).",
    "Paste it into the Notepad window under the comment lines, save (Ctrl+S), close Notepad.",
    "Tell me 'done'. Never paste the token into this chat.") 0
}

# -Import
if (-not (Test-Path -LiteralPath $pastePath)) {
  Out-Result "error" "No paste file at $pastePath. Run pat.ps1 -Prepare first." @() 1
}
$raw = @(Get-Content -LiteralPath $pastePath -Encoding UTF8 | ForEach-Object { $_.Trim() })
$orgLine = @($raw | Where-Object { $_ -match '^#\s*organization:\s*(\S+)' })[0]
if (-not $Organization -and $orgLine -match '^#\s*organization:\s*(\S+)') { $Organization = $Matches[1] }
$lines = @($raw | Where-Object { $_ -and -not $_.StartsWith("#") })
$raw = $null
if ($lines.Count -eq 0) {
  Out-Result "empty" "The paste file is still empty - the token was not saved yet." @(
    "Paste the token into the Notepad window, press Ctrl+S, close Notepad, then tell me 'done'.") 3
}
$token = $lines[0]
# The file is consumed now: from here on, whatever happens, it must not survive.
$secure = New-Object System.Security.SecureString
foreach ($c in $token.ToCharArray()) { $secure.AppendChar($c) }
$secure.MakeReadOnly()
$token = $null
$lines = $null
Remove-Item -LiteralPath $pastePath -Force

if ($secure.Length -lt 20) {
  Out-Result "rejected" "That does not look like a PAT (too short). Nothing was stored." @("Create the token again and repeat.") 4
}

# Where to prove it: every organization a project is configured for, else -Organization.
$organizations = @()
if (Test-Path -LiteralPath (Get-ConfigPath)) {
  $organizations = @(@(Get-Prop (Get-AssistantConfig) "contexts" @()) | ForEach-Object { $_.organization } | Where-Object { $_ } | Select-Object -Unique)
}
if ($Organization) { $organizations = @($Organization.TrimEnd('/')) + @($organizations | Where-Object { $_ -ne $Organization.TrimEnd('/') }) }

# Same rule as setup.ps1: the PAT is written before it can be proven (requests read it
# from disk), so the one it replaces is set aside and restored on any failure.
$backup = $null
if (Test-Path -LiteralPath $secretPath) {
  $backup = "$secretPath.previous"
  Copy-Item -LiteralPath $secretPath -Destination $backup -Force
}
$secure | Export-Clixml -LiteralPath $secretPath -Force
$script:AdoPat = $null

if ($organizations.Count -eq 0) {
  # Nothing to prove it against. A first PAT may wait for the first project to prove it;
  # a working one is never replaced by one nobody has checked.
  if ($backup) {
    Move-Item -LiteralPath $backup -Destination $secretPath -Force
    Out-Result "error" "No organization to check the new PAT against, so the previous PAT was kept. Run pat.ps1 -Prepare -Organization <org URL> and repeat." @() 1
  }
  Install-GitHelper -ScriptRoot $scriptRoot | Out-Null
  Out-Result "stored-unverified" "PAT stored; there is no project yet to prove it against. Adding a project will." @() 0
}

$failure = $null
foreach ($org in $organizations) {
  try { Invoke-AdoRest -Organization $org -Path "_apis/projects" -Query @{ '$top' = 1 } | Out-Null }
  catch { $failure = "${org}: $_"; break }
}
if ($failure) {
  if ($backup) { Move-Item -LiteralPath $backup -Destination $secretPath -Force }
  else { Remove-Item -LiteralPath $secretPath -Force }
  $kept = if ($backup) { " The previous PAT is still in place." } else { "" }
  Out-Result "rejected" "Azure DevOps did not accept the new PAT ($failure).$kept" @(
    "Check that the token was copied whole and has the scopes Code (Read) and Work Items (Read & write), then repeat.") 4
}
if ($backup) { Remove-Item -LiteralPath $backup -Force }
Install-GitHelper -ScriptRoot $scriptRoot | Out-Null
Out-Result "ok" "PAT stored and accepted by $($organizations -join ', ')." @() 0

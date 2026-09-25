<#
.SYNOPSIS
  authorize-connection — register a connection the human has finished setting up (Windows).
.DESCRIPTION
  Refuses unless the config block is fully filled (no <FILL_IN> left) and the key file
  exists. The AI can only authorize a connection a human actually completed.
.EXAMPLE
  .\authorize-connection.ps1 my-server
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Name
)
$ErrorActionPreference = 'Stop'

$sshDir    = Join-Path $env:USERPROFILE '.ssh'
$config    = Join-Path $sshDir 'config'
$allowlist = if ($env:SAFE_SSH_ALLOWLIST) { $env:SAFE_SSH_ALLOWLIST } else { Join-Path $sshDir 'claude-allowed-hosts' }

# 1. Connection defined with a real HostName (no leftover placeholder).
$resolved = (& ssh -G $Name 2>$null | Select-String -Pattern '^hostname ' | Select-Object -First 1) -replace '^hostname\s+', ''
if (-not $resolved -or $resolved -eq $Name -or $resolved -match 'FILL_IN') {
  Write-Error "refused: connection '$Name' is not finished in $config (HostName empty or still a placeholder). A human must fill it in first (run new-connection.ps1 '$Name', then edit $config)."
  exit 1
}

# 2. The configured key file must exist.
$keyfile = (& ssh -G $Name 2>$null | Select-String -Pattern '^identityfile ' | Select-Object -First 1) -replace '^identityfile\s+', ''
$keyfileExp = $keyfile -replace '^~', $env:USERPROFILE
if (-not $keyfileExp -or -not (Test-Path -LiteralPath $keyfileExp)) {
  Write-Error "refused: key file for '$Name' not found ($keyfile). A human must generate it: ssh-keygen -t ed25519 -f `"$keyfileExp`""
  exit 1
}

# 3. Register the connection.
if (-not (Test-Path -LiteralPath $allowlist)) { New-Item -ItemType File -Force -Path $allowlist | Out-Null }
$approved = Get-Content -LiteralPath $allowlist | ForEach-Object { $_.Trim() }
if ($approved -contains $Name) {
  Write-Host "Connection '$Name' is already authorized."
} else {
  Add-Content -LiteralPath $allowlist -Value $Name
  Write-Host "Authorized connection '$Name' in $allowlist"
}

# 4. Verify end to end.
Write-Host ''
& (Join-Path $PSScriptRoot 'check-setup.ps1') $Name

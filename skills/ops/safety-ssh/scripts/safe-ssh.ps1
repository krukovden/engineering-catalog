<#
.SYNOPSIS
  safe-ssh — run a command on an APPROVED host connection, credential-free.
.DESCRIPTION
  Accepts only a bare connection that a human has placed in the allowlist. Never takes a
  hostname, IP, user, or key — those live in ~/.ssh/config. Always uses BatchMode so
  a missing key fails fast instead of hanging on a hidden password prompt.
.EXAMPLE
  .\safe-ssh.ps1 my-server uptime
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Connection,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Command
)

$ErrorActionPreference = 'Stop'

$allowlist = if ($env:SAFE_SSH_ALLOWLIST) {
  $env:SAFE_SSH_ALLOWLIST
} else {
  Join-Path $env:USERPROFILE '.ssh\claude-allowed-hosts'
}

# The target must be a bare connection — reject options, paths, and whitespace so a real
# host or ssh option can't be smuggled in through the connection argument.
if ($Connection -match '^[-/]' -or $Connection -match '[\s\\/]') {
  Write-Error "refused: '$Connection' is not a bare connection name"
  exit 1
}

if (-not (Test-Path -LiteralPath $allowlist)) {
  Write-Error "refused: allowlist '$allowlist' not found. A human must create it (run new-connection.ps1). Do not work around this."
  exit 1
}

$approved = Get-Content -LiteralPath $allowlist |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ -and -not $_.StartsWith('#') }

if ($approved -notcontains $Connection) {
  Write-Error "refused: '$Connection' is not in the approved allowlist ('$allowlist'). A human must add it deliberately. Do not work around this."
  exit 1
}

$sshArgs = @(
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'PreferredAuthentications=publickey',
  '-o', 'ClearAllForwardings=yes',
  '--', $Connection
)
if ($Command) { $sshArgs += $Command }

& ssh @sshArgs
exit $LASTEXITCODE

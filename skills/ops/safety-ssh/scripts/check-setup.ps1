<#
.SYNOPSIS
  check-setup — verify credential-free SSH is correctly set up for a connection.
.DESCRIPTION
  Read-only. Exposes no secrets. Exit 0 = ready, 1 = not ready.
.EXAMPLE
  .\check-setup.ps1 my-server
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Connection
)

$allowlist = if ($env:SAFE_SSH_ALLOWLIST) {
  $env:SAFE_SSH_ALLOWLIST
} else {
  Join-Path $env:USERPROFILE '.ssh\claude-allowed-hosts'
}

$fail = 0
function Ok($m)  { Write-Host "[ok]   $m" }
function Bad($m) { Write-Host "[FAIL] $m"; $script:fail = 1 }

# 1. ssh-agent service running and holding a key.
$svc = Get-Service ssh-agent -ErrorAction SilentlyContinue
if (-not $svc -or $svc.Status -ne 'Running') {
  Bad "ssh-agent service is not running (Start-Service ssh-agent, then ssh-add <keyfile>)"
} else {
  $keys = & ssh-add -l 2>$null
  if ($LASTEXITCODE -eq 0) { Ok "ssh-agent is running with a key loaded" }
  else { Bad "ssh-agent is running but has NO keys loaded (run: ssh-add <keyfile>)" }
}

# 2. Connection defined in ~/.ssh/config (ssh -G echoes the connection back when undefined).
$resolved = (& ssh -G $Connection 2>$null | Select-String -Pattern '^hostname ' | Select-Object -First 1) -replace '^hostname\s+', ''
if ($resolved -and $resolved -ne $Connection) {
  Ok "connection '$Connection' is defined in ~/.ssh/config"
} else {
  Bad "connection '$Connection' is not defined in ~/.ssh/config (a human must add a Host block)"
}

# 3. Connection approved in the allowlist.
$approved = @()
if (Test-Path -LiteralPath $allowlist) {
  $approved = Get-Content -LiteralPath $allowlist | ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') }
}
if ($approved -contains $Connection) { Ok "connection '$Connection' is in the allowlist" }
else { Bad "connection '$Connection' is NOT in the allowlist ('$allowlist')" }

# 4. Key auth: at least one IdentityFile configured for the connection EXISTS on disk.
#    ssh -G lists stock defaults for any host, so existence is what makes this
#    check discriminating rather than always-true.
$keyok = $false
& ssh -G $Connection 2>$null | ForEach-Object {
  if ($_ -match '^identityfile\s+(.+)$') {
    $expanded = $matches[1].Trim() -replace '^~', $env:USERPROFILE
    if (Test-Path -LiteralPath $expanded) { $keyok = $true }
  }
}
if ($keyok) { Ok "a configured private key file exists for '$Connection'" }
else { Bad "no existing private key file is configured for '$Connection' (run new-connection)" }

# 5. Fail-fast key-only connection works.
& ssh -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes `
      -o PreferredAuthentications=publickey $Connection true 2>$null
if ($LASTEXITCODE -eq 0) { Ok "key-based connection to '$Connection' works (BatchMode, no prompt)" }
else { Bad "could not connect to '$Connection' with key auth — check the key is authorized on the host" }

if ($fail -eq 0) { Write-Host "RESULT: ready" } else { Write-Host "RESULT: not ready" }
exit $fail

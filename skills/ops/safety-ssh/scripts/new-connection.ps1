<#
.SYNOPSIS
  new-connection — scaffold a credential-free SSH connection template (Windows).
.DESCRIPTION
  Safe for the AI to run: creates ~/.ssh/config (if missing) and appends a template
  block for <name> with EMPTY <FILL_IN> placeholders. Writes NO real hostnames,
  users, or secrets — a human fills those in afterward.
.EXAMPLE
  .\new-connection.ps1 my-server
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Name
)
$ErrorActionPreference = 'Stop'

if ($Name -match '^[-/]' -or $Name -match '[\s\\/]') {
  throw "connection name must be a bare token (no spaces, slashes, leading -)"
}

$sshDir  = Join-Path $env:USERPROFILE '.ssh'
$config  = Join-Path $sshDir 'config'
$keyfile = Join-Path $sshDir ("id_ed25519_{0}" -f $Name)

New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
if (-not (Test-Path -LiteralPath $config)) { New-Item -ItemType File -Force -Path $config | Out-Null }

$configText = Get-Content -LiteralPath $config -Raw -ErrorAction SilentlyContinue
if ($configText -and ($configText -match "(?im)^\s*Host\s+$([regex]::Escape($Name))(\s|$)")) {
  Write-Host "Connection '$Name' already exists in $config. Edit it there if you need to change it."
  exit 0
}

$block = @"

# --- SSH connection '$Name' — replace the two <FILL_IN> values below ---
Host $Name
    HostName <FILL_IN_hostname_or_ip>
    User <FILL_IN_login_user>
    Port 22
    IdentityFile $keyfile
    IdentitiesOnly yes
    AddKeysToAgent yes
    ForwardAgent no
    StrictHostKeyChecking accept-new
"@
Add-Content -LiteralPath $config -Value $block

Write-Host @"
Created a template for connection '$Name' in $config.

Now YOU (not the assistant) do two things:

  1. Open $config and replace the two <FILL_IN> values
     (HostName = the real host/IP, User = the login user).

  2. Create the key WITH a passphrase, load it, and install the public key:
       ssh-keygen -t ed25519 -f "$keyfile" -C "$Name"
       ssh-add "$keyfile"
       # then append $keyfile.pub to ~/.ssh/authorized_keys on the server

When that's done, tell the assistant to authorize the connection
(it will run: authorize-connection.ps1 $Name).
"@

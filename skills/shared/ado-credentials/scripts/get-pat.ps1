# get-pat.ps1 — unwrap the DPAPI-protected PAT to stdout.
#
# Deliberately standalone: git spawns this once per credential prompt through
# GIT_ASKPASS, so it stays free of dot-sourcing and prints exactly one line.
# setup.ps1 copies it into %USERPROFILE%\.ado-credentials\ next to git-askpass.cmd,
# which is the copy git actually runs.
# Git asks for the username first and the password second; the wrapper passes the
# prompt text as the only argument.

param([string]$PromptText = "")
$ErrorActionPreference = "Stop"

$secretPath = Join-Path $env:USERPROFILE ".ado-credentials\ado-pat.xml"
if (-not (Test-Path -LiteralPath $secretPath)) {
  throw "Protected PAT not found at $secretPath. Run setup.ps1."
}

# Any non-empty username works with PAT-over-basic auth; the PAT is the password.
if ($PromptText -match "Username") { Write-Output "ado"; exit 0 }

$secure = Import-Clixml -LiteralPath $secretPath
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }

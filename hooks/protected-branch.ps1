#!/usr/bin/env pwsh
# protected-branch.ps1 - twin of protected-branch.sh: hands the payload to the Node
# implementation. No node, or any failure, means the call goes ahead.
param([switch]$Copilot)

$ErrorActionPreference = 'Stop'
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { exit 0 }
    $extra = @()
    if ($Copilot) { $extra += '--copilot' }
    $payload = [Console]::In.ReadToEnd()
    $payload | node (Join-Path $PSScriptRoot 'protected-branch.js') @extra
} catch { }
exit 0

#!/usr/bin/env pwsh
param(
    [switch]$Quiet,
    [switch]$Force,
    [switch]$Json,
    [int]$Days = 7
)

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
& (Join-Path $root 'skills/shared/catalog-freshness/scripts/check-freshness.ps1') @PSBoundParameters
# One throttled line in the existing hook, never a second SessionStart hook.
try {
    & node (Join-Path $root 'skills/shared/ado-board/scripts/ado-board.js') reconcile --allow-unconfigured --throttle-hours 12 *> $null
} catch {
    # Hook helpers never block the session.
}

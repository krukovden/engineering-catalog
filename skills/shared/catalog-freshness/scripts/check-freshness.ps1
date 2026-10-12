#!/usr/bin/env pwsh
# check-freshness.ps1 - "check every N days, last checked on D" (DESIGN Sec 7.4).
# Reads the install receipt, asks the remote for its tags, prints a one-line hint when a
# newer catalog exists. Always exits 0: a hint must never break a session.
param(
    [switch]$Quiet,
    [switch]$Force,
    [switch]$Json,
    [switch]$Version,
    [int]$Days = 7
)

$ErrorActionPreference = 'SilentlyContinue'

# One message, two shapes. Claude adds a SessionStart hook's plain stdout to the session as
# context; Copilot reads the same stdout as JSON and takes the line from `additionalContext`,
# dropping plain text without a word. -Json picks the second (copilot-facts.md Sec 6).
# Messages are collected and printed once by Finish: Copilot reads exactly one JSON object.
$script:Messages = @()
function Emit([string]$Message) { $script:Messages += $Message }

function Say([string]$Message) {
    if (-not $Quiet) { Emit $Message }
}

function Finish {
    if ($script:Messages.Count -gt 0) {
        $text = $script:Messages -join "`n"
        if ($Json) { Write-Output ((@{ additionalContext = $text } | ConvertTo-Json -Compress)) }
        else { Write-Output $text }
    }
    exit 0
}

$homeDir = $env:ENGCAT_HOME
if ([string]::IsNullOrEmpty($homeDir)) {
    $homeDir = $HOME
}

# Not about freshness, but this is the one script every session runs first. When the QA
# skill is installed beside this one on Windows and no Azure DevOps project is configured,
# say so every session, so the first conversation sets one up instead of the first work
# item failing. Located without a relative path: the skills root is two levels up.
$skillsRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $Version -and $env:OS -eq 'Windows_NT' -and (Test-Path -LiteralPath (Join-Path (Join-Path $skillsRoot 'qa-ado-work-item') 'SKILL.md'))) {
    $adoConfig = Join-Path (Join-Path $homeDir '.ado-credentials') 'config.json'
    $hasProject = $false
    if (Test-Path -LiteralPath $adoConfig) {
        try { $hasProject = @((Get-Content -Raw -LiteralPath $adoConfig | ConvertFrom-Json).contexts | Where-Object { $_.organization }).Count -gt 0 } catch { }
    }
    if (-not $hasProject) {
        Emit 'No Azure DevOps project is connected yet, so bugs cannot be filed here. Send me a link to your board (any board, backlog or sprint page) and, if you have them, links to the code, and I will connect it.'
    }
}

$receiptCandidates = @(
    (Join-Path '.' '.engineering-catalog/receipt.json'),
    (Join-Path $homeDir '.engineering-catalog/receipt.json')
)
$receiptPath = $null
foreach ($cand in $receiptCandidates) {
    if (Test-Path -LiteralPath $cand -PathType Leaf) { $receiptPath = $cand; break }
}
if (-not $receiptPath) {
    Say 'engineering-catalog is not installed here (no receipt).'
    Finish
}

$statePath = Join-Path $homeDir '.engineering-catalog/freshness.json'

$receipt = $null
try {
    $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
} catch {
    Say 'engineering-catalog receipt is unreadable.'
    Finish
}

$firstInstall = $null
if ($receipt.installs -and $receipt.installs.Count -gt 0) {
    $firstInstall = $receipt.installs[0]
}
if (-not $firstInstall) {
    Say 'engineering-catalog is not installed here (no receipt).'
    Finish
}

$source = $firstInstall.source
$installed = $firstInstall.catalogVersion

# "Which version is installed?" answered from the receipt alone: no network, no interval.
if ($Version) {
    # PowerShell 7 turns an ISO date in JSON into a [datetime]; 5.1 keeps the string.
    $installedOn = $firstInstall.date
    if ($installedOn -is [datetime]) { $installedOn = $installedOn.ToUniversalTime().ToString('yyyy-MM-dd') }
    else { $installedOn = "$installedOn"; if ($installedOn.Length -ge 10) { $installedOn = $installedOn.Substring(0, 10) } }
    Emit "engineering-catalog $installed is installed (on $installedOn, from $source)."
    Finish
}

if (-not $Force -and (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    $state = $null
    try { $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } catch { $state = $null }
    if ($state -and $state.lastChecked) {
        $lastChecked = $null
        try { $lastChecked = [DateTimeOffset]::Parse($state.lastChecked) } catch { $lastChecked = $null }
        if ($lastChecked) {
            $elapsed = [DateTimeOffset]::UtcNow - $lastChecked.ToUniversalTime()
            if ($elapsed.TotalDays -lt $Days) {
                Finish
            }
        }
    }
}

# Never prompt for credentials: under a hook there is nobody to answer, and a
# credential-manager dialog would hang the session.
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$tagLines = & git -c credential.interactive=false ls-remote --tags $source 2>$null
$latest = $null
if ($tagLines) {
    $versions = @()
    foreach ($line in $tagLines) {
        if ($line -match 'refs/tags/v([0-9][0-9.]*)$') {
            $versions += $Matches[1]
        }
    }
    if ($versions.Count -gt 0) {
        $latest = ($versions | Sort-Object { [version]$_ } | Select-Object -Last 1)
    }
}

$stateDir = Split-Path -Parent $statePath
if (-not (Test-Path -LiteralPath $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}
$nowIso = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$stateOut = [ordered]@{ lastChecked = $nowIso; latest = if ($latest) { $latest } else { $installed } }
($stateOut | ConvertTo-Json -Compress) | Set-Content -LiteralPath $statePath

if (-not $latest) {
    Say "engineering-catalog $installed - could not read tags from $source."
    Finish
}

$newest = @($installed, $latest) | Sort-Object { [version]$_ } | Select-Object -Last 1
if ($newest -ne $installed) {
    Emit "engineering-catalog $installed -> $latest available. Update: npx git+$source update"
} else {
    Say "engineering-catalog $installed is current."
}
Finish

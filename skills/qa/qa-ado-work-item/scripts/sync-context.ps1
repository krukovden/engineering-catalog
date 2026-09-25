# sync-context.ps1 — bring a context's repositories up to date, without ever losing work.
#
# `fetch --prune` always; `pull --ff-only` only when the checkout is clean, on a branch,
# and that branch has an upstream. There is no reset, stash, merge, rebase, or checkout
# anywhere in this script: a tester's working tree is evidence, and evidence is not
# something a tool may overwrite to make its own job easier.
#
# Output is one JSON object on stdout. Every repository gets one of these states:
#   current      pulled (or already up to date); detail is the short HEAD sha
#   dirty        fetched; uncommitted changes present, pull skipped
#   detached     fetched; not on a branch, pull skipped
#   no-upstream  fetched; branch tracks nothing, pull skipped
#   diverged     fetched; fast-forward refused, pull skipped
#   fetch-failed could not reach the remote
#   missing      no Git checkout at the configured path
#
# Exit codes: 0 = every repository is current
#             2 = at least one is not current — USABLE, not a failure. Carry on and
#                 label that repository's evidence with its state.
#             1 = the context could not be read at all.

param([string]$ContextName)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot "common.ps1")
Assert-Windows

$config = Get-AssistantConfig
$context = Resolve-AssistantContext -Config $config -Name $ContextName
# The helper was installed by the ado-credentials setup; this only resolves its path.
$askpass = Write-GitAskpass

# git writes progress to stderr and returns non-zero for ordinary outcomes; let this
# script keep going and record the outcome per repository instead of aborting the batch.
$ErrorActionPreference = "Continue"

$results = @()
foreach ($repo in @(Get-Prop $context "repositories" @())) {
  $result = [ordered]@{ name = $repo.name; path = $repo.path; branch = $null; status = "unknown"; detail = "" }

  if (-not (Test-Path -LiteralPath (Join-Path $repo.path ".git"))) {
    $result.status = "missing"
    $result.detail = "No Git checkout at the configured path - re-run setup-workspace.ps1 or clone it manually."
    $results += [pscustomobject]$result
    continue
  }

  $env:GIT_ASKPASS = $askpass
  $env:GIT_TERMINAL_PROMPT = "0"
  try {
    & git -C $repo.path fetch --prune origin 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $result.status = "fetch-failed"
      $result.detail = "git fetch returned $LASTEXITCODE - remote unreachable or the PAT lacks Code (Read)."
      $results += [pscustomobject]$result
      continue
    }

    $dirty = (& git -C $repo.path status --porcelain)
    $branch = (& git -C $repo.path branch --show-current)
    if ($branch) { $branch = $branch.Trim() }
    $result.branch = $branch
    $upstream = (& git -C $repo.path rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>&1)
    if ($LASTEXITCODE -ne 0) { $upstream = $null }

    if (-not $branch) {
      $result.status = "detached"; $result.detail = "Fetched; HEAD is detached, pull skipped."
    }
    elseif ($dirty) {
      $result.status = "dirty"; $result.detail = "Fetched; uncommitted local changes present, pull skipped."
    }
    elseif (-not $upstream) {
      $result.status = "no-upstream"; $result.detail = "Fetched; '$branch' tracks no upstream, pull skipped."
    }
    else {
      & git -C $repo.path pull --ff-only 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $result.status = "current"
        $result.detail = (& git -C $repo.path rev-parse --short HEAD).Trim()
      }
      else {
        $result.status = "diverged"
        $result.detail = "Fast-forward refused; local commits differ from '$upstream'. No changes made."
      }
    }
  }
  finally {
    Remove-Item Env:GIT_ASKPASS -ErrorAction SilentlyContinue
    Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
  }

  $results += [pscustomobject]$result
}

$stale = @($results | Where-Object { $_.status -ne "current" })
[ordered]@{
  context      = $context.name
  organization = $context.organization
  project      = $context.project
  repositories = $results
  allCurrent   = ($stale.Count -eq 0)
  staleCount   = $stale.Count
} | ConvertTo-Json -Depth 5

if ($stale.Count -gt 0) { exit 2 }

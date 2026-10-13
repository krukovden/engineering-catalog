param(
  [switch]$Json,
  [int]$PendingLimit = 20,
  [string]$Root,
  [Alias('Home')]
  [string]$HomeDir
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $result = [ordered]@{
    root = $(if ($Root) { $Root } else { (Get-Location).Path })
    home = $(if ($HomeDir) { $HomeDir } else { $env:USERPROFILE })
    checks = @(
      [ordered]@{
        status = "fail"
        id = "node"
        detail = "node is not on PATH."
        fix = "Install Node 20+ and re-run catalog-doctor."
      },
      [ordered]@{
        status = "warn"
        id = "doctor-core"
        detail = "catalog-doctor skipped the remaining checks because its core script needs node."
        fix = "Install Node 20+ and re-run catalog-doctor."
      }
    )
  }
  if ($Json) {
    $result | ConvertTo-Json -Depth 6
  } else {
    foreach ($check in $result.checks) {
      Write-Output ("{0}`t{1}`t{2}`tfix: {3}" -f $check.status, $check.id, $check.detail, $check.fix)
    }
  }
  exit 0
}

$args = @()
if ($Json) { $args += '--json' }
$args += @('--pending-limit', "$PendingLimit")
if ($Root) { $args += @('--root', $Root) }
if ($HomeDir) { $args += @('--home', $HomeDir) }
& $node.Source (Join-Path $scriptDir 'doctor.js') @args
exit $LASTEXITCODE

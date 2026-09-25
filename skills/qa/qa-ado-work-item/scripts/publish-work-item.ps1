# publish-work-item.ps1 — the ONLY script in this skill that writes to Azure DevOps.
#
# Three guarantees, each enforced by the script rather than promised in prose:
#
#   1. VALIDATE BEFORE PREVIEW. The work item type, every field reference name, and the
#      parent are checked against the live project. A draft that would be rejected — or
#      quietly filed under the wrong parent — fails here, not after the human approved it.
#
#   2. APPROVAL IS BOUND TO CONTENT. Preview prints a draftHash over the exact patch it
#      would send. -Commit requires that hash back. Edit the draft after the preview and
#      the hash moves, so approval of an older wording cannot publish a newer one.
#
#   3. PUBLISHING HAPPENS ONCE. A receipt file is written beside the draft before the
#      request goes out and updated after it returns. A second -Commit never re-posts:
#      it reports the item already created, or refuses because the previous attempt's
#      outcome is unknown. A timed-out POST that actually succeeded cannot become two
#      work items.
#
# Exit codes: 0 = preview produced, or item created and read back clean
#             1 = validation or request error; nothing was created
#             3 = refused (hash mismatch, or a receipt already exists) — nothing sent
#             5 = created, but the read-back differs from the approved draft.
#                 DO NOT RETRY. Report the mismatch with the id and url.

param(
  [Parameter(Mandatory = $true)][string]$DraftPath,
  [switch]$Commit,
  [string]$ApprovedHash
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptRoot "common.ps1")
Assert-Windows

# House rule, tighter than the 255 Azure DevOps allows: a title that does not fit on a
# board card is not doing its job.
$TitleLimit = 100

if (-not (Test-Path -LiteralPath $DraftPath)) { throw "Draft not found: $DraftPath" }
$DraftPath = (Resolve-Path -LiteralPath $DraftPath).Path
$receiptPath = "$DraftPath.receipt.json"

try { $draft = Get-Content -LiteralPath $DraftPath -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { throw "Draft is not valid JSON: $DraftPath`n$($_.Exception.Message)" }

$config = Get-AssistantConfig
$context = Resolve-AssistantContext -Config $config -Name (Get-Prop $draft "context")
$organization = $context.organization
$project = $context.project

# ---------------------------------------------------------------- validation

$problems = @()
$checks = @()
function Add-Check { param([string]$Name, [bool]$Ok, [string]$Detail)
  $script:checks += [ordered]@{ check = $Name; ok = $Ok; detail = $Detail }
  if (-not $Ok) { $script:problems += "$Name - $Detail" }
}

$type = Get-Prop $draft "type"
if (-not $type) { throw "Draft is missing 'type'." }
$fields = Get-Prop $draft "fields"
if (-not $fields) { throw "Draft is missing 'fields'." }
$fieldNames = @($fields.PSObject.Properties.Name)
$parentId = Get-Prop $draft "parentId"

# Type must exist in this project's process.
$typeResponse = Invoke-AdoRest -Organization $organization -Project $project -Path "_apis/wit/workitemtypes"
$typeNames = @(@($typeResponse.value) | ForEach-Object { $_.name })
$typeMatch = @($typeNames | Where-Object { $_ -eq $type })[0]
Add-Check "type-exists" ([bool]$typeMatch) $(if ($typeMatch) { "'$type' exists in $project" } else { "'$type' is not a work item type in $project. Available: $($typeNames -join ', ')" })

# Title: present, non-empty, within the house limit.
$title = Get-Prop $fields "System.Title"
Add-Check "title-present" ([bool]$title) $(if ($title) { "present" } else { "System.Title is required" })
if ($title) {
  Add-Check "title-length" ($title.Length -le $TitleLimit) "$($title.Length) characters (limit $TitleLimit)"
}

# Every field must be on the context's allow list...
$notAllowed = @($fieldNames | Where-Object { $context.allowedFields -notcontains $_ })
Add-Check "fields-allowed" ($notAllowed.Count -eq 0) $(if ($notAllowed.Count -eq 0) { "all $($fieldNames.Count) field(s) allowed by context" } else { "not on the context allow list: $($notAllowed -join ', ')" })

# ...and must actually exist on this type in this project's process. This is what catches
# a Bug drafted with System.Description in a process where Bugs only carry ReproSteps.
if ($typeMatch) {
  $fieldResponse = Invoke-AdoRest -Organization $organization -Project $project `
    -Path "_apis/wit/workitemtypes/$([Uri]::EscapeDataString($type))/fields"
  $typeFields = @(@($fieldResponse.value) | ForEach-Object { $_.referenceName })
  $unknown = @($fieldNames | Where-Object { $typeFields -notcontains $_ })
  Add-Check "fields-exist-on-type" ($unknown.Count -eq 0) $(if ($unknown.Count -eq 0) { "all field reference names exist on '$type'" } else { "not fields of '$type': $($unknown -join ', ')" })
}

# Parent must exist, and must live in the same project.
$parentSummary = $null
if ($parentId) {
  try {
    $parent = Invoke-AdoRest -Organization $organization -Project $project -Path "_apis/wit/workitems/$parentId"
    $parentProject = Get-Prop $parent.fields "System.TeamProject"
    $parentSummary = "$($parent.fields.'System.WorkItemType') $parentId - $($parent.fields.'System.Title')"
    Add-Check "parent-in-project" ($parentProject -eq $project) $(if ($parentProject -eq $project) { $parentSummary } else { "parent $parentId is in project '$parentProject', not '$project'" })
  }
  catch {
    Add-Check "parent-exists" $false "parent $parentId could not be read: $($_.Exception.Message)"
  }
}
else {
  $checks += [ordered]@{ check = "parent"; ok = $true; detail = "none - item will be created unparented" }
}

# ---------------------------------------------------------------- patch document

$patch = @()
foreach ($property in $fields.PSObject.Properties) {
  if ($null -ne $property.Value -and "$($property.Value)" -ne "") {
    $patch += [ordered]@{ op = "add"; path = "/fields/$($property.Name)"; value = $property.Value }
  }
}
if ($parentId) {
  $patch += [ordered]@{
    op    = "add"
    path  = "/relations/-"
    value = [ordered]@{
      rel        = "System.LinkTypes.Hierarchy-Reverse"
      url        = "$($organization.TrimEnd('/'))/_apis/wit/workItems/$parentId"
      attributes = @{ comment = "Parent" }
    }
  }
}
$patchJson = ConvertTo-JsonArray -InputObject $patch -Depth 12

# The hash covers exactly what would be sent, so reformatting the draft file does not
# invalidate an approval but changing a single character of content does.
$canonical = "$type|$parentId|$patchJson"
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $draftHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))) -replace '-', '').ToLowerInvariant().Substring(0, 16)
}
finally { $sha.Dispose() }

# ---------------------------------------------------------------- preview

if (-not $Commit) {
  [ordered]@{
    mode         = "PREVIEW"
    context      = $context.name
    organization = $organization
    project      = $project
    type         = $type
    parentId     = $parentId
    parent       = $parentSummary
    draftHash    = $draftHash
    valid        = ($problems.Count -eq 0)
    checks       = $checks
    problems     = $problems
    # The exact request body, as a string: re-serialising it here would let PowerShell
    # collapse a one-operation array back into an object and show something the API
    # would never receive.
    patchJson    = $patchJson
    receipt      = $(if (Test-Path -LiteralPath $receiptPath) { $receiptPath } else { $null })
  } | ConvertTo-Json -Depth 12

  Write-Host ""
  if ($problems.Count -gt 0) {
    Write-Host "NOTHING HAS BEEN CREATED. Fix the problems above, then preview again."
    exit 1
  }
  Write-Host "NOTHING HAS BEEN CREATED."
  Write-Host "After the user approves THIS exact content, publish with:"
  Write-Host "  -Commit -ApprovedHash $draftHash"
  exit 0
}

# ---------------------------------------------------------------- commit

if ($problems.Count -gt 0) {
  Exit-WithMessage -Code 1 -Message "Draft failed validation; nothing was sent:`n  $($problems -join "`n  ")"
}

if (-not $ApprovedHash) {
  Exit-WithMessage -Code 3 -Message "-Commit requires -ApprovedHash. Run preview, show its output to the user, and pass back the draftHash they approved (currently $draftHash)."
}
if ($ApprovedHash.Trim().ToLowerInvariant() -ne $draftHash) {
  Exit-WithMessage -Code 3 -Message "The draft changed after the approved preview (approved $ApprovedHash, current $draftHash). Preview again and ask for approval of the new content. Nothing was sent."
}

if (Test-Path -LiteralPath $receiptPath) {
  $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ((Get-Prop $receipt "state") -eq "created") {
    [ordered]@{ mode = "ALREADY-PUBLISHED"; id = $receipt.id; url = $receipt.url; publishedAt = $receipt.publishedAt } | ConvertTo-Json -Depth 5
    Write-Host "This draft was already published. No second item was created."
    exit 3
  }
  $previous = if ((Get-Prop $receipt "state") -eq "failed") {
    "failed at $(Get-Prop $receipt 'failedAt') with: $(Get-Prop $receipt 'error')"
  } else {
    "started at $(Get-Prop $receipt 'startedAt') and never recorded an outcome"
  }
  Exit-WithMessage -Code 3 -Message @"
A previous publish of this draft $previous.
The request had already been sent, so the work item may exist. Nothing was sent this time.
Search before retrying:
  query-ado.ps1 -Action Duplicates -Text "$title"
If it exists, record its id and url in $receiptPath with "state": "created".
If it does not, delete that file and re-run.
"@
}

# Written before the request, so a lost response still leaves a trail.
[ordered]@{ state = "in-flight"; draftHash = $draftHash; title = $title; type = $type; startedAt = (Get-Date).ToString("o") } |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding UTF8

try {
  $created = Invoke-AdoRest -Organization $organization -Project $project `
    -Path "_apis/wit/workitems/`$$([Uri]::EscapeDataString($type))" `
    -Method "Post" -Body $patchJson -ContentType "application/json-patch+json"
}
catch {
  # The receipt stays — the request went out, and a lost response looks exactly like a
  # rejected one from here. Record why, so the next run explains itself instead of just
  # refusing.
  [ordered]@{ state = "failed"; draftHash = $draftHash; title = $title; type = $type; failedAt = (Get-Date).ToString("o"); error = "$($_.Exception.Message)" } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  Exit-WithMessage -Code 1 -Message "$($_.Exception.Message)`n`nRecorded in $receiptPath. Confirm the item was not created before re-running (see references/troubleshooting.md)."
}

$itemUrl = "$($organization.TrimEnd('/'))/$([Uri]::EscapeDataString($project))/_workitems/edit/$($created.id)"
[ordered]@{ state = "created"; id = $created.id; url = $itemUrl; draftHash = $draftHash; title = $title; type = $type; publishedAt = (Get-Date).ToString("o") } |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding UTF8

# ---------------------------------------------------------------- read back

# Azure DevOps rewrites HTML fields (wrapping in <div>, normalising entities), so a
# byte-difference there is expected and is reported as "normalized" rather than a
# mismatch. Only a difference in the visible text counts as one.
function ConvertTo-PlainText {
  param([string]$Value)
  $text = $Value -replace '<[^>]+>', ' '
  $text = $text -replace '&nbsp;', ' ' -replace '&amp;', '&' -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&#39;', "'"
  return ($text -replace '\s+', ' ').Trim()
}

$readBack = Invoke-AdoRest -Organization $organization -Project $project `
  -Path "_apis/wit/workitems/$($created.id)" -Query @{ '$expand' = 'relations' }

$comparisons = @()
$mismatches = @()
foreach ($property in $fields.PSObject.Properties) {
  if ($null -eq $property.Value -or "$($property.Value)" -eq "") { continue }
  $submitted = "$($property.Value)"
  $returned = "$(Get-Prop $readBack.fields $property.Name)"
  $verdict = if ($submitted -ceq $returned) { "exact" }
             elseif ((ConvertTo-PlainText $submitted) -eq (ConvertTo-PlainText $returned)) { "normalized" }
             else { "differs" }
  $comparisons += [ordered]@{ field = $property.Name; verdict = $verdict }
  if ($verdict -eq "differs") { $mismatches += $property.Name }
}

$actualType = Get-Prop $readBack.fields "System.WorkItemType"
if ($actualType -ne $type) { $mismatches += "System.WorkItemType (asked '$type', got '$actualType')" }

$actualParent = $null
$parentRelation = @(@(Get-Prop $readBack "relations" @()) | Where-Object { $_.rel -eq "System.LinkTypes.Hierarchy-Reverse" })[0]
if ($parentRelation) { $actualParent = [int](($parentRelation.url -split "/")[-1]) }
if ($parentId -and $actualParent -ne [int]$parentId) { $mismatches += "parent (asked $parentId, got $actualParent)" }
if (-not $parentId -and $actualParent) { $mismatches += "parent (asked none, got $actualParent)" }

[ordered]@{
  mode         = "COMMITTED"
  id           = $created.id
  url          = $itemUrl
  type         = $actualType
  title        = Get-Prop $readBack.fields "System.Title"
  state        = Get-Prop $readBack.fields "System.State"
  parentId     = $actualParent
  verification = [ordered]@{
    verdict    = $(if ($mismatches.Count -eq 0) { "verified" } else { "mismatch" })
    fields     = $comparisons
    mismatches = $mismatches
  }
  receipt      = $receiptPath
} | ConvertTo-Json -Depth 8

if ($mismatches.Count -gt 0) {
  Write-Host ""
  Write-Host "Work item $($created.id) WAS created but does not match the approved draft."
  Write-Host "Do not retry - report the mismatch and the URL to the user."
  exit 5
}

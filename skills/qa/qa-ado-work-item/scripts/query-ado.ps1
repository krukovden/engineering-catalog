# query-ado.ps1 — every read this skill performs against Azure DevOps.
#
# Fixed actions, not free-form commands. The agent picks an action and passes typed
# arguments; it never composes a request. That is the difference between a lookup that
# runs identically every time and one that is re-improvised per conversation.
#
# READ-ONLY BY CONSTRUCTION: every action issues GET, or POST to the WIQL endpoint
# (which only evaluates a query). Nothing here can create or modify a work item —
# publish-work-item.ps1 is the single script that writes.
#
# Output is always one JSON object on stdout.
# Exit codes: 0 = ok, 1 = error.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Probe", "Types", "Fields", "Duplicates", "Show", "Children")]
  [string]$Action,
  [string]$ContextName,
  [string]$Type,
  [string]$Text,
  [int]$Id,
  [int]$Top = 25
)

$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "common.ps1")
Assert-Windows

$config = Get-AssistantConfig
$context = Resolve-AssistantContext -Config $config -Name $ContextName
$organization = $context.organization
$project = $context.project

# Fields worth reading back for any item, in every action that returns items.
$summaryFields = "System.Id,System.WorkItemType,System.Title,System.State,System.AreaPath,System.IterationPath,System.ChangedDate"

function Get-ItemSummaries {
  param([int[]]$Ids)
  if (-not $Ids -or $Ids.Count -eq 0) { return @() }
  $results = @()
  # The batch endpoint caps at 200 ids per request.
  for ($offset = 0; $offset -lt $Ids.Count; $offset += 200) {
    $slice = $Ids[$offset..([Math]::Min($offset + 199, $Ids.Count - 1))]
    $response = Invoke-AdoRest -Organization $organization -Project $project `
      -Path "_apis/wit/workitems" `
      -Query @{ ids = ($slice -join ","); fields = $summaryFields }
    foreach ($item in @($response.value)) {
      $results += [ordered]@{
        id    = $item.id
        type  = Get-Prop $item.fields "System.WorkItemType"
        title = Get-Prop $item.fields "System.Title"
        state = Get-Prop $item.fields "System.State"
        url   = "$($organization.TrimEnd('/'))/$([Uri]::EscapeDataString($project))/_workitems/edit/$($item.id)"
      }
    }
  }
  return $results
}

# WIQL string literals are single-quoted; a quote inside a term is escaped by doubling.
function Format-WiqlLiteral {
  param([string]$Value)
  return "'" + ($Value -replace "'", "''") + "'"
}

$output = $null

switch ($Action) {

  "Probe" {
    # The setup completion gate: proves the credentials context and the workspace context
    # join up and the PAT scopes reach the project before any drafting begins.
    $projectInfo = Invoke-AdoRest -Organization $organization -Path "_apis/projects/$([Uri]::EscapeDataString($project))"
    $types = Invoke-AdoRest -Organization $organization -Project $project -Path "_apis/wit/workitemtypes"
    $output = [ordered]@{
      action        = "Probe"
      context       = $context.name
      organization  = $organization
      project       = $projectInfo.name
      projectId     = $projectInfo.id
      workItemTypes = @(@($types.value) | ForEach-Object { $_.name })
      reachable     = $true
    }
  }

  "Types" {
    $types = Invoke-AdoRest -Organization $organization -Project $project -Path "_apis/wit/workitemtypes"
    $output = [ordered]@{
      action = "Types"
      types  = @(@($types.value) | ForEach-Object { [ordered]@{ name = $_.name; description = $_.description } })
    }
  }

  "Fields" {
    if (-not $Type) { throw "-Type is required for the Fields action." }
    $fields = Invoke-AdoRest -Organization $organization -Project $project `
      -Path "_apis/wit/workitemtypes/$([Uri]::EscapeDataString($Type))/fields"
    $output = [ordered]@{
      action = "Fields"
      type   = $Type
      fields = @(@($fields.value) | ForEach-Object {
          [ordered]@{ referenceName = $_.referenceName; name = $_.name; alwaysRequired = $_.alwaysRequired }
        })
    }
  }

  "Duplicates" {
    if (-not $Text) { throw "-Text is required for the Duplicates action." }
    # Words shorter than four characters ("the", "on", "is") match almost everything and
    # bury the real candidates, so they are dropped from the search.
    $terms = @(($Text -split '[^\p{L}\p{Nd}]+') | Where-Object { $_.Length -ge 4 } | Select-Object -Unique -First 6)
    if ($terms.Count -eq 0) { throw "No search term of four characters or more in: $Text" }
    $clauses = @($terms | ForEach-Object { "[System.Title] CONTAINS $(Format-WiqlLiteral $_)" })
    $wiql = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND (" +
            ($clauses -join " OR ") + ") ORDER BY [System.ChangedDate] DESC"
    $response = Invoke-AdoRest -Organization $organization -Project $project `
      -Path "_apis/wit/wiql" -Method "Post" -Body @{ query = $wiql } -Query @{ '$top' = $Top }
    $ids = @(@($response.workItems) | ForEach-Object { [int]$_.id })
    $output = [ordered]@{
      action     = "Duplicates"
      searchedOn = $terms
      wiql       = $wiql
      count      = $ids.Count
      candidates = Get-ItemSummaries -Ids $ids
    }
  }

  "Show" {
    if (-not $Id) { throw "-Id is required for the Show action." }
    $item = Invoke-AdoRest -Organization $organization -Project $project `
      -Path "_apis/wit/workitems/$Id" -Query @{ '$expand' = 'relations' }
    $parent = @(@(Get-Prop $item "relations" @()) |
      Where-Object { $_.rel -eq "System.LinkTypes.Hierarchy-Reverse" })[0]
    $parentId = $null
    if ($parent) { $parentId = [int](($parent.url -split "/")[-1]) }
    $output = [ordered]@{
      action   = "Show"
      id       = $item.id
      type     = Get-Prop $item.fields "System.WorkItemType"
      title    = Get-Prop $item.fields "System.Title"
      state    = Get-Prop $item.fields "System.State"
      project  = Get-Prop $item.fields "System.TeamProject"
      parentId = $parentId
      url      = "$($organization.TrimEnd('/'))/$([Uri]::EscapeDataString($project))/_workitems/edit/$($item.id)"
      fields   = $item.fields
    }
  }

  "Children" {
    if (-not $Id) { throw "-Id is required for the Children action." }
    $wiql = "SELECT [System.Id] FROM WorkItemLinks " +
            "WHERE [Source].[System.Id] = $Id AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' " +
            "MODE (MustContain)"
    $response = Invoke-AdoRest -Organization $organization -Project $project `
      -Path "_apis/wit/wiql" -Method "Post" -Body @{ query = $wiql } -Query @{ '$top' = $Top }
    # MustContain returns the queried item itself as a source-less row; drop it so only
    # real children come back.
    $ids = @(@($response.workItemRelations) |
      Where-Object { $_.target -and $_.target.id -ne $Id } |
      ForEach-Object { [int]$_.target.id } | Select-Object -Unique)
    $output = [ordered]@{
      action   = "Children"
      parentId = $Id
      count    = $ids.Count
      children = Get-ItemSummaries -Ids $ids
    }
  }
}

$output | ConvertTo-Json -Depth 8

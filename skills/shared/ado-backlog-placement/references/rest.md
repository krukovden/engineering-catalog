# Azure DevOps REST used by ado-backlog-placement

API version 7.1. `{o}` = `https://dev.azure.com/{org}`, `{p}` = `{o}/{project}`, `{t}` =
`{p}/{team}`. Shapes marked **verify** come from the documentation, not a live capture;
confirm them on one of the team's projects and remove the mark.

| Call | Used by | Fields read |
|---|---|---|
| `GET {o}/_apis/projects?$top=500` | `projects` | `value[].name` |
| `GET {o}/_apis/projects/{p}/teams?$top=500` | `projects --project` | `value[].name` |
| `GET {o}/_apis/projects/{p}` | every query with no team | `id`, `defaultTeam.name` (**verify**) |
| `GET {t}/_apis/work/teamsettings/teamfieldvalues` | `duplicates`, `candidates` | `values[].value`, `values[].includeChildren` (**verify**: area path is the team field) |
| `GET {t}/_apis/work/teamsettings/iterations?$timeframe=current` | `candidates` | `value[0].path` (**verify**) |
| `GET {p}/_apis/wit/workitemtypes` | `duplicates`, `candidates`, `create` | `value[].name`, `value[].isDisabled` |
| `GET {p}/_apis/wit/workitemtypes/{type}/states` | `duplicates`, `candidates` | `value[].name`, `value[].category` — Completed and Removed are not open |
| `GET {p}/_apis/wit/workitemtypes/{type}/fields` | `create` | `value[].referenceName` |
| `POST {p}/_apis/wit/wiql?$top=200` | `duplicates`, `candidates` | `workItems[].id` |
| `GET {p}/_apis/wit/workitems?ids=…&$expand=relations&errorPolicy=omit` | `duplicates`, `candidates` | `fields["System.Title" \| "System.Description" \| "System.State" \| "System.WorkItemType" \| "System.IterationPath" \| "System.ChangedDate"]`, `relations[]`; `fields=` cannot be combined with `$expand` |
| `GET {p}/_apis/git/repositories/{name}` | `candidates` | `id` |
| `GET {p}/_apis/wit/workitems/{id}?$expand=relations` | `create` (parent, read-back) | `fields["System.TeamProject" \| "System.WorkItemType" \| "System.Title" \| "System.State"]`, `relations[]` |
| `POST {p}/_apis/wit/workitems/${type}` (`application/json-patch+json`) | `create` | body: `add /fields/<name>` per field, then `add /relations/-` with `System.LinkTypes.Hierarchy-Reverse` to `{o}/_apis/wit/workItems/{parent}`; reads `id` |

## WIQL

```
SELECT [System.Id] FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.WorkItemType] IN ('Feature')
  AND [System.State] NOT IN (<Completed and Removed states of those types>)
  AND ([System.AreaPath] UNDER '<area>' OR [System.AreaPath] = '<area without children>')
ORDER BY [System.ChangedDate] DESC
```

At most 200 items are read; on a very large backlog the oldest open items are not scored.

## Repository links (verify)

A Feature's PR or branch link is a `relations[]` entry with `rel: "ArtifactLink"` and a URL
like `vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{pr}` or
`vstfs:///Git/Ref/{projectId}%2F{repoId}%2FGB{branch}`. The bonus is given when the decoded
URL contains `/{repoId}/`. Most links sit on the PBIs, not the Feature; record here whether
the bonus ever fires on the team's board.

## A rejected create (verify)

HTTP 400/401/403/404/422 is treated as "nothing created" and releases the receipt; any other
failure keeps it. Record here what the service returns for an unknown field or a parent in
another project.

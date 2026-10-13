# Azure DevOps REST used by ado-board

API version 7.1. `{p}` = `https://dev.azure.com/{org}/{project}`. Shapes marked **verify** come
from the documentation, not a live capture; confirm them on one of the team's projects and
remove the mark.

| Call | Used by | Fields read |
|---|---|---|
| `GET {p}/_apis/wit/workitemtypes` | `states discover` | `value[].name`, `value[].isDisabled` |
| `GET {p}/_apis/wit/workitemtypes/{type}/states` | `states discover` | `value[].name`, `value[].category` (Proposed, InProgress, Resolved, Completed, Removed) |
| `GET {p}/_apis/wit/workitems/{id}?fields=…` | `move`, a write that conflicted | `rev`, `fields["System.WorkItemType" \| "System.State" \| "System.Tags"]` |
| `GET {p}/_apis/wit/workitems?ids=…&fields=…&errorPolicy=omit` | `reconcile` | as above, plus `Microsoft.VSTS.Common.StateChangeDate`; omitted ids come back `null` (**verify**) |
| `PATCH {p}/_apis/wit/workitems/{id}` (`application/json-patch+json`) | `move`, `reconcile` | body: `test /rev` (the revision read), `add /fields/System.State`, `add /fields/System.History` (the evidence comment, same revision) |
| `POST {p}/_apis/wit/wiql?$top=200` | `reconcile`, nudge | `workItems[].id`; `@Me` is the credential's owner |
| `GET {p}/_apis/git/repositories/{name}` | `reconcile`, nudge | `id`, `defaultBranch` |
| `GET {p}/_apis/git/repositories/{id}/stats/branches` | `reconcile`, nudge | `value[].name`, `aheadCount`, `commit.commitId`, `commit.committer.date` (**verify**: ahead of the default branch) |
| `GET {p}/_apis/git/repositories/{id}/pullrequests?searchCriteria.status=completed&searchCriteria.queryTimeRangeType=closed&searchCriteria.minTime=…&$top=100&$skip=…` | `reconcile` | `pullRequestId`, `title`, `sourceRefName`, `closedDate`, `completionOptions.transitionWorkItems` (**verify**: set when "complete linked work items" was ticked). Paged until a short page, at most 20 pages; `closedDate` is filtered again locally |
| `GET {p}/_apis/git/repositories/{id}/pullRequests/{pr}/workitems` | `reconcile` | `value[].id` |

## A write on a stale read (verify)

The `test /rev` op fails when the item changed after the read. `board-rest.js` treats HTTP
412 and 409 as that conflict; record here which one the service actually returns.

## A transition that demands a field (verify)

A `PATCH` the process rules refuse returns HTTP 400 with `TF401320` and, per field,
`customProperties.RuleValidationErrors[]` carrying `fieldReferenceName`, `fieldStatusFlags`
(`required, …`) and `errorMessage` ("Rule Error for field Resolved Reason. Error code:
Required, …"). `move` reads the field name from there, or from `message` when the list is
absent, and stops. Fixture: `test/fixtures/ado-board/rule-error-required.json`.

## Work item mentions (verify)

On Azure Repos a work item mention in a commit or PR is `#123`; `AB#123` is the syntax for
GitHub-hosted repositories. Whether a mention links the item, and whether `Fixes #123`
transitions it on completion, depend on repository settings. `reconcile` does not rely on
either: it reads PR links, the PR title and the branch name. Record here what one of the
team's repositories actually does.

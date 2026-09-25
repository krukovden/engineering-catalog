# Memory file formats

These are the formats `scripts/memory-lib.js` parses and `scripts/lint.js` checks.
Anything that departs from them is either ignored or reported as a problem.

## `index.md`

```markdown
<!-- memory:index — what this project is, its architecture, one row per unit, project-level rejections.
     Machine-read fields: `reconciled-sha:` and `store:` lines. Keep it small; unit files win on conflict. -->
# <project> — memory index

reconciled-sha: <full sha or none>
store: committed | local

## What this project is
<prose>

## Architecture
<prose>

## Units
| Unit | Summary |
|---|---|
| [[<slug>]] | <one line> |

## Rejected at project level
- <one line> (<entry-id>)
```

What the scripts read:

- `reconciled-sha:` and `store:` — one line each, anywhere in the file;
  `reconcile.js --mark` rewrites the first.
- `## Units` — every row whose first cell is `[[<slug>]]`. The slug must be the
  name of an existing `units/<slug>.md`, and every unit file must have a row.
- `## Rejected at project level` — every `- ` line up to the next `## ` heading.

## `units/<slug>.md`

```markdown
<!-- memory:unit <slug> — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# <Title>

## Entries

### <entry-id> <title>
- status: active | superseded | open | needs-review
- evidence: confirmed | inferred | unknown
- pr: <number or none>
- sha-at-write: <sha or none>
- merged-sha: <sha or none>
- supersedes: <entry-id or none>
- superseded-by: <entry-id or none>
- date: <YYYY-MM-DD>

<body — what changed, why; [[other-slug]] links>
```

What the scripts read:

- The slug in the contract comment must equal the file name without `.md`.
- An entry starts at a `### ` heading whose first word is an id of the form
  `e-YYYYMMDD-xxxx` (four lowercase hex characters). Any other `### ` heading is
  body text, so do not start a body heading with an id.
- The eight fields follow the heading directly, one `- key: value` per line. The
  first line that is not one of these eight starts the body. `none` and an empty
  value both mean "not set".
- `status`, `evidence` and `date` are validated; `date` must be `YYYY-MM-DD`.
- `supersedes` and `superseded-by` are checked across every unit file: both ids
  must exist and each must name the other.
- Every `[[slug]]` in the body is a link.

## A supersede pair, worked

The first entry was written when sessions were chosen; the second when the
requirement changed. Both stay. The old entry's `status` and `superseded-by` were
edited when the new one was written; nothing else in it changed.

```markdown
### e-20260112-a41c Sessions over JWT for the portal login
- status: superseded
- evidence: confirmed
- pr: 218
- sha-at-write: 9f1c2b7e0d4a6c8b3e5f7a9c1d2e3f4a5b6c7d8e
- merged-sha: 4c0e1d2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d
- supersedes: none
- superseded-by: e-20260303-7b2e
- date: 2026-01-12

Server-side sessions in Redis instead of signed JWTs. A JWT cannot be revoked
before it expires and the portal needs immediate logout on account suspension;
the cost is a Redis dependency, already present for [[rate-limiting]].

### e-20260303-7b2e JWT after all — the mobile client cannot hold a cookie
- status: active
- evidence: confirmed
- pr: 261
- sha-at-write: 2a9d8c7b6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b
- merged-sha: none
- supersedes: e-20260112-a41c
- superseded-by: none
- date: 2026-03-03

The mobile client (see [[mobile-api]]) runs in a webview without cookie storage,
so session cookies never reach it. Short-lived JWTs (5 min) with a server-side
refresh-token denylist give the same suspension latency as sessions did. Redis
stays, now holding the denylist.
```

The index row for this unit changed once, to `| [[auth]] | Short-lived JWT with
a refresh denylist; sessions until 2026-03 |`. Nothing was deleted.

## Status × evidence

Two independent axes. Status says where the entry is in its life; evidence says
how well the *origin* of the claim is established.

| | `confirmed` | `inferred` | `unknown` |
|---|---|---|---|
| `active` | the decision holds and its origin is verified — you made it, or the PR or a person states it | holds; the reasoning was reconstructed from the code or the diff | holds; nobody can say why it was made |
| `superseded` | replaced; what it says was true while it held, and verified | replaced; its reasoning was reconstructed | replaced; its reasoning was never established |
| `open` | a trade-off still undecided; the options are verified against the code | undecided; the options were reconstructed | undecided; even the options are uncertain |
| `needs-review` | a person must look; the facts are verified but the conclusion is disputed | a person must look; the facts were reconstructed | a person must look; nothing is established — what `memory-writer` writes when it cannot establish a commit's reasoning |

Every cell is legitimate. An `active` entry may carry `unknown`; a `superseded`
one may carry `confirmed` for what was true while it held. Reducing a mixed case
to one word never picks the stronger one.

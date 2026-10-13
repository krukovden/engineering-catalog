<!-- memory:unit project-workspace — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Project workspace

`project-workspace` (shared; qa, product and developers bundles) knows where every repository
lives on the machine and searches several of them at once, read-only. Self-contained Node
scripts under `skills/shared/project-workspace/scripts/`; `qa-ado-work-item`, `qa-triage`,
`ado-backlog-placement`, `onboard-project` and the developer skills call into it.

## Entries

### e-20261013-79fa A map of where repositories live, plus a separate reference store the catalog owns
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: f762bfff26b763455319eadfca6634958fdc2dd6
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-13

Two places instead of one clone folder. `~/.engineering-catalog/repos.json` maps every repository, keyed by its normalised `origin` URL, to the working copies already on the machine (`paths`, grown by `register` from every catalog skill that runs in a repository and by one `setup` scan of the working folder), an optional board and a store copy. The reference store `<referenceRoot>/<org>/<project>/<repo>` holds the copies the catalog downloads itself, on demand and only after a yes, never a whole project at once (a project can hold 50+ repositories). The org/project levels keep two organisations or projects with the same repository name apart. The store and the working folder are required to be different folders, and a store copy is never a mapped working copy or inside or around one (cd0c1a3, 3ebcc94), so a reset in the store cannot reach anyone's work. Non-developer flows only read; a developer's working copy is only ever fetched, merging stays with `git-sync` on request. The alternative was the earlier `qa-ado-work-item` layout, `QA-Workspaces\<alias>\` cloned and pulled per context: Windows only, one context at a time, and a developer who already had a clone would get a second one. CRAP's multi-workspace and cross-repository federation were checked and not reused: the first is several areas inside one repository, the second exposes only blueprint markdown through Claude-only hooks. One idea was taken from it: resolve a repository by explicit path, then a known location, then the managed store. Credentials stay with [[azure-devops-access]]; neither file holds one.

### e-20261013-06bf Search reads origin/<default> from the object database; fetch uses an explicit tracking-only refspec on the URL
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: a9ba01215078cc8caf0216bdddd934dbf65bdd7f
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-13

Search runs `git grep` and `git log --grep`/`-S` against `refs/remotes/origin/<default>`, never the working tree. A fetch touches neither files nor the checked-out branch, so a developer's existing working copy can be searched at the server's latest version without a second clone and without disturbing a branch, an index or unsaved work. The cost is that a search never sees uncommitted or unpushed local code. The ref is passed by its full name because a local branch called `origin/<x>` would shadow the short one (cd0c1a3). The fetch goes to the configured URL rather than the remote name, with `+refs/heads/*:refs/remotes/origin/*` on the command line: fetching by remote name also applies `remote.origin.fetch`, which a working copy can configure to write local branches, and the URL form writes nothing outside `refs/remotes/origin/*`. Fetches are throttled to one per repository per 10 minutes (`--fresh` overrides); offline, the copy already present is searched and its age reported.

### e-20261013-915c A store copy is reset only after reset-consent, and any failed inspection counts as local work
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 0345f89ca06f7d1242e2507c54d1c85806f126d0
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-13

A store copy sits detached at `origin/<default>` with no local branches. Before moving it, `ensure` inspects it; local changes, untracked and ignored files (listed to the person, cd0c1a3) or unpushed commits return `needs: reset-consent`, and only `--reset` after a yes discards them. When `git status` or the unpushed-commit count itself fails, the copy is treated as holding local work rather than as clean: a failed inspection proves nothing is safe to discard, so the check fails closed. The cost is an extra question when git misbehaves; the alternative silently threw away work it could not see. The containment check that keeps a store copy apart from working copies is re-run under the map lock and the lock held through the change (a9ba012), because a registration can land during the fetch.

### e-20261013-3b26 Scripts never prompt; every decision comes back as needs + ask + options + then
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: 7bacf18754918d82bc6393e36bc09fc699c59caf
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-13

The people this skill serves, testers and product owners, never type commands; they talk to the model. So `workspace.js` never reads stdin. Every command prints one JSON object, and a decision the person must make returns exit 0 with `needs` (setup, move-qa-workspaces, which-repos, which-project, repo-link, clone-consent, reset-consent, board-choice), `ask` (the question already in plain words), `options` and `then` (the exact command to run after a yes). `SKILL.md` tells the model to ask one question at a time and never show script names, flags, refs or JSON. The alternative, interactive prompts or the model composing its own questions, either hangs a non-interactive tool call or lets the wording and the follow-up command drift run to run. Moving earlier `QA-Workspaces` clones into the store was first done as a side effect of `setup` and became its own `needs: move-qa-workspaces` decision for the same reason.

### e-20261013-5922 qa-ado-work-item stops pulling; the QA-Workspaces scripts stay one release as a fallback
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: a420513552a9c70605868e83544f72cfebaf4d8e
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-10-13

`qa-ado-work-item` ([[azure-devops-access]]) requires `project-workspace`, and its step 1 no longer refreshes or pulls any repository: step 2's search reads the server's latest version and changes no checkout, so the step's completion criterion became "context chosen, nothing modified", and the safety rule changed from "repository sync happens freely" to "discovery never changes a checkout". `setup-workspace.ps1` and `sync-context.ps1` are kept for one release, printing that `project-workspace` replaces them, and `sync-context.ps1` runs only when `project-workspace` is not installed. Removing them at once would break testers whose installs predate the new skill; keeping them indefinitely would leave two ways to get code onto the machine. A context's `repositories` field is now a hint for which repositories to search first, not the only place code may live.

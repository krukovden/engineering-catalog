<!-- memory:unit catalog-validation — the chain of this piece of functionality. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Catalog validation

`lib/frontmatter.js` parses the one-level YAML subset the units use; `lib/units.js` loads
skills, agents, workflows and bundles, scans the folders and computes each unit's content
version; `lib/checks.js` enforces the invariants of DESIGN.md §11 — unique names,
resolvable `requires:` / `skills:` / `steps:` / bundle names, transitive bundle closure
(through agents' skills and workflow steps), the machine-checked `shared` rule, secret
patterns and skill self-containment. `npm run build` refuses to write on any error.

## Entries

This predates tracking; history before 2026-09-15 is not recorded.

# Branch-policy template for `main`

One-time setup only. The user runs these commands themselves; `ado-pull-request` never
creates policies or pipeline YAML on its own.

The commands below were checked against `az repos policy ... create --help` on
2026-10-12. Anything marked **verify** uses a real flag, but the right value depends on
the repository or the organisation.

## Recommended policies

### Linked work items required

```sh
az repos policy work-item-linking create \
  --org "<org-url>" \
  --project "<project>" \
  --repository-id "<repository-id>" \
  --branch main \
  --branch-match-type exact \
  --blocking true \
  --enabled true
```

### Build validation

Use the PR-validation pipeline that runs AI review and the full test suite for PRs into
`main`.

```sh
az repos policy build create \
  --org "<org-url>" \
  --project "<project>" \
  --repository-id "<repository-id>" \
  --branch main \
  --branch-match-type exact \
  --blocking true \
  --enabled true \
  --build-definition-id "<pr-validation-build-definition-id>" \
  --display-name "PR validation — AI review + full test suite" \
  --manual-queue-only false \
  --queue-on-source-update-only true \
  --valid-duration 0
```

**Verify:** the build definition id, the display name, and whether `--valid-duration 0`
in this Azure DevOps org is the same setting as "Build expiration: immediately when main
is updated".

### All comments resolved

```sh
az repos policy comment-required create \
  --org "<org-url>" \
  --project "<project>" \
  --repository-id "<repository-id>" \
  --branch main \
  --branch-match-type exact \
  --blocking true \
  --enabled true
```

### Squash only

```sh
az repos policy merge-strategy create \
  --org "<org-url>" \
  --project "<project>" \
  --repository-id "<repository-id>" \
  --branch main \
  --branch-match-type exact \
  --blocking true \
  --enabled true \
  --allow-no-fast-forward false \
  --allow-rebase false \
  --allow-rebase-merge false \
  --allow-squash true
```

### Votes reset on push + minimum reviewers

Azure DevOps carries both settings on the approver-count policy.

```sh
az repos policy approver-count create \
  --org "<org-url>" \
  --project "<project>" \
  --repository-id "<repository-id>" \
  --branch main \
  --branch-match-type exact \
  --blocking true \
  --enabled true \
  --minimum-approver-count 2 \
  --creator-vote-counts false \
  --allow-downvotes true \
  --reset-on-source-push true
```

**Verify:** the minimum reviewer count. `2` is a common default, not a universal one.

## Product-repository pipeline shape

The catalog does not write pipeline YAML. A product repository extends the
organisation's shared templates and then points the `main` branch policy at the PR
validation pipeline that template produces.

Example:

```yaml
resources:
  repositories:
    - repository: pipeline_templates
      type: git
      name: Shared/pipeline_templates
      ref: refs/heads/main

extends:
  template: pipelines/pr-main.yml@pipeline_templates
  parameters:
    enableAiReview: true
    runFullTestSuite: true
```

**Verify:** the template path and parameter names in `pipeline_templates`; this
snippet shows the shape (`resources.repositories` + `extends`), not a claimed filename.

Recommended split:

- **PR validation pipeline** — runs AI review and the full test suite for PRs into
  `main`; the build-validation policy above gates merges through it.
- **Build pipeline** — produces the artifact and stores it both in blob and as pipeline
  artifacts so the exact built version survives the run in two ordinary Azure DevOps
  retrieval paths.
- **Deploy pipeline** — deploys any stored version forward or backward; keep it separate
  from build so release choice and build execution stay decoupled.

# PR dashboard and merge status

Use this mode when the user asks for "my PRs", "what can merge", "what needs my vote",
or "why can't PR 123 merge?".

## Dashboard

1. List active PRs I created:

   ```sh
   az repos pr list --creator --status active -o json
   ```

2. List active PRs where I am a reviewer:

   ```sh
   az repos pr list --reviewer --status active -o json
   ```

3. Combine and dedupe by `pullRequestId`. Tag each PR as `mine`, `needs my vote`, or
   both.
4. For each PR you will report, read its policy state:

   ```sh
   az repos pr policy list --id <pull-request-id> -o json
   ```

## Buckets

- **Merge ready** — nothing in the policy list is failed, rejected or still pending.
- **Needs attention** — at least one policy failed or was rejected, unresolved comments
  are blocking, or the next action is on me now (for example: I still owe the review).
- **Waiting** — policies are still running, or the next action is on somebody else.

Report each PR with:

- `pullRequestId` and title;
- bucket;
- whether it is `mine`, `needs my vote`, or both;
- one line on why it sits in that bucket.

## One PR: why it cannot merge

Run:

```sh
az repos pr policy list --id <pull-request-id> -o json
```

Name the blocking policy evaluations directly from the output, say whether each one is
failed vs waiting, and state the next action that would clear it. If the policy output is
ambiguous, say so instead of guessing.

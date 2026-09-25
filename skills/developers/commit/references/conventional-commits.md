# Conventional commits — the fallback format

Use this only when the repository's own history shows no convention. A repository that
has one wins, even when it differs from everything below.

```text
<type>(<scope>): <subject>

<body>
```

## Type

| Type | For |
|---|---|
| `feat` | behaviour a user of the code can now rely on |
| `fix` | a defect that no longer happens |
| `docs` | documentation only |
| `test` | tests only |
| `refactor` | same behaviour, different structure |
| `ci` | pipelines and build configuration |
| `chore` | housekeeping that fits nowhere above |

One commit, one type. A change that needs two types is two commits.

## Scope

Optional. The module, package or component the change lives in: `fix(export): …`. Leave
it out when the change cuts across the repository.

## Subject

- Lowercase after the colon, no trailing period.
- At most 72 characters including the prefix.
- Says what changed in behaviour, not what the author did.

## Body

Optional. A blank line after the subject, then plain sentences wrapped at about 72
characters. It answers why: the reason for the approach, what it replaces, how the
problem was found. What changed is already in the diff.

## Good

```text
fix(export): stream files over 10 MB

The exporter buffered the whole file in memory, and the request timed out
past 10 MB. It now writes to the response as it reads.
```

```text
feat(search): filter the well list by field and status
```

## Bad

```text
Updated files
```

No type, and it says nothing the reader could not guess.

```text
fix: Fixed the bug with the export that we discussed, also renamed some variables and bumped deps.
```

Past tense, a capital letter, a trailing period, a reference to a conversation the reader
never saw, and three changes in one commit.

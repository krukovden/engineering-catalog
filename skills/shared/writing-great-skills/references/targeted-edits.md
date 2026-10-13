# Targeted Edits of User-Owned Files

When helper scripts or skill automation edit configuration files that the user or project also owns (such as `.claude/settings.json`, `.copilot/config.json`, `ado-credentials` config, or repository YAML manifests), edits must be surgical and non-destructive.

## The Problem with Wholesale Serialization

Standard parse-mutate-serialize patterns (`JSON.parse` → mutate object → `JSON.stringify`, or YAML `load` → mutate → `dump`):
- Strip comments and formatting from JSONC and YAML files.
- Reorder keys and alter indentation styles.
- Create noisy, unreadable git diffs across unrelated sections.

Wholesale serialization must never be used on files the user or project owns.

## Targeted Field Rewrites for JSON/JSONC

Use targeted string replacement anchored to the enclosing key rather than parsing the full document:

1. Locate the specific section or parent key enclosing the target field.
2. Replace only the targeted value using a regex anchored to that key.
3. Preserve surrounding whitespace, indentation, and comments.

## AST Round-Trips for YAML

When modifying structured YAML files:
- Use an AST-preserving mutator that parses YAML nodes into an Abstract Syntax Tree.
- Mutate the specific node in place.
- Serialize back preserving existing comment nodes, formatting, and key order.

## The Single-Match Invariant

Every targeted edit must assert that the newly written value appears exactly once:

- **Zero matches**: The anchor failed to find the target field; the edit was not applied.
- **Multiple matches**: The replacement pattern was ambiguous and inadvertently modified sibling keys.
- **Action on failure**: If the post-edit check does not yield exactly one match, immediately restore the file from backup and exit non-zero.

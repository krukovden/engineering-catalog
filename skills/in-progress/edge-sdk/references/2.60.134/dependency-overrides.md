# Edge-SDK 2.60.134 — Dependency Overrides

Edge-sdk 2.60.134 ships with severely outdated transitive dependencies. The project overrides them via `package.json` `overrides` and related fields. **These must be maintained manually when edge-sdk updates.**

## In `TSS-SDK/package.json`

| Dependency | Edge-SDK Ships | Overridden To | Why |
|-----------|---------------|---------------|-----|
| axios | 0.21.4 | ~1.13.2 | CVEs in 0.x |
| jsonwebtoken | 8.5.1 | ~9.0.2 | CVEs |
| express | 4.18.2 | ~4.21.2 | CVEs |
| mongoose | 6.7.2 | ~8.20.2 | Major version + CVEs |
| @grpc/grpc-js | 1.5.9 | ~1.14.2 | Compat |
| protobufjs | 6.11.3 | ~7.4.0 | CVEs |
| ws | — | ~8.18.3 | CVEs |
| socket.io (scoped) | 4.3.0 | ~4.8.3 | Under `@hds/edge-sdk` scope |

## In all VM services (vmbe, vm-insite, vm-logger)

| Dependency | Overridden To | Why |
|-----------|---------------|-----|
| `path-to-regexp` (scoped under `@hds/edge-sdk`) | ~0.1.12 | ReDoS CVE |

## RxJS Version Mismatch (not overridden)

Edge-sdk 2.60.134 ships with `rxjs 6.5.4`, but the project uses `rxjs 7.8.x`. Can cause subtle Observable-interop issues when using edge-sdk streams directly.

**Workaround**: always access streams through TSS-SDK wrappers, never raw edge-sdk observables.

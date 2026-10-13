---
name: edge-sdk
description: Use when working with @hds/edge-sdk (LOGIX Rigsite Integration SDK) or @tss/tss-sdk wrapper services in vmbe, vm-logger-microservice, or vm-insite-microservice. Covers package architecture, structural invariants (error-swallowing historian, dual-instance risk, wcEdge-only environment), and version-specific API references for the installed 2.60.134.
---

# Edge SDK Reference

Use when working with `@hds/edge-sdk` (LOGIX™ Rigsite Integration SDK) or `@tss/tss-sdk` services that wrap it.

## Package Info

- **Package**: `@hds/edge-sdk`
- **Direct consumer**: `@tss/tss-sdk` (TSS-SDK) — the ONLY direct dependency
- **Indirect consumers**: vmbe, vm-logger-microservice, vm-insite-microservice (via `@tss/tss-sdk`)
- **vmui**: No edge-sdk usage (frontend)
- **Docs portal**: https://ambitious-tree-03e52b010.4.azurestaticapps.net/docs/category/edge-sdk-nodejs

## Installed Version

**Current: `2.60.134`** — detailed, version-specific content lives under `references/2.60.134/`.

When `@hds/edge-sdk` is upgraded, fork the folder:

```bash
cp -r references/2.60.134 references/<new-version>
```

Edit the new folder to reflect API changes, then update the version pointer above. The base content in this file stays — only the version number and the "Version-Specific Detail" table rows below change.

## Architecture: How Edge-SDK Flows Through the Stack

```
@hds/edge-sdk
  └── @tss/tss-sdk (TSS-SDK wraps it)
        └── TssSDK class → ServiceProvider → lazy-initialized services
              ├── vmbe (NestJS main backend)
              ├── vm-logger-microservice
              └── vm-insite-microservice
```

**Key files** (stable across edge-sdk versions):
- `TSS-SDK/src/services/tss-sdk.ts` — entry point
- `TSS-SDK/src/services/service-provider.ts` — lazy getters for all services
- `TSS-SDK/src/interfaces/extended-edge-sdk-config.ts` — `ExtendedEdgeSDKConfig`

### TssSDK Constructor

```typescript
// EdgeSDK param is OPTIONAL — exists to avoid dual MongoDB/MQTT connections
// during migration. If omitted, TSS-SDK creates its own EdgeSDK instance.
const sdk = new TssSDK(config: ExtendedEdgeSDKConfig, edgeSDK?: EdgeSDK);
```

Access pattern in consumers: `tssSDK.serviceProvider.<serviceName>`.

## Structural Invariants

These hold regardless of edge-sdk version — they're how the SDK is shaped, not what's in it. Keep them in mind before reaching for version-specific docs.

1. **Historian swallows errors.** Edge-sdk historian methods catch errors internally and return `undefined`. Standard `try/catch` catches nothing, and retry predicates based on error types never fire. Always call the wrapped `tssSDK.serviceProvider.insiteService` — it implements undefined-based retry. Never wrap raw `edgeSDK.historian` in error-classifying retry.

2. **Dual-instance risk.** If `TssSDK` is constructed without passing an existing `EdgeSDK`, it creates its own → duplicate MongoDB / MQTT / RabbitMQ connections. Always pass the existing instance if the consuming app already has one.

3. **Only `'wcEdge'` environment supported.** `ServiceProvider`'s switch statement throws `'Unknown environment'` for any other value of `config.environmentServer`. No other factories exist.

4. **Access via the wrapper, not the raw SDK.** Every `edgeSDK.<service>` call in VM services should go through `tssSDK.serviceProvider.<wrapper>`. The wrapper layer is where retry, tracing, re-exports, and undefined-handling live. Exactly one direct `@hds/edge-sdk` import exists in vmbe (health-check); it's a known exception, not a pattern to copy.

## Version-Specific Detail

All API surface, config shapes, and version-annotated behavior for the currently installed edge-sdk live under `references/<version>/`. For `2.60.134`:

| Looking for | File |
|-------------|------|
| Which services exist on `ServiceProvider`, what they wrap, deprecated getters | `references/2.60.134/services.md` |
| `ExtendedEdgeSDKConfig` props, env vars, connection examples | `references/2.60.134/config.md` |
| Import paths, re-exports, known direct-import exceptions | `references/2.60.134/imports.md` |
| Historian API methods with `v1.x` availability annotations | `references/2.60.134/historian.md` |
| Capabilities reference (features list, notable version changes) | `references/2.60.134/capabilities.md` |
| Transitive dependency override map (CVE fixes) | `references/2.60.134/dependency-overrides.md` |
| Known issues, gaps, deprecated APIs, quirks | `references/2.60.134/known-issues.md` |

**Rule of thumb for where new info goes:**
- Is it true across all edge-sdk versions? → this `SKILL.md` (Structural Invariants or Architecture).
- Does it name specific methods, properties, file paths inside `@hds/edge-sdk`, or exact dependency versions? → `references/<version>/`.

## Filling Gaps from the Live Docs Portal

The bundled `references/<version>/` files are curated, not exhaustive. When you need a detail they don't cover — a method signature, a config option, a behavior nuance — reach for the live Docs portal before guessing or reporting it as unknown:

https://ambitious-tree-03e52b010.4.azurestaticapps.net/docs/category/edge-sdk-nodejs

Two ways in, in order of preference:

1. **WebSearch** — fastest for "does edge-sdk expose X" questions. Search the API/feature name plus `edge-sdk`; the portal pages are indexed, and a snippet often answers it without loading a page.
2. **chrome-devtools MCP, headless** — when you need to read or scrape a specific portal page that search snippets don't fully cover, or walk the docs tree. Drive it headless and do not surface a visible browser window: the user isn't watching a screen, so a popped-up window is pure noise and interrupts their focus for no benefit. Navigate, extract the relevant text, and cite the page you took it from.

The portal is the source of truth for the installed version — when it contradicts a bundled reference, trust the portal and correct the reference. After confirming a detail this way, fold it back in so the next session doesn't re-fetch it: version-specific facts → `references/<version>/`, cross-version truths → this `SKILL.md` (per the rule of thumb above).

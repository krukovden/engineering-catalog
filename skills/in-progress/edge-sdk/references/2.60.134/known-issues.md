# Edge-SDK 2.60.134 — Known Issues, Gaps & Quirks

## Critical: Error Swallowing in Historian

**Severity**: High
**Affects**: All historian/InSite data queries

Edge-sdk historian methods catch errors internally and return `undefined` instead of throwing.
This makes standard error handling impossible:
- `try/catch` won't catch anything
- Error classification predicates (isTransientError) can't inspect the error
- Retry policies based on error types don't work

**Workaround**: TSS-SDK's `InsiteService` implements undefined-based retry internally.
Always use `insiteService` methods with retry options, never raw `edgeSDK.historian` directly.

**Source**: `TSS-SDK/src/misc/retry-policy/index.ts` (lines 10-14)

---

## Critical: Outdated Transitive Dependencies

**Severity**: High (security)
**Affects**: All consumers

Edge-sdk v2.60.134 ships with severely outdated dependencies:

| Package | Ships With | Current | CVEs |
|---------|-----------|---------|------|
| axios | 0.21.4 | 1.13.x | Multiple CVEs |
| mongoose | 6.7.2 | 8.x | Breaking changes + CVEs |
| express | 4.18.2 | 4.21.x | CVEs |
| jsonwebtoken | 8.5.1 | 9.x | CVEs |
| protobufjs | 6.11.3 | 7.x | CVEs |
| socket.io | 4.3.0 | 4.8.x | CVEs |
| @grpc/grpc-js | 1.5.9 | 1.14.x | Compat issues |
| path-to-regexp | (express dep) | — | ReDoS CVE |

**Workaround**: All overridden in `TSS-SDK/package.json` and VM service `package.json` files.
Must be maintained manually when edge-sdk updates. See `dependency-overrides.md` for exact map.

---

## Warning: Dual Instance Risk

**Severity**: Medium
**Affects**: Apps that create both `EdgeSDK` and `TssSDK`

`TssSDK` constructor accepts optional `EdgeSDK` parameter. If omitted, it creates its own.
Two instances = duplicate connections to MongoDB, MQTT, RabbitMQ.

**Source**: `TSS-SDK/src/services/tss-sdk.ts` (line 27 comment, line 33 constructor)

**Status**: Interim design. Will be removed when all projects migrate off direct edge-sdk.

---

## Warning: Only 'wcEdge' Environment Supported

**Severity**: Low
**Affects**: `ServiceProvider` initialization

`ServiceProvider` constructor has a switch statement that only handles `'wcEdge'`.
Any other value for `config.environmentServer` throws `'Unknown environment'`.

**Source**: `TSS-SDK/src/services/service-provider.ts` (lines 115-121)

---

## Warning: Deprecated APIs Still in Use

**Severity**: Low
**Affects**: Future upgrades

Several `ServiceProvider` getters are deprecated but still actively used:
- `uomStatefulService` → should use `uomServiceProvider`
- `uomEventsProvider` → should use `uomServiceProvider`
- `loggerService` → should use `tssLogger`
- `communicationService` → should use `websocketService`

Edge-sdk also has deprecated APIs:
- **Rig Activity**: `getActiveRigActivitySourceWithLastActivity`, `getActiveRigActivity`,
  `getActiveRigActivityBySource`, `getRigActivitySourceListWithLastActivity` (historical tracking disabled)
- **Alarm Management** → renamed to Alert Management in v1.7.0
- `IAuditLogManagement.injectLogs()` → use authorization methods instead

---

## Info: RxJS Version Mismatch

**Severity**: Low
**Affects**: Observable handling

Edge-sdk ships with `rxjs 6.5.4`, but the project uses `rxjs 7.8.x`.
This can cause subtle issues with Observable interop if using edge-sdk streams directly.

**Workaround**: Always access streams through TSS-SDK wrappers, not raw edge-sdk.

---

## Info: Direct Edge-SDK Import in vmbe

**Severity**: Low
**Affects**: `vmbe/src/services/health-check/health-check.service.ts`

One file directly imports from `@hds/edge-sdk` instead of through `@tss/tss-sdk`:
```typescript
import { IDataSourceBase } from '@hds/edge-sdk/models/dataSourceManagement/dataSourceObject';
```

Should ideally use TSS-SDK re-export to maintain the abstraction layer.

---

## Warning: Historian Delete Only Supports Numeric Types

**Severity**: Medium
**Affects**: InSite historian row deletion

Edge-sdk's `EdgeDeleteRecordRows` currently supports **numeric data types only**.
Non-numeric row deletion silently fails or produces incorrect results.

**Source**: Official docs — "Delete Rows" section

---

## Warning: Historical Data Persistence Requires RMQ Source

**Severity**: Medium
**Affects**: Historical data saving to MongoDB

"For data to save in MongoDB, the data should be coming from RMQ publisher."
Data from other sources (MQTT, direct API) will NOT be persisted to historical storage.

**Source**: Official docs — "Historical Data Service"

---

## Warning: InSite Real-Time Subscriptions Deprecated

**Severity**: Medium
**Affects**: `sdk.historian.subscribeToDataChange()`

InSite real-time subscription methods are deprecated from v1.8.0.
Use platform-level IoT modules instead.

---

## Info: RBAC v1 Widget-Group System Removed

**Severity**: Low
**Affects**: Code using `EDGE_AUTHORIZATION_GROUPNAME` env var

RBAC v1 (widget-group based) was deprecated in v1.7.0 and removed in v1.8.0.
If `EDGE_AUTHORIZATION_GROUPNAME` is set without the new auth system, the process may terminate.

Use `sdk.authManagementService.authorize()` (v1.7+ RBAC) instead.

---

## Info: @UserAuditLog Decorator Required for User Attribution

**Severity**: Low
**Affects**: Audit log entries

Without `@UserAuditLog()` decorator on controller methods, all audit logs use the
**system user ID** as the creator ID, not the actual user.

---

## Info: SDK Defaults to Swarm Endpoints

**Severity**: Low
**Affects**: Non-Docker / non-Swarm deployments

If custom host addresses are not provided in config, edge-sdk defaults to Docker Swarm
service names as endpoints. This silently fails in non-Swarm environments.

---

## Info: Transaction Timeout Increased in v1.8.0

**Severity**: Low
**Affects**: IoT Hub transaction operations

Default `submitTransaction` timeout was increased to 5 minutes in v1.8.0.
Long-running transactions may now block longer before failing.

---

## Gaps to Fill

<!-- Add entries below as issues are discovered -->

### [Template]
**Date**: YYYY-MM-DD
**Severity**: Critical/High/Medium/Low
**Affects**: <what breaks>
**Description**: <what happens>
**Workaround**: <if any>
**Status**: Open / Resolved in <version>

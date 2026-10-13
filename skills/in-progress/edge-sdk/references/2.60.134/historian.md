# Edge-SDK 2.60.134 — Historian API

Edge-sdk's historian is accessed via `sdk.historian` (raw) or `tssSDK.serviceProvider.insiteService` (wrapped).

**Always use the wrapped `insiteService`.** Raw historian methods catch errors internally and return `undefined` — you cannot apply standard error-based retry. The `insiteService` wrapper implements undefined-based retry that works around this. See `known-issues.md` → "Error Swallowing in Historian".

## Data Query Methods

| Method | Purpose | Version |
|--------|---------|---------|
| `getRecordRows` | Query record rows | v1.0+ |
| `getRecordRowsV2` | Paginated query (`count`/`offset`) | v1.7+ |
| `getRecordRowsByDepthV2` | Paginated depth-based query | v1.7+ |
| `getRecordRowsByTimeV2` | Paginated time-based query | v1.7+ |
| `getVariables(getVariableForConfiguredRecords?)` | Get variables | v1.7.3+ |
| `getRunsInformation()` | Get run info | v1.7.2+ |
| `getActiveWellInfo()` | Returns `{ activeWell, activeRun }` | v1.6+ |
| `getInsiteRecordsTreeByWellRun` | Well run tree retrieval | v1.7+ |

## Data Change Notifications (DCN)

| Method | Purpose |
|--------|---------|
| `subscribeToDataChangeNotification(info, callback)` | Register for DCN |
| `unsubscribeFromDataChangeNotification(subscriptionId)` | Remove DCN |
| `cancelDataChangeNotificationSubscription` | Cancel DCN (v1.7+) |
| `getAllActiveDataChangeNotification` | List active DCNs |

## Historical Persistence V2 (v1.8.0+)

| Method | Purpose |
|--------|---------|
| `getDepthBasedVariablesHistoricalData` | Depth-based historical data |
| `getTimeBasedVariablesHistoricalData` | Time-based historical data |
| `getAllConfigs` / `getMultipleConfigs` | Get persistence configs |
| `setMultipleConfigs` / `deleteConfig` | Manage configs |

Configured via `dataManagerUrl` property in config.

## Delete Rows Limitation

`EdgeDeleteRecordRows` supports **numeric data types only**. Non-numeric row deletion silently fails or produces incorrect results.

## Historical Data Persistence Source Requirement

For data to save in MongoDB, the data must come from the **RMQ publisher**. Data from other sources (MQTT, direct API) will not be persisted to historical storage.

## InSite Real-Time Subscriptions Deprecated

`sdk.historian.subscribeToDataChange()` and friends are deprecated from v1.8.0. Use platform-level IoT modules instead.

## Retry-Aware Usage Example

```typescript
// ❌ DON'T — historian swallows errors, retry predicate never fires:
await executeWithRetry(() => historian.queryData(), { isRetryable: isTransientError });

// ✅ DO — wrapper implements undefined-based retry:
const result = await insiteService.getLastRow(...params, { enabled: true });
```

# Edge-SDK 2.60.134 — Services via ServiceProvider

Access pattern: `tssSDK.serviceProvider.<serviceName>`

## Service Table

| Service | Getter | Edge-SDK Underlying | Usage Count |
|---------|--------|---------------------|-------------|
| Historian/InSite | `insiteService` | `edgeSDK.historian` | 28 files |
| IoT Hub | `iotHubService` | `edgeSDK.iotHubService` | 25 files |
| Auth | `authService` | `edgeSDK.authManagementService` | 14 files |
| Alerts | `alertManagementService` | `edgeSDK.alertManagement` | 9 files |
| Data Sources | `dataSourcesService` | `edgeSDK.dataSourceManagement` | Via insiteService |
| RabbitMQ | `rmqService` | `edgeSDK.serviceProvider` | Messaging |
| MQTT | `mqttService` | `edgeSDK.serviceProvider` | Service comms |
| MongoDB | `mongoDBService` | `edgeSDK.serviceProvider` | Direct DB access |
| Redis (global) | `globalRedisProvider` | TSS-SDK native (ioredis) | State/messaging |
| Redis (tenant) | `tenantRedisProvider` | TSS-SDK native (ioredis) | Scoped state |
| WebSocket | `websocketService` | `edgeSDK.serviceProvider` | Real-time |
| Logger | `tssLogger` | TSS-SDK native (winston) | All services |
| Metrics | `metricsService` | TSS-SDK native (OpenTelemetry) | All services |
| Connectors | `connectorsService` | `edgeSDK.iotHubService` | IoT modules |
| UOM | `uomServiceProvider` | API + RMQ | Unit management |
| State | `stateServices` | Redis-backed | VM shared state |
| Messaging | `messagingChannelsFactory` | Redis pub/sub | Domain events |

## Deprecated Getters

Still present in ServiceProvider but should not be used in new code:

- `uomStatefulService` → use `uomServiceProvider`
- `uomEventsProvider` → use `uomServiceProvider`
- `loggerService` → use `tssLogger`
- `communicationService` → use `websocketService`

## Factory / Wrapper Chain

ServiceProvider lazily creates each service via `WcEdgeServiceFactory`. The factory wraps the raw `edgeSDK.<service>` method — the wrapper is where retry, tracing, and undefined-based error handling live.

```
TSS-SDK/src/services/wcEdge/wc-edge-factory/wc-edge-service-factory.ts  // Factory
TSS-SDK/src/services/wcEdge/insite-service/insite-service.ts            // Historian wrapper
TSS-SDK/src/services/wcEdge/auth-service/auth-service.ts                // Auth wrapper
TSS-SDK/src/services/wcEdge/rmq-service/rmq-service.ts                  // RabbitMQ wrapper
TSS-SDK/src/services/wcEdge/iot-hub-service/iot-hub-service.ts          // IoT wrapper
TSS-SDK/src/services/wcEdge/data-sources-service/data-sources-service.ts // Data sources
TSS-SDK/src/services/wcEdge/alert-management/alert-management-service.ts // Alerts
```

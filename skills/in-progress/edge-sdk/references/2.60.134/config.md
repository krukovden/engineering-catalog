# Edge-SDK 2.60.134 — Configuration

Type: `ExtendedEdgeSDKConfig` (TSS-SDK), which extends `EdgeSDKConfig` from edge-sdk.

Source: `TSS-SDK/src/interfaces/extended-edge-sdk-config.ts`

## Edge-SDK Base (`EdgeSDKConfig`)

```typescript
{
  edgeApiHost?, edgeApiPort?, edgeApiSecure?,    // API connectivity
  edgeMqttHost?, edgeMqttPort?,                   // MQTT broker
  edgeIoTHost?, iotMiddlewareHost?,               // IoT management
  edgeAuthorizationHost?,                          // Auth service
  alertsOrchestratorHost?,                         // Alerts
  mongoConnection?, mongoDbName?,                  // Database
  rabbitConnection?,                               // Message queue
  secure?, caFile?, certFile?, keyFile?,           // TLS
  edgeConsulHost?,                                 // Service discovery
  logLevel?, solutionName?, disableStreaming?
}
```

## TSS-SDK Extensions

```typescript
{
  environmentServer?: string,    // Must be 'wcEdge' (only supported value)
  applicationId?, applicationName?, mongoDBName?,
  redisConfig?: { connectionOptions, keyOptions },
  rabbitMqConfig?: { channelName, subscriberConfig, publisherConfig },
  connectorsConfig?: ConnectorsConfig,
  tssMetricsConfig?: MetricsConfig,
  loggerConfig?: TssLoggerConfig,
  applicationRoles?: string[],
  debugUsername?, debugPassword?,      // Dev-only auth bypass
  edgeApiAddress?, opcExplorerUrl?, timeServerUrl?,
  uomsConfig?: { changeDetectionInterval? }
}
```

## Environment Variables

Edge-sdk reads these automatically — no need to pipe them through config:

```
EDGE_API_HOST, EDGE_API_PORT, EDGE_API_SECURE
EDGE_MQTT_HOST, EDGE_MQTT_PORT
EDGE_IOT_HOST, EDGE_IOT_PORT
EDGE_TLS_CA_FILE, EDGE_TLS_CERT_FILE, EDGE_TLS_KEY_FILE
CONFIG_PATH (path to config.json)
```

## Connection Patterns

| Infrastructure | Config Key | Example |
|---------------|-----------|---------|
| MongoDB | `mongoConnection` | `mongodb://user:pass@mongo:27017` |
| RabbitMQ | `rabbitConnection` | `amqp://edge:Landmark1@rabbitmq/edge` |
| MQTT | `EDGE_MQTT_HOST` + port | `host:8883` (secure) |
| gRPC | `rigActivityGRPCServer` | `edge_rig-activity-service:50052` |
| TLS | `EDGE_TLS_CA_FILE`, `_CERT_`, `_KEY_` | Certificate file paths |

## Gotcha: Default Swarm Endpoints

If custom host addresses are not provided, edge-sdk defaults to Docker Swarm service names (e.g., `edge_mongo`). These silently fail in non-Swarm environments. Always provide explicit hosts in dev/test.

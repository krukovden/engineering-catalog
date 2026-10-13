# Edge-SDK 2.60.134 — Capabilities Reference

From official docs version 1.8.0 (last updated August 14, 2025).
Source: https://ambitious-tree-03e52b010.4.azurestaticapps.net/docs/category/edge-sdk-nodejs

| Capability | Description |
|-----------|-------------|
| Telemetry Subscription | Real-time tags from IoT gateway, RabbitMQ, MQTT sources |
| InSite Historian Stream | Subscribe to record descriptors, get notified on new rows |
| InSite Historian Query | Query by depth, time, last rows; pagination via V2 APIs |
| Service-to-Service Pub/Sub | MQTT topic-based messaging between services |
| IoT Management | Create/validate/monitor IoT modules from iot-config files |
| IoT Hub | CRUD for IoT modules with transaction syntax |
| Data Source Management | Subscribe to add/update/delete events via RabbitMQ |
| Alert Management | Create/update/query alerts (replaced deprecated Alarm Management) |
| User Management & RBAC | User CRUD, role-based access control, Express middleware |
| Audit Logging | Activity logs with `@UserAuditLog()` decorator |
| Consul | Service registration and health checks |
| Rig Activity | gRPC-based rig activity source/consumer (partially deprecated) |

## Notable Version Changes Visible in 2.60.134

- **v1.8.0 docs**: Historical Persistence V2 (see `historian.md`), `submitTransaction` default timeout increased to 5 minutes, InSite real-time subscriptions deprecated, RBAC v1 widget-group system removed
- **v1.7.0**: Alarm Management renamed to Alert Management, RBAC v2 introduced (`authManagementService.authorize()`)
- **v1.6+**: `getActiveWellInfo()` available

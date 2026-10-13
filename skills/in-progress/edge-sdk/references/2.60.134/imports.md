# Edge-SDK 2.60.134 — Import Patterns

## From edge-sdk (only in TSS-SDK code)

```typescript
import EdgeSDK from '@hds/edge-sdk';                    // Default import
import { EdgeSDK, Logger } from '@hds/edge-sdk';        // Named
import { IEdgeHistorianData } from '@hds/edge-sdk/historian';
import { UserDto } from '@hds/edge-sdk/models/auth/user.dto';
import { IRabbitMQSetting } from '@hds/edge-sdk/models/common/rabbit-mq.config.model';
import { IDataSourceBase } from '@hds/edge-sdk/models/dataSourceManagement/dataSourceObject';
```

## From TSS-SDK (in VM services)

```typescript
import { TssSDK } from '@tss/tss-sdk';

// Re-exported edge types:
import {
  IEdgeHistorianData,
  UserDto,
  // ...
} from '@tss/tss-sdk/interfaces/re-exported/edge.interfaces';
```

VM services should import edge types via `@tss/tss-sdk/interfaces/re-exported/edge.interfaces` — never directly from `@hds/edge-sdk`. The re-export layer is how TSS-SDK isolates consumers from edge-sdk version drift.

## Known Exception: Direct Edge-SDK Import in vmbe

```typescript
// vmbe/src/services/health-check/health-check.service.ts
import { IDataSourceBase } from '@hds/edge-sdk/models/dataSourceManagement/dataSourceObject';
```

This is the only direct `@hds/edge-sdk` import in vmbe. Should be migrated to the TSS-SDK re-export when touched.

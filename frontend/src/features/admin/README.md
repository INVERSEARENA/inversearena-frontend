# Admin Feature Module

This module contains all admin dashboard functionality, organized according to the feature-based architecture.

## Structure

```
features/admin/
├── api/              # API functions for admin operations
│   └── adminApi.ts
├── components/       # React components for admin UI
│   ├── AdminTabs.tsx
│   ├── ArenaManagementPanel.tsx
│   ├── MetricsOverview.tsx
│   ├── SystemHealthPanel.tsx
│   └── index.ts
├── hooks/           # Custom React hooks
│   ├── useAdminMetrics.ts
│   ├── useArenaManagement.ts
│   ├── useSystemHealth.ts
│   └── index.ts
├── data/            # Mock data for development
│   └── mockAdminData.ts
├── __tests__/       # Unit and integration tests
│   ├── ArenaManagementPanel.test.tsx
│   ├── MetricsOverview.test.tsx
│   └── useAdminMetrics.test.ts
├── types.ts         # TypeScript type definitions
├── index.ts         # Public API exports
└── README.md        # This file
```

## Usage

Import from the feature module:

```typescript
import {
  // Components
  MetricsOverview,
  ArenaManagementPanel,
  SystemHealthPanel,
  AdminTabs,
  // Hooks
  useAdminMetrics,
  useArenaManagement,
  useSystemHealth,
  // Types
  type AdminMetrics,
  type ArenaConfig,
  // API
  fetchAdminMetrics,
} from "@/features/admin";
```

## Components

### MetricsOverview
Displays key platform metrics (arenas, players, volume, fees).

**Props:**
- `metrics: AdminMetrics` - Platform metrics data

### ArenaManagementPanel
Manages arena configurations (pause, activate, edit).

**Props:**
- `arenas: ArenaConfig[]` - List of arenas
- `onUpdateArena: (id: string, config: Partial<ArenaConfig>) => Promise<void>`

### SystemHealthPanel
Displays system health metrics (CPU, memory, network).

**Props:**
- `health: SystemHealth` - System health data

### AdminTabs
Tab navigation for admin dashboard sections.

**Props:**
- `activeTab: AdminTab` - Currently active tab
- `onTabChange: (tab: AdminTab) => void` - Tab change handler

## Hooks

### useAdminMetrics()
Fetches and manages admin metrics.

**Returns:**
- `metrics: AdminMetrics | null`
- `isLoading: boolean`
- `error: Error | null`
- `refetch: () => Promise<void>`

### useArenaManagement()
Manages arena CRUD operations.

**Returns:**
- `arenas: ArenaConfig[]`
- `isLoading: boolean`
- `error: Error | null`
- `refetch: () => Promise<void>`
- `updateArena: (id: string, config: Partial<ArenaConfig>) => Promise<ArenaConfig>`

### useSystemHealth(pollingInterval?: number)
Monitors system health with optional polling.

**Parameters:**
- `pollingInterval?: number` - Polling interval in ms (default: 30000)

**Returns:**
- `health: SystemHealth | null`
- `isLoading: boolean`
- `error: Error | null`
- `refetch: () => Promise<void>`

## API Functions

All API functions are in `api/adminApi.ts`:

- `fetchAdminMetrics(): Promise<AdminMetrics>`
- `fetchArenas(): Promise<ArenaConfig[]>`
- `updateArenaConfig(id, config): Promise<ArenaConfig>`
- `fetchUsers(): Promise<UserManagement[]>`
- `updateUserStatus(userId, status): Promise<UserManagement>`
- `fetchSystemHealth(): Promise<SystemHealth>`
- `fetchTransactions(limit): Promise<Transaction[]>`
- `fetchGovernanceProposals(): Promise<GovernanceProposal[]>`
- `createModerationAction(action): Promise<ModerationAction>`

## Testing

Run tests with:

```bash
npm test -- features/admin
```

Test coverage includes:
- Component rendering
- User interactions
- Hook behavior
- API error handling
- Edge cases

## Development

Use mock data from `data/mockAdminData.ts` for development without backend:

```typescript
import { mockAdminMetrics, mockArenas } from "@/features/admin/data/mockAdminData";
```

## Import Boundaries

This module follows these import rules:
- ✅ Can import from `@/shared-d` (shared utilities)
- ✅ Can import from `@/components/ui` (UI components)
- ❌ Cannot import from other features
- ❌ Cannot be imported by non-route files outside this feature

## Future Enhancements

Planned additions:
- User management panel
- Transaction monitoring
- Governance proposals interface
- Moderation tools
- Analytics dashboard
- Real-time notifications
- Audit log viewer

# Creator Operations Console

The Creator Operations Console provides an authenticated, ownership-scoped dashboard for arena hosts to manage the end-to-end operational lifecycle and recovery of their arenas without relying on manual raw transactions or admin tooling.

## Core Capabilities

1. **State Categorization**:
   Distinguishes typed arena states:
   - `waiting`: Lobby filling, awaiting players or deployment confirmation.
   - `actionable`: Minimum players met, game ready to start, or round ready for settlement.
   - `blocked`: Active round in progress or waiting on players.
   - `degraded`: Deployment unconfirmed or orphaned transaction requiring recovery.
   - `terminal`: Arena settled or cancelled.

2. **Preflight Guard**:
   Every lifecycle mutation (`start`, `cancel`, `retry_confirmation`, `settle`) executes a preflight check immediately before signing, confirming ownership, network alignment, and current contract state to prevent conflicting actions.

3. **Deterministic Post-Transaction Reconciliation**:
   Actions reconcile local state with on-chain records and update metrics (`creator_action_outcomes_total`, `creator_state_conflicts_total`).

## Endpoints

- `GET /api/creator/arenas`: Paginated list of creator-owned arenas with keyset pagination.
- `POST /api/creator/arenas/:id/preflight`: Preflight check before signing.
- `POST /api/creator/arenas/:id/action`: Execute lifecycle action.

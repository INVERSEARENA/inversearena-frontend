# Arena State Integration

## Boundary

`fetchArenaState(arenaId, publicKey?)` validates both inputs and reads the canonical `ArenaStateFromContract` boundary. Contract money values remain `bigint` until `toArenaState` converts display amounts.

`useArenaStateActions(arenaId)` owns polling and reconciliation without subscribing the calling component to store changes. `useArenaState(arenaId)` preserves its public return shape for compatibility:

- `state: ArenaState | null`
- `health: "connected" | "degraded" | "offline"`
- `lastSyncedAt: number | null`
- `reconcile(publicKey?): Promise<ArenaState | null>`

The hook owns one polling/reconciliation boundary for the live arena page. Polling runs every five seconds, uses capped retry backoff, and stops publishing after unmount. Reconciliation authenticates user fields and is preferred after a transaction outcome.

## Store and subscriptions

`arenaStore.ts` publishes frozen immutable snapshots. `useArenaStore(selector, equalityFn?)` uses React `useSyncExternalStore`; only subscribers whose selected value changes render. Equivalent chain responses preserve the previous `ArenaState` reference, so a sync timestamp update does not invalidate state-only panels.

Arena panels should use stable module-level selectors. Timer ticks stay inside `Timer`; SSE state stays in `useArenaStream`; wallet state stays in `WalletProvider`.

```tsx
const round = useArenaStore((snapshot) => snapshot.state?.currentRound ?? 0);
```

For object or array selectors, pass an equality function or memoize the selector. Do not allocate selectors in render unless the selected value is primitive or the equality function intentionally treats each allocation as a change.

## State and failure behavior

| Event | Result |
|---|---|
| Empty/invalid arena ID | No network request; empty snapshot |
| Poll/reconcile success | One authoritative snapshot; connected health |
| Equivalent success | Previous state reference; updated sync time |
| Retry/failure | Last known state retained; degraded, then offline health |
| Older concurrent response | Ignored by request generation |
| Arena change/unmount | Pending publication invalidated |

Claim readiness fails closed. Authenticated reconciliation values are preserved across unauthenticated polling.

## Compatibility

No REST payload, SSE event, Soroban ABI, or public hook signature changes are introduced. The selector store is an additive client-side boundary. Existing `useArenaState(arenaId)` callers remain valid.

## Tests

Focused tests live in `frontend/src/features/arena/__tests__`. They cover normal polling, reconciliation, invalid input, stale concurrent reads, retry recovery, equivalent state references, selector isolation, and timer isolation. Run them with:

```bash
pnpm exec jest --runInBand \
  src/features/arena/__tests__/arenaStore.test.tsx \
  src/features/arena/__tests__/useArenaState.store.test.tsx
```

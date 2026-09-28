# Cross-Tab Wallet Mutation Coordinator (#1492)

## Problem

Inverse Arena can be open in multiple browser tabs under the same wallet.
Without coordination, two tabs can independently:

- Build, sign, and **submit the same `join` / `commit` / `reveal` / `claim`
  transaction**, producing duplicate wallet prompts and on-chain failures.
- Generate **different salts** for the same commit, so the second tab's reveal
  will fail the contract's commitment check.

## Solution

`frontend/src/shared-d/utils/mutation-coordinator.ts` provides a coordinator
that serialises wallet mutations across browser tabs on the same origin.

### Transport

Primary: **`BroadcastChannel`** (all modern browsers, same-origin only).  
Fallback: **`storage` events** on `localStorage` (private-browsing contexts and
any environment where `BroadcastChannel` is not exposed).

Both paths converge on the same `CoordinatorMessage` envelope; callers do not
need to be aware of which transport is active.

### Lock keys

A lock key uniquely identifies one mutation:

```
{network}:{walletPublicKey}:{arenaId}:{round}:{action}
```

| Component | Example |
|---|---|
| `network` | `testnet` or the full Stellar network passphrase |
| `walletPublicKey` | `GBRPYHIL2CI…` |
| `arenaId` | On-chain arena contract address |
| `round` | Integer round number (0-based) |
| `action` | `join` \| `commit` \| `reveal` \| `claim` |

Build keys with the exported helper:

```ts
import { buildMutationKey } from "@/shared-d/utils/mutation-coordinator";

const key = buildMutationKey(network, walletPublicKey, arenaId, round, "commit");
```

### State machine

```
                      acquire(key)
                          │
          ┌───────────────┴───────────────┐
          │                               │
    owned: true                     owned: false
    (this tab is owner)         (another tab is owner)
          │                               │
          │                    onPending() fires in this tab
          │                               │
       build/sign/submit             show pending UI
          │                       subscribe() for outcome
          │
   setOutcome(key, outcome)
          │
   ┌──────┴──────────────────────────────────────┐
   │  Writes outcome to localStorage              │
   │  Broadcasts `outcome` message to all tabs    │
   │  Releases the lock (stops heartbeat)         │
   └──────────────────────────────────────────────┘
          │
   OutcomeHandler fires in all tabs
          │
   trigger authoritative reconciliation
```

### Outcomes

| Status | Meaning |
|---|---|
| `confirmed` | Transaction landed on-chain; carries `txHash`. |
| `rejected` | Transaction rejected (user denied, contract error, etc.); carries `reason`. |
| `expired` | The round or operation window closed before submission. |
| `unknown` | The outcome could not be determined (e.g. RPC timeout); callers should keep last known state and wait for polling to converge. |

### Heartbeat and expiry

- The owning tab emits a heartbeat every **1 500 ms** (writes to `localStorage`,
  broadcasts over `BroadcastChannel`).
- A lock whose heartbeat is older than **6 000 ms** is considered stale and
  can be reclaimed by another tab (e.g. the owning tab crashed or was closed).
- These constants are exported as `HEARTBEAT_INTERVAL_MS` and `LOCK_EXPIRY_MS`.

### Outcome TTL

Outcome records written to `localStorage` expire after **30 seconds**.  A tab
that subscribes after this window will receive `null` from `getStoredOutcome()`
and must wait for the normal polling path to converge.

---

## Usage

```ts
import {
  getMutationCoordinator,
  buildMutationKey,
} from "@/shared-d/utils/mutation-coordinator";

// In a transaction hook / modal:
const coordinator = getMutationCoordinator();
const key = buildMutationKey(network, walletPublicKey, arenaId, round, "commit");

// Subscribe before acquire so we don't miss the outcome if another tab
// already holds the lock and finishes quickly.
const unsub = coordinator.subscribe(key, (outcome) => {
  // Called in ALL tabs (including the owner) when the operation completes.
  // Trigger authoritative reconciliation here.
  if (outcome.status === "confirmed" || outcome.status === "rejected") {
    void reconcileArena(arenaId, walletPublicKey);
  }
});

const lock = coordinator.acquire(key);
if (!lock.owned) {
  // Another tab is already handling this mutation.
  // The subscribe() above will fire when it finishes.
  coordinator.onPending(key, (ownerId) => {
    showPendingUI(ownerId);
  });
  return;
}

// This tab owns the lock.
try {
  const result = await buildSignSubmit(/* … */);
  coordinator.setOutcome(key, { status: "confirmed", txHash: result.hash });
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  coordinator.setOutcome(key, { status: "rejected", reason });
} finally {
  // setOutcome() calls release() internally, but release() is safe to call
  // again as a belt-and-suspenders.
  coordinator.release(key);
  unsub();
}
```

### Commit-reveal salt uniqueness

`saveCommitment()` in `commit-reveal.ts` is **idempotent**: if a commitment is
already stored for a given `arenaId / round / walletPublicKey` triplet, the
existing record is returned and the new argument is ignored.  This ensures that
even if two tabs somehow both reach `saveCommitment` before the coordinator lock
is fully established, only one salt ever gets committed for a given round.

```ts
// Both calls return the same commitment (the first writer wins):
const c1 = saveCommitment(arenaId, round, wallet, { choice: "Heads", salt: salt1 });
const c2 = saveCommitment(arenaId, round, wallet, { choice: "Tails", salt: salt2 });
// c1.salt === c2.salt === salt1
```

---

## Integration points

| Module | Role |
|---|---|
| `WalletProvider` | Acquires the coordinator singleton on mount; passes coordinator context to transaction hooks via the wallet context (future: `useTransactionMutation`). |
| `useStellarWallet` | Wallet/network change clears any in-progress lock for the old wallet key (keys are wallet-scoped). |
| `commit-reveal.ts` | Idempotent `saveCommitment` acts as a belt-and-suspenders salt guard. |
| Transaction modals / hooks | Acquire the lock before showing the wallet prompt; release on completion or cancellation. |

---

## Testing

```bash
# Coordinator unit tests
pnpm exec jest mutation-coordinator

# Updated commit-reveal tests (idempotency)
pnpm exec jest commit-reveal

# Full frontend suite
pnpm exec jest

# Type-check
pnpm exec tsc --noEmit
```

Tests cover:
- Single-tab acquire / release / isOwner
- Two-tab lock contention and outcome propagation
- Heartbeat refresh and stale-lock reclaim
- Late-arriving tab reads stored outcome
- Simultaneous acquire race (first writer wins)
- `BroadcastChannel` unavailable fallback (storage events)
- Wallet and network key isolation
- `destroy()` cleanup (no leaked timers or listeners)
- Commit-reveal salt idempotency

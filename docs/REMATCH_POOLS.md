# Rematch pools (#1572)

A **rematch** is a new arena created from a *finished* arena, reusing that
arena's canonical configuration so the host does not have to re-enter it and
cannot accidentally drift (a smaller stake, a different token, a round speed
the vault no longer backs). This note covers the three halves of the feature:
the contract views, the backend derivation/policy, and the frontend prefill.

## Why the prefill is not cached UI state

The pool-creation modal already holds a local draft (`pool-draft.ts`, #1405).
A rematch deliberately ignores it: the source of truth is the arena's own
on-chain `PoolConfig`, read at request time. A cached draft can be stale,
tampered with, or simply from a different arena, and a rematch built on one
would submit a `create_pool` whose policy the factory might reject — after
the host has already signed.

## 1. Contract views

- **`Arena.get_pool_config()`** returns `PoolConfigView`:
  `{ stake_token, yield_vault, entry_fee, oracle_contract, min_players,
  max_players, round_duration, start_deadline, factory, pool_id }`.
  `factory` and `pool_id` are included so the backend never has to reverse
  look-up which factory pool an arena belongs to. `round_duration` and
  `start_deadline` are `0` until the first `start_round` records them.
- **`Factory.get_active_pool_count(host)`** exposes the per-host active count;
  the policy check compares it against the factory's `max_active_pools`.

`CONTRACT_VERSION` moved to 6 (arena) and 3 (factory).

## 2. Backend: `RematchService`

`backend/src/services/rematchService.ts` holds:

- `getRematchConfig(arenaId, userWallet?)` — reads the arena row (host from
  `metadata.createdBy`), the arena's `get_pool_config`, and the factory's
  token/vault/oracle approval views plus the host's active-pool headroom, then
  returns a `RematchConfigResponse`. It is derived and returned as
  `available: false` with a `blockedReason` when a rematch is not possible —
  a blocked rematch is a normal answer, not an error. Only an unknown arena
  (404) or an unreadable config (503) throw.
- `evaluateRematchEligibility(checks)` — the pure decision, ordered so the
  prerequisite the host hits first is reported first:
  `SOURCE_ARENA_NOT_FINISHED` → token → vault → oracle → host active-pool
  limit.
- `notifyPriorParticipants(sourceArenaId, rematchArenaId)` — one deduped
  in-app delivery per prior participant (`rematch:<source>:<rematch>`), plus a
  best-effort push. Never throws: a notification failure must not undo a
  persisted linkage.

`GET /api/arenas/:id/rematch-config` (auth) exposes `getRematchConfig`.

## 3. The linkage

`Arena.rematchOf` (nullable self-relation `ArenaRematch`) records the source
arena. It is written by `ArenaService.confirmArenaDeployment`, which:

1. rejects a `rematchOf` that is not a valid contract id or names an arena we
   do not have;
2. is **idempotent** — a retried deployment of the same arena with the same
   linkage returns the existing row instead of a duplicate-key error, while a
   *different* linkage for an existing arena is a genuine conflict and throws;
3. notifies prior participants only when it actually created the row.

`POST /api/arenas` accepts the optional `rematchOf` and passes it through.

## 4. Frontend

- `features/pools/model/rematch-config.ts` — `fetchRematchConfig`,
  `toRematchFormPrefill` (maps the chain config onto the form: entry fee →
  stake amount, round duration → nearest round speed, `max_players` →
  capacity), and `recordRematchArena` (POSTs `rematchOf` + the confirmed
  `txHash` after `create_pool`).
- `PoolCreationModal` takes an optional `rematch` prop. A rematch prefill
  **overrides** any restored local draft, because it is authoritative, and the
  modal POSTs the linkage after the transaction confirms.
- The result page offers a "Rematch available" CTA when
  `GET /api/arenas/:id/rematch-config` says the arena can be rematched; it
  links to `/dashboard?rematch=<arenaId>`, where the dashboard opens the modal
  prefilled from that arena's chain config. A blocked or unreadable rematch is
  simply not offered.

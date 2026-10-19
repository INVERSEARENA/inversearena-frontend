# Design note: reveal window and platform fee (#1552, #1554)

## Problem

Two gaps in the arena protocol shipped together as contract version 3:

1. **#1552 — the reveal window had no end.** A round could stay in the reveal
   phase indefinitely, so an unresponsive player could stall resolution.
   Commitments and reveals were also governed by one timestamp, so the client
   could not tell "commitments are closed but reveals are open" from "the round
   is resolvable".
2. **#1554 — the platform fee was charged but never accounted for on chain.**
   The fee was computed off-chain, so the treasury's cut and the winner's net
   were not independently verifiable, and a winner could not see what was taken.

## Ownership

| Layer | Files |
| --- | --- |
| Arena contract | `contract/arena/src/{types,storage,lib,events}.rs` — `reveal_deadline`, deadline views, phase guards, settlement breakdown |
| Factory | `contract/factory/src/{lib,storage,types}.rs` — `treasury` in `PoolConfig`, snapshotted into each arena |
| Frontend | `frontend/src/shared-d/hooks/useArenaTimer.ts`, `stellar-transactions.ts`, arena page/timer, result page |
| Backend | `backend/src/services/projection/*` (deadline fold + phase), `backend/src/domain/treasuryEventDecoder.ts`, treasury reconciliation, claim-inbox breakdown |

The contract is the owner of the deadlines and the fee arithmetic; every other
layer derives from it and must not re-derive economics.

## State transitions

```text
Lobby ──start_round──► Commit ──commit_deadline──► Reveal ──reveal_deadline──► Resolvable
```

- `get_round_phase` returns `Lobby | Commit | Reveal | Resolvable`.
- `get_phase_deadlines`, `get_commit_deadline`, `get_reveal_deadline` expose the
  two timestamps; `reveal_deadline == 0` means *unbounded* and is the legacy /
  pre-#1552 behaviour.
- `start_round` rejects a window that is not strictly increasing with
  `DeadlineTooSoon` (28). `reveal_choice` rejects before the commit deadline
  with `RoundNotActive`/`RevealPhaseActive` and at/after the reveal deadline
  with `RevealPhaseEnded` (42). `resolve_round` rejects during an active reveal
  window with `RevealPhaseActive` (41).
- **Fee.** The fee base is **yield only**: `gross = principal + yield`,
  `fee = floor(yield * bps / 10_000)`, `net = gross - fee`. Integer division
  rounds the fee down, so dust goes to the winner, never the treasury. The fee
  rate is snapshotted into `ArenaConfig.platform_fee_bps` at `initialize`; a
  later admin rate change affects only arenas initialized afterwards.
- **Settlement.** `get_settlement_breakdown` returns
  `Option<SettlementBreakdown { gross, fee, net, yield_amount, treasury }>`.
  `claimed` carries the same five values so an indexer can reconcile without a
  second read.

## Failure behaviour

- A malformed `claimed` payload (not a 5-tuple) decodes to an `unknown` treasury
  event with a `5-tuple` reason and is skipped, never silently reinterpreted as
  a zero-fee claim.
- `fee_coll` with `fee == 0` produces no treasury transfer expectation; a
  treasury reconciliation run treats a zero-fee claim as fully reconciled.
- The backend claim inbox treats the gross/fee/net fields as optional: an older
  server, or an arena with no settlement breakdown, simply omits them and the UI
  renders the net amount only.
- Projection phase derivation is pure: `gameState !== in_progress`, a null
  commit deadline, or a legacy event all fall back to `lobby`, so a projection
  replay never invents a phase from missing data.
- `reveal_deadline == 0` is treated as unbounded everywhere, so older arenas
  remain playable and resolvable.

## Compatibility

- Version bumps: `arena::CONTRACT_VERSION = 3`, `factory = 2`, `payout = 1`,
  `staking = 1`. ABI snapshots are regenerated and checked in
  (`generate_abi_snapshots.sh --check`).
- `ArenaConfig` gained `reveal_deadline` and `treasury`. Because a
  `#[contracttype]` struct is encoded as a field-name-keyed map, a decode with
  the wrong entry count aborts at the host level rather than returning a Rust
  error. `load_config` therefore inspects the encoded map for the
  `reveal_deadline` key and picks the legacy or v3 decoder explicitly;
  `legacy_arena_config_is_migrated_in_place` covers the migration.
- The storage-layout fixture (`contract/fixtures/storage-layout/arena-v1.json`)
  was bumped to match the v3 shape.
- Frontend tolerates a missing `get_phase_deadlines` (older deployment) by
  falling back to the previous timer behaviour.
- Backend reconciliation accepts both 4-field (legacy) and 5-field `claimed`
  events, and learns the new `fee_coll` topic.

## Observability

- Events: `started` now carries `(round, commit_deadline, reveal_deadline)`;
  `claimed` carries the full settlement tuple; `fee_coll` carries
  `(fee, fee_bps)` keyed by treasury.
- Backend: the projection exposes `phase`, and the claim inbox optionally
  carries `grossAmountStroops` / `feeAmountStroops` / `netAmountStroops` for the
  client to display; treasury reconciliation fails closed on undecodable
  events.

## Tests

- Contracts: `cargo test --workspace` (arena lib = 160 tests), including
  deadline guard, fee-at-max, settlement, legacy migration, and event-shape
  tests; ABI and storage-layout snapshot checks.
- Frontend: `useArenaTimer` deadline/phase tests, arena store tests,
  claim-inbox panel gross/fee/net rendering.
- Backend: projection phase tests (`arenaProjectionFold.unit.test.ts`),
  treasury decoder 5-tuple/`fee_coll` tests
  (`treasuryEventDecoder.unit.test.ts`), claim-inbox settlement tests.

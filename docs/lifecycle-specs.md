# Lifecycle specifications

Machine-readable lifecycle specs (#1693) define the state enums, legal transitions,
and terminal states for the arena, round, and transaction lifecycles. The backend
and frontend consume generated code instead of hand-copied unions.

## Files

| Path | Role |
| --- | --- |
| `scripts/lifecycle/lifecycle-spec.json` | Source of truth. Edit this file. |
| `scripts/lifecycle/generate-lifecycle.mjs` | Generator. Dependency-free Node script. |
| `backend/src/domain/lifecycle/generated.ts` | Generated. Backend state machines import this. |
| `frontend/src/shared/lib/lifecycle/generated.ts` | Generated. Frontend exhaustive switches import this. |
| `backend/tests/contract-fixtures/lifecycle-transitions.json` | Generated golden fixture: every ordered state pair per domain, marked legal or illegal. |
| `backend/tests/unit/lifecycleGenerated.unit.test.ts` | Checks the generated code against the fixture. |

## Workflow

1. Change `lifecycle-spec.json`.
2. Run `node scripts/lifecycle/generate-lifecycle.mjs`.
3. Commit the spec and all generated outputs together.

`node scripts/lifecycle/generate-lifecycle.mjs --check` exits non-zero when any
generated file differs from what the spec would produce. Wire this into CI so a
hand edit to a generated file fails the build. Generated files start with a
`DO NOT EDIT` header.

## Domains

- **round**: `OPEN → CLOSED → RESOLVED → SETTLED` (`rounds.state`).
- **arenaGame**: the contract `GameState` enum in `contract/arena/src/types.rs`:
  `Open`, `Active`, `Finished`, `Cancelled`, `Settled`. Legal transitions mirror
  `can_transition` in `contract/arena/src/state_machine.rs`.
- **transaction**: the `TransactionState` values in
  `backend/src/domain/transactionState.ts`, with transitions derived from
  `TransactionStateMachine`.

Not yet covered: payout states, transaction-intent states, integration registry
states, and the frontend `ArenaStateStatus` union. Each needs its owner to confirm
the transition table before it is added.

## Compatibility policy

- Wire values are frozen. Renaming a state is a breaking change, so it needs a new
  `specVersion` and a migration.
- Adding a state is additive. Consumers parse unknown values with
  `parse<Domain>State`, which returns `{ kind: "unknown", raw }` instead of
  throwing. Legacy and unknown rows are reported, not coerced.
- Tightening a DB constraint requires first auditing existing values. Do not add a
  constraint for a state that legacy rows may still hold.
- Terminal states must have no outgoing transitions. The generator rejects a spec
  that violates this, and also rejects self-loops and undeclared states.

## Known drift (found while writing this spec)

The spec documents what the contract defines. The backend code does not match it.

- `backend/src/services/onChainReader.ts` calls a `game_state` view function.
  The arena contract (`contract/arena/src/lib.rs`) has no `game_state` entry point,
  so `readOnChainGameState` cannot succeed on a deployed arena.
- The reader's `OnChainGameState` type and `mapGameStateToStatus` use `InProgress`,
  which the contract never defines (its variant is `Active`). They also omit
  `Settled`, so a settled arena falls through to the `default` branch and maps to
  `"active"`.

These are not fixed by this change. They need a decision on which read the backend
should use (for example `get_settlement` or `get_player_status`) before the reader
is changed.
# Three-option minority rounds

New arenas may set `PoolConfig.option_count` to `2` or `3`. Existing arenas
without this storage key remain binary (`2`). The third choice is encoded as
`Option3` / byte `2`; `Heads` and `Tails` keep bytes `0` and `1`. Commitments
remain bound to the arena, round, and player.

After reveals, each choice with at least one vote is compared by count. In a
three-option arena, every used choice tied for the lowest count survives; a
choice with no votes is ignored so an unused option cannot eliminate every
revealer. In a binary arena, an equal tally keeps the established rule that
nobody is eliminated. Non-revealers are eliminated in either mode. The
versioned `rslvd3` event adds the third tally while the existing `rslvd2`
event remains available for older consumers.

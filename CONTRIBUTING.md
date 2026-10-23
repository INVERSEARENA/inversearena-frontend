# Contributing to InverseArena

## Smart Contract Code Review Checklist

Every PR that touches a contract function which moves funds (transfers tokens,
interacts with a vault, pays out prizes, etc.) must be reviewed against the
checks-effects-interactions pattern. Reviewers should confirm each of the
following before approving:

- [ ] **Checks first.** All input validation, auth (`require_auth`), state
  preconditions (e.g. `GameState`), and "already done" guards
  (e.g. `prize_claimed`) run before any state write.
- [ ] **Effects next.** Every persistent storage write that records the
  outcome of the operation (state transitions, flags such as
  `mark_prize_claimed`, counters, balances) is committed *before* any
  cross-contract call.
- [ ] **Interactions last.** Cross-contract calls — token transfers, vault
  withdrawals, oracle reads that can have side effects — happen only after
  all state has been persisted. The function should not write to storage
  after a cross-contract call returns.
- [ ] **No "guard after transfer".** A flag like `prize_claimed` or
  `state = Settled` must never be set after a `token.transfer`,
  `rwa.withdraw_all`, or similar external invocation. A malicious token
  contract could re-enter and replay the operation before the flag is set.
- [ ] **Reentrancy regression test.** Any new or modified fund-moving function
  has a unit test that pre-sets the relevant guard flag (simulating mid-call
  reentry) and asserts the function returns the corresponding `AlreadyX`
  error.

See `contract/arena/src/lib.rs::claim` for the canonical example of this
ordering.

## Snapshot Testing

Soroban stores all `#[contracttype]` values using XDR serialization. A change to a `contracttype` struct (adding, removing, or reordering fields) silently breaks deserialization of existing ledger entries.

To prevent this, we use snapshot tests that assert the XDR serialization of every `contracttype` matches a hard-coded byte array.

### How it works

Every contract (`arena`, `factory`, `payout`, `staking`) has a `snapshot_test.rs` module. These tests:
1. Construct a sample value of a `#[contracttype]`.
2. Serialize it to XDR bytes.
3. Assert that the bytes match a hard-coded expected array.

### Adding new types

When you add a new `#[contracttype]`, you **must** add a corresponding snapshot test in the relevant contract's `snapshot_test.rs`.

### Updating snapshots

If you intentionally make a breaking change to a `contracttype` (e.g., adding a field), the snapshot tests will fail. To update them:
1. Run the tests with nocapture to see the actual bytes:
   ```bash
   cargo test test_snapshots --manifest-path contract/<contract_name>/Cargo.toml -- --nocapture
   ```
2. Copy the "Actual" byte array from the test output.
3. Update the hard-coded byte array in `snapshot_test.rs`.
4. Document why the breaking change was necessary in your pull request.

## Backend tests

Backend tests live under `backend/tests/` in three tiers (#1644):

| Directory | Needs services? | Run with |
| --- | --- | --- |
| `tests/unit/` | no | `npm run test:unit` |
| `tests/integration/` | Postgres + Redis (+ Mongo via `mongodb-memory-server`) | `npm run test:integration` |
| `tests/contract-fixtures/` | no (data only) | — |

Shared helpers are in `tests/helpers/`; shared setup in `tests/setup/`
(`unit-setup.ts` for the unit project, `setup.ts` for integration).

**Where to put a new test**

- Pure function / service with no I/O → `tests/unit/`
- Anything that touches Prisma, Redis, Mongo, or the HTTP app → `tests/integration/`
- Golden fixtures shared with the contracts → `tests/contract-fixtures/`

A small number of suites run under `node --test` instead of Jest (see
`test:node` in `backend/package.json`). Prefer Jest for new tests.

**CI** (`.github/workflows/backend-ci.yml`) runs `unit` on every PR and
`integration` only after `unit` passes, with Postgres/Redis service containers.

## Local development stack

`make dev` (#1647) is the supported way to get a working app from a clean
clone:

```bash
make dev         # quickstart + contracts + seed + backend + frontend
make dev-reset   # clean slate
make dev-seed    # re-seed arenas only
```

It writes `contract/deployment-manifest.json` (contract ids + network
passphrase) and the `.env` / `.env.local` files the apps auto-load. Do not
commit those generated files. Seed state lives in `scripts/.seed-state.json`.

See `README.md` → *One-command local stack* for the full walkthrough and
`docker-compose.dev.yml` for the service topology (note the offset ports:
Postgres 5433, Redis 6380, Mongo 27018 — chosen so the stack can sit next to a
system Postgres/Redis without clobbering it).

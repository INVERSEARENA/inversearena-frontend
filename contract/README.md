# Contract Workspace

Soroban smart contracts for Inverse Arena, written in Rust and compiled to WASM for the Stellar network.

## Status

These contracts are **open for contribution**. The directory structure and interfaces are defined; the implementations are tracked as issues in the project issue tracker. Each contract's `src/lib.rs` contains a documented stub explaining what needs to be built.

| Contract | Role | Status |
| --- | --- | --- |
| `arena` | Round lifecycle, player choices, elimination logic | Open for implementation |
| `factory` | Pool creation, host whitelist, protocol configuration | Open for implementation |
| `payout` | Winnings distribution (principal + yield) | Open for implementation |
| `staking` | XLM deposits routed to RWA yield vaults | Open for implementation |

## Structure

```
contract/
├── Cargo.toml               # Workspace manifest
├── arena/src/lib.rs         # Arena contract stub
├── factory/src/lib.rs       # Factory contract stub
├── payout/src/lib.rs        # Payout contract stub
├── staking/src/lib.rs       # Staking contract stub
├── scripts/
│   ├── generate_abi_snapshots.sh   # ABI snapshot generation / CI check
│   └── optimize_and_check_wasm.sh  # WASM build + size budget enforcement
├── ARCHITECTURE.md          # System design and contract interaction model
├── CONTRACTS.md             # Detailed entrypoint and storage specs
├── DATA_MODEL.md            # On-chain data structures
├── EVENTS.md                # Contract event definitions
├── ERRORS.md                # Error codes and conditions
├── BOUNDS.md                # Numeric limits and constants
└── DEPLOY.md                # Deployment and upgrade runbook
```

## Getting Started

### Prerequisites

- Rust stable toolchain with `wasm32-unknown-unknown` target
- Stellar CLI: `cargo install --locked stellar-cli`

### Build

```bash
cd contract
cargo build --target wasm32-unknown-unknown --release
```

### Test

```bash
cargo test --workspace
```

### ABI Snapshots

ABI snapshots live at `<contract>/abi_snapshot.json` and are generated from compiled WASM artifacts.

```bash
# Regenerate after an interface change
./scripts/generate_abi_snapshots.sh

# Verify snapshots match (runs in CI)
./scripts/generate_abi_snapshots.sh --check
```

After regenerating, commit the updated snapshot file and document the interface change in your PR.

## Contributing

1. Pick an issue from the tracker.
2. Read `ARCHITECTURE.md` to understand where your contract fits in the system.
3. Read the relevant `CONTRACTS.md` section for the expected entrypoints and storage layout.
4. Implement, test, and add a snapshot test before opening a PR.
5. Run `./scripts/generate_abi_snapshots.sh` to generate an initial ABI snapshot.

See the top-level `CONTRIBUTING.md` for snapshot testing requirements.

## Arena Events

| Event | Topic key | Data |
| --- | --- | --- |
| initialized | `init` | `admin` |
| player_joined | `join` | `player_count` |
| game_started | `started` | `(round, duration_seconds)` |
| round_resolved | `resolved` | `(round, eliminated, survivors)` |
| player_eliminated | `elim` | `round` |
| game_finished | `finished` | `(winner, round)` |
| prize_claimed | `claimed` | `(amount, yield_amount)` |
| admin_changed | `admin` | `(old_admin, new_admin)` |

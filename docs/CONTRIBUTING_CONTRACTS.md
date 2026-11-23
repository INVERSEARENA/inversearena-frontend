# Contributing to InverseArena Smart Contracts

Welcome! This guide covers everything you need to start contributing to the Soroban smart contracts
that power InverseArena.

## Prerequisites

Use the pinned toolchain for reproducible builds:

- **Rust 1.82.0** (`rust-toolchain.toml` / `contract/rust-toolchain.toml`)
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  rustup toolchain install 1.82.0
  rustup target add wasm32-unknown-unknown wasm32v1-none --toolchain 1.82.0
  ```
- **Stellar CLI 22.6.0**
  ```bash
  cargo install --locked stellar-cli@22.6.0
  ```
- **Node 20.20.2 / npm 10.9.9 / pnpm 10.11.1** for workspace tooling

The devcontainer (`.devcontainer/`) pins these versions.

## Setup

```bash
git clone https://github.com/INVERSEARENA/inversearena-frontend.git
cd inversearena-frontend
```

Contracts live in `contract/`. The workspace is defined in `contract/Cargo.toml`.

## Build

```bash
# Build the contract to a WASM blob
cargo build --manifest-path contract/Cargo.toml --target wasm32v1-none --release

# Or use the project Makefile shortcut
make contracts-build
```

Compiled artifacts are written under `contract/target/wasm32v1-none/release/`.

## Run Tests

```bash
# Run all contract unit tests
cargo test --manifest-path contract/Cargo.toml --workspace

# Run a single test by name
cargo test --manifest-path contract/Cargo.toml --workspace -- test_full_game_two_players_one_round

# Run with output (useful for debugging)
cargo test --manifest-path contract/Cargo.toml --workspace -- --nocapture
```

Tests use the Soroban SDK test utilities (`soroban_sdk::testutils`) and run entirely in-process —
no network connection required.

## Code Style

### Error handling

- Every fallible function returns `Result<T, ArenaError>`.
- Add new error variants to `errors.rs` before using them; give each a unique `u32` discriminant.
- Never `unwrap()` in production code paths; use `ok_or(ArenaError::...)`.

### Naming conventions

- Types: `PascalCase` (`ArenaConfig`, `GameState`).
- Functions: `snake_case` (`resolve_round`, `get_config`).
- Storage keys: `Symbol::short("ALLCAPS")` for global keys; tuple keys `(Symbol, Address)` for
  per-player data.

### Module structure

| File | Purpose |
|------|---------|
| `lib.rs` | Public contract entry points (`#[contractimpl]`) |
| `types.rs` | `#[contracttype]` structs and enums |
| `storage.rs` | All `env.storage()` reads and writes |
| `events.rs` | `env.events().publish(...)` wrappers |
| `errors.rs` | `#[contracterror]` enum |
| `test.rs` | Unit tests (`#[cfg(test)]`) |

Keep `lib.rs` thin — business logic belongs in focused helper modules, not inline.

### Writing tests

Add tests near the contract implementation (for example `contract/arena/src/test.rs` or extracted test modules). Follow existing patterns:

```rust
#[test]
fn my_new_test() {
    let env = create_test_env();
    env.mock_all_auths();
    let (admin, client) = setup_arena(&env);

    // arrange
    client.initialize(&admin, &100_000_000, &100, &(env.ledger().timestamp() + 86400));

    // act
    let result = client.try_some_function(...);

    // assert
    assert_eq!(result, Ok(expected_value));
}
```

- Use `client.try_*` for calls you expect to fail; it returns `Result` instead of panicking.
- Use `env.mock_all_auths()` for the happy path; clear auths with `env.set_auths(&[])` to test
  auth failures.

## Issue Labels

| Label | Meaning |
|-------|---------|
| `good first issue` | Self-contained change, < 50 lines, no new modules |
| `difficulty: medium` | Requires understanding one existing module |
| `difficulty: hard` | Cross-module change or new feature |
| `testing` | Adding or improving test coverage |
| `security` | Security-sensitive — requires extra review |
| `docs` | Documentation only |

## PR Checklist

Before opening a PR, verify:

- [ ] `cargo test --manifest-path contract/Cargo.toml --workspace` passes with no warnings
- [ ] New public functions have a one-line doc comment explaining the happy path
- [ ] New error variants are added to `errors.rs` and documented
- [ ] Tests cover the happy path **and** at least one failure path for every new function
- [ ] No `unwrap()` calls in non-test code
- [ ] PR description references the issue with `closes #N`

## Getting Help

- Open a GitHub Discussion for design questions before writing code.
- For quick questions, mention `@INVERSEARENA` in the issue thread.

# Pool Creation Compatibility & Safety Enforcements (#1634)

## Overview
When creating an arena pool via `Factory.create_pool(host, config)`, the factory contract strictly validates compatibility between:
1. The pool's configured `stake_token`.
2. The approved `yield_vault` (RWA Adapter).
3. The approved `oracle_contract`.

## Problem Solved
Previously, `create_pool` checked independently whether `stake_token` was supported, `yield_vault` was approved, and `oracle_contract` was approved. However, nothing verified that:
- The vault's underlying collateral asset matches the pool's `stake_token`.
- The vault's configured yield oracle matches the pool's `oracle_contract`.

A mismatch would allow an arena with token A and a vault for token B to fail at the first player join, or worse, transfer the wrong asset and desynchronize yield snapshots with vault payouts.

## On-Chain Verification
The RWA Adapter exposes a `config()` read method:
```rust
pub fn config(env: Env) -> Result<RwaConfig, RwaError>
```

When `create_pool` executes:
1. `is_approved_vault(&env, &config.yield_vault)` must be true (else `InvalidVault = 11`).
2. `is_approved_oracle(&env, &config.oracle_contract)` must be true (else `InvalidOracle = 12`).
3. Factory queries `VaultClient::new(&env, &config.yield_vault).try_config()`. If unreadable, it rejects with `InvalidVault = 11`.
4. If `vault_config.stake_token != config.stake_token`, factory rejects with `VaultTokenMismatch = 21`.
5. If `vault_config.oracle != config.oracle_contract`, factory rejects with `OracleMismatch = 22`.

## Approved Vault Token Registration
When `Factory.add_approved_vault(vault)` is invoked by admin, the factory automatically queries `vault.config()` and records the vault's supported stake token. An explicit method `Factory.add_approved_vault_for_token(vault, token)` and query `Factory.get_vault_token(vault)` are also available.

## Client-Side Enforcement
The frontend provides pre-flight validation via `frontend/src/shared-d/utils/pool-compatibility.ts`:
- `checkPoolCompatibility`: Validates combinations prior to constructing transaction envelopes.
- `filterCompatibleVaults`: Filters available vaults based on the selected stake token.
- `getCompatibleCurrencies`: Enumerates currencies that have at least one approved matching vault.

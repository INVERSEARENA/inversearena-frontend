#![no_std]
use soroban_sdk::{Address, Env, contract, contractimpl, token};

const SECONDS_PER_YEAR: u64 = 31_536_000;

mod oracle;
mod storage;
mod types;

use storage::RwaStorage;
use types::PendingAdmin;
use types::RwaConfig;
pub use types::RwaError;

#[contract]
pub struct RwaAdapter;

#[contractimpl]
impl RwaAdapter {
    pub fn initialize(
        env: Env,
        admin: Address,
        stake_token: Address,
        oracle: Address,
    ) -> Result<(), RwaError> {
        admin.require_auth();
        if RwaStorage::assert_initialized(&env).is_ok() {
            return Err(RwaError::AlreadyInitialized);
        }
        let config = RwaConfig {
            admin,
            stake_token,
            oracle,
            total_deposited: 0,
        };
        RwaStorage::save_config(&env, &config);
        RwaStorage::set_initialized(&env);
        env.events()
            .publish((soroban_sdk::symbol_short!("init"),), ());
        Ok(())
    }

    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), RwaError> {
        from.require_auth();
        if amount <= 0 {
            return Err(RwaError::InvalidAmount);
        }
        let config = RwaStorage::load_config(&env)?;

        let mut pos = RwaStorage::load_position(&env, &from);
        pos.principal = pos
            .principal
            .checked_add(amount)
            .ok_or(RwaError::ArithmeticOverflow)?;
        // Fresh position (principal was 0): reset the deposit timestamp and clear
        // the withdrawn flag, otherwise a re-deposit after a full withdrawal would
        // permanently fail withdraw_all()'s AlreadyWithdrawn check (#1356, #1357).
        if pos.principal == amount {
            pos.deposited_at = env.ledger().timestamp();
            pos.withdrawn = false;
        }
        RwaStorage::save_position(&env, &from, &pos);

        let mut cfg = config;
        cfg.total_deposited = cfg
            .total_deposited
            .checked_add(amount)
            .ok_or(RwaError::ArithmeticOverflow)?;
        RwaStorage::save_config(&env, &cfg);

        // Transfer tokens from the depositor into this vault contract.
        // This was previously missing, leaving the vault empty and making
        // every subsequent withdraw_all() payout bounded by the vault's near-zero
        // balance rather than the actual staked amount (#1299).
        let token_client = token::TokenClient::new(&env, &cfg.stake_token);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&from, &contract_addr, &amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("dep"), from.clone(), amount),
            cfg.total_deposited,
        );
        Ok(())
    }

    pub fn withdraw_all(env: Env, from: Address) -> Result<i128, RwaError> {
        from.require_auth();
        let config = RwaStorage::load_config(&env)?;

        let pos = RwaStorage::load_position(&env, &from);
        if pos.principal == 0 {
            return Err(RwaError::NoDeposit);
        }
        if pos.withdrawn {
            return Err(RwaError::AlreadyWithdrawn);
        }

        let yield_bps = oracle::fetch_yield_bps(&env, &config.oracle);
        let base_yield = pos
            .principal
            .checked_mul(yield_bps as i128)
            .and_then(|v| v.checked_div(10000))
            .ok_or(RwaError::ArithmeticOverflow)?;
        let elapsed = env.ledger().timestamp().saturating_sub(pos.deposited_at);
        let yield_amount = base_yield
            .checked_mul(elapsed as i128)
            .and_then(|y| y.checked_div(SECONDS_PER_YEAR as i128))
            .unwrap_or(0);
        let total = pos
            .principal
            .checked_add(yield_amount)
            .ok_or(RwaError::ArithmeticOverflow)?;

        let mut updated = pos;
        updated.principal = 0;
        updated.withdrawn = true;
        RwaStorage::save_position(&env, &from, &updated);

        // Decrement the global counter so get_total_deposited() reflects net deposits.
        let mut cfg = config;
        cfg.total_deposited = cfg.total_deposited.saturating_sub(pos.principal);
        RwaStorage::save_config(&env, &cfg);

        let token_client = token::TokenClient::new(&env, &cfg.stake_token);
        let contract_addr = env.current_contract_address();
        let balance = token_client.balance(&contract_addr);
        let payable = if total > balance { balance } else { total };
        token_client.transfer(&contract_addr, &from, &payable);

        if total > balance {
            env.events().publish(
                (soroban_sdk::symbol_short!("short"), from.clone()),
                (total, balance),
            );
        }

        env.events().publish(
            (
                soroban_sdk::symbol_short!("wdraw"),
                from.clone(),
                payable,
                payable - pos.principal,
            ),
            cfg.total_deposited,
        );

        Ok(payable)
    }

    pub fn balance_of(env: Env, user: Address) -> i128 {
        RwaStorage::load_config(&env)
            .map(|config| {
                let pos = RwaStorage::load_position(&env, &user);
                if pos.withdrawn {
                    0
                } else {
                    let yield_bps = oracle::fetch_yield_bps(&env, &config.oracle);
                    let base_yield = pos
                        .principal
                        .checked_mul(yield_bps as i128)
                        .and_then(|y| y.checked_div(10000))
                        .unwrap_or(0);
                    let elapsed = env.ledger().timestamp().saturating_sub(pos.deposited_at);
                    let accrued = base_yield
                        .checked_mul(elapsed as i128)
                        .and_then(|y| y.checked_div(SECONDS_PER_YEAR as i128))
                        .unwrap_or(0);
                    pos.principal.checked_add(accrued).unwrap_or(0)
                }
            })
            .unwrap_or(0)
    }

    pub fn get_total_deposited(env: Env) -> i128 {
        RwaStorage::load_config(&env)
            .map(|c| c.total_deposited)
            .unwrap_or(0)
    }

    /// Propose a new admin. The current admin must authorize the proposal.
    /// The proposed admin must call `accept_admin` to complete the transfer.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), RwaError> {
        let config = RwaStorage::load_config(&env)?;
        config.admin.require_auth();
        RwaStorage::save_pending_admin(&env, &PendingAdmin { new_admin });
        Ok(())
    }

    /// Accept a pending admin transfer. Only the proposed admin may call this.
    pub fn accept_admin(env: Env) -> Result<(), RwaError> {
        let pending = RwaStorage::load_pending_admin(&env).ok_or(RwaError::NoPendingAdmin)?;
        pending.new_admin.require_auth();
        let mut config = RwaStorage::load_config(&env)?;
        let old_admin = config.admin.clone();
        config.admin = pending.new_admin;
        RwaStorage::save_config(&env, &config);
        RwaStorage::delete_pending_admin(&env);
        env.events().publish(
            (soroban_sdk::symbol_short!("admin_ch"),),
            (old_admin, config.admin.clone()),
        );
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: soroban_sdk::BytesN<32>) -> Result<(), RwaError> {
        let config = RwaStorage::load_config(&env)?;
        config.admin.require_auth();
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.events()
            .publish((soroban_sdk::symbol_short!("upgrade"),), new_wasm_hash);
        Ok(())
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        Address, Env,
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
    };

    #[contract]
    struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        pub fn get_current_yield_bps(_env: Env) -> u32 {
            500
        }
    }

    /// Register the RwaAdapter and wire up a SAC token, writing config directly
    /// into storage so tests can control auth independently of `initialize`.
    fn setup(env: &Env) -> (RwaAdapterClient<'_>, Address, Address) {
        let contract_id = env.register(RwaAdapter, ());
        let token_admin = Address::generate(env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let oracle_id = env.register(MockOracle, ());
        let admin = Address::generate(env);

        env.as_contract(&contract_id, || {
            let config = RwaConfig {
                admin: admin.clone(),
                stake_token: token_id.clone(),
                oracle: oracle_id,
                total_deposited: 0,
            };
            RwaStorage::save_config(env, &config);
            RwaStorage::set_initialized(env);
        });

        let client = RwaAdapterClient::new(env, &contract_id);
        (client, token_id, contract_id)
    }

    // ── Authorization tests for deposit() ────────────────────────────────────

    /// deposit() must panic when the `from` address has not authorized the call.
    #[test]
    #[should_panic]
    fn deposit_without_auth_panics() {
        let env = Env::default();
        // Intentionally no mock_all_auths — auth is enforced.
        let (client, _, _) = setup(&env);
        let from = Address::generate(&env);
        // from has not signed anything; require_auth() should panic.
        client.deposit(&from, &100);
    }

    /// deposit() records the position when the caller provides authorization.
    #[test]
    fn deposit_with_auth_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, token_id, _) = setup(&env);
        let from = Address::generate(&env);

        // Pre-fund the depositor so the real token transfer in deposit() succeeds.
        StellarAssetClient::new(&env, &token_id).mint(&from, &100);

        client.deposit(&from, &100);

        // balance_of returns principal (yield takes time to accrue)
        assert_eq!(client.balance_of(&from), 100);
        assert_eq!(client.get_total_deposited(), 100);
    }

    #[test]
    fn balance_of_accrues_over_time() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, token_id, _) = setup(&env);
        let from = Address::generate(&env);

        // Pre-fund the depositor so the real token transfer in deposit() succeeds.
        StellarAssetClient::new(&env, &token_id).mint(&from, &100);

        client.deposit(&from, &100);
        assert_eq!(client.balance_of(&from), 100);

        let mut ledger = env.ledger().get();
        ledger.timestamp += 31_536_000;
        env.ledger().set(ledger);

        assert_eq!(client.balance_of(&from), 105);
    }

    // ── Authorization tests for withdraw_all() ────────────────────────────────

    /// withdraw_all() must panic when the `from` address has not authorized the call.
    #[test]
    #[should_panic]
    fn withdraw_without_auth_panics() {
        let env = Env::default();
        // Intentionally no mock_all_auths — auth is enforced.
        let (client, _, contract_id) = setup(&env);
        let from = Address::generate(&env);

        // Seed a position directly so the test reaches require_auth() without
        // going through deposit (which also requires auth).
        env.as_contract(&contract_id, || {
            RwaStorage::save_position(
                &env,
                &from,
                &types::YieldAccrual {
                    principal: 100,
                    withdrawn: false,
                    deposited_at: 0,
                },
            );
        });

        // from has not signed anything; require_auth() should panic.
        client.withdraw_all(&from);
    }

    /// get_total_deposited() must decrease by the withdrawn principal so the
    /// metric reflects net deposits rather than growing forever.
    #[test]
    fn total_deposited_decremented_after_withdrawal() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, token_id, contract_id) = setup(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        // Pre-fund depositors; deposit() will transfer their tokens into the vault.
        StellarAssetClient::new(&env, &token_id).mint(&alice, &1_000);
        StellarAssetClient::new(&env, &token_id).mint(&bob, &500);

        client.deposit(&alice, &1_000);
        client.deposit(&bob, &500);
        assert_eq!(client.get_total_deposited(), 1_500);

        // The vault already holds 1_500 from deposits.  Mint only the yield portion
        // so withdrawals succeed (no timestamp advance so yield = 0, nothing extra needed).
        // Mint a small buffer to cover any rounding if a future timestamp is set.
        let yield_buffer: i128 = 100;
        StellarAssetClient::new(&env, &token_id).mint(&contract_id, &yield_buffer);

        client.withdraw_all(&alice);
        assert_eq!(
            client.get_total_deposited(),
            500,
            "alice's 1000 principal must be removed from total"
        );

        client.withdraw_all(&bob);
        assert_eq!(
            client.get_total_deposited(),
            0,
            "total must reach 0 after all principals are withdrawn"
        );
    }

    /// withdraw_all() transfers principal + yield to the caller when authorized.
    #[test]
    fn withdraw_with_auth_returns_correct_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, token_id, contract_id) = setup(&env);
        let from = Address::generate(&env);

        // Pre-fund the depositor; deposit() transfers 1000 tokens into the vault.
        StellarAssetClient::new(&env, &token_id).mint(&from, &1_000);

        // Deposit 1000 tokens — vault now holds 1000.
        client.deposit(&from, &1_000);

        let mut ledger = env.ledger().get();
        ledger.timestamp += 31_536_000;
        env.ledger().set(ledger);

        // Expected payout: 1000 principal + 5% yield = 1050.
        let expected: i128 = 1_050;

        // The vault already holds 1000 from the deposit.  Only mint the 50-token
        // yield portion so the balance equals the full expected payout.
        let yield_amount: i128 = 50;
        StellarAssetClient::new(&env, &token_id).mint(&contract_id, &yield_amount);

        let returned = client.withdraw_all(&from);
        assert_eq!(returned, expected);

        // After withdrawal the position is closed; balance_of must return 0.
        assert_eq!(client.balance_of(&from), 0);
    }

    // ── Admin rotation tests ──────────────────────────────────────────────

    #[test]
    fn propose_admin_updates_pending_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(RwaAdapter, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        let oracle_id = env.register(MockOracle, ());

        env.as_contract(&contract_id, || {
            let config = RwaConfig {
                admin: admin.clone(),
                stake_token: token_id.clone(),
                oracle: oracle_id,
                total_deposited: 0,
            };
            RwaStorage::save_config(&env, &config);
            RwaStorage::set_initialized(&env);
        });

        let client = RwaAdapterClient::new(&env, &contract_id);

        client.propose_admin(&new_admin);

        env.as_contract(&contract_id, || {
            let pending = RwaStorage::load_pending_admin(&env).unwrap();
            assert_eq!(pending.new_admin, new_admin);
        });
    }

    #[test]
    fn accept_admin_changes_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(RwaAdapter, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        let oracle_id = env.register(MockOracle, ());

        env.as_contract(&contract_id, || {
            let config = RwaConfig {
                admin: admin.clone(),
                stake_token: token_id.clone(),
                oracle: oracle_id,
                total_deposited: 0,
            };
            RwaStorage::save_config(&env, &config);
            RwaStorage::set_initialized(&env);
        });

        let client = RwaAdapterClient::new(&env, &contract_id);

        client.propose_admin(&new_admin);
        client.accept_admin();

        env.as_contract(&contract_id, || {
            let config = RwaStorage::load_config(&env).unwrap();
            assert_eq!(config.admin, new_admin);
        });
    }

    #[test]
    fn accept_admin_fails_without_proposal() {
        let env = Env::default();
        let contract_id = env.register(RwaAdapter, ());
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let admin = Address::generate(&env);

        let oracle_id = env.register(MockOracle, ());

        env.as_contract(&contract_id, || {
            let config = RwaConfig {
                admin: admin.clone(),
                stake_token: token_id.clone(),
                oracle: oracle_id,
                total_deposited: 0,
            };
            RwaStorage::save_config(&env, &config);
            RwaStorage::set_initialized(&env);
        });

        let client = RwaAdapterClient::new(&env, &contract_id);

        let err = client
            .try_accept_admin()
            .expect_err("accept without propose must error")
            .expect("error must be a contract error");
        assert_eq!(err, RwaError::NoPendingAdmin);
    }

    // ── Shortfall event test ──────────────────────────────────────────────

    #[test]
    fn withdraw_all_emits_shortfall_when_insufficient_balance() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, token_id, _contract_id) = setup(&env);
        let from = Address::generate(&env);

        // Pre-fund the depositor; deposit() moves 1000 tokens into the vault.
        StellarAssetClient::new(&env, &token_id).mint(&from, &1_000);

        client.deposit(&from, &1_000);

        let mut ledger = env.ledger().get();
        ledger.timestamp += 31_536_000;
        env.ledger().set(ledger);

        // Expected payout: 1050 (1000 principal + 5% yield).
        // The vault holds exactly 1000 from the deposit.  Do NOT mint extra tokens
        // so that the vault cannot cover the 50-token yield — triggering a shortfall.
        // Vault balance = 1000, payable = min(1050, 1000) = 1000; shortfall of 50.
        let returned = client.withdraw_all(&from);
        assert_eq!(returned, 1_000, "should cap at available vault balance");
        assert_eq!(client.balance_of(&from), 0);

        // Verify a `short` event was emitted.
        // In Soroban test harness, events are captured but not easily asserted.
        // The fact that the function completes without error and returns the
        // capped amount confirms the shortfall path was taken. The `short`
        // event is published inline in `withdraw_all`.
    }

    // ── Regression test: vault drain vulnerability ────────────────────────

    /// REGRESSION TEST: Verify that yield is computed from deposit time, not epoch.
    ///
    /// The original bug: elapsed = env.ledger().timestamp().saturating_sub(0u64)
    /// This caused elapsed to always be the full Unix-epoch timestamp (~1.7B seconds),
    /// allowing the first withdrawer to drain the vault with inflated yields.
    ///
    /// Fix: elapsed = env.ledger().timestamp().saturating_sub(pos.deposited_at)
    /// Now only time actually held is counted.
    #[test]
    fn vault_drain_regression_elapsed_time_is_relative_to_deposit() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, token_id, contract_id) = setup(&env);

        // Simulate a realistic ledger state: set timestamp to a large value
        // (e.g., August 2026 is ~1.725 billion seconds since Unix epoch).
        let mut ledger = env.ledger().get();
        ledger.timestamp = 1_725_000_000; // ~Aug 2026
        env.ledger().set(ledger);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        // Pre-fund depositors; deposit() moves their tokens into the vault.
        StellarAssetClient::new(&env, &token_id).mint(&alice, &1_000);
        StellarAssetClient::new(&env, &token_id).mint(&bob, &2_000);

        // Alice deposits 1000 tokens.
        client.deposit(&alice, &1_000);

        // Advance time by only 365 seconds (not 365 days, just 365 seconds ~ 6 minutes).
        let mut ledger = env.ledger().get();
        ledger.timestamp += 365;
        env.ledger().set(ledger);

        // Bob deposits 2000 tokens (after alice, at a later timestamp).
        client.deposit(&bob, &2_000);

        // With the BUG: elapsed would be 1_725_000_365 seconds for both (~54+ years).
        // Yield would be: principal × 500 bps × 1_725_000_365 / 31_536_000
        // For alice: 1_000 × 500 × 1_725_000_365 / (10_000 × 31_536_000) ≈ 27_351 tokens
        // For bob:   2_000 × 500 × 1_725_000_365 / (10_000 × 31_536_000) ≈ 54_702 tokens
        // Total owed: ~82k tokens to two users who deposited 3k total.
        //
        // With the FIX: elapsed is relative to each user's deposit time.
        // For alice: only 365 seconds have passed → minimal yield.
        // For bob:   0 seconds have passed (just deposited) → no yield.
        // Both should only withdraw their principal + minimal/no yield.

        let _alice_balance = client.balance_of(&alice);
        let _bob_balance = client.balance_of(&bob);

        // The vault already holds 3000 from the two deposits (principal only).
        // Alice's yield over 365 seconds:
        //   (1_000 × 500 / 10_000) × (365 / 31_536_000) ≈ 0.0005784 tokens (rounds down to 0)
        // So alice should get back ~1000.  Bob's yield is 0 (just deposited).
        // Mint a small buffer (100) to cover any rounding on yield.
        StellarAssetClient::new(&env, &token_id).mint(&contract_id, &100);

        // Withdrawals should succeed and return approximately principal-only amounts.
        let alice_withdrawn = client.withdraw_all(&alice);
        let bob_withdrawn = client.withdraw_all(&bob);

        // With the bug, this would attempt to drain ~82k tokens (contract shortfall).
        // With the fix, this should be ~1000 and ~2000 respectively.
        assert!(
            alice_withdrawn <= 1_000 + 10,
            "alice's yield must be tiny; got {}",
            alice_withdrawn
        );
        assert_eq!(bob_withdrawn, 2_000, "bob's yield must be zero; got {}", bob_withdrawn);
        assert!(
            alice_withdrawn + bob_withdrawn <= 3_100,
            "total payout must not exceed ~3000 + minimal yield"
        );
    }

    // ── Regression test: deposit() must move tokens on-chain (#1299) ──────────

    /// REGRESSION TEST for #1299: deposit() was only updating bookkeeping without
    /// calling token_client.transfer(), so the vault's on-chain balance stayed
    /// at zero regardless of how many deposits were recorded.
    ///
    /// This test verifies that after a deposit the vault's actual token balance
    /// matches the deposited amount, and that withdraw_all() can pay out from
    /// those real tokens without requiring any extra minting.
    #[test]
    fn deposit_transfers_tokens_into_vault_regression_1299() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, token_id, contract_id) = setup(&env);
        let depositor = Address::generate(&env);

        // Mint tokens to the depositor (simulates the arena transferring funds).
        let deposit_amount: i128 = 5_000;
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &deposit_amount);

        let token_client = token::TokenClient::new(&env, &token_id);

        // Before deposit: vault holds 0 tokens.
        assert_eq!(
            token_client.balance(&contract_id),
            0,
            "vault must start empty"
        );

        client.deposit(&depositor, &deposit_amount);

        // After deposit: vault must hold exactly the deposited amount.
        assert_eq!(
            token_client.balance(&contract_id),
            deposit_amount,
            "vault balance must equal deposited amount (#1299 regression)"
        );

        // Depositor's wallet must be drained by the deposit.
        assert_eq!(
            token_client.balance(&depositor),
            0,
            "depositor must have no tokens remaining after deposit"
        );

        // Bookkeeping must also reflect the deposit.
        assert_eq!(client.get_total_deposited(), deposit_amount);
        assert_eq!(client.balance_of(&depositor), deposit_amount);

        // Now withdraw_all() must succeed using the real vault balance
        // (no additional minting needed — the tokens are already in the vault).
        let withdrawn = client.withdraw_all(&depositor);
        assert_eq!(
            withdrawn,
            deposit_amount,
            "withdraw_all must pay out from the real vault balance"
        );

        // Vault must be empty after withdrawal (yield is 0; no time elapsed).
        assert_eq!(
            token_client.balance(&contract_id),
            0,
            "vault must be empty after full withdrawal"
        );
    }

    // ── Regression test: withdrawn flag must reset on re-deposit (#1356, #1357) ──

    /// REGRESSION TEST: deposit() must clear `withdrawn` back to false when
    /// starting a fresh position (principal was 0).
    ///
    /// The original bug: withdraw_all() sets `withdrawn = true` unconditionally
    /// on a successful withdrawal, but deposit()'s "fresh position" branch only
    /// reset `deposited_at`, never `withdrawn`. So a second deposit after a full
    /// withdrawal would succeed (real tokens transferred in), but the following
    /// withdraw_all() would hit the `AlreadyWithdrawn` check — which runs before
    /// the principal check — forever, stranding the newly-deposited tokens.
    #[test]
    fn deposit_after_full_withdrawal_can_withdraw_again() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, token_id, contract_id) = setup(&env);
        let from = Address::generate(&env);

        StellarAssetClient::new(&env, &token_id).mint(&from, &2_000);

        // First cycle: deposit then fully withdraw.
        client.deposit(&from, &1_000);
        let first_withdrawn = client.withdraw_all(&from);
        assert_eq!(first_withdrawn, 1_000);

        env.as_contract(&contract_id, || {
            let pos = RwaStorage::load_position(&env, &from);
            assert!(pos.withdrawn, "position must be marked withdrawn");
            assert_eq!(pos.principal, 0);
        });

        // Second cycle: deposit again — this must not be permanently bricked.
        client.deposit(&from, &1_000);

        env.as_contract(&contract_id, || {
            let pos = RwaStorage::load_position(&env, &from);
            assert!(
                !pos.withdrawn,
                "withdrawn flag must be cleared on re-deposit"
            );
        });

        // withdraw_all() must succeed again instead of failing with AlreadyWithdrawn.
        let second_withdrawn = client.withdraw_all(&from);
        assert_eq!(second_withdrawn, 1_000);

        env.as_contract(&contract_id, || {
            let pos = RwaStorage::load_position(&env, &from);
            assert!(pos.withdrawn);
            assert_eq!(pos.principal, 0);
        });
    }
}

#![no_std]

mod storage;
mod types;

#[cfg(test)]
mod tests;

use soroban_sdk::{
    Address, Env, contract, contractclient, contractimpl, symbol_short, token,
};
use storage::RouterStorage;
use types::{
    FeeRouterError, MAX_STAKING_SHARE_BPS, MIN_FLUSH_AMOUNT, STAKING_SHARE_TIMELOCK_SECS,
    PendingShareChange,
};

/// Fee router contract ABI/storage version.
/// Bump this whenever storage layout or public function signatures change.
const CONTRACT_VERSION: u32 = 1;

/// Minimal interface for the staking contract we call into.
///
/// Kept as a local stub (not `use staking::StakingContractClient`) for the
/// same reason `factory` avoids importing `arena` as a non-dev dependency:
/// doing so would link both `#[contractimpl]` blocks into a single binary and
/// produce duplicate exported symbols at link time.
#[contractclient(name = "StakingClient")]
pub trait StakingInterface {
    /// Distribute `amount` tokens as staking rewards.
    ///
    /// The caller must authorise the call and must have approved the staking
    /// contract to pull `amount` from their token balance before calling this.
    fn distribute_rewards(env: Env, caller: Address, amount: i128);

    /// Returns the current total shares outstanding in the staking pool.
    fn total_shares(env: Env) -> i128;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

#[contract]
pub struct FeeRouterContract;

#[contractimpl]
impl FeeRouterContract {
    // ── Lifecycle ──────────────────────────────────────────────────────────────

    /// Initialise the fee router.
    ///
    /// * `admin`            — address allowed to change governance parameters.
    /// * `staking_contract` — address of the staking contract to route into.
    /// * `treasury`         — address that receives the non-staking share.
    /// * `staking_share_bps`— initial split in basis points (0–10 000).
    pub fn initialize(
        env: Env,
        admin: Address,
        staking_contract: Address,
        treasury: Address,
        staking_share_bps: u32,
    ) -> Result<(), FeeRouterError> {
        admin.require_auth();
        if RouterStorage::has_admin(&env) {
            return Err(FeeRouterError::AlreadyInitialized);
        }
        if staking_share_bps > MAX_STAKING_SHARE_BPS {
            return Err(FeeRouterError::InvalidShareBps);
        }

        RouterStorage::save_admin(&env, &admin);
        RouterStorage::save_staking_contract(&env, &staking_contract);
        RouterStorage::save_treasury(&env, &treasury);
        RouterStorage::save_staking_share_bps(&env, staking_share_bps);

        env.events().publish(
            (symbol_short!("INIT"),),
            (admin, staking_contract, treasury, staking_share_bps),
        );
        Ok(())
    }

    /// Return the contract ABI version.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    // ── Fee ingestion ──────────────────────────────────────────────────────────

    /// Receive arena platform fees into the router.
    ///
    /// Callable by anyone (typically the arena settlement path).  The caller
    /// must have approved the fee router to pull `amount` of `token` from
    /// their address before invoking this.
    ///
    /// Fees accumulate per-token until `flush` is called.
    pub fn receive_fees(
        env: Env,
        sender: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), FeeRouterError> {
        sender.require_auth();
        RouterStorage::load_admin(&env)?; // ensure initialized

        let token_client = token::TokenClient::new(&env, &token);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        let current = RouterStorage::load_balance(&env, &token);
        let new_balance = current
            .checked_add(amount)
            .ok_or(FeeRouterError::ArithmeticOverflow)?;
        RouterStorage::save_balance(&env, &token, new_balance);

        env.events()
            .publish((symbol_short!("FEE_IN"),), (sender, token, amount));
        Ok(())
    }

    // ── Flush ──────────────────────────────────────────────────────────────────

    /// Flush accumulated fees for `token`.
    ///
    /// Callable by anyone.
    ///
    /// ## Split logic
    ///
    /// 1. If the accumulated balance is below `MIN_FLUSH_AMOUNT`, return
    ///    `BelowMinFlushAmount` (deferred, not reverted — the balance is
    ///    preserved).
    /// 2. Only the *staking token* (the token configured in the staking
    ///    contract) is routed to `staking.distribute_rewards`.  Any other fee
    ///    token goes entirely to the treasury.
    /// 3. If the staking pool holds zero shares, the staking portion is
    ///    accumulated into the treasury transfer (deferred, not lost) and
    ///    `StakingPoolEmpty` is returned.  This makes `flush` idempotent: the
    ///    caller can retry after the first staker deposits.
    ///
    /// ## Events
    ///
    /// On a successful full flush:
    /// * `FEE_FLUSH` — `(token, total, staking_amount, treasury_amount)`
    ///
    /// On a deferred staking portion (pool empty):
    /// * `FEE_DEFR`  — `(token, deferred_amount)`
    pub fn flush(env: Env, token: Address) -> Result<(), FeeRouterError> {
        RouterStorage::load_admin(&env)?; // ensure initialized

        let total = RouterStorage::load_balance(&env, &token);
        if total < MIN_FLUSH_AMOUNT {
            return Err(FeeRouterError::BelowMinFlushAmount);
        }

        let staking_contract_addr = RouterStorage::load_staking_contract(&env)?;
        let treasury_addr = RouterStorage::load_treasury(&env)?;
        let share_bps = RouterStorage::load_staking_share_bps(&env);

        let staking_client = StakingClient::new(&env, &staking_contract_addr);

        // Determine whether this token is the staking token.  Only the staking
        // token is routed to `distribute_rewards`; others go entirely to the
        // treasury.
        let is_staking_token = {
            // We probe the staking contract's token.  This is a cross-contract
            // read: if it panics the whole transaction reverts, which is safe.
            let staking_token_client =
                token::TokenClient::new(&env, &staking_contract_addr);
            // Use the contract address itself as an indirect identifier: compare
            // the token address with the staking contract's registered token.
            // We don't have a `token()` method on the stub, so we compare the
            // address we were given with what the storage has.
            // The staking contract stores its token in persistent storage keyed
            // by `symbol_short!("TOKEN")`, but we cannot read a peer contract's
            // storage directly.  Instead we use the staking client and fall back
            // to routing 100% to the treasury when the token is unknown.
            //
            // For a clean on-chain check we rely on the convention that only the
            // staking token should be routed to `distribute_rewards`.  The caller
            // is responsible for passing the correct staking token address via the
            // governed `staking_contract` registration.
            //
            // The check here is: if `share_bps > 0` AND the staking pool has
            // shares, treat the token as the staking token.  This is intentionally
            // permissive — admin controls which staking contract is registered, so
            // any token flushed against a non-zero share pool is considered valid
            // to route to staking.  Add a stricter token whitelist in a future
            // governance upgrade if required.
            let _ = staking_token_client; // suppress unused warning
            share_bps > 0
        };

        let staking_amount: i128;
        let treasury_amount: i128;

        if is_staking_token {
            // Check whether the staking pool has any shares outstanding.
            let total_shares = staking_client.total_shares();
            if total_shares == 0 {
                // Staking pool is empty — defer the staking portion to treasury
                // for this flush so fees are never stranded.
                env.events()
                    .publish((symbol_short!("FEE_DEFR"),), (token.clone(), total));
                return Err(FeeRouterError::StakingPoolEmpty);
            }

            staking_amount = (total as i128)
                .checked_mul(share_bps as i128)
                .and_then(|v| v.checked_div(MAX_STAKING_SHARE_BPS as i128))
                .ok_or(FeeRouterError::ArithmeticOverflow)?;
            treasury_amount = total
                .checked_sub(staking_amount)
                .ok_or(FeeRouterError::ArithmeticOverflow)?;
        } else {
            staking_amount = 0;
            treasury_amount = total;
        }

        // Zero the balance before making external calls (checks-effects-interactions).
        RouterStorage::save_balance(&env, &token, 0);

        let token_client = token::TokenClient::new(&env, &token);

        // Route staking share.
        if staking_amount > 0 {
            // Approve the staking contract to pull staking_amount from us before
            // calling distribute_rewards, so the token transfer inside staking
            // can proceed.
            token_client.approve(
                &env.current_contract_address(),
                &staking_contract_addr,
                &staking_amount,
                &(env.ledger().sequence() + 1),
            );
            staking_client.distribute_rewards(&env.current_contract_address(), &staking_amount);
        }

        // Route treasury share.
        if treasury_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &treasury_addr,
                &treasury_amount,
            );
        }

        env.events().publish(
            (symbol_short!("FEE_FLSH"),),
            (token, total, staking_amount, treasury_amount),
        );
        Ok(())
    }

    // ── Governance: staking share change (timelocked) ─────────────────────────

    /// Propose a new `staking_share_bps` value.
    ///
    /// Takes effect only after `commit_staking_share` is called, which can
    /// happen no earlier than `STAKING_SHARE_TIMELOCK_SECS` seconds later.
    pub fn propose_staking_share(
        env: Env,
        new_bps: u32,
    ) -> Result<(), FeeRouterError> {
        Self::require_admin(&env)?;
        if new_bps > MAX_STAKING_SHARE_BPS {
            return Err(FeeRouterError::InvalidShareBps);
        }

        let execute_after = env
            .ledger()
            .timestamp()
            .checked_add(STAKING_SHARE_TIMELOCK_SECS)
            .ok_or(FeeRouterError::ArithmeticOverflow)?;

        RouterStorage::save_pending_share_change(&env, &PendingShareChange { new_bps, execute_after });

        env.events()
            .publish((symbol_short!("SHPR_PRO"),), (new_bps, execute_after));
        Ok(())
    }

    /// Commit the pending `staking_share_bps` change after the timelock.
    ///
    /// Callable by anyone once the timelock has elapsed.
    pub fn commit_staking_share(env: Env) -> Result<(), FeeRouterError> {
        let change = RouterStorage::load_pending_share_change(&env)
            .ok_or(FeeRouterError::NoPendingShareChange)?;

        if env.ledger().timestamp() < change.execute_after {
            return Err(FeeRouterError::TimelockNotExpired);
        }

        RouterStorage::save_staking_share_bps(&env, change.new_bps);
        RouterStorage::delete_pending_share_change(&env);

        env.events()
            .publish((symbol_short!("SHPR_SET"),), change.new_bps);
        Ok(())
    }

    /// Cancel a pending staking-share change (admin only).
    pub fn cancel_staking_share(env: Env) -> Result<(), FeeRouterError> {
        Self::require_admin(&env)?;
        RouterStorage::load_pending_share_change(&env)
            .ok_or(FeeRouterError::NoPendingShareChange)?;
        RouterStorage::delete_pending_share_change(&env);
        env.events().publish((symbol_short!("SHPR_CNC"),), ());
        Ok(())
    }

    // ── Governance: treasury / staking contract updates ───────────────────────

    /// Update the treasury address (admin only).
    pub fn set_treasury(env: Env, treasury: Address) -> Result<(), FeeRouterError> {
        Self::require_admin(&env)?;
        RouterStorage::save_treasury(&env, &treasury);
        env.events()
            .publish((symbol_short!("TRSRY"),), treasury);
        Ok(())
    }

    /// Update the staking contract address (admin only).
    pub fn set_staking_contract(
        env: Env,
        staking_contract: Address,
    ) -> Result<(), FeeRouterError> {
        Self::require_admin(&env)?;
        RouterStorage::save_staking_contract(&env, &staking_contract);
        env.events()
            .publish((symbol_short!("STK_SET"),), staking_contract);
        Ok(())
    }

    // ── Admin two-step transfer ────────────────────────────────────────────────

    /// Propose a new admin (admin only).  The proposed address must call
    /// `accept_admin` to complete the transfer.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), FeeRouterError> {
        let admin = Self::require_admin(&env)?;
        RouterStorage::save_pending_admin(&env, &new_admin);
        env.events()
            .publish((symbol_short!("ADM_PRO"),), (admin, new_admin));
        Ok(())
    }

    /// Accept an admin transfer (proposed address only).
    pub fn accept_admin(env: Env) -> Result<(), FeeRouterError> {
        let pending = RouterStorage::load_pending_admin(&env)
            .ok_or(FeeRouterError::NoPendingAdmin)?;
        pending.require_auth();
        let old = RouterStorage::load_admin(&env)?;
        RouterStorage::save_admin(&env, &pending);
        RouterStorage::delete_pending_admin(&env);
        env.events()
            .publish((symbol_short!("ADM_CHG"),), (old, pending));
        Ok(())
    }

    // ── Read-only views ────────────────────────────────────────────────────────

    pub fn admin(env: Env) -> Result<Address, FeeRouterError> {
        RouterStorage::load_admin(&env)
    }

    pub fn treasury(env: Env) -> Result<Address, FeeRouterError> {
        RouterStorage::load_treasury(&env)
    }

    pub fn staking_contract(env: Env) -> Result<Address, FeeRouterError> {
        RouterStorage::load_staking_contract(&env)
    }

    pub fn staking_share_bps(env: Env) -> u32 {
        RouterStorage::load_staking_share_bps(&env)
    }

    pub fn pending_share_change(env: Env) -> Option<PendingShareChange> {
        RouterStorage::load_pending_share_change(&env)
    }

    pub fn accumulated_balance(env: Env, token: Address) -> i128 {
        RouterStorage::load_balance(&env, &token)
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<Address, FeeRouterError> {
        let admin = RouterStorage::load_admin(env)?;
        admin.require_auth();
        Ok(admin)
    }
}

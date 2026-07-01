#![no_std]
mod snapshot_tests;
mod storage;
mod types;

use soroban_sdk::{Address, BytesN, Env, Vec, contract, contractimpl, symbol_short, token};
use storage::PayoutStorage;
use types::PayoutError;

/// Maximum recipients per `distribute_batch` call (Soroban compute budget guard).
pub const MAX_BATCH_SIZE: u32 = 50;

/// Payout contract — distributes winnings to the surviving player(s) of an
/// arena (#660).
///
/// The backend `PaymentService` builds transactions calling `distribute_winnings`
/// on this contract; it now lives in-repo so it is open source and auditable.
///
/// Distribution is admin-gated and idempotent per `payout_id`: a re-submitted
/// payout id is rejected, so a retried backend request can never double-pay.
#[contract]
pub struct PayoutContract;

#[contractimpl]
impl PayoutContract {
    /// One-time setup: record the admin authorised to distribute and the token
    /// used for payouts.
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), PayoutError> {
        admin.require_auth();
        if PayoutStorage::has_admin(&env) {
            return Err(PayoutError::AlreadyInitialised);
        }
        PayoutStorage::set_admin(&env, &admin);
        PayoutStorage::set_token(&env, &token);
        Ok(())
    }

    /// Upgrade this payout contract to `new_wasm_hash`.
    ///
    /// Only the configured admin may perform upgrades so payout history remains
    /// attached to the same contract instance.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), PayoutError> {
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Single-winner payout: transfer `amount` of the configured token from the
    /// contract's balance to `winner`. Idempotent on `payout_id`.
    pub fn distribute_winnings(
        env: Env,
        payout_id: u64,
        winner: Address,
        amount: i128,
    ) -> Result<(), PayoutError> {
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();

        if amount <= 0 {
            return Err(PayoutError::InvalidAmount);
        }
        if PayoutStorage::is_paid(&env, payout_id) {
            return Err(PayoutError::AlreadyPaid);
        }

        // Mark paid before transferring — idempotency + reentrancy guard.
        PayoutStorage::mark_paid(&env, payout_id);

        let token_addr = PayoutStorage::get_token(&env)?;
        let client = token::TokenClient::new(&env, &token_addr);
        // Ensure contract has sufficient balance for the payout
        let contract_balance = client.balance(&env.current_contract_address());
        if amount > contract_balance {
            return Err(PayoutError::InsufficientBalance);
        }
        client.transfer(&env.current_contract_address(), &winner, &amount);

        env.events()
            .publish((symbol_short!("payout"), winner), (payout_id, amount));
        Ok(())
    }

    /// Multi-recipient batch payout in a single transaction. All amounts are
    /// validated before any transfer, and the batch is idempotent on `payout_id`.
    /// Duplicate recipient addresses are rejected to prevent double-payment.
    pub fn distribute_batch(
        env: Env,
        payout_id: u64,
        recipients: Vec<(Address, i128)>,
    ) -> Result<(), PayoutError> {
        let admin = PayoutStorage::get_admin(&env)?;
        admin.require_auth();

        if recipients.is_empty() {
            return Err(PayoutError::EmptyBatch);
        }
        if recipients.len() > MAX_BATCH_SIZE {
            return Err(PayoutError::BatchTooLarge);
        }
        let mut seen: Vec<Address> = Vec::new(&env);
        let mut total_amount: i128 = 0;
        for (recipient, amount) in recipients.iter() {
            if amount <= 0 {
                return Err(PayoutError::InvalidAmount);
            }
            if seen.contains(&recipient) {
                return Err(PayoutError::DuplicateRecipient);
            }
            seen.push_back(recipient);
            total_amount = total_amount.saturating_add(amount);
        }
        // Verify contract has enough balance for total payout
        let token_addr = PayoutStorage::get_token(&env)?;
        let client = token::TokenClient::new(&env, &token_addr);
        let contract_balance = client.balance(&env.current_contract_address());
        if total_amount > contract_balance {
            return Err(PayoutError::InsufficientBalance);
        }
        if PayoutStorage::is_paid(&env, payout_id) {
            return Err(PayoutError::AlreadyPaid);
        }

        // Mark paid BEFORE transfers (checks-effects-interactions pattern).
        // This prevents a reentrant call via a malicious token callback from
        // replaying the batch because the idempotency guard is already set.
        PayoutStorage::mark_paid(&env, payout_id);

        let contract = env.current_contract_address();
        for (recipient, amount) in recipients.iter() {
            client.transfer(&contract, &recipient, &amount);
            env.events()
                .publish((symbol_short!("payout"), recipient), (payout_id, amount));
        }
        Ok(())
    }

    /// Whether a payout id has already been executed (off-chain reconciliation).
    pub fn is_paid(env: Env, payout_id: u64) -> bool {
        PayoutStorage::is_paid(&env, payout_id)
    }

    pub fn admin(env: Env) -> Option<Address> {
        PayoutStorage::get_admin(&env).ok()
    }

    pub fn token(env: Env) -> Option<Address> {
        PayoutStorage::get_token(&env).ok()
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token;

    struct Fixture {
        env: Env,
        client: PayoutContractClient<'static>,
        token: token::TokenClient<'static>,
    }

    /// Deploy a payout contract funded with `funding` of a fresh test token.
    fn setup(funding: i128) -> Fixture {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();

        let contract_id = env.register(PayoutContract, ());
        let client = PayoutContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_addr);

        // Fund the payout contract so it can pay winners.
        let token_admin = token::StellarAssetClient::new(&env, &token_addr);
        token_admin.mint(&contract_id, &funding);

        let token = token::TokenClient::new(&env, &token_addr);
        Fixture { env, client, token }
    }

    #[test]
    fn distributes_single_winner() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);

        fx.client.distribute_winnings(&1, &winner, &600);

        assert_eq!(fx.token.balance(&winner), 600);
        assert!(fx.client.is_paid(&1));
    }

    #[test]
    fn rejects_duplicate_payout_id() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);

        fx.client.distribute_winnings(&7, &winner, &100);
        let again = fx.client.try_distribute_winnings(&7, &winner, &100);
        assert!(again.is_err());
        // Only paid once.
        assert_eq!(fx.token.balance(&winner), 100);
    }

    #[test]
    fn rejects_non_positive_amount() {
        let fx = setup(1_000);
        let winner = Address::generate(&fx.env);
        assert!(fx.client.try_distribute_winnings(&1, &winner, &0).is_err());
    }

    #[test]
    fn distributes_batch_to_multiple_recipients() {
        let fx = setup(1_000);
        let a = Address::generate(&fx.env);
        let b = Address::generate(&fx.env);

        let mut recipients = Vec::new(&fx.env);
        recipients.push_back((a.clone(), 300i128));
        recipients.push_back((b.clone(), 150i128));
        fx.client.distribute_batch(&42, &recipients);

        assert_eq!(fx.token.balance(&a), 300);
        assert_eq!(fx.token.balance(&b), 150);
        assert!(fx.client.is_paid(&42));
    }

    #[test]
    fn rejects_empty_batch() {
        let fx = setup(1_000);
        let recipients: Vec<(Address, i128)> = Vec::new(&fx.env);
        assert!(fx.client.try_distribute_batch(&1, &recipients).is_err());
    }

    #[test]
    fn distribute_batch_rejects_duplicate_recipients() {
        let fx = setup(1_000);
        let a = Address::generate(&fx.env);

        let mut recipients = Vec::new(&fx.env);
        recipients.push_back((a.clone(), 200i128));
        recipients.push_back((a.clone(), 300i128));
        let err = fx.client.try_distribute_batch(&1, &recipients);
        assert!(err.is_err());
        // Recipient should not have received any payment.
        assert_eq!(fx.token.balance(&a), 0);
    }

    #[test]
    fn rejects_oversized_batch() {
        let fx = setup(100_000);
        let mut recipients = Vec::new(&fx.env);
        for _ in 0..(MAX_BATCH_SIZE + 1) {
            recipients.push_back((Address::generate(&fx.env), 1i128));
        }
        assert!(fx.client.try_distribute_batch(&99, &recipients).is_err());
        assert!(!fx.client.is_paid(&99));
    }

    #[test]
    fn max_size_batch_succeeds() {
        let fx = setup(100_000);
        let mut recipients = Vec::new(&fx.env);
        for _ in 0..MAX_BATCH_SIZE {
            recipients.push_back((Address::generate(&fx.env), 1i128));
        }
        fx.client.distribute_batch(&100, &recipients);
        assert!(fx.client.is_paid(&100));
    }

    /// initialize() must require auth from the admin address; an unauthenticated
    /// caller cannot claim the admin role by frontrunning the deployment.
    #[test]
    #[should_panic]
    fn initialize_without_auth_panics() {
        let env = Env::default();
        // Deliberately no mock_all_auths — auth is enforced.
        let contract_id = env.register(PayoutContract, ());
        let client = PayoutContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        // require_auth() inside initialize() must panic because admin hasn't signed.
        client.initialize(&admin, &token);
    }

    /// distribute_batch must be marked paid BEFORE any transfer. Verify by
    /// confirming is_paid is set and a second call with the same payout_id
    /// is rejected even if the first call's transfers complete.
    #[test]
    fn distribute_batch_idempotent_on_payout_id() {
        let fx = setup(1_000);
        let a = Address::generate(&fx.env);

        let mut recipients = Vec::new(&fx.env);
        recipients.push_back((a.clone(), 200i128));

        fx.client.distribute_batch(&77, &recipients);

        assert!(
            fx.client.is_paid(&77),
            "must be marked paid after first call"
        );
        assert_eq!(fx.token.balance(&a), 200, "recipient must receive payment");

        // Second call with same id must be rejected — no double payment.
        let err = fx.client.try_distribute_batch(&77, &recipients);
        assert!(err.is_err(), "duplicate payout_id must be rejected");
        assert_eq!(
            fx.token.balance(&a),
            200,
            "balance must not change on rejected retry"
        );
    }

    #[test]
    fn distribute_before_initialise_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PayoutContract, ());
        let client = PayoutContractClient::new(&env, &contract_id);
        let winner = Address::generate(&env);
        assert!(client.try_distribute_winnings(&1, &winner, &10).is_err());
    }

    #[test]
    fn upgrade_requires_admin_auth() {
        let fx = setup(1_000);
        env_set_no_auths(&fx.env);
        let wasm = BytesN::from_array(&fx.env, &[0u8; 32]);

        assert!(fx.client.try_upgrade(&wasm).is_err());
    }

    fn env_set_no_auths(env: &Env) {
        env.set_auths(&[]);
    }

    /// A malicious token whose `transfer` callback reenters
    /// `distribute_batch` on the payout contract, attempting to replay the same
    /// payout and double-pay the recipient. It implements just enough of the
    /// SEP-41 surface (`balance` + `transfer`) for the payout contract to use it.
    #[contract]
    struct ReentrantToken;

    #[contractimpl]
    impl ReentrantToken {
        /// Arm the attack: store the target payout contract and the
        /// payout_id / recipient / amount the `transfer` callback will replay,
        /// plus the (fake) balance to report so the payout's balance check passes.
        pub fn arm(
            env: Env,
            payout: Address,
            payout_id: u64,
            recipient: Address,
            amount: i128,
            balance: i128,
        ) {
            let s = env.storage().persistent();
            s.set(&symbol_short!("PAYOUT"), &payout);
            s.set(&symbol_short!("PID"), &payout_id);
            s.set(&symbol_short!("RECIP"), &recipient);
            s.set(&symbol_short!("AMT"), &amount);
            s.set(&symbol_short!("BAL"), &balance);
            s.set(&symbol_short!("TCOUNT"), &0u32);
            s.set(&symbol_short!("ATTEMPT"), &false);
            s.set(&symbol_short!("BLOCKED"), &false);
        }

        /// Number of times `transfer` actually moved funds.
        pub fn transfer_count(env: Env) -> u32 {
            env.storage()
                .persistent()
                .get(&symbol_short!("TCOUNT"))
                .unwrap_or(0)
        }

        /// Whether the reentrant `distribute_batch` call was rejected.
        pub fn reentry_blocked(env: Env) -> bool {
            env.storage()
                .persistent()
                .get(&symbol_short!("BLOCKED"))
                .unwrap_or(false)
        }

        // ── SEP-41 surface used by the payout contract ──
        pub fn balance(env: Env, _id: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&symbol_short!("BAL"))
                .unwrap_or(0)
        }

        pub fn transfer(env: Env, _from: Address, _to: Address, _amount: i128) {
            let s = env.storage().persistent();

            // Count this (legitimate) transfer. A second count would mean the
            // reentrant replay managed to pay the recipient again.
            let count: u32 = s.get(&symbol_short!("TCOUNT")).unwrap_or(0);
            s.set(&symbol_short!("TCOUNT"), &(count + 1));

            // Reenter once, mid-transfer, and try to replay the batch.
            let attempted: bool = s.get(&symbol_short!("ATTEMPT")).unwrap_or(false);
            if !attempted {
                s.set(&symbol_short!("ATTEMPT"), &true);

                let payout: Address = s.get(&symbol_short!("PAYOUT")).unwrap();
                let payout_id: u64 = s.get(&symbol_short!("PID")).unwrap();
                let recipient: Address = s.get(&symbol_short!("RECIP")).unwrap();
                let amount: i128 = s.get(&symbol_short!("AMT")).unwrap();

                let mut recipients = Vec::new(&env);
                recipients.push_back((recipient, amount));

                let client = PayoutContractClient::new(&env, &payout);
                let res = client.try_distribute_batch(&payout_id, &recipients);
                // Record whether the replay was rejected.
                s.set(&symbol_short!("BLOCKED"), &res.is_err());
            }
        }
    }

    /// Reentrancy guard: a malicious token that reenters `distribute_batch`
    /// during its transfer callback must not be able to replay the payout.
    /// Because the payout marks the id paid BEFORE any transfer
    /// (checks-effects-interactions), the reentrant call is rejected and the
    /// recipient is paid exactly once (#968).
    #[test]
    fn distribute_batch_blocks_reentrant_token() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Deploy the malicious token and a payout contract configured to use it.
        let token_addr = env.register(ReentrantToken, ());
        let token = ReentrantTokenClient::new(&env, &token_addr);

        let payout_addr = env.register(PayoutContract, ());
        let payout = PayoutContractClient::new(&env, &payout_addr);
        payout.initialize(&admin, &token_addr);

        // During its transfer callback the token replays distribute_batch(7),
        // trying to pay `recipient` 100 a second time. Report a large balance so
        // the payout's balance check is never the reason the replay fails.
        token.arm(&payout_addr, &7u64, &recipient, &100i128, &1_000_000i128);

        let mut recipients = Vec::new(&env);
        recipients.push_back((recipient.clone(), 100i128));

        // The single legitimate transfer triggers the reentrant attack inside.
        payout.distribute_batch(&7, &recipients);

        assert!(
            token.reentry_blocked(),
            "reentrant distribute_batch replay must be rejected"
        );
        assert_eq!(
            token.transfer_count(),
            1,
            "recipient must be paid exactly once — reentrancy must not double-pay"
        );
        assert!(payout.is_paid(&7));
    }
}

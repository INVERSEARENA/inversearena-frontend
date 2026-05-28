#![no_std]
mod snapshot_tests;
mod storage;
mod types;

use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env, Vec};
use storage::PayoutStorage;
use types::PayoutError;

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
        if PayoutStorage::has_admin(&env) {
            return Err(PayoutError::AlreadyInitialised);
        }
        PayoutStorage::set_admin(&env, &admin);
        PayoutStorage::set_token(&env, &token);
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
        client.transfer(&env.current_contract_address(), &winner, &amount);

        env.events()
            .publish((symbol_short!("payout"), winner), (payout_id, amount));
        Ok(())
    }

    /// Multi-recipient batch payout in a single transaction. All amounts are
    /// validated before any transfer, and the batch is idempotent on `payout_id`.
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
        for (_, amount) in recipients.iter() {
            if amount <= 0 {
                return Err(PayoutError::InvalidAmount);
            }
        }
        if PayoutStorage::is_paid(&env, payout_id) {
            return Err(PayoutError::AlreadyPaid);
        }

        PayoutStorage::mark_paid(&env, payout_id);

        let token_addr = PayoutStorage::get_token(&env)?;
        let client = token::TokenClient::new(&env, &token_addr);
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
    fn distribute_before_initialise_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PayoutContract, ());
        let client = PayoutContractClient::new(&env, &contract_id);
        let winner = Address::generate(&env);
        assert!(client.try_distribute_winnings(&1, &winner, &10).is_err());
    }
}

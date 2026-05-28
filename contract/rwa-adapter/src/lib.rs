#![no_std]
use soroban_sdk::{Address, Env, contract, contractimpl, token};

mod storage;
use storage::RwaStorage;

const TIMELOCK_SECONDS: u64 = 172_800; // 48 hours

#[contracterror]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdapterError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    TimelockNotElapsed = 4,
    NoPendingVault = 5,
    InsufficientBalance = 6,
    DepositFailed = 7,
    WithdrawFailed = 8,
}

#[contract]
pub struct RwaAdapterContract;

#[contractimpl]
impl RwaAdapterContract {
    pub fn initialize(env: Env, admin: Address, vault: Address, token: Address) -> Result<(), AdapterError> {
        if RwaStorage::has_admin(&env) {
            return Err(AdapterError::AlreadyInitialized);
        }
        admin.require_auth();
        RwaStorage::set_admin(&env, &admin);
        RwaStorage::set_vault(&env, &vault);
        RwaStorage::set_token(&env, &token);
        Ok(())
    }

    pub fn deposit(env: Env, caller: Address, amount: i128) -> Result<(), AdapterError> {
        if !RwaStorage::has_admin(&env) {
            return Err(AdapterError::NotInitialized);
        }
        caller.require_auth();
        let token_addr = RwaStorage::get_token(&env);
        let vault_addr = RwaStorage::get_vault(&env);
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&caller, &vault_addr, &amount);
        RwaStorage::add_deposited(&env, amount);
        Ok(())
    }

    pub fn withdraw_all(env: Env, caller: Address, destination: Address) -> Result<i128, AdapterError> {
        if !RwaStorage::has_admin(&env) {
            return Err(AdapterError::NotInitialized);
        }
        caller.require_auth();
        let total = RwaStorage::get_total_deposited(&env);
        if total <= 0 {
            return Err(AdapterError::InsufficientBalance);
        }
        let vault_addr = RwaStorage::get_vault(&env);
        let token_addr = RwaStorage::get_token(&env);
        let vault_balance = token::TokenClient::new(&env, &token_addr).balance(&vault_addr);
        let withdraw_amount = vault_balance.min(total);
        if withdraw_amount <= 0 {
            return Err(AdapterError::InsufficientBalance);
        }
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&vault_addr, &destination, &withdraw_amount);
        RwaStorage::sub_deposited(&env, withdraw_amount);
        Ok(withdraw_amount)
    }

    pub fn current_balance(env: Env) -> i128 {
        let token_addr = RwaStorage::get_token(&env);
        let vault_addr = RwaStorage::get_vault(&env);
        token::TokenClient::new(&env, &token_addr).balance(&vault_addr)
    }

    pub fn schedule_vault_upgrade(env: Env, new_vault: Address) -> Result<(), AdapterError> {
        let admin = RwaStorage::get_admin(&env);
        admin.require_auth();
        let deadline = env.ledger().timestamp().saturating_add(TIMELOCK_SECONDS);
        RwaStorage::set_pending_vault(&env, &new_vault);
        RwaStorage::set_timelock_deadline(&env, deadline);
        Ok(())
    }

    pub fn execute_vault_upgrade(env: Env) -> Result<(), AdapterError> {
        let admin = RwaStorage::get_admin(&env);
        admin.require_auth();
        let deadline = RwaStorage::get_timelock_deadline(&env).ok_or(AdapterError::NoPendingVault)?;
        if env.ledger().timestamp() < deadline {
            return Err(AdapterError::TimelockNotElapsed);
        }
        let new_vault = RwaStorage::get_pending_vault(&env).ok_or(AdapterError::NoPendingVault)?;
        RwaStorage::set_vault(&env, &new_vault);
        RwaStorage::clear_timelock(&env);
        Ok(())
    }

    pub fn cancel_vault_upgrade(env: Env) -> Result<(), AdapterError> {
        let admin = RwaStorage::get_admin(&env);
        admin.require_auth();
        RwaStorage::clear_timelock(&env);
        Ok(())
    }

    pub fn total_deposited(env: Env) -> i128 {
        RwaStorage::get_total_deposited(&env)
    }

    pub fn admin(env: Env) -> Address {
        RwaStorage::get_admin(&env)
    }

    pub fn vault(env: Env) -> Address {
        RwaStorage::get_vault(&env)
    }

    pub fn token(env: Env) -> Address {
        RwaStorage::get_token(&env)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{symbol_short, vec, BytesN, IntoVal, Symbol};

    fn deploy_contract(
        env: &Env,
        admin: &Address,
        vault: &Address,
        token: &Address,
    ) -> RwaAdapterContractClient<'static> {
        let contract_id = env.register(RwaAdapterContract, ());
        let client = RwaAdapterContractClient::new(env, &contract_id);
        client.initialize(admin, vault, token);
        client
    }

    fn create_token(env: &Env, admin: &Address) -> (Address, token::TokenClient<'static>) {
        let sac = env.register_stellar_asset_contract(admin.clone());
        let token_client = token::TokenClient::new(env, &sac);
        (sac, token_client)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let vault = Address::generate(&env);
        let token = Address::generate(&env);
        let client = deploy_contract(&env, &admin, &vault, &token);
        assert_eq!(client.admin(), admin);
        assert_eq!(client.vault(), vault);
        assert_eq!(client.token(), token);
    }

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let vault = Address::generate(&env);
        let token = Address::generate(&env);
        let client = deploy_contract(&env, &admin, &vault, &token);
        let result = client.try_initialize(&admin, &vault, &token);
        assert_eq!(result, Err(Ok(AdapterError::AlreadyInitialized)));
    }

    #[test]
    fn test_deposit() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let (token_id, token_client) = create_token(&env, &admin);
        let vault = Address::generate(&env);
        let contract_id = env.register(RwaAdapterContract, ());
        let client = RwaAdapterContractClient::new(&env, &contract_id);
        client.initialize(&admin, &vault, &token_id);
        let caller = Address::generate(&env);
        token_client.mint(&caller, &1000);
        let bal_before = token_client.balance(&vault);
        client.deposit(&caller, &500);
        let bal_after = token_client.balance(&vault);
        assert_eq!(bal_after, bal_before + 500);
        let deposited = env.as_contract(&contract_id, || RwaStorage::get_total_deposited(&env));
        assert_eq!(deposited, 500);
    }

    #[test]
    fn test_withdraw_all() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let (token_id, token_client) = create_token(&env, &admin);
        let vault = Address::generate(&env);
        let contract_id = env.register(RwaAdapterContract, ());
        let client = RwaAdapterContractClient::new(&env, &contract_id);
        client.initialize(&admin, &vault, &token_id);
        let caller = Address::generate(&env);
        let dest = Address::generate(&env);
        token_client.mint(&caller, &1000);
        client.deposit(&caller, &600);
        let withdrawn = client.withdraw_all(&admin, &dest);
        assert_eq!(withdrawn, 600);
        assert_eq!(token_client.balance(&dest), 600);
        assert_eq!(token_client.balance(&vault), 0);
    }

    #[test]
    fn test_current_balance() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let (token_id, token_client) = create_token(&env, &admin);
        let vault = Address::generate(&env);
        let contract_id = env.register(RwaAdapterContract, ());
        let client = RwaAdapterContractClient::new(&env, &contract_id);
        client.initialize(&admin, &vault, &token_id);
        let caller = Address::generate(&env);
        token_client.mint(&caller, &2000);
        client.deposit(&caller, &800);
        assert_eq!(client.current_balance(), 800);
    }

    #[test]
    fn test_schedule_and_execute_vault_upgrade() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let (token_id, _) = create_token(&env, &admin);
        let old_vault = Address::generate(&env);
        let new_vault = Address::generate(&env);
        let contract_id = env.register(RwaAdapterContract, ());
        let client = RwaAdapterContractClient::new(&env, &contract_id);
        client.initialize(&admin, &old_vault, &token_id);
        assert_eq!(client.vault(), old_vault);
        client.schedule_vault_upgrade(&new_vault);
        let deadline: u64 = env.as_contract(&contract_id, || RwaStorage::get_timelock_deadline(&env).unwrap());
        env.ledger().with_mut(|li| li.timestamp = deadline);
        client.execute_vault_upgrade();
        assert_eq!(client.vault(), new_vault);
    }

    #[test]
    fn test_execute_vault_upgrade_before_timelock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let (token_id, _) = create_token(&env, &admin);
        let old_vault = Address::generate(&env);
        let new_vault = Address::generate(&env);
        let client = deploy_contract(&env, &admin, &old_vault, &token_id);
        client.schedule_vault_upgrade(&new_vault);
        let result = client.try_execute_vault_upgrade();
        assert_eq!(result, Err(Ok(AdapterError::TimelockNotElapsed)));
    }

    #[test]
    fn test_cancel_vault_upgrade() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let (token_id, _) = create_token(&env, &admin);
        let old_vault = Address::generate(&env);
        let new_vault = Address::generate(&env);
        let client = deploy_contract(&env, &admin, &old_vault, &token_id);
        client.schedule_vault_upgrade(&new_vault);
        client.cancel_vault_upgrade();
        let result = client.try_execute_vault_upgrade();
        assert_eq!(result, Err(Ok(AdapterError::NoPendingVault)));
    }

    #[test]
    fn test_unauthorized_call_fails() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let (token_id, _) = create_token(&env, &admin);
        let vault = Address::generate(&env);
        let contract_id = env.register(RwaAdapterContract, ());
        let client = RwaAdapterContractClient::new(&env, &contract_id);
        env.as_contract(&contract_id, || {
            RwaStorage::set_admin(&env, &admin);
            RwaStorage::set_vault(&env, &vault);
            RwaStorage::set_token(&env, &token_id);
        });
        let caller = Address::generate(&env);
        let result = client.try_deposit(&caller, &100);
        assert!(result.is_err());
    }

    #[test]
    fn test_total_deposited() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let (token_id, token_client) = create_token(&env, &admin);
        let vault = Address::generate(&env);
        let client = deploy_contract(&env, &admin, &vault, &token_id);
        let caller = Address::generate(&env);
        token_client.mint(&caller, &5000);
        assert_eq!(client.total_deposited(), 0);
        client.deposit(&caller, &1000);
        assert_eq!(client.total_deposited(), 1000);
        client.deposit(&caller, &2000);
        assert_eq!(client.total_deposited(), 3000);
    }
}

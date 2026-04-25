#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, LedgerInfo},
    Address, Bytes, BytesN, Env, xdr::ToXdr,
};

fn set_ledger_sequence(env: &Env, sequence: u32) {
    let mut li = env.ledger().get();
    li.sequence_number = sequence;
    env.ledger().set(li);
}

fn setup_test_env() -> (Env, ArenaContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let contract_id = env.register(ArenaContract, (&admin,));
    let client = ArenaContractClient::new(&env, &contract_id);
    
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin.clone());
    
    client.set_token(&token_id);
    client.init(&10, &100, &(env.ledger().timestamp() + 7200)); // 10 ledgers speed, 100 stake, 2h deadline
    
    (env, client, admin, token_id)
}

fn fund_player(env: &Env, token_id: &Address, player: &Address, amount: i128) {
    let token_client = token::StellarAssetClient::new(env, token_id);
    token_client.mint(player, &amount);
}

fn create_commitment(env: &Env, player: &Address, choice: Choice, nonce: &BytesN<32>) -> BytesN<32> {
    let mut bytes = Bytes::new(env);
    let choice_byte: u8 = match choice {
        Choice::Heads => 0,
        Choice::Tails => 1,
    };
    bytes.append(&Bytes::from_array(env, &[choice_byte]));
    bytes.append(&soroban_sdk::Bytes::from_slice(&env, &nonce.to_array()));
    bytes.append(&player.clone().to_xdr(env));
    env.crypto().sha256(&bytes).into()
}

#[test]
fn test_happy_path() {
    let (env, client, _admin, token) = setup_test_env();
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    fund_player(&env, &token, &player1, 100);
    fund_player(&env, &token, &player2, 100);
    
    client.join(&player1, &100);
    client.join(&player2, &100);
    let round = client.start_round();
    
    let choice = Choice::Heads;
    let nonce = BytesN::from_array(&env, &[1; 32]);
    let commitment = create_commitment(&env, &player1, choice.clone(), &nonce.clone().into());
    
    client.commit_choice(&player1, &1, &commitment);
    
    set_ledger_sequence(&env, round.round_deadline_ledger);
    
    client.reveal_choice(&player1, &1, &choice, &Bytes::from_slice(&env, &nonce.to_array()));
    
    let round_after = client.get_round();
    assert_eq!(round_after.total_submissions, 1);
    assert_eq!(client.get_choice(&1, &player1), Some(Choice::Heads));
}

#[test]
#[should_panic(expected = "Error(Contract, #45)")]
fn test_reveal_without_commit() {
    let (env, client, _admin, token) = setup_test_env();
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    fund_player(&env, &token, &player1, 100);
    fund_player(&env, &token, &player2, 100);
    client.join(&player1, &100);
    client.join(&player2, &100);
    let round = client.start_round();
    
    set_ledger_sequence(&env, round.round_deadline_ledger);
    client.reveal_choice(&player1, &1, &Choice::Heads, &Bytes::from_slice(&env, &[0; 32]));
}

#[test]
#[should_panic(expected = "Error(Contract, #45)")]
fn test_wrong_nonce_in_reveal() {
    let (env, client, _admin, token) = setup_test_env();
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    fund_player(&env, &token, &player1, 100);
    fund_player(&env, &token, &player2, 100);
    client.join(&player1, &100);
    client.join(&player2, &100);
    let round = client.start_round();
    
    let nonce = BytesN::from_array(&env, &[1; 32]);
    let commitment = create_commitment(&env, &player1, Choice::Heads, &nonce.clone().into());
    
    client.commit_choice(&player1, &1, &commitment);
    
    set_ledger_sequence(&env, round.round_deadline_ledger);
    let wrong_nonce = BytesN::from_array(&env, &[2; 32]);
    client.reveal_choice(&player1, &1, &Choice::Heads, &(wrong_nonce).clone().into());
}

#[test]
#[should_panic(expected = "Error(Contract, #45)")]
fn test_wrong_choice_in_reveal() {
    let (env, client, _admin, token) = setup_test_env();
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    fund_player(&env, &token, &player1, 100);
    fund_player(&env, &token, &player2, 100);
    client.join(&player1, &100);
    client.join(&player2, &100);
    let round = client.start_round();
    
    let nonce = BytesN::from_array(&env, &[1; 32]);
    let commitment = create_commitment(&env, &player1, Choice::Heads, &nonce.clone().into());
    
    client.commit_choice(&player1, &1, &commitment);
    
    set_ledger_sequence(&env, round.round_deadline_ledger);
    client.reveal_choice(&player1, &1, &Choice::Tails, &Bytes::from_slice(&env, &nonce.to_array()));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_reveal_after_deadline() {
    let (env, client, _admin, token) = setup_test_env();
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    fund_player(&env, &token, &player1, 100);
    fund_player(&env, &token, &player2, 100);
    client.join(&player1, &100);
    client.join(&player2, &100);
    
    let round = client.start_round();
    
    let choice = Choice::Heads;
    let nonce = BytesN::from_array(&env, &[1; 32]);
    let commitment = create_commitment(&env, &player1, choice.clone(), &nonce.clone().into());
    
    client.commit_choice(&player1, &1, &commitment);
    
    set_ledger_sequence(&env, round.round_deadline_ledger + 1);
    client.reveal_choice(&player1, &1, &Choice::Heads, &Bytes::from_slice(&env, &nonce.to_array()));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_commit_after_deadline() {
    let (env, client, _admin, token) = setup_test_env();
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    fund_player(&env, &token, &player1, 100);
    fund_player(&env, &token, &player2, 100);
    client.join(&player1, &100);
    client.join(&player2, &100);
    
    let round = client.start_round();
    set_ledger_sequence(&env, round.round_deadline_ledger + 1);
    client.commit_choice(&player1, &1, &BytesN::from_array(&env, &[0; 32]));
}

#[test]
#[should_panic(expected = "Error(Contract, #41)")]
fn test_double_commit() {
    let (env, client, _admin, token) = setup_test_env();
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    fund_player(&env, &token, &player1, 100);
    fund_player(&env, &token, &player2, 100);
    client.join(&player1, &100);
    client.join(&player2, &100);
    client.start_round();
    
    client.commit_choice(&player1, &1, &BytesN::from_array(&env, &[1; 32]));
    client.commit_choice(&player1, &1, &BytesN::from_array(&env, &[2; 32]));
}

#[test]
fn test_correct_hash_formula() {
    let env = Env::default();
    let player = Address::generate(&env);
    let nonce = BytesN::from_array(&env, &[1; 32]);
    
    let commitment = create_commitment(&env, &player, Choice::Tails, &nonce.clone().into());
    assert_eq!(commitment.len(), 32);
}

#[test]
#[should_panic]
fn test_reveal_another_player_commitment() {
    let (env, client, _admin, token) = setup_test_env();
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    fund_player(&env, &token, &player1, 100);
    fund_player(&env, &token, &player2, 100);
    
    client.join(&player1, &100);
    client.join(&player2, &100);
    let round = client.start_round();
    
    let nonce = BytesN::from_array(&env, &[1; 32]);
    let commitment = create_commitment(&env, &player1, Choice::Heads, &nonce.clone().into());
    
    client.commit_choice(&player1, &1, &commitment);
    
    set_ledger_sequence(&env, round.round_deadline_ledger);
    
    client.reveal_choice(&player2, &1, &Choice::Heads, &Bytes::from_slice(&env, &nonce.to_array()));
}

#[test]
fn test_two_players_same_round() {
    let (env, client, _admin, token) = setup_test_env();
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    fund_player(&env, &token, &player1, 100);
    fund_player(&env, &token, &player2, 100);
    
    client.join(&player1, &100);
    client.join(&player2, &100);
    let round = client.start_round();
    
    let nonce1 = BytesN::from_array(&env, &[1; 32]);
    let commit1 = create_commitment(&env, &player1, Choice::Heads, &nonce1.clone().into());
    
    let nonce2 = BytesN::from_array(&env, &[2; 32]);
    let commit2 = create_commitment(&env, &player2, Choice::Tails, &nonce2.clone().into());
    
    client.commit_choice(&player1, &1, &commit1);
    client.commit_choice(&player2, &1, &commit2);
    
    set_ledger_sequence(&env, round.round_deadline_ledger);
    
    client.reveal_choice(&player1, &1, &Choice::Heads, &Bytes::from_slice(&env, &nonce1.to_array()));
    client.reveal_choice(&player2, &1, &Choice::Tails, &Bytes::from_slice(&env, &nonce2.to_array()));
    
    let round_after = client.get_round();
    assert_eq!(round_after.total_submissions, 2);
    assert_eq!(client.get_choice(&1, &player1), Some(Choice::Heads));
    assert_eq!(client.get_choice(&1, &player2), Some(Choice::Tails));
}

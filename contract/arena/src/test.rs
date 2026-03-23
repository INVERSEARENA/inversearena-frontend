#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, LedgerInfo},
    Address, Env,
};

fn create_client<'a>(env: &'a Env) -> ArenaContractClient<'a> {
    let contract_id = env.register(ArenaContract, ());
    ArenaContractClient::new(env, &contract_id)
}

fn set_ledger_sequence(env: &Env, sequence_number: u32) {
    let mut ledger = env.ledger().get();
    ledger.sequence_number = sequence_number;
    env.ledger().set(LedgerInfo {
        timestamp: 1_700_000_000,
        protocol_version: 22,
        sequence_number: ledger.sequence_number,
        network_id: ledger.network_id,
        base_reserve: ledger.base_reserve,
        min_temp_entry_ttl: ledger.min_temp_entry_ttl,
        min_persistent_entry_ttl: ledger.min_persistent_entry_ttl,
        max_entry_ttl: ledger.max_entry_ttl,
    });
}

#[test]
fn start_round_records_start_and_deadline_ledgers() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 100);

    client.init(&5);
    let round = client.start_round();

    assert_eq!(
        round,
        RoundState {
            round_number: 1,
            round_start_ledger: 100,
            round_deadline_ledger: 105,
            active: true,
            total_submissions: 0,
            timed_out: false,
        }
    );
}

#[test]
fn submit_choice_allows_submission_on_deadline_ledger() {
    let env = Env::default();
    env.mock_all_auths();

    let client = create_client(&env);
    let player = Address::generate(&env);

    set_ledger_sequence(&env, 200);
    client.init(&5);
    client.start_round();

    set_ledger_sequence(&env, 205);
    client.submit_choice(&player, &Choice::Heads);

    assert_eq!(client.get_choice(&1, &player), Some(Choice::Heads));
    assert_eq!(client.get_round().total_submissions, 1);
}

#[test]
fn submit_choice_rejects_late_submissions() {
    let env = Env::default();
    env.mock_all_auths();

    let client = create_client(&env);
    let player = Address::generate(&env);

    set_ledger_sequence(&env, 300);
    client.init(&5);
    client.start_round();

    set_ledger_sequence(&env, 306);
    let result = client.try_submit_choice(&player, &Choice::Tails);

    assert_eq!(result, Err(Ok(ArenaError::SubmissionWindowClosed)));
}

#[test]
fn timeout_round_is_callable_by_anyone_after_deadline() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 400);
    client.init(&3);
    client.start_round();

    set_ledger_sequence(&env, 404);
    let timed_out_round = client.timeout_round();

    assert_eq!(timed_out_round.round_number, 1);
    assert!(!timed_out_round.active);
    assert!(timed_out_round.timed_out);
    assert_eq!(client.get_round(), timed_out_round);
}

#[test]
fn timeout_round_rejects_calls_before_deadline() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 500);
    client.init(&4);
    client.start_round();

    set_ledger_sequence(&env, 504);
    let result = client.try_timeout_round();

    assert_eq!(result, Err(Ok(ArenaError::RoundStillOpen)));
}

#[test]
fn new_round_can_start_after_timeout() {
    let env = Env::default();
    let client = create_client(&env);

    set_ledger_sequence(&env, 600);
    client.init(&2);
    client.start_round();

    set_ledger_sequence(&env, 603);
    client.timeout_round();

    set_ledger_sequence(&env, 604);
    let second_round = client.start_round();

    assert_eq!(second_round.round_number, 2);
    assert_eq!(second_round.round_start_ledger, 604);
    assert_eq!(second_round.round_deadline_ledger, 606);
    assert!(second_round.active);
    assert!(!second_round.timed_out);
}

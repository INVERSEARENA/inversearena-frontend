use soroban_sdk::{Address, Env, Vec};
use crate::errors::ArenaError;
use crate::events::ArenaEvents;
use crate::storage::ArenaStorage;
use crate::types::{Choice, GameState, RoundResult};

/// Core round resolution: implements minority-wins elimination.
///
/// - Counts Heads and Tails among active players.
/// - Minority survives; majority is eliminated.
/// - Tie with > 2 players: no eliminations (re-run round).
/// - Tie with exactly 2 players: Heads survives (deterministic tie-break).
/// - Players who did not submit are auto-eliminated.
/// - When ≤ 1 survivor remains, game transitions to Finished.
pub fn resolve(env: &Env) -> Result<RoundResult, ArenaError> {
    let mut config = ArenaStorage::load_config(env)?;
    if config.state != GameState::InProgress {
        return Err(ArenaError::InvalidStateTransition);
    }

    let players = ArenaStorage::load_all_players(env);
    let mut active: Vec<Address> = Vec::new(env);
    let mut heads = 0u32;
    let mut tails = 0u32;

    for p in players.iter() {
        if ArenaStorage::is_player_active(env, &p) {
            active.push_back(p.clone());
            match ArenaStorage::load_player_choice(env, &p) {
                Some(Choice::Heads) => heads += 1,
                Some(Choice::Tails) => tails += 1,
                None => {}
            }
        }
    }

    let active_count = active.len();
    let mut eliminated = 0u32;
    let mut survivors = 0u32;

    if heads == tails {
        if active_count == 2 {
            // Deterministic tie-break for 2 players: Heads wins
            for p in active.iter() {
                match ArenaStorage::load_player_choice(env, &p) {
                    Some(Choice::Tails) | None => {
                        ArenaStorage::set_player_active(env, &p, false);
                        eliminated += 1;
                        ArenaEvents::player_eliminated(env, &p);
                    }
                    Some(Choice::Heads) => {
                        survivors += 1;
                    }
                }
            }
        } else {
            // Tie with > 2 players: no eliminations, re-run round
            survivors = active_count;
        }
    } else {
        let winning_choice = if heads < tails { Choice::Heads } else { Choice::Tails };

        for p in active.iter() {
            match ArenaStorage::load_player_choice(env, &p) {
                Some(choice) if choice == winning_choice => {
                    survivors += 1;
                }
                _ => {
                    ArenaStorage::set_player_active(env, &p, false);
                    eliminated += 1;
                    ArenaEvents::player_eliminated(env, &p);
                }
            }
        }
    }

    ArenaStorage::clear_choices(env);

    let round = ArenaStorage::get_round(env) + 1;
    ArenaStorage::set_round(env, round);

    if survivors <= 1 {
        config.state = GameState::Finished;
        ArenaStorage::save_config(env, &config);

        for p in players.iter() {
            if ArenaStorage::is_player_active(env, &p) {
                ArenaStorage::set_winner(env, &p);
                break;
            }
        }
    }

    Ok(RoundResult { round, eliminated, survivors })
}

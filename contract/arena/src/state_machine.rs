//! Arena lifecycle state machine (#694).
//!
//! Centralises the legal `GameState` transitions and the guards the contract
//! entry points use, so a security reviewer can reason about state transitions
//! in one place instead of scanning `lib.rs`.
//!
//! Legal transitions (mirrors the transitions actually performed in `lib.rs`):
//! ```text
//! Open     → Active      (start_round — the first round starts)
//! Open     → Cancelled   (cancel_arena / force_cancel_arena before play)
//! Active   → Open        (resolve_round — more than one survivor remains)
//! Active   → Finished    (resolve_round — exactly one survivor remains)
//! Active   → Cancelled   (resolve_round — zero survivors, OR force_cancel_arena mid-game)
//! Finished → Settled     (claim — prize distributed to the winner)
//! ```
//!
//! `Cancelled` and `Settled` are terminal — no transitions leave them.

use crate::types::{ArenaError, ArenaPhase, GameState, RoundSchedule};

/// Returns `true` if a direct transition from `from` to `to` is allowed.
///
/// Kept in sync with the `config.state = …` assignments in `lib.rs`; see the
/// module-level table above.
pub fn can_transition(from: &GameState, to: &GameState) -> bool {
    use GameState::*;
    matches!(
        (from, to),
        (Open, Active)
            | (Open, Cancelled)
            | (Active, Open)
            | (Active, Finished)
            | (Active, Cancelled)
            | (Finished, Settled)
    )
}

/// Guard requiring the arena to currently be in `expected`, returning `err`
/// otherwise. Used by entry points that are only valid in a single state.
pub fn ensure_state(
    current: &GameState,
    expected: &GameState,
    err: ArenaError,
) -> Result<(), ArenaError> {
    if current == expected {
        Ok(())
    } else {
        Err(err)
    }
}

/// Guard requiring a `from → to` transition to be legal before it is applied.
#[allow(dead_code)]
pub fn ensure_transition(
    from: &GameState,
    to: &GameState,
    err: ArenaError,
) -> Result<(), ArenaError> {
    if can_transition(from, to) {
        Ok(())
    } else {
        Err(err)
    }
}

/// Derive the player-facing phase (#1582). `Open` is the lobby until the first
/// round resolves and an intermission afterwards; `Active` accepts commitments
/// strictly before `commit_deadline` and reveals from then on, matching the
/// guards in `submit_commitment` and `reveal_choice`.
pub fn phase(state: &GameState, round_count: u32, commit_deadline: u64, now: u64) -> ArenaPhase {
    match state {
        GameState::Open if round_count == 0 => ArenaPhase::Lobby,
        GameState::Open => ArenaPhase::Intermission,
        GameState::Active if now < commit_deadline => ArenaPhase::Commit,
        GameState::Active => ArenaPhase::Reveal,
        GameState::Finished => ArenaPhase::Finished,
        GameState::Settled => ArenaPhase::Settled,
        GameState::Cancelled => ArenaPhase::Cancelled,
    }
}

/// Derive the player-facing phase with a `RoundSchedule` reference (#1836).
pub fn phase_with_schedule(
    state: &GameState,
    round_count: u32,
    schedule: Option<&RoundSchedule>,
    now: u64,
) -> ArenaPhase {
    match state {
        GameState::Open if round_count == 0 => ArenaPhase::Lobby,
        GameState::Open => ArenaPhase::Intermission,
        GameState::Active => match schedule {
            Some(s) if s.can_commit(now) => ArenaPhase::Commit,
            _ => ArenaPhase::Reveal,
        },
        GameState::Finished => ArenaPhase::Finished,
        GameState::Settled => ArenaPhase::Settled,
        GameState::Cancelled => ArenaPhase::Cancelled,
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::types::GameState::*;

    const STATES: [GameState; 5] = [Open, Active, Finished, Cancelled, Settled];
    const LEGAL: [(GameState, GameState); 6] = [
        (Open, Active),
        (Open, Cancelled),
        (Active, Open),
        (Active, Finished),
        (Active, Cancelled),
        (Finished, Settled),
    ];

    #[test]
    fn phase_splits_open_and_active_states() {
        assert_eq!(phase(&Open, 0, 0, 0), ArenaPhase::Lobby);
        assert_eq!(phase(&Open, 1, 0, 0), ArenaPhase::Intermission);
        assert_eq!(phase(&Active, 0, 100, 99), ArenaPhase::Commit);
        assert_eq!(phase(&Active, 0, 100, 100), ArenaPhase::Reveal);
        assert_eq!(phase(&Finished, 3, 0, 0), ArenaPhase::Finished);
        assert_eq!(phase(&Settled, 3, 0, 0), ArenaPhase::Settled);
        assert_eq!(phase(&Cancelled, 0, 0, 0), ArenaPhase::Cancelled);
    }

    #[test]
    fn phase_boundaries_are_exact() {
        assert_eq!(phase(&Active, 1, 100, 98), ArenaPhase::Commit);
        assert_eq!(phase(&Active, 1, 100, 99), ArenaPhase::Commit);
        assert_eq!(phase(&Active, 1, 100, 100), ArenaPhase::Reveal);
        assert_eq!(phase(&Active, 1, 100, 101), ArenaPhase::Reveal);
        assert_eq!(phase(&Active, 0, 100, 100), ArenaPhase::Reveal);
        assert_eq!(
            phase(&Active, 1, u64::MAX, u64::MAX - 1),
            ArenaPhase::Commit
        );
        assert_eq!(phase(&Active, 1, u64::MAX, u64::MAX), ArenaPhase::Reveal);
    }

    #[test]
    fn transition_matrix_matches_the_documented_edges() {
        for from in &STATES {
            for to in &STATES {
                let expected = LEGAL
                    .iter()
                    .any(|(legal_from, legal_to)| legal_from == from && legal_to == to);
                assert_eq!(
                    can_transition(from, to),
                    expected,
                    "transition {from:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn terminal_states_have_no_outgoing_transitions() {
        for terminal in [&Cancelled, &Settled] {
            for to in &STATES {
                assert!(
                    !can_transition(terminal, to),
                    "transition {terminal:?} -> {to:?}"
                );
            }
        }
    }

    #[test]
    fn no_state_transitions_to_itself() {
        for state in &STATES {
            assert!(!can_transition(state, state), "self-loop {state:?}");
        }
    }

    #[test]
    fn ensure_state_returns_the_exact_error_for_every_mismatch() {
        for current in &STATES {
            for expected in &STATES {
                let result = ensure_state(current, expected, ArenaError::InvalidGameState);
                if current == expected {
                    assert!(result.is_ok());
                } else {
                    assert_eq!(result, Err(ArenaError::InvalidGameState));
                }
            }
        }
        assert_eq!(
            ensure_state(&Active, &Open, ArenaError::GameNotFinished),
            Err(ArenaError::GameNotFinished),
        );
    }

    #[test]
    fn ensure_transition_returns_the_exact_error_for_every_illegal_edge() {
        for from in &STATES {
            for to in &STATES {
                let result = ensure_transition(from, to, ArenaError::InvalidGameState);
                if can_transition(from, to) {
                    assert!(result.is_ok());
                } else {
                    assert_eq!(result, Err(ArenaError::InvalidGameState));
                }
            }
        }
        assert_eq!(
            ensure_transition(&Open, &Finished, ArenaError::GameNotFinished),
            Err(ArenaError::GameNotFinished),
        );
    }
}

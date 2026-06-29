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
//! Active   → Finished    (resolve_round last survivor / expire_arena)
//! Active   → Cancelled   (force_cancel_arena mid-game)
//! Finished → Settled     (claim — prize distributed to the winner)
//! ```
//!
//! `Cancelled` and `Settled` are terminal — no transitions leave them.

use crate::types::{ArenaError, GameState};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::GameState::*;

    #[test]
    fn legal_transitions() {
        // Every transition `lib.rs` actually performs must be accepted.
        assert!(can_transition(&Open, &Active));
        assert!(can_transition(&Open, &Cancelled));
        assert!(can_transition(&Active, &Open));
        assert!(can_transition(&Active, &Finished));
        assert!(can_transition(&Active, &Cancelled));
        assert!(can_transition(&Finished, &Settled));
    }

    #[test]
    fn illegal_transitions() {
        // Skipping intermediate states is not allowed.
        assert!(!can_transition(&Open, &Finished));
        assert!(!can_transition(&Open, &Settled));
        assert!(!can_transition(&Active, &Settled));
        // Finished transitions: only Settled is allowed (start_round rejects it).
        assert!(!can_transition(&Finished, &Active));
        assert!(!can_transition(&Finished, &Cancelled));
        assert!(!can_transition(&Finished, &Open));
        // Terminal states never transition out.
        assert!(!can_transition(&Cancelled, &Open));
        assert!(!can_transition(&Cancelled, &Active));
        assert!(!can_transition(&Settled, &Open));
        assert!(!can_transition(&Settled, &Active));
        // No self-loops.
        assert!(!can_transition(&Open, &Open));
        assert!(!can_transition(&Active, &Active));
    }

    #[test]
    fn ensure_state_matches_and_rejects() {
        assert!(ensure_state(&Open, &Open, ArenaError::InvalidGameState).is_ok());
        assert_eq!(
            ensure_state(&Active, &Open, ArenaError::InvalidGameState),
            Err(ArenaError::InvalidGameState),
        );
    }

    #[test]
    fn ensure_transition_guards() {
        assert!(ensure_transition(&Open, &Active, ArenaError::InvalidGameState).is_ok());
        // Finished → Settled is legal (claim); Finished → Cancelled is not.
        assert!(ensure_transition(&Finished, &Settled, ArenaError::InvalidGameState).is_ok());
        assert_eq!(
            ensure_transition(&Finished, &Cancelled, ArenaError::InvalidGameState),
            Err(ArenaError::InvalidGameState),
        );
    }
}

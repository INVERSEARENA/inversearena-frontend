#![allow(dead_code)]
//! Arena lifecycle state machine (#694).
//!
//! Centralises the legal `GameState` transitions and the guards the contract
//! entry points use, so a security reviewer can reason about state transitions
//! in one place instead of scanning `lib.rs`.
//!
//! Legal transitions:
//! ```text
//! Open    → Active      (first round starts)
//! Open    → Cancelled   (admin cancels before the game starts)
//! Active  → Finished     (last round resolved)
//! ```

use crate::types::{ArenaError, GameState};

/// Returns `true` if a direct transition from `from` to `to` is allowed.
pub fn can_transition(from: &GameState, to: &GameState) -> bool {
    use GameState::*;
    matches!(
        (from, to),
        (Open, Active) | (Open, Cancelled) | (Active, Finished)
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
        assert!(can_transition(&Open, &Active));
        assert!(can_transition(&Open, &Cancelled));
        assert!(can_transition(&Active, &Finished));
    }

    #[test]
    fn illegal_transitions() {
        assert!(!can_transition(&Open, &Finished));
        assert!(!can_transition(&Active, &Cancelled));
        assert!(!can_transition(&Finished, &Active));
        assert!(!can_transition(&Cancelled, &Open));
        // No self-loops.
        assert!(!can_transition(&Open, &Open));
    }

    #[test]
    fn ensure_state_matches_and_rejects() {
        assert!(ensure_state(&Open, &Open, ArenaError::CannotCancelStartedGame).is_ok());
        assert_eq!(
            ensure_state(&Active, &Open, ArenaError::CannotCancelStartedGame),
            Err(ArenaError::CannotCancelStartedGame),
        );
    }

    #[test]
    fn ensure_transition_guards() {
        assert!(ensure_transition(&Open, &Active, ArenaError::CannotCancelStartedGame).is_ok());
        assert!(ensure_transition(&Finished, &Active, ArenaError::CannotCancelStartedGame).is_err());
    }
}

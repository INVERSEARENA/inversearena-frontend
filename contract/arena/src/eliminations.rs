//! Round elimination logic (#694).
//!
//! Inverse Arena is a *minority-wins* game: the choice made by fewer players
//! survives the round; the majority is eliminated. Isolating the counting and
//! survival rules here lets reviewers audit fairness without reading the
//! contract's storage and auth plumbing, and lets the rules be unit-tested as
//! pure functions.

use crate::types::Choice;
use soroban_sdk::Vec;

/// Vote counts for a single round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tally {
    pub heads: u32,
    pub tails: u32,
}

impl Tally {
    #[allow(dead_code)]
    pub fn total(&self) -> u32 {
        self.heads + self.tails
    }
}

/// Count the revealed choices for a round.
pub fn tally_choices(choices: &Vec<Choice>) -> Tally {
    let mut heads = 0;
    let mut tails = 0;
    for c in choices.iter() {
        match c {
            Choice::Heads => heads += 1,
            Choice::Tails => tails += 1,
        }
    }
    Tally { heads, tails }
}

/// The surviving choice under minority-wins rules.
///
/// If both sides receive votes, the smaller side survives and the majority is
/// eliminated. A tie is inconclusive, so nobody is eliminated. If every
/// submitting player picked the same side, that side survives because there is
/// no opposing majority to eliminate.
pub fn surviving_choice(tally: &Tally) -> Option<Choice> {
    match (tally.heads, tally.tails) {
        (0, 0) => None,
        (_, 0) => Some(Choice::Heads),
        (0, _) => Some(Choice::Tails),
        (heads, tails) if heads == tails => None,
        (heads, tails) if heads < tails => Some(Choice::Heads),
        _ => Some(Choice::Tails),
    }
}

/// Whether a player who picked `choice` is eliminated this round. On a tie
/// nobody is eliminated.
pub fn is_eliminated(choice: Choice, tally: &Tally) -> bool {
    match surviving_choice(tally) {
        Some(survivor) => choice != survivor,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Env, Vec};

    #[test]
    fn minority_survives() {
        // 1 heads vs 3 tails → heads (the minority) survives.
        let t = Tally { heads: 1, tails: 3 };
        assert_eq!(surviving_choice(&t), Some(Choice::Heads));
        assert!(is_eliminated(Choice::Tails, &t));
        assert!(!is_eliminated(Choice::Heads, &t));
    }

    #[test]
    fn three_heads_seven_tails_keeps_heads() {
        let t = Tally { heads: 3, tails: 7 };
        assert_eq!(surviving_choice(&t), Some(Choice::Heads));
        assert!(!is_eliminated(Choice::Heads, &t));
        assert!(is_eliminated(Choice::Tails, &t));
    }

    #[test]
    fn tie_is_inconclusive() {
        let t = Tally { heads: 5, tails: 5 };
        assert_eq!(surviving_choice(&t), None);
        // Nobody is eliminated on a tie.
        assert!(!is_eliminated(Choice::Heads, &t));
        assert!(!is_eliminated(Choice::Tails, &t));
    }

    #[test]
    fn all_players_on_one_side_survive() {
        let t = Tally {
            heads: 10,
            tails: 0,
        };
        assert_eq!(surviving_choice(&t), Some(Choice::Heads));
        assert!(!is_eliminated(Choice::Heads, &t));

        let t = Tally {
            heads: 0,
            tails: 10,
        };
        assert_eq!(surviving_choice(&t), Some(Choice::Tails));
        assert!(!is_eliminated(Choice::Tails, &t));
    }

    #[test]
    fn single_submitter_survives() {
        let t = Tally { heads: 1, tails: 0 };
        assert_eq!(surviving_choice(&t), Some(Choice::Heads));
        assert!(!is_eliminated(Choice::Heads, &t));
    }

    #[test]
    fn no_choices_has_no_surviving_choice() {
        let t = Tally { heads: 0, tails: 0 };
        assert_eq!(surviving_choice(&t), None);
    }

    #[test]
    fn tally_counts_each_side() {
        let env = Env::default();
        let mut choices = Vec::new(&env);
        choices.push_back(Choice::Heads);
        choices.push_back(Choice::Tails);
        choices.push_back(Choice::Tails);
        let t = tally_choices(&choices);
        assert_eq!(t, Tally { heads: 1, tails: 2 });
        assert_eq!(t.total(), 3);
        assert_eq!(surviving_choice(&t), Some(Choice::Heads));
    }
}

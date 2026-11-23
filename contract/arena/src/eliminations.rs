//! Round elimination logic for binary and three-option minority arenas.
use crate::types::Choice;
use soroban_sdk::Vec;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tally {
    pub heads: u32,
    pub tails: u32,
    pub option3: u32,
}

impl Tally {
    pub fn total(&self) -> u32 {
        self.heads.saturating_add(self.tails).saturating_add(self.option3)
    }

    fn count(&self, choice: Choice) -> u32 {
        match choice {
            Choice::Heads => self.heads,
            Choice::Tails => self.tails,
            Choice::Option3 => self.option3,
        }
    }
}

pub fn tally_choices(choices: &Vec<Choice>) -> Tally {
    let mut tally = Tally { heads: 0, tails: 0, option3: 0 };
    for choice in choices.iter() {
        match choice {
            Choice::Heads => tally.heads = tally.heads.saturating_add(1),
            Choice::Tails => tally.tails = tally.tails.saturating_add(1),
            Choice::Option3 => tally.option3 = tally.option3.saturating_add(1),
        }
    }
    tally
}

/// The least-selected *used* choice or choices survive. An unused option is
/// ignored when comparing the tally so an empty option cannot eliminate every
/// player. Binary ties preserve the established no-elimination behavior.
pub fn is_eliminated(choice: Choice, tally: &Tally, option_count: u32) -> bool {
    if option_count == 2 && tally.heads == tally.tails {
        return false;
    }
    let selected = tally.count(choice);
    if selected == 0 {
        return true;
    }
    let mut least = u32::MAX;
    if tally.heads > 0 { least = least.min(tally.heads); }
    if tally.tails > 0 { least = least.min(tally.tails); }
    if option_count == 3 && tally.option3 > 0 { least = least.min(tally.option3); }
    selected != least
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use soroban_sdk::{Env, Vec};

    #[test]
    fn binary_minority_and_tie_rules_are_unchanged() {
        let tally = Tally { heads: 1, tails: 3, option3: 0 };
        assert!(!is_eliminated(Choice::Heads, &tally, 2));
        assert!(is_eliminated(Choice::Tails, &tally, 2));
        let tie = Tally { heads: 5, tails: 5, option3: 0 };
        assert!(!is_eliminated(Choice::Heads, &tie, 2));
        assert!(!is_eliminated(Choice::Tails, &tie, 2));
    }

    #[test]
    fn three_way_minority_keeps_all_tied_least_used_options() {
        let tally = Tally { heads: 2, tails: 1, option3: 1 };
        assert!(is_eliminated(Choice::Heads, &tally, 3));
        assert!(!is_eliminated(Choice::Tails, &tally, 3));
        assert!(!is_eliminated(Choice::Option3, &tally, 3));
    }

    #[test]
    fn unused_option_does_not_eliminate_every_voter() {
        let tally = Tally { heads: 2, tails: 2, option3: 0 };
        assert!(!is_eliminated(Choice::Heads, &tally, 3));
        assert!(!is_eliminated(Choice::Tails, &tally, 3));
    }

    #[test]
    fn tally_counts_three_choices() {
        let env = Env::default();
        let mut choices = Vec::new(&env);
        choices.push_back(Choice::Heads);
        choices.push_back(Choice::Tails);
        choices.push_back(Choice::Option3);
        let tally = tally_choices(&choices);
        assert_eq!(tally, Tally { heads: 1, tails: 1, option3: 1 });
        assert_eq!(tally.total(), 3);
    }
}

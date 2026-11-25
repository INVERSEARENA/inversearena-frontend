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
        self.heads
            .saturating_add(self.tails)
            .saturating_add(self.option3)
    }

    pub fn count(&self, choice: Choice) -> u32 {
        match choice {
            Choice::Heads => self.heads,
            Choice::Tails => self.tails,
            Choice::Option3 => self.option3,
        }
    }
}

/// Pure choice tallying over any slice of choices.
pub fn tally_slice(choices: &[Choice]) -> Tally {
    let mut tally = Tally {
        heads: 0,
        tails: 0,
        option3: 0,
    };
    for choice in choices {
        match choice {
            Choice::Heads => tally.heads = tally.heads.saturating_add(1),
            Choice::Tails => tally.tails = tally.tails.saturating_add(1),
            Choice::Option3 => tally.option3 = tally.option3.saturating_add(1),
        }
    }
    tally
}

pub fn tally_choices(choices: &Vec<Choice>) -> Tally {
    let mut tally = Tally {
        heads: 0,
        tails: 0,
        option3: 0,
    };
    for choice in choices.iter() {
        match choice {
            Choice::Heads => tally.heads = tally.heads.saturating_add(1),
            Choice::Tails => tally.tails = tally.tails.saturating_add(1),
            Choice::Option3 => tally.option3 = tally.option3.saturating_add(1),
        }
    }
    tally
}

/// Returns the unique surviving choice if a strict minority exists, or `None` on a tie
/// or when no valid choices were selected.
pub fn surviving_choice(tally: &Tally, option_count: u32) -> Option<Choice> {
    if option_count == 2 {
        if tally.heads == tally.tails {
            None // On a binary tie, no one is eliminated, so there is no unique strict minority
        } else if tally.heads < tally.tails {
            Some(Choice::Heads)
        } else {
            Some(Choice::Tails)
        }
    } else if option_count == 3 {
        let mut least = u32::MAX;
        let mut min_choice = None;
        let mut tie = false;

        let options = [
            (Choice::Heads, tally.heads),
            (Choice::Tails, tally.tails),
            (Choice::Option3, tally.option3),
        ];

        for (choice, count) in options {
            if count > 0 {
                if count < least {
                    least = count;
                    min_choice = Some(choice);
                    tie = false;
                } else if count == least {
                    tie = true;
                }
            }
        }

        if tie {
            None
        } else {
            min_choice
        }
    } else {
        None
    }
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
    if tally.heads > 0 {
        least = least.min(tally.heads);
    }
    if tally.tails > 0 {
        least = least.min(tally.tails);
    }
    if option_count == 3 && tally.option3 > 0 {
        least = least.min(tally.option3);
    }
    selected != least
}

#[cfg(kani)]
mod kani_proofs {
    use super::*;

    #[kani::proof]
    fn proof_surviving_choice_strict_minority_binary() {
        let heads: u32 = kani::any();
        let tails: u32 = kani::any();
        kani::assume(heads < 100_000 && tails < 100_000);
        let tally = Tally {
            heads,
            tails,
            option3: 0,
        };
        let survivor = surviving_choice(&tally, 2);

        if heads == tails {
            // A tie eliminates no one: surviving_choice is None and neither is eliminated
            assert!(survivor.is_none());
            assert!(!is_eliminated(Choice::Heads, &tally, 2));
            assert!(!is_eliminated(Choice::Tails, &tally, 2));
        } else if heads < tails {
            assert_eq!(survivor, Some(Choice::Heads));
            // is_eliminated agrees with surviving_choice
            assert!(!is_eliminated(Choice::Heads, &tally, 2));
            assert!(is_eliminated(Choice::Tails, &tally, 2));
        } else {
            assert_eq!(survivor, Some(Choice::Tails));
            assert!(is_eliminated(Choice::Heads, &tally, 2));
            assert!(!is_eliminated(Choice::Tails, &tally, 2));
        }
    }

    #[kani::proof]
    fn proof_surviving_choice_three_way() {
        let heads: u32 = kani::any();
        let tails: u32 = kani::any();
        let option3: u32 = kani::any();
        kani::assume(heads < 10_000 && tails < 10_000 && option3 < 10_000);
        let tally = Tally {
            heads,
            tails,
            option3,
        };
        let survivor = surviving_choice(&tally, 3);

        if let Some(s) = survivor {
            let count_s = tally.count(s);
            assert!(count_s > 0);
            if s != Choice::Heads && tally.heads > 0 {
                assert!(count_s < tally.heads);
            }
            if s != Choice::Tails && tally.tails > 0 {
                assert!(count_s < tally.tails);
            }
            if s != Choice::Option3 && tally.option3 > 0 {
                assert!(count_s < tally.option3);
            }
            // Strict minority survives: is_eliminated returns false for survivor
            assert!(!is_eliminated(s, &tally, 3));
        }
    }

    #[kani::proof]
    fn proof_tally_choices_totals_equal_input_length() {
        let len: usize = kani::any();
        kani::assume(len <= 5);
        let mut choices = [Choice::Heads; 5];
        for i in 0..len {
            let choice_id: u8 = kani::any();
            choices[i] = match choice_id % 3 {
                0 => Choice::Heads,
                1 => Choice::Tails,
                _ => Choice::Option3,
            };
        }
        let tally = tally_slice(&choices[0..len]);
        assert_eq!(tally.total() as usize, len);
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use soroban_sdk::{Env, Vec};

    #[test]
    fn binary_minority_and_tie_rules_are_unchanged() {
        let tally = Tally {
            heads: 1,
            tails: 3,
            option3: 0,
        };
        assert!(!is_eliminated(Choice::Heads, &tally, 2));
        assert!(is_eliminated(Choice::Tails, &tally, 2));
        assert_eq!(surviving_choice(&tally, 2), Some(Choice::Heads));

        let tie = Tally {
            heads: 5,
            tails: 5,
            option3: 0,
        };
        assert!(!is_eliminated(Choice::Heads, &tie, 2));
        assert!(!is_eliminated(Choice::Tails, &tie, 2));
        assert_eq!(surviving_choice(&tie, 2), None);
    }

    #[test]
    fn three_way_minority_keeps_all_tied_least_used_options() {
        let tally = Tally {
            heads: 2,
            tails: 1,
            option3: 1,
        };
        assert!(is_eliminated(Choice::Heads, &tally, 3));
        assert!(!is_eliminated(Choice::Tails, &tally, 3));
        assert!(!is_eliminated(Choice::Option3, &tally, 3));
        assert_eq!(surviving_choice(&tally, 3), None);

        let unique_min = Tally {
            heads: 5,
            tails: 2,
            option3: 4,
        };
        assert_eq!(surviving_choice(&unique_min, 3), Some(Choice::Tails));
        assert!(!is_eliminated(Choice::Tails, &unique_min, 3));
        assert!(is_eliminated(Choice::Heads, &unique_min, 3));
        assert!(is_eliminated(Choice::Option3, &unique_min, 3));
    }

    #[test]
    fn unused_option_does_not_eliminate_every_voter() {
        let tally = Tally {
            heads: 2,
            tails: 2,
            option3: 0,
        };
        assert!(!is_eliminated(Choice::Heads, &tally, 3));
        assert!(!is_eliminated(Choice::Tails, &tally, 3));
        assert_eq!(surviving_choice(&tally, 3), None);
    }

    #[test]
    fn tally_counts_three_choices() {
        let env = Env::default();
        let mut choices = Vec::new(&env);
        choices.push_back(Choice::Heads);
        choices.push_back(Choice::Tails);
        choices.push_back(Choice::Option3);
        let tally = tally_choices(&choices);
        assert_eq!(
            tally,
            Tally {
                heads: 1,
                tails: 1,
                option3: 1
            }
        );
        assert_eq!(tally.total(), 3);

        let slice = [Choice::Heads, Choice::Tails, Choice::Option3];
        let slice_tally = tally_slice(&slice);
        assert_eq!(slice_tally, tally);
        assert_eq!(slice_tally.total(), 3);
    }
}

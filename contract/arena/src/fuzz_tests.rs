#[cfg(test)]
mod fuzz_tests {
    use crate::eliminations::{is_eliminated, surviving_choice, tally_choices, Tally};
    use crate::types::Choice;
    use proptest::prelude::*;
    use soroban_sdk::{Env, Vec};

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        /// Minority always survives: whichever side has fewer votes is never
        /// eliminated, and the majority is always eliminated.
        #[test]
        fn minority_always_survives(
            heads in 0u32..50,
            tails in 0u32..50,
        ) {
            let tally = Tally { heads, tails };

            if heads < tails {
                // Heads is minority — heads survive, tails are eliminated.
                prop_assert_eq!(surviving_choice(&tally), Some(Choice::Heads));
                prop_assert!(!is_eliminated(Choice::Heads, &tally));
                prop_assert!(is_eliminated(Choice::Tails, &tally));
            } else if tails < heads {
                // Tails is minority — tails survive, heads are eliminated.
                prop_assert_eq!(surviving_choice(&tally), Some(Choice::Tails));
                prop_assert!(!is_eliminated(Choice::Tails, &tally));
                prop_assert!(is_eliminated(Choice::Heads, &tally));
            } else {
                // Tie — nobody is eliminated.
                prop_assert_eq!(surviving_choice(&tally), None);
                prop_assert!(!is_eliminated(Choice::Heads, &tally));
                prop_assert!(!is_eliminated(Choice::Tails, &tally));
            }
        }

        /// No player is ever silently dropped: the surviving side's count plus
        /// the eliminated side's count always equals the total submitted.
        #[test]
        fn total_is_conserved(
            heads in 0u32..50,
            tails in 0u32..50,
        ) {
            let tally = Tally { heads, tails };
            prop_assert_eq!(tally.total(), heads + tails);

            match surviving_choice(&tally) {
                Some(Choice::Heads) => {
                    // survivors = heads, eliminated = tails
                    prop_assert_eq!(heads + tails, tally.total());
                }
                Some(Choice::Tails) => {
                    // survivors = tails, eliminated = heads
                    prop_assert_eq!(tails + heads, tally.total());
                }
                None => {
                    // Tie: no eliminations, all players survive.
                    prop_assert_eq!(heads, tails);
                }
            }
        }

        /// tally_choices correctly counts each side regardless of submission order.
        #[test]
        fn tally_counts_match_input(
            heads_count in 0usize..30,
            tails_count in 0usize..30,
        ) {
            let env = Env::default();
            let mut choices: Vec<Choice> = Vec::new(&env);
            for _ in 0..heads_count {
                choices.push_back(Choice::Heads);
            }
            for _ in 0..tails_count {
                choices.push_back(Choice::Tails);
            }

            let tally = tally_choices(&choices);
            prop_assert_eq!(tally.heads, heads_count as u32);
            prop_assert_eq!(tally.tails, tails_count as u32);
            prop_assert_eq!(tally.total(), (heads_count + tails_count) as u32);
        }
    }
}

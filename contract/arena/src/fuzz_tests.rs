#[cfg(test)]
mod fuzz_tests {
    use crate::eliminations::{Tally, is_eliminated, tally_choices};
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
            let tally = Tally { heads, tails, option3: 0 };

            if heads == 0 && tails == 0 {
                // No votes at all — no survivor.
                prop_assert!(!is_eliminated(Choice::Heads, &tally, 2));
                prop_assert!(!is_eliminated(Choice::Tails, &tally, 2));
            } else if heads == 0 {
                // Only tails voted — they survive (no opposing majority).
                prop_assert!(is_eliminated(Choice::Heads, &tally, 2));
                prop_assert!(!is_eliminated(Choice::Tails, &tally, 2));
            } else if tails == 0 {
                // Only heads voted — they survive (no opposing majority).
                prop_assert!(!is_eliminated(Choice::Heads, &tally, 2));
                prop_assert!(is_eliminated(Choice::Tails, &tally, 2));
            } else if heads < tails {
                // Heads is minority — heads survive, tails are eliminated.
                prop_assert!(!is_eliminated(Choice::Heads, &tally, 2));
                prop_assert!(is_eliminated(Choice::Tails, &tally, 2));
            } else if tails < heads {
                // Tails is minority — tails survive, heads are eliminated.
                prop_assert!(is_eliminated(Choice::Heads, &tally, 2));
                prop_assert!(!is_eliminated(Choice::Tails, &tally, 2));
            } else {
                // Tie — nobody is eliminated.
                prop_assert!(!is_eliminated(Choice::Heads, &tally, 2));
                prop_assert!(!is_eliminated(Choice::Tails, &tally, 2));
            }
        }

        /// No player is ever silently dropped: the surviving side's count plus
        /// the eliminated side's count always equals the total submitted.
        #[test]
        fn total_is_conserved(
            heads in 0u32..50,
            tails in 0u32..50,
        ) {
            let tally = Tally { heads, tails, option3: 0 };
            prop_assert_eq!(tally.total(), heads + tails);

            if !is_eliminated(Choice::Heads, &tally, 2) && is_eliminated(Choice::Tails, &tally, 2) {
                prop_assert!(heads > 0);
            } else if !is_eliminated(Choice::Tails, &tally, 2) && is_eliminated(Choice::Heads, &tally, 2) {
                prop_assert!(tails > 0);
            } else {
                prop_assert_eq!(heads, tails);
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

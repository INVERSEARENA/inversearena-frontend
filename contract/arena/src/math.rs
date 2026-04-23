use soroban_sdk::Env;
use crate::errors::ArenaError;
use crate::events::Choice;

/// Returns the surviving side given head/tail counts.
/// When tied, picks randomly via the ledger PRNG.
pub fn choose_surviving_side(env: &Env, heads_count: u32, tails_count: u32) -> Option<Choice> {
    match (heads_count, tails_count) {
        (0, 0) => None,
        (0, _) => Some(Choice::Tails),
        (_, 0) => Some(Choice::Heads),
        _ if heads_count == tails_count => {
            if (env.prng().r#gen::<u64>() & 1) == 0 {
                Some(Choice::Heads)
            } else {
                Some(Choice::Tails)
            }
        }
        _ if heads_count < tails_count => Some(Choice::Heads),
        _ => Some(Choice::Tails),
    }
}

/// Integer division with dust remainder returned as (share, dust).
pub fn split_prize(total: i128, count: u32) -> Result<(i128, i128), ArenaError> {
    if count == 0 {
        return Err(ArenaError::InvalidAmount);
    }
    let n = count as i128;
    Ok((total / n, total % n))
}

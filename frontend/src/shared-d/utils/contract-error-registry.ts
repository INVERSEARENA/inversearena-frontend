/**
 * User-facing strings for Soroban contract panic codes (`Error(Contract, #N)`).
 *
 * **Keep in sync with `contract/ERRORS.md`.** When you add or change a code in Rust,
 * update both places in the same change.
 */
export const CONTRACT_PANIC_USER_MESSAGES: Readonly<Record<number, string>> =
  Object.freeze({
    // General 1–99
    1: "You do not have permission to perform this action.",
    2: "The supplied values are invalid. Please check them and try again.",
    3: "Your balance is too low for this operation.",
    4: "This action cannot be done in the current game or pool state.",
    5: "This resource already exists.",
    6: "The pool or resource could not be found.",
    7: "The time window for this action has closed.",
    8: "The arena has reached its maximum capacity.",
    // Factory 100–199
    100: "Stake amount does not meet the rules for creating a pool.",
    101: "This token is not supported for pool creation.",
    // Arena 200–299
    200: "You need to join this arena before doing that.",
    201: "You have already submitted a choice for this round.",
    202: "This round is not valid for the current game.",
    203: "Choices are not being accepted right now.",
    204: "There is nothing to claim right now.",
    // Arena `ArenaError` (Rust enum numeric codes — see contract/ERRORS.md)
    20: "This round has reached the maximum number of submissions.",
    21: "You have been eliminated from this arena.",
    22: "The round has advanced. Please refresh and resubmit.",
    // Staking 300–399
    300: "Stake amount is invalid.",
    301: "Staking is temporarily unavailable.",
    // Payout 400–499
    400: "Payout is not available yet.",
  });

/**
 * Returns a full sentence for logs/UI, always including the on-chain code for support.
 */
export function formatContractPanicMessage(
  code: number,
  knownMessage?: string,
): string {
  const base =
    knownMessage ??
    "The contract could not complete this action. See contract/ERRORS.md for code definitions.";
  return `${base} (on-chain code ${code})`;
}

export function userMessageForContractPanicCode(code: number): string {
  const known = CONTRACT_PANIC_USER_MESSAGES[code];
  return formatContractPanicMessage(code, known);
}

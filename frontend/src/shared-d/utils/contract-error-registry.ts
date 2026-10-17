/**
 * User-facing strings for Soroban contract panic codes (`Error(Contract, #N)`).
 *
 * **Keep in sync with `contract/ERRORS.md`.** When you add or change a code in Rust,
 * update both places in the same change.
 */
export const CONTRACT_PANIC_USER_MESSAGES: Readonly<Record<number, string>> =
  Object.freeze({
    // Arena `ArenaError` (Rust enum numeric codes — see contract/arena/src/types.rs)
    1: "You do not have permission to perform this action.",
    2: "Cannot cancel a game that has already started.",
    3: "This arena has not been initialized yet.",
    4: "This action cannot be done in the current round state.",
    5: "The round has not started yet.",
    6: "The grace period for this round has not elapsed yet.",
    7: "Your revealed choice and salt do not match your commitment.",
    8: "You have not submitted a commitment for this round.",
    9: "You have already revealed your choice for this round.",
    10: "This arena has already been initialized.",
    11: "The game is not finished yet.",
    12: "You have already claimed your prize.",
    13: "You have been eliminated from this arena.",
    14: "There is no pending admin transfer to accept.",
    15: "The vault address provided is invalid.",
    16: "The contract is paused. State-changing actions are temporarily disabled.",
    17: "This action cannot be performed in the current arena state.",
    18: "This arena has not been initialized yet.",
    19: "Not enough players to start a round. At least 2 active players are required.",
    20: "You have been banned from joining arenas.",
    21: "You cannot join your own arena.",
    22: "This arena is full. No more players can join.",
    23: "Invalid player limits configured.",
    24: "A reentrant call was detected. Please wait for the current operation to finish.",
    25: "You have already claimed your refund.",
    26: "You can only claim a refund when the arena has been cancelled.",
    27: "You are not registered as a player in this arena.",
    28: "The required deadline has not passed yet. Please wait.",
    29: "You have already joined this arena.",
    30: "The upgrade timelock has not elapsed yet. Please wait.",
    31: "No pending upgrade was found. Propose an upgrade first.",
    32: "The entry fee must be greater than zero.",
    33: "The commitment phase has ended. You can no longer submit choices for this round.",
    34: "Invalid round duration. Please check the duration parameter.",
    35: "Vault deposit failed. The token transfer has been rolled back.",
    // Factory 100–199
    100: "Stake amount does not meet the rules for creating a pool.",
    101: "This token is not supported for pool creation.",
    121: "The selected yield vault does not support this stake token.",
    122: "The selected oracle does not match the yield vault oracle.",
  });

/**
 * User-facing strings for Factory contract panic codes (contract/factory/src/types.rs).
 */
export const FACTORY_PANIC_USER_MESSAGES: Readonly<Record<number, string>> =
  Object.freeze({
    1: "The factory has not been initialized yet.",
    2: "The factory has already been initialized.",
    3: "You do not have permission to perform this factory action.",
    4: "Invalid stake amount.",
    5: "Insufficient creator stake.",
    6: "The specified arena was not found.",
    7: "The entry fee is below the required minimum stake.",
    8: "The host is not whitelisted for pool creation.",
    9: "The arena WASM hash is not configured.",
    10: "Maximum pool limit has been reached.",
    11: "The specified yield vault is invalid or unapproved.",
    12: "The specified oracle is invalid or unapproved.",
    13: "The host has reached their maximum active pool limit.",
    14: "Pool not found.",
    15: "The factory contract is currently paused.",
    16: "This token is not supported for pool creation.",
    17: "The entry fee must be greater than zero.",
    18: "Invalid pool configuration parameters.",
    19: "No pending admin transfer to accept.",
    20: "Decimal scaling overflowed.",
    21: "The selected yield vault does not support this stake token.",
    22: "The selected oracle does not match the yield vault oracle.",
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

export function userMessageForFactoryPanicCode(code: number): string {
  const known = FACTORY_PANIC_USER_MESSAGES[code] ?? CONTRACT_PANIC_USER_MESSAGES[code];
  return formatContractPanicMessage(code, known);
}

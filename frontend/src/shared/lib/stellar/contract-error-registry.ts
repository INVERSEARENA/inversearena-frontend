/**
 * User-facing copy for contract errors (#1597).
 *
 * Codes and variant names come from `contract-errors.generated.ts`, generated
 * from the compiled contract specs; this module only adds message overrides,
 * keyed by (contract, variant name). Typing the keys against the generated
 * names makes an override for a removed or renamed variant a type error.
 */
import {
  CONTRACT_ERRORS,
  type ContractErrorName,
  type ContractKind,
} from "@/shared/lib/stellar/contract-errors.generated";

/**
 * Stellar Asset Contract errors. SAC tokens are built into the host and have
 * no WASM spec, so these mirror `soroban-env-host/src/builtin_contracts/contract_error.rs`.
 */
export const SAC_ERRORS = {
  enumName: "ContractError",
  codes: {
    1: "_Reserved1",
    2: "OperationNotSupportedError",
    3: "AlreadyInitializedError",
    4: "UnauthorizedError",
    5: "AuthenticationError",
    6: "AccountMissingError",
    7: "AccountIsNotClassic",
    8: "NegativeAmountError",
    9: "AllowanceError",
    10: "BalanceError",
    11: "BalanceDeauthorizedError",
    12: "OverflowError",
    13: "TrustlineMissingError",
    14: "InsufficientAccountReserve",
    15: "TooManyAccountSubentries",
  },
} as const;

/** Any contract whose errors the client can name: a protocol contract or a SAC token. */
export type ErrorSourceKind = ContractKind | "sac";

type SacErrorName = (typeof SAC_ERRORS)["codes"][keyof (typeof SAC_ERRORS)["codes"]];

type MessageOverrides = {
  [K in ContractKind]?: Partial<Record<ContractErrorName<K>, string>>;
} & { sac?: Partial<Record<SacErrorName, string>> };

export const CONTRACT_ERROR_MESSAGES: MessageOverrides = {
  arena: {
    Unauthorized: "You do not have permission to perform this action.",
    CannotCancelStartedGame: "Cannot cancel a game that has already started.",
    NotInitialised: "This arena has not been initialized yet.",
    RoundNotActive: "This action cannot be done in the current round state.",
    RoundNotStarted: "The round has not started yet.",
    GracePeriodNotElapsed: "The grace period for this round has not elapsed yet.",
    InvalidReveal: "Your revealed choice and salt do not match your commitment.",
    MissingCommitment: "You have not submitted a commitment for this round.",
    ChoiceAlreadyRevealed: "You have already revealed your choice for this round.",
    AlreadyInitialized: "This arena has already been initialized.",
    GameNotFinished: "The game is not finished yet.",
    PrizeAlreadyClaimed: "You have already claimed your prize.",
    PlayerEliminated: "You have been eliminated from this arena.",
    NoPendingAdmin: "There is no pending admin transfer to accept.",
    InvalidVaultAddress: "The vault address provided is invalid.",
    ContractPaused: "The contract is paused. State-changing actions are temporarily disabled.",
    InvalidGameState: "This action cannot be performed in the current arena state.",
    NotInitialized: "This arena has not been initialized yet.",
    NotEnoughPlayers:
      "Not enough players to start a round. At least 2 active players are required.",
    PlayerBanned: "You have been banned from joining arenas.",
    CreatorCannotJoin: "You cannot join your own arena.",
    ArenaFull: "This arena is full. No more players can join.",
    InvalidPlayerLimits: "Invalid player limits configured.",
    ReentrantCall:
      "A reentrant call was detected. Please wait for the current operation to finish.",
    RefundAlreadyClaimed: "You have already claimed your refund.",
    ArenaNotCancelled: "You can only claim a refund when the arena has been cancelled.",
    NotAPlayer: "You are not registered as a player in this arena.",
    DeadlineTooSoon: "The required deadline has not passed yet. Please wait.",
    AlreadyJoined: "You have already joined this arena.",
    UpgradeTimelockPending: "The upgrade timelock has not elapsed yet. Please wait.",
    NoPendingUpgrade: "No pending upgrade was found. Propose an upgrade first.",
    InvalidEntryFee: "The entry fee must be greater than zero.",
    CommitPhaseEnded:
      "The commitment phase has ended. You can no longer submit choices for this round.",
    InvalidDuration: "Invalid round duration. Please check the duration parameter.",
    VaultDepositFailed: "Vault deposit failed. The token transfer has been rolled back.",
    GloballyPaused: "Inverse Arena is paused protocol-wide. Please try again later.",
  },
  factory: {
    StakeBelowMinimum: "Stake amount does not meet the rules for creating a pool.",
    UnsupportedToken: "This token is not supported for pool creation.",
  },
  staking: {
    NotInitialized: "Staking is not available yet.",
    AlreadyInitialized: "Staking is already set up.",
    Paused: "Staking is temporarily unavailable.",
    InvalidAmount: "Enter an amount greater than zero.",
    InsufficientShares: "You do not have that many shares to unstake.",
    ZeroShares: "This deposit is too small for the current pool value. Stake more.",
    BelowMinimumInitialStake: "The first deposit must be at least the minimum initial stake.",
  },
  sac: {
    BalanceError: "Your token balance is too low for this transaction.",
    BalanceDeauthorizedError: "The asset issuer has not authorized your balance.",
    TrustlineMissingError: "Your account needs a trustline for this asset first.",
  },
};

/** A contract error code attributed to the contract that raised it, when known. */
export interface ContractErrorRef {
  /** `null` when the raising contract could not be identified. */
  kind: ErrorSourceKind | null;
  code: number;
}

function errorTable(kind: ErrorSourceKind): {
  enumName: string;
  codes: Readonly<Record<number, string>>;
} {
  return kind === "sac" ? SAC_ERRORS : CONTRACT_ERRORS[kind];
}

/** Variant name for a (contract, code) pair, or `null` when it is not declared. */
export function contractErrorName(ref: ContractErrorRef): string | null {
  return ref.kind ? (errorTable(ref.kind).codes[ref.code] ?? null) : null;
}

/** A full sentence for UI and logs that always names the contract and code. */
export function userMessageForContractError(ref: ContractErrorRef): string {
  if (!ref.kind) {
    return `The contract could not complete this action (on-chain code ${ref.code}).`;
  }
  const { enumName } = errorTable(ref.kind);
  const name = contractErrorName(ref);
  if (!name) {
    return `The ${ref.kind} contract could not complete this action (${enumName} code ${ref.code}).`;
  }
  const overrides = CONTRACT_ERROR_MESSAGES[ref.kind] as Readonly<Record<string, string>> | undefined;
  const message =
    overrides?.[name] ?? `The ${ref.kind} contract rejected this action (${name}).`;
  return `${message} (${enumName}::${name}, code ${ref.code})`;
}

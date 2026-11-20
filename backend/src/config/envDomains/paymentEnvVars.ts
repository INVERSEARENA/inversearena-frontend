import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const paymentEnvVars = {
  PAYOUTS_LIVE_EXECUTION: {
    section: "Payouts",
    description: "Submit payouts on-chain. When false, payouts are prepared but not sent.",
    example: "false",
    default: "false",
    schema: flag,
  },
  PAYOUTS_SIGN_WITH_HOT_KEY: {
    section: "Payouts",
    description: "Sign payouts with PAYOUT_HOT_SIGNER_SECRET instead of handing them to an external signer.",
    example: "false",
    default: "false",
    schema: flag,
  },
  PAYOUT_HOT_SIGNER_SECRET: {
    section: "Payouts",
    description: "Hot signer secret seed. Only set in controlled environments.",
    secret: true,
    schema: secretSeed,
  },
  PAYOUTS_MAX_GAS_STROOPS: { section: "Payouts", description: "Fee ceiling per payout transaction.", default: "2000000", schema: int(1) },
  PAYOUTS_MAX_ATTEMPTS: { section: "Payouts", description: "Submission attempts per payout.", default: "5", schema: int(1) },
  PAYOUTS_CONFIRM_POLL_MS: { section: "Payouts", description: "Delay between confirmation polls.", default: "2500", schema: int(1) },
  PAYOUTS_CONFIRM_MAX_POLLS: { section: "Payouts", description: "Confirmation polls before giving up.", default: "20", schema: int(1) },
  PAYOUTS_FAILED_RETRY_MAX: {
    section: "Payouts",
    description: "Retries for payouts stuck in `failed` before dead-lettering (#1122).",
    default: "3",
    schema: int(0),
  },
  PAYOUTS_FAILED_RETRY_BASE_MS: { section: "Payouts", description: "Base backoff for those retries.", default: "5000", schema: int(1) },
  PAYOUTS_FEE_SPONSORSHIP_ENABLED: {
    section: "Payouts",
    description: "Sponsor the network fee of payout claims.",
    default: "false",
    schema: flag,
  },
  PAYOUTS_FEE_SPONSORSHIP_TTL_HOURS: {
    section: "Payouts",
    description: "How long a fee sponsorship offer stays valid.",
    default: "72",
    schema: int(1),
  }
} satisfies Record<string, EnvVarSpec>;

/** Canonical review digest for CLI mutation intents (#1699). No private keys. */
import { createHash, timingSafeEqual } from "node:crypto";
export interface MutationPlan {
  version: 1;
  command: string;
  manifestDigest: string;
  networkPassphrase: string;
  contractId: string;
  contractVersion: string;
  signerPublicKey: string;
  signerRole: string;
  args: unknown[];
  simulationDigest: string;
  maxFeeStroops: string;
  minLedger: number;
  maxLedger: number;
  expiresAt: string;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map(k => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
  }
  if (value === undefined || typeof value === "function") throw new Error("INVALID_PLAN_VALUE");
  return JSON.stringify(value);
}
export function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function verifyApprovedMutation(
  approved: MutationPlan,
  current: MutationPlan,
  expectedDigest: string,
  now = new Date(),
): void {
  if (new Date(approved.expiresAt).getTime() <= now.getTime() ||
      !Number.isFinite(new Date(approved.expiresAt).getTime())) throw new Error("MUTATION_PLAN_EXPIRED");
  if (current.minLedger > current.maxLedger || current.maxLedger < 0) throw new Error("INVALID_LEDGER_BOUNDS");
  const actual = Buffer.from(sha256(approved), "hex");
  const expected = /^[0-9a-f]{64}$/i.test(expectedDigest)
    ? Buffer.from(expectedDigest, "hex") : Buffer.alloc(32);
  if (!timingSafeEqual(actual, expected) || sha256(approved) !== sha256(current)) {
    throw new Error("MUTATION_PLAN_DRIFT");
  }
}

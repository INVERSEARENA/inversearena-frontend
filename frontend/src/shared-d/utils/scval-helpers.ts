import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  StellarContractIdSchema,
  StellarPublicKeySchema,
} from "@/shared-d/utils/security-validation";

export type RoundChoice = "Heads" | "Tails";

function toBigInt(value: bigint | number, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a finite integer number`);
  }
  return BigInt(value);
}

/**
 * Encode a Stellar public key or Soroban contract id into an `scvAddress`.
 *
 * Note: Soroban contract ids use the `C...` format; wallet addresses use `G...`.
 */
export function encodeAddress(address: string): xdr.ScVal {
  const trimmed = address.trim();

  const pkParsed = StellarPublicKeySchema.safeParse(trimmed);
  if (pkParsed.success) return new Address(pkParsed.data).toScVal();

  const contractParsed = StellarContractIdSchema.safeParse(trimmed);
  if (contractParsed.success) {
    return new Contract(contractParsed.data).address().toScVal();
  }

  // Final attempt (will throw a useful SDK error if invalid).
  return new Address(trimmed).toScVal();
}

/** Encode an i128 amount. */
export function encodeAmount(amount: bigint | number): xdr.ScVal {
  return nativeToScVal(toBigInt(amount, "amount"), { type: "i128" });
}

/** Encode a u32 round number / round speed. */
export function encodeRound(round: bigint | number): xdr.ScVal {
  let n: number;

  if (typeof round === "bigint") {
    if (round < 0n || round > 0xffffffffn) {
      throw new Error("round is out of u32 range");
    }
    n = Number(round);
  } else {
    if (!Number.isFinite(round) || !Number.isInteger(round)) {
      throw new Error("round must be a finite integer number");
    }
    if (round < 0 || round > 0xffffffff) {
      throw new Error("round is out of u32 range");
    }
    n = round;
  }

  return nativeToScVal(n, { type: "u32" });
}

/** Encode the Heads/Tails choice as an `scvSymbol`. */
export function encodeChoice(choice: RoundChoice): xdr.ScVal {
  if (choice !== "Heads" && choice !== "Tails") {
    throw new Error("choice must be either 'Heads' or 'Tails'");
  }
  return xdr.ScVal.scvSymbol(choice);
}


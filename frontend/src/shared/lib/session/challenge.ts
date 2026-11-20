import { Account, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import type { ChallengeSigner, LoginProof } from "./types";

/** manageData key holding the SHA-256 digest of the backend nonce. */
export const CHALLENGE_DATA_KEY = "inversearena_auth_challenge";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Wallets disagree on the shape of `signMessage` responses: Freighter returns
 * `{ signedMessage }`, xBull can return `{ signature }`, and some kits return a
 * raw string. Some also use hex rather than base64. Normalise all of them to
 * the base64 signature the backend verifies.
 */
export function normalizeSignature(raw: unknown): string {
  let value: string;
  if (typeof raw === "string") {
    value = raw;
  } else if (raw && typeof raw === "object") {
    const candidate = raw as Record<string, unknown>;
    const signature = candidate.signature ?? candidate.signedMessage ?? candidate.signedMsg;
    if (typeof signature !== "string" || signature.length === 0) {
      throw new Error("Wallet did not return a signature");
    }
    value = signature;
  } else {
    throw new Error("Wallet did not return a signature");
  }

  if (/^0x[0-9a-f]+$/i.test(value)) value = value.slice(2);
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    return bytesToBase64(hexToBytes(value));
  }
  return value;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/**
 * Fallback for wallets that cannot sign arbitrary messages: wrap the nonce
 * digest in a short-lived challenge transaction the wallet signs as usual.
 * The transaction is never submitted — the backend verifies the wallet's
 * signature over it and the embedded nonce digest.
 */
export async function buildChallengeTransactionXdr(
  nonce: string,
  walletAddress: string,
  networkPassphrase: string,
  now = Date.now(),
): Promise<string> {
  const digest = await sha256(nonce);
  const account = new Account(walletAddress, "0");
  const transaction = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase,
    timebounds: {
      minTime: 0,
      maxTime: Math.floor(now / 1000) + 300,
    },
  })
    .addOperation(
      Operation.manageData({
        name: CHALLENGE_DATA_KEY,
        // Stellar's manageData accepts a string (UTF-8 encoded) or a Buffer;
        // pass the raw digest so the backend can compare the exact SHA-256.
        value: Buffer.from(digest),
      }),
    )
    .build();

  return transaction.toXDR();
}

/**
 * Signs the backend-issued challenge with message signing where available and
 * falls back to a challenge transaction for wallets such as xBull builds that
 * reject arbitrary messages.
 */
export async function signChallenge(
  nonce: string,
  signer: ChallengeSigner,
  networkPassphrase: string,
  now = Date.now(),
): Promise<LoginProof> {
  if (signer.signMessage) {
    try {
      const raw = await signer.signMessage(nonce);
      return { signature: normalizeSignature(raw) };
    } catch {
      // Fall through to the challenge-transaction path. Some wallets advertise
      // signMessage but reject it at runtime.
    }
  }

  const xdr = await buildChallengeTransactionXdr(nonce, signer.walletAddress, networkPassphrase, now);
  const signed = await signer.signTransaction(xdr);
  // The backend expects the signed transaction XDR verbatim. Do not run it
  // through signature normalisation: an XDR string that happens to be all hex
  // characters would be decoded into unrelated bytes.
  if (typeof signed !== "string" || signed.length === 0) {
    throw new Error("Wallet did not return a signed challenge transaction");
  }
  return { signedChallengeXdr: signed };
}

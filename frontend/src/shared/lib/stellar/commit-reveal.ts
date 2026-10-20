/**
 * Client-side commit-reveal protocol helpers (#1137).
 *
 * The arena contract's `submit_commitment` / `reveal_choice` flow requires
 * the player to commit to `SHA256([choice_byte] ++ salt_32_bytes)` without
 * revealing the choice, then later reveal the original choice + salt so the
 * contract can verify it against the stored commitment
 * (`contract/arena/src/lib.rs`'s `compute_commitment`). The salt must never
 * be submitted on-chain during the commit phase — only the hash is — so it
 * has to be generated client-side and persisted locally between the two
 * phases, since there is nowhere else it can come from at reveal time.
 *
 * Cross-tab salt uniqueness (#1492):
 * `saveCommitment` is idempotent — if a salt was already saved for a given
 * wallet/arena/round it returns the *existing* one rather than overwriting it.
 * This means that even if two tabs call `saveCommitment` concurrently, the
 * second write is a no-op and both tabs end up with the same salt, preventing
 * divergent commitments.  The mutation coordinator ensures only one tab ever
 * reaches `saveCommitment` for a given commit action; this guard is a
 * belt-and-suspenders defence.
 */

import { Address } from "@stellar/stellar-sdk";

export type RoundChoice = "Heads" | "Tails";

const STORAGE_PREFIX = "inversearena:commit-reveal";

function storageKey(arenaId: string, round: number, publicKey: string): string {
  return `${STORAGE_PREFIX}:${arenaId}:${round}:${publicKey}`;
}

function choiceToByte(choice: RoundChoice): number {
  return choice === "Heads" ? 0 : 1;
}

/** Generates a cryptographically random 32-byte salt via WebCrypto. */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return salt;
}

/**
 * The arena, round, and player a commitment is bound to (#1630). A hash made
 * for one context fails `reveal_choice` in any other, so a copied commitment
 * cannot be replayed by another player, round, or arena.
 */
export interface CommitmentContext {
  /** Arena contract id (`C...` strkey). */
  arenaId: string;
  /** Round number the commitment is for. */
  round: number;
  /** Player account (`G...` strkey) that will reveal. */
  player: string;
}

/** Domain separator prepended to every commitment preimage (#1630). */
const COMMIT_DOMAIN = new TextEncoder().encode("IA_COMMIT_V1");

/**
 * ScVal XDR of an address, matching Rust's `Address::to_xdr` in the arena
 * contract. Both sides hash these exact bytes.
 */
function addressXdr(address: string): Uint8Array {
  return new Uint8Array(Address.fromString(address).toScVal().toXDR());
}

function roundBytes(round: number): Uint8Array {
  if (!Number.isInteger(round) || round < 0 || round > 0xffffffff) {
    throw new Error(`round must be a u32, got ${round}`);
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, round, false);
  return bytes;
}

/**
 * Builds the bound preimage
 * `"IA_COMMIT_V1" || arena_xdr || round_u32_be || player_xdr || choice_byte || salt`.
 * Byte-for-byte what the contract's `compute_commitment` hashes.
 */
export function buildCommitmentPreimage(
  choice: RoundChoice,
  salt: Uint8Array,
  context: CommitmentContext,
): Uint8Array {
  if (salt.length !== 32) {
    throw new Error(`salt must be exactly 32 bytes, got ${salt.length}`);
  }
  const parts = [
    COMMIT_DOMAIN,
    addressXdr(context.arenaId),
    roundBytes(context.round),
    addressXdr(context.player),
    new Uint8Array([choiceToByte(choice)]),
    salt,
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const preimage = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    preimage.set(part, offset);
    offset += part.length;
  }
  return preimage;
}

/**
 * Computes `SHA256("IA_COMMIT_V1" || arena || round || player || choice || salt)`
 * in-browser via WebCrypto, matching the arena contract's `compute_commitment`.
 */
export async function computeCommitment(
  choice: RoundChoice,
  salt: Uint8Array,
  context: CommitmentContext,
): Promise<Uint8Array> {
  const preimage = buildCommitmentPreimage(choice, salt, context);
  const digest = await crypto.subtle.digest("SHA-256", preimage);
  return new Uint8Array(digest);
}

export interface StoredCommitment {
  choice: RoundChoice;
  salt: Uint8Array;
}

interface StoredCommitmentJson {
  choice: string;
  salt: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Persist the choice + salt for a round between the commit and reveal
 * phases, keyed by arena + round + wallet address so multiple wallets on
 * the same device never collide (#1331).
 *
 * Cross-tab idempotency (#1492): if a commitment is already stored for this
 * key, the existing record is returned unchanged and the new `commitment`
 * argument is ignored.  This prevents a second tab from overwriting a salt
 * that was already committed on-chain by the first tab.
 *
 * Returns the commitment that is now stored (either the pre-existing one or
 * the newly written one).
 */
export function saveCommitment(
  arenaId: string,
  round: number,
  publicKey: string,
  commitment: StoredCommitment,
): StoredCommitment {
  const existing = loadCommitment(arenaId, round, publicKey);
  if (existing) return existing;

  const json: StoredCommitmentJson = {
    choice: commitment.choice,
    salt: bytesToBase64(commitment.salt),
  };
  localStorage.setItem(storageKey(arenaId, round, publicKey), JSON.stringify(json));
  return commitment;
}

/**
 * Retrieve the choice + salt saved during the commit phase for a round.
 * Returns null if nothing was saved, or it's corrupt — the caller cannot
 * reveal without this, since the salt has no other source.
 */
export function loadCommitment(arenaId: string, round: number, publicKey: string): StoredCommitment | null {
  const raw = localStorage.getItem(storageKey(arenaId, round, publicKey));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredCommitmentJson;
    if (parsed.choice !== "Heads" && parsed.choice !== "Tails") return null;
    const salt = base64ToBytes(parsed.salt);
    if (salt.length !== 32) return null;
    return { choice: parsed.choice, salt };
  } catch {
    return null;
  }
}

/** Remove the stored choice + salt for a round — call only once its reveal has actually confirmed. */
export function clearCommitment(arenaId: string, round: number, publicKey: string): void {
  localStorage.removeItem(storageKey(arenaId, round, publicKey));
}

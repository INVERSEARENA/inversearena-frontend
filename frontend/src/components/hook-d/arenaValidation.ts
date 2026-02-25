import { z } from "zod";

/**
 * Validation result type
 */
export type ValidationResult<T = any> = 
  | { valid: true; data: T } 
  | { valid: false; error: string };

/**
 * Stellar Public Key regex (Starts with G, 56 chars, Base32)
 */
const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Choice enum
 */
const ARENA_CHOICE_ENUM = ["HEADS", "TAILS"] as const;

/**
 * Color mode enum
 */
const COLOR_MODE_ENUM = ["dark", "high-contrast"] as const;

/**
 * Helper to extract error message from Zod result
 */
function getErrorMessage(result: any, fallback: string): string {
  if (result.success) return "";
  return result.error.issues[0]?.message || fallback;
}

/**
 * Validate Stake Amount
 * Range: 0 < amount <= 1,000,000,000
 */
export function validateStakeAmount(amount: number): ValidationResult<number> {
  const schema = z.number()
    .finite()
    .positive("Stake amount must be greater than zero")
    .max(1_000_000_000, "Stake amount exceeds maximum allowed value");
  
  const result = schema.safeParse(amount);
  if (!result.success) {
    return { valid: false, error: getErrorMessage(result, "Invalid stake amount") };
  }
  return { valid: true, data: result.data };
}

/**
 * Validate Round Duration
 * Range: Integer, typically (30, 60, 300) but we allow any positive int for flexibility
 */
export function validateRoundDuration(duration: number): ValidationResult<number> {
  const schema = z.number()
    .int("Round duration must be an integer")
    .positive("Round duration must be positive")
    .min(10, "Round duration is too short (min 10s)")
    .max(3600, "Round duration is too long (max 1h)");
  
  const result = schema.safeParse(duration);
  if (!result.success) {
    return { valid: false, error: getErrorMessage(result, "Invalid round duration") };
  }
  return { valid: true, data: result.data };
}

/**
 * Validate Max Players (Quorum)
 * Range: 2 <= players <= 10,000
 */
export function validateMaxPlayers(players: number): ValidationResult<number> {
  const schema = z.number()
    .int("Player count must be an integer")
    .min(2, "Minimum quorum is 2 players")
    .max(10_000, "Maximum player limit exceeded");
  
  const result = schema.safeParse(players);
  if (!result.success) {
    return { valid: false, error: getErrorMessage(result, "Invalid player count") };
  }
  return { valid: true, data: result.data };
}

/**
 * Validate Stellar Public Key
 */
export function validateStellarAddress(address: string): ValidationResult<string> {
  if (!address) return { valid: false, error: "Stellar address is required" };
  
  if (STELLAR_PUBLIC_KEY_REGEX.test(address)) {
    return { valid: true, data: address };
  }
  
  return { valid: false, error: "Invalid Stellar public key format" };
}

/**
 * Validate Arena ID
 */
export function validateArenaId(id: string): ValidationResult<string> {
  const schema = z.string().trim().min(3, "Arena ID must be at least 3 characters");
  
  const result = schema.safeParse(id);
  if (!result.success) {
    return { valid: false, error: getErrorMessage(result, "Invalid arena ID") };
  }
  return { valid: true, data: result.data };
}

/**
 * Validate Choice
 */
export function validateChoice(choice: string): ValidationResult<string> {
  const schema = z.enum(ARENA_CHOICE_ENUM);
  
  const result = schema.safeParse(choice);
  if (!result.success) {
    return { valid: false, error: "Choice must be strictly 'HEADS' or 'TAILS'" };
  }
  return { valid: true, data: result.data };
}

/**
 * Validate Volume
 */
export function validateVolume(volume: number): ValidationResult<number> {
  const schema = z.number()
    .min(0, "Volume cannot be negative")
    .max(100, "Volume cannot exceed 100");
  
  const result = schema.safeParse(volume);
  if (!result.success) {
    return { valid: false, error: getErrorMessage(result, "Invalid volume") };
  }
  return { valid: true, data: result.data };
}

/**
 * Validate Color Mode
 */
export function validateColorMode(mode: string): ValidationResult<string> {
  const schema = z.enum(COLOR_MODE_ENUM);
  
  const result = schema.safeParse(mode);
  if (!result.success) {
    return { valid: false, error: "Invalid color mode" };
  }
  return { valid: true, data: result.data };
}

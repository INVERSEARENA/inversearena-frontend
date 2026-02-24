/**
 * Mock Data Factory for Arena Types
 * 
 * Provides deterministic mock data generation for development, Storybook stories, and unit tests.
 * Uses a seedable pseudo-random number generator (mulberry32) to ensure reproducible outputs.
 * 
 * @module mockFactory
 */

import type {
  ArenaV2Status,
  RoundPhase,
  RoundResult,
  PlayerEntry,
  PlayerStatus,
  EliminationEvent,
  YieldSnapshot,
} from './arenaTypes';

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Options for configuring mock data generation
 */
export interface MockFactoryOptions {
  /** Seed value for deterministic random generation */
  seed?: number;
}

/**
 * Random number generator interface
 */
interface RNG {
  /** Returns a random float between 0 and 1 */
  next(): number;
}

/**
 * Arena interface (inferred from requirements)
 */
export interface Arena {
  arenaId: string;
  status: ArenaV2Status;
  maxPlayers: number;
  currentPlayers: number;
  entryFee: string;
  currentRound: number;
  roundPhase: RoundPhase;
  createdAt: number;
  participants: PlayerEntry[];
  rounds: RoundResult[];
  yieldData: YieldSnapshot;
}


// ============================================================================
// RNG Layer - Seeded Random Number Generation
// ============================================================================

/**
 * Mulberry32 seeded pseudo-random number generator
 * 
 * A simple and fast PRNG that produces deterministic sequences.
 * Based on the mulberry32 algorithm.
 * 
 * @param seed - Initial seed value
 * @returns Function that generates random numbers between 0 and 1
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return function(): number {
    let t = state += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Creates a random number generator with optional seed
 * 
 * @param seed - Optional seed value. If not provided, uses current timestamp
 * @returns RNG instance with next() method
 */
function createRNG(seed?: number): RNG {
  const actualSeed = seed ?? Math.floor(Math.random() * 2147483647);
  const generator = mulberry32(actualSeed);
  
  return {
    next: generator
  };
}


// ============================================================================
// Generator Layer - Random Value Utilities
// ============================================================================

/**
 * Generates a random integer between min (inclusive) and max (inclusive)
 * 
 * @param rng - Random number generator
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @returns Random integer in range [min, max]
 */
function randomInt(rng: RNG, min: number, max: number): number {
  return Math.floor(rng.next() * (max - min + 1)) + min;
}

/**
 * Randomly selects an element from an array
 * 
 * @param rng - Random number generator
 * @param array - Array to select from
 * @returns Random element from the array
 */
function randomChoice<T>(rng: RNG, array: T[]): T {
  const index = Math.floor(rng.next() * array.length);
  return array[index];
}

/**
 * Generates a random timestamp near the current time
 * 
 * @param rng - Random number generator
 * @param baseTime - Base timestamp (defaults to current time)
 * @returns Random timestamp within ±30 days of base time
 */
function randomTimestamp(rng: RNG, baseTime?: number): number {
  const base = baseTime ?? Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const offset = (rng.next() - 0.5) * 2 * thirtyDays;
  return Math.floor(base + offset);
}


/**
 * Generates a valid-format Stellar address
 * 
 * Stellar addresses are 56 characters long, start with 'G', and use base32 encoding.
 * This generates addresses that match the format but are not cryptographically valid.
 * 
 * @param rng - Random number generator
 * @returns Mock Stellar address string
 */
function randomStellarAddress(rng: RNG): string {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let address = 'G';
  
  for (let i = 0; i < 55; i++) {
    const index = Math.floor(rng.next() * base32Chars.length);
    address += base32Chars[index];
  }
  
  return address;
}


// ============================================================================
// Factory Layer - Public API
// ============================================================================

/**
 * Creates a mock PlayerEntry with sensible defaults
 * 
 * @param overrides - Partial PlayerEntry to override defaults
 * @param options - Factory options including optional seed
 * @returns Complete PlayerEntry object
 * 
 * @example
 * // Generate random participant
 * const participant = createMockParticipant();
 * 
 * @example
 * // Generate deterministic participant
 * const participant = createMockParticipant({}, { seed: 12345 });
 * 
 * @example
 * // Override specific fields
 * const participant = createMockParticipant({ status: 'ELIMINATED' });
 */
export function createMockParticipant(
  overrides?: Partial<PlayerEntry>,
  options?: MockFactoryOptions
): PlayerEntry {
  const rng = createRNG(options?.seed);
  
  const defaults: PlayerEntry = {
    wallet: randomStellarAddress(rng),
    status: randomChoice<PlayerStatus>(rng, ['JOINING', 'READY', 'ALIVE', 'ELIMINATED']),
    joinedAt: Date.now(),
    currentRound: 1,
  };
  
  return {
    ...defaults,
    ...overrides,
  };
}


/**
 * Creates a mock RoundResult with sensible defaults
 * 
 * @param overrides - Partial RoundResult to override defaults
 * @param options - Factory options including optional seed
 * @returns Complete RoundResult object
 * 
 * @example
 * // Generate random round result
 * const round = createMockRoundResult();
 * 
 * @example
 * // Generate deterministic round result
 * const round = createMockRoundResult({}, { seed: 12345 });
 * 
 * @example
 * // Override specific fields
 * const round = createMockRoundResult({ round: 5, eliminatedCount: 10 });
 */
export function createMockRoundResult(
  overrides?: Partial<RoundResult>,
  options?: MockFactoryOptions
): RoundResult {
  const rng = createRNG(options?.seed);
  
  const defaults: RoundResult = {
    round: 1,
    choice: randomChoice<"HEADS" | "TAILS" | null>(rng, ["HEADS", "TAILS", null]),
    outcome: randomChoice<"HEADS" | "TAILS">(rng, ["HEADS", "TAILS"]),
    majorityChoice: randomChoice<"HEADS" | "TAILS">(rng, ["HEADS", "TAILS"]),
    eliminatedCount: randomInt(rng, 0, 50),
  };
  
  return {
    ...defaults,
    ...overrides,
  };
}


/**
 * Creates a mock YieldSnapshot with realistic financial data
 * 
 * @param overrides - Partial YieldSnapshot to override defaults
 * @param options - Factory options including optional seed
 * @returns Complete YieldSnapshot object
 * 
 * @example
 * // Generate random yield snapshot
 * const yieldData = createMockYieldSnapshot();
 * 
 * @example
 * // Generate deterministic yield snapshot
 * const yieldData = createMockYieldSnapshot({}, { seed: 12345 });
 * 
 * @example
 * // Override specific fields
 * const yieldData = createMockYieldSnapshot({ apy: 12.5, principal: 5000 });
 */
export function createMockYieldSnapshot(
  overrides?: Partial<YieldSnapshot>,
  options?: MockFactoryOptions
): YieldSnapshot {
  const rng = createRNG(options?.seed);
  
  const defaults: YieldSnapshot = {
    principal: randomInt(rng, 100, 10000),
    accruedYield: rng.next() * 500, // 0 to 500
    apy: rng.next() * 20, // 0% to 20% APY (realistic DeFi range)
    lastUpdatedAt: Date.now(),
    surgeMultiplier: 1.0 + rng.next() * 2.0, // 1.0 to 3.0
  };
  
  return {
    ...defaults,
    ...overrides,
  };
}


/**
 * Creates an array of mock EliminationEvent objects
 * 
 * @param count - Number of elimination events to generate
 * @param options - Factory options including optional seed
 * @returns Array of EliminationEvent objects
 * @throws {TypeError} If count is not a positive integer
 * 
 * @example
 * // Generate 5 random elimination events
 * const events = createMockEliminationLog(5);
 * 
 * @example
 * // Generate deterministic elimination events
 * const events = createMockEliminationLog(10, { seed: 12345 });
 */
export function createMockEliminationLog(
  count: number,
  options?: MockFactoryOptions
): EliminationEvent[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(`Count must be a non-negative integer, got: ${count}`);
  }
  
  const rng = createRNG(options?.seed);
  const events: EliminationEvent[] = [];
  const reasons: Array<"MINORITY" | "TIMEOUT" | "FORFEIT"> = ["MINORITY", "TIMEOUT", "FORFEIT"];
  
  for (let i = 0; i < count; i++) {
    events.push({
      arenaId: `arena-${randomInt(rng, 1000, 9999)}`,
      round: i + 1, // Sequential round numbers
      walletAddress: randomStellarAddress(rng),
      reason: randomChoice(rng, reasons),
      timestamp: randomTimestamp(rng),
    });
  }
  
  return events;
}

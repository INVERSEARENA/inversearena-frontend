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

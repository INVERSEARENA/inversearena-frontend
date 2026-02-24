# Hook-D: Arena Mock Data Factory

This directory contains the deterministic mock data factory for arena-related types used in blockchain interactions.

## Overview

The `mockFactory.ts` module provides a complete suite of factory functions for generating realistic test data for:
- Arena objects
- Player entries
- Round results
- Yield snapshots
- Elimination events

All factories support:
- **Deterministic generation** via optional seed parameter
- **Partial overrides** for customizing specific fields
- **Type safety** with full TypeScript support
- **No external dependencies** - uses lightweight mulberry32 PRNG

## Quick Start

```typescript
import {
  createMockArena,
  createMockParticipant,
  createMockRoundResult,
  createMockYieldSnapshot,
  createMockEliminationLog,
} from './mockFactory';

// Generate random mock data
const arena = createMockArena();
const participant = createMockParticipant();

// Generate deterministic data (for tests)
const arena1 = createMockArena({}, { seed: 12345 });
const arena2 = createMockArena({}, { seed: 12345 });
// arena1 === arena2 (identical)

// Override specific fields
const customArena = createMockArena({
  status: 'ACTIVE',
  maxPlayers: 50,
  entryFee: '100'
});
```

## Factory Functions

### `createMockArena(overrides?, options?)`
Creates a complete Arena object with participants, rounds, and yield data.

**Default values:**
- Random status and round phase
- 3-5 participants
- 1-3 rounds
- Realistic yield data

### `createMockParticipant(overrides?, options?)`
Creates a PlayerEntry with a valid-format Stellar address.

**Default values:**
- Random Stellar address (56 chars, starts with 'G')
- Random player status
- Current timestamp for joinedAt
- Round 1

### `createMockRoundResult(overrides?, options?)`
Creates a RoundResult with random game outcomes.

**Default values:**
- Random choice (HEADS/TAILS/null)
- Random outcome and majority choice
- 0-50 eliminated players

### `createMockYieldSnapshot(overrides?, options?)`
Creates a YieldSnapshot with realistic DeFi values.

**Default values:**
- Principal: 100-10,000
- APY: 0-20% (realistic DeFi range)
- Surge multiplier: 1.0-3.0
- Positive accrued yield

### `createMockEliminationLog(count, options?)`
Creates an array of EliminationEvent objects.

**Features:**
- Sequential round numbers
- Unique wallet addresses
- Random elimination reasons
- Validates count parameter

## Testing

The factory includes comprehensive tests in `mockFactory.test.ts` that verify:
- Deterministic behavior with seeds
- Override functionality
- Stellar address format validation
- Sequential round numbers
- Realistic value ranges
- Type conformance

To run tests (when test runner is configured):
```bash
npm test mockFactory.test.ts
```

## Architecture

The factory uses a three-layer architecture:

1. **RNG Layer**: Mulberry32 seeded pseudo-random number generator
2. **Generator Layer**: Utility functions for random values (int, choice, address, timestamp)
3. **Factory Layer**: Public API that composes generators into complete objects

## Use Cases

- **Unit Tests**: Generate consistent test data with seeds
- **Storybook Stories**: Create varied UI states for component development
- **Development**: Quickly populate UI with realistic data
- **Integration Tests**: Test blockchain interactions with mock data

## Notes

- This factory is specifically for the `hook-d/arenaTypes.ts` types (blockchain layer)
- For UI-layer arena types, see `shared-d/features/games/data/mockArenas.ts`
- Stellar addresses are format-valid but not cryptographically valid
- All timestamps are in milliseconds since epoch

## Related Files

- `arenaTypes.ts` - Type definitions
- `mockFactory.test.ts` - Test suite
- `sorobanEventParser.ts` - Event parsing utilities

# Arena State Integration Documentation

## Overview

This document describes the implementation of real Soroban contract integration for the `fetchArenaState` function, replacing the previous mock implementation.

## Implementation Details

### Function: `fetchArenaState`

**Location:** `frontend/src/shared-d/utils/stellar-transactions.ts`

**Purpose:** Fetches live arena state from the deployed Soroban arena contract.

### Parameters

- `arenaId: string` - The Stellar contract ID of the arena (validated with `StellarContractIdSchema`)
- `userAddress?: string` - Optional user's Stellar public key (validated with `StellarPublicKeySchema`)

### Return Type

```typescript
interface ArenaStateResponse {
  arenaId: string;
  survivorsCount: number;
  maxCapacity: number;
  isUserIn: boolean;
  hasWon: boolean;
  currentStake: number;
  potentialPayout: number;
  roundNumber: number;
}
```

### How It Works

1. **Validation**: Input parameters are validated using Zod schemas
2. **Contract Query**: Uses Soroban RPC to simulate contract calls (read-only operations)
3. **Arena State**: Calls `get_arena_state()` method on the arena contract
4. **User State**: If user address provided, calls `get_user_state(address)` method
5. **Response Parsing**: Extracts values from ScVal responses using helper functions
6. **Error Handling**: Provides structured error messages for debugging

### Contract Methods Expected

The implementation expects the following contract methods:

#### `get_arena_state()`

Returns a map/struct with:
- `survivors_count: u32` - Current number of survivors
- `max_capacity: u32` - Maximum arena capacity
- `round_number: u32` - Current round number
- `current_stake: i128` - Current stake amount (in stroops)
- `potential_payout: i128` - Potential payout amount (in stroops)

#### `get_user_state(address: Address)`

Returns a map/struct with:
- `is_active: bool` - Whether user is currently in the arena
- `has_won: bool` - Whether user has won

### Configuration

The function uses these constants from `stellar-transactions.ts`:

- `SOROBAN_RPC_URL`: RPC endpoint (default: `https://soroban-testnet.stellar.org`)
- `NETWORK_PASSPHRASE`: Network identifier (default: `Test SDF Network ; September 2015`)

### Error Handling

Errors are caught and wrapped with descriptive messages:

```typescript
try {
  const state = await fetchArenaState(arenaId, userAddress);
} catch (error) {
  // Error message format: "Arena state fetch failed: <details>"
  console.error(error.message);
}
```

Common error scenarios:
- Invalid arena ID format
- Invalid user address format
- Contract not found
- Contract method not found
- Network/RPC errors
- Invalid response structure

### Helper Functions

#### `extractU32FromScVal(scVal, fieldName?)`
Extracts unsigned 32-bit integer from ScVal (for counts, capacities, round numbers)

#### `extractI128FromScVal(scVal, fieldName?)`
Extracts 128-bit integer from ScVal and converts from stroops to decimal (for amounts)

#### `extractBoolFromScVal(scVal, fieldName?)`
Extracts boolean value from ScVal (for flags)

## Integration with Hooks

### `useArenaState` Hook

**Location:** `src/hooks/arena/useArenaState.ts`

The hook consumes `fetchArenaState` and provides:
- Automatic polling (configurable interval, default 5s)
- Loading states
- Error handling
- Automatic stop on terminal states (ENDED)

**Usage:**

```typescript
const { arenaState, loading, error, refetch } = useArenaState(
  arenaId,
  userAddress,
  { refreshInterval: 5000 }
);
```

## Deployment Checklist

Before deploying to production:

1. **Deploy Arena Contract**: Ensure your Soroban arena contract is deployed
2. **Verify Contract Methods**: Confirm the contract has `get_arena_state` and `get_user_state` methods
3. **Update Contract ID**: Replace placeholder contract IDs with real ones
4. **Test Response Structure**: Verify the contract returns data in the expected format
5. **Configure RPC URL**: Update `SOROBAN_RPC_URL` for mainnet if needed
6. **Update Network Passphrase**: Change to mainnet passphrase for production

## Customization

### Adjusting Contract Method Names

If your contract uses different method names, update these lines:

```typescript
// Line ~295
const getStateOperation = arenaContract.call("get_arena_state");

// Line ~340
const userStateOperation = arenaContract.call(
  "get_user_state",
  new Address(validatedUserAddress).toScVal()
);
```

### Adjusting Response Field Names

If your contract returns different field names, update the extraction calls:

```typescript
const survivorsCount = extractU32FromScVal(stateData, "your_field_name");
```

### Adding New Fields

To add new fields to the response:

1. Update the `ArenaStateResponse` interface
2. Add extraction logic in `fetchArenaState`
3. Update the hook if needed

## Testing

### Unit Tests

Run the test suite:

```bash
npm test -- fetchArenaState.test.ts
```

### Manual Testing

1. Deploy a test contract with the expected methods
2. Update the arena ID in your test
3. Call `fetchArenaState` with the contract ID
4. Verify the response structure

### Integration Testing

Test with the `useArenaState` hook in a React component:

```typescript
function TestComponent() {
  const { arenaState, loading, error } = useArenaState(
    "YOUR_ARENA_CONTRACT_ID"
  );
  
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  
  return <pre>{JSON.stringify(arenaState, null, 2)}</pre>;
}
```

## Performance Considerations

- **Polling Interval**: Default 5s, adjust based on your needs
- **RPC Rate Limits**: Be aware of Soroban RPC rate limits
- **Caching**: Consider implementing caching for frequently accessed arenas
- **Error Retry**: The hook automatically retries on the next interval

## Troubleshooting

### "Contract not found" Error

- Verify the contract ID is correct
- Ensure the contract is deployed on the correct network
- Check the RPC URL matches the network

### "Method not found" Error

- Verify contract method names match the implementation
- Check contract ABI/interface

### "Invalid response structure" Error

- Verify contract return types match expected structure
- Check field names in the contract response
- Use browser dev tools to inspect the raw response

### Type Errors

- Ensure TypeScript target is ES2020+ for BigInt support
- Verify `@stellar/stellar-sdk` version is 14.5.0+

## Future Enhancements

Potential improvements:

1. **Contract Spec Integration**: Use contract spec files for type-safe method calls
2. **Response Caching**: Implement Redis/memory caching
3. **Batch Queries**: Fetch multiple arenas in one call
4. **WebSocket Support**: Real-time updates instead of polling
5. **Retry Logic**: Exponential backoff for failed requests
6. **Metrics**: Track query performance and errors

## References

- [Soroban Documentation](https://soroban.stellar.org/)
- [Stellar SDK Documentation](https://stellar.github.io/js-stellar-sdk/)
- [Soroban RPC API](https://developers.stellar.org/docs/data/rpc)

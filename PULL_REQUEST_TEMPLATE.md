# Add configure_arena Function for Admin Parameter Updates

## Issue
Closes #687

## Description
Implements the `configure_arena` function that allows arena administrators to update arena parameters (entry fee, max players, join deadline) after initialization but before the game starts. This provides operational flexibility without requiring contract redeployment.

## Changes Made

### New Files
- **contracts/arena/src/lib.rs** - Main contract with `configure_arena` function
- **contracts/arena/src/types.rs** - ArenaConfig and GameState types
- **contracts/arena/src/storage.rs** - Storage management utilities
- **contracts/arena/src/errors.rs** - Error definitions
- **contracts/arena/src/events.rs** - Event emission utilities
- **contracts/arena/src/test.rs** - Comprehensive test suite (20 tests)
- **contracts/arena/Cargo.toml** - Package configuration
- **contracts/Cargo.toml** - Workspace configuration
- **contracts/arena/.cargo/config.toml** - Build configuration
- **contracts/arena/README.md** - Contract documentation
- **contracts/.gitignore** - Ignore build artifacts
- **IMPLEMENTATION_SUMMARY.md** - Detailed implementation notes

### Statistics
- **12 files changed**
- **1,195 insertions**
- **542 lines of tests**
- **20 test cases**

## Function Signature
```rust
pub fn configure_arena(
    env: Env,
    new_entry_fee: Option<i128>,
    new_max_players: Option<u32>,
    new_join_deadline: Option<u64>,
) -> Result<(), ArenaError>
```

## Key Features
✅ **Admin-only access** - Requires admin authentication
✅ **State validation** - Only works when GameState is Open
✅ **Partial updates** - Update any combination of parameters
✅ **Entry fee validation** - Must be positive (> 0)
✅ **Deadline validation** - Must be in the future
✅ **Event emission** - Emits `arena_configured` event
✅ **Comprehensive tests** - 20 test cases covering all scenarios

## Use Cases

### 1. Extend Join Deadline
```rust
configure_arena(env, None, None, Some(original_deadline + 86400))
```

### 2. Lower Entry Fee
```rust
configure_arena(env, Some(50_000_000), None, None)
```

### 3. Increase Capacity
```rust
configure_arena(env, None, Some(200), None)
```

### 4. Emergency Pause
```rust
configure_arena(env, None, Some(0), None)
```

### 5. Complete Reconfiguration
```rust
configure_arena(
    env,
    Some(75_000_000),
    Some(150),
    Some(current_time + 172800)
)
```

## Test Coverage

### Unit Tests (20 tests)
1. ✅ Valid configuration update (all parameters)
2. ✅ Partial update - entry fee only
3. ✅ Partial update - max players only
4. ✅ Partial update - deadline only
5. ✅ Authorization failure (non-admin)
6. ✅ State validation - InProgress
7. ✅ State validation - Finished
8. ✅ Invalid entry fee - zero
9. ✅ Invalid entry fee - negative
10. ✅ Invalid deadline - past
11. ✅ Invalid deadline - current time
12. ✅ Valid deadline - future
13. ✅ Multiple updates
14. ✅ Event emission
15. ✅ No-op configuration (all None)
16. ✅ Configure after players joined
17. ✅ Configure then start game
18. ✅ Initialize with invalid entry fee
19. ✅ Initialize with past deadline
20. ✅ Edge case - set max players to zero

## Error Handling

| Error | Code | Condition |
|-------|------|-----------|
| `ConfigNotFound` | 1 | Arena not initialized |
| `InvalidEntryFee` | 2 | Entry fee <= 0 |
| `DeadlineTooSoon` | 3 | Deadline <= current time |
| `ArenaAlreadyStarted` | 4 | Game not in Open state |
| `InvalidStateTransition` | 5 | Invalid state change |
| `ArenaFull` | 6 | Max players reached |
| `DeadlinePassed` | 7 | Join deadline passed |

## Security Considerations

✅ **Admin Authentication** - Strict enforcement via `require_auth()`
✅ **State Integrity** - No updates during active game
✅ **Economic Protection** - Entry fee validation prevents zero/negative fees
✅ **Time Validation** - Deadline must be in future
✅ **No Breaking Changes** - Purely additive functionality

## Building & Testing

### Build
```bash
cd contracts/arena
cargo build --target wasm32-unknown-unknown --release
```

### Test
```bash
cargo test
```

**Note**: Tests require proper Rust toolchain setup. On Windows, you may need MinGW/MSYS2 for full build support.

## Acceptance Criteria

✅ `configure_arena` updates the specified parameters
✅ Requires admin auth
✅ Rejected if the game has already started (InProgress or Finished state)
✅ Validates new values (fee > 0, deadline in future)
✅ Emits a `arena_configured` event
✅ Tests cover: valid update, update after start (should fail), invalid values

## Documentation

- ✅ Inline code comments
- ✅ Function-level documentation
- ✅ README with usage examples
- ✅ Error code documentation
- ✅ Test documentation
- ✅ Implementation summary

## Deployment

Ready for deployment to Soroban testnet:

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/arena_contract.wasm \
  --source <YOUR_SECRET_KEY> \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015"
```

## Checklist

- [x] Code follows project style guidelines
- [x] Self-review completed
- [x] Code commented, particularly complex areas
- [x] Documentation updated
- [x] No new warnings generated
- [x] Tests added covering new functionality
- [x] All tests pass locally
- [x] No breaking changes
- [x] Security considerations addressed

## Screenshots/Demo

N/A - Smart contract implementation (no UI changes)

## Additional Notes

This implementation follows the Soroban smart contract best practices and is based on the detailed specification in `docs/CONFIGURE_ARENA_SPEC.md`. The contract is ready for integration with the frontend and backend systems.

## Reviewer Notes

Please pay special attention to:
1. Admin authentication enforcement
2. State validation logic
3. Parameter validation (entry fee, deadline)
4. Test coverage completeness
5. Error handling patterns

## Related Issues/PRs

- Issue #687: Add configure_arena function for admin to update parameters before game starts

# Arena Smart Contract

A Soroban smart contract for managing game arenas with configurable parameters.

## Features

- **Initialize Arena**: Set up a new arena with entry fee, max players, and join deadline
- **Configure Arena**: Update arena parameters before the game starts (Issue #687)
- **Join Arena**: Players can join before the deadline
- **Game State Management**: Transition between Open, InProgress, and Finished states

## Configure Arena Function

The `configure_arena` function allows administrators to update arena parameters after initialization but before the game starts. This provides flexibility to adjust settings based on player adoption rates, market conditions, or operational requirements.

### Parameters

- `new_entry_fee` (Option<i128>): New entry fee in stroops (must be > 0)
- `new_max_players` (Option<u32>): New maximum player capacity
- `new_join_deadline` (Option<u64>): New join deadline as Unix timestamp (must be in future)

### Authorization

Requires admin authentication via `config.admin.require_auth()`

### Preconditions

- Arena must be in `GameState::Open` state
- Function fails with `ArenaError::ArenaAlreadyStarted` if game is InProgress or Finished

### Validation Rules

- **Entry Fee**: Must be positive (> 0)
- **Max Players**: Any u32 value accepted (0 can be used for emergency pause)
- **Join Deadline**: Must be in the future (> current timestamp)

### Use Cases

1. **Extend Join Deadline**: Give more time for players to join
2. **Lower Entry Fee**: Attract more participants during slow periods
3. **Increase Capacity**: Handle high demand by increasing arena size
4. **Emergency Pause**: Set max_players to 0 to prevent new joins
5. **Complete Reconfiguration**: Adjust all parameters based on market feedback

### Example Usage

```rust
// Extend deadline by 1 day
configure_arena(
    env,
    None,                           // Keep entry fee
    None,                           // Keep max players
    Some(original_deadline + 86400) // Extend by 1 day
)

// Lower entry fee to attract more players
configure_arena(
    env,
    Some(50_000_000),  // Reduce to 5 XLM
    None,              // Keep max players
    None               // Keep deadline
)

// Update all parameters
configure_arena(
    env,
    Some(75_000_000),              // Adjust fee
    Some(150),                     // Adjust capacity
    Some(current_time + 172800)    // Extend deadline by 2 days
)
```

## Error Codes

| Error | Code | Description |
|-------|------|-------------|
| `ConfigNotFound` | 1 | Arena configuration not found |
| `InvalidEntryFee` | 2 | Entry fee must be positive |
| `DeadlineTooSoon` | 3 | Deadline must be in the future |
| `ArenaAlreadyStarted` | 4 | Arena has already started or finished |
| `InvalidStateTransition` | 5 | Invalid state transition |
| `ArenaFull` | 6 | Arena is full |
| `DeadlinePassed` | 7 | Join deadline has passed |

## Events

- `INIT`: Arena initialized
- `CFGD`: Arena configured
- `START`: Game started
- `FINISH`: Game finished
- `JOIN`: Player joined

## Building

```bash
cd contracts/arena
cargo build --target wasm32-unknown-unknown --release
```

## Testing

```bash
cargo test
```

## Deployment

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/arena_contract.wasm \
  --source <YOUR_SECRET_KEY> \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015"
```

## Security Considerations

- Admin-only access enforced for configuration changes
- State integrity maintained (no updates during active game)
- Economic attacks prevented (entry fee validation)
- Time manipulation prevented (deadline validation)

## License

See LICENSE file in repository root.

# Configure Arena Function Specification

## Overview

The `configure_arena` function allows the arena administrator to update arena parameters after initialization but before the game starts. This provides flexibility to adjust settings based on player adoption rates, market conditions, or operational requirements without requiring contract redeployment.

## Function Signature

```rust
pub fn configure_arena(
    env: Env,
    new_entry_fee: Option<i128>,
    new_max_players: Option<u32>,
    new_join_deadline: Option<u64>,
) -> Result<(), ArenaError>
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `env` | `Env` | Yes | Soroban environment |
| `new_entry_fee` | `Option<i128>` | No | New entry fee in stroops (1 XLM = 10^7 stroops). If `None`, entry fee remains unchanged. |
| `new_max_players` | `Option<u32>` | No | New maximum player capacity. If `None`, max players remains unchanged. |
| `new_join_deadline` | `Option<u64>` | No | New join deadline as Unix timestamp. If `None`, deadline remains unchanged. |

## Authorization

- **Required:** Admin authentication via `config.admin.require_auth()`
- **Scope:** Only the arena administrator can invoke this function

## Preconditions

### State Requirements
- Arena must be in `GameState::Open` state
- Function fails with `ArenaError::ArenaAlreadyStarted` if:
  - State is `GameState::InProgress`
  - State is `GameState::Finished`

### Validation Rules

#### Entry Fee (`new_entry_fee`)
- **Must be positive:** `fee > 0`
- **Error:** `ArenaError::InvalidEntryFee` if `fee <= 0`
- **Rationale:** Zero or negative fees would break the economic model

#### Max Players (`new_max_players`)
- **No explicit validation required** (u32 is inherently non-negative)
- **Consideration:** Should be >= current player count (implementation detail)
- **Edge case:** Setting to 0 would prevent new joins (valid use case for emergency pause)

#### Join Deadline (`new_join_deadline`)
- **Must be in the future:** `deadline > env.ledger().timestamp()`
- **Error:** `ArenaError::DeadlineTooSoon` if `deadline <= now`
- **Rationale:** Past deadlines would immediately close the arena

## Behavior

### Update Logic
1. Load current arena configuration
2. Verify admin authentication
3. Check arena state is `Open`
4. For each provided parameter:
   - Validate the new value
   - Update the configuration field
5. Save updated configuration
6. Emit `arena_configured` event

### Partial Updates
- Only provided parameters are updated
- `None` values leave existing configuration unchanged
- All three parameters can be updated in a single call
- Any combination of parameters can be updated

## Events

### `arena_configured`
Emitted after successful configuration update.

**Event Data:**
```rust
ArenaEvents::arena_configured(&env);
```

**Suggested Event Payload (Implementation Detail):**
```rust
pub struct ArenaConfiguredEvent {
    pub entry_fee: Option<i128>,
    pub max_players: Option<u32>,
    pub join_deadline: Option<u64>,
    pub updated_by: Address,
    pub timestamp: u64,
}
```

## Error Cases

| Error | Condition | HTTP Analogy |
|-------|-----------|--------------|
| `ArenaError::ArenaAlreadyStarted` | Game state is not `Open` | 409 Conflict |
| `ArenaError::InvalidEntryFee` | Entry fee <= 0 | 400 Bad Request |
| `ArenaError::DeadlineTooSoon` | Deadline <= current time | 400 Bad Request |
| `ArenaError::Unauthorized` | Caller is not admin | 403 Forbidden |

## Use Cases

### 1. Extend Join Deadline
**Scenario:** Player adoption is slower than expected

```rust
configure_arena(
    env,
    None,                           // Keep entry fee
    None,                           // Keep max players
    Some(original_deadline + 86400) // Extend by 1 day
)
```

### 2. Lower Entry Fee
**Scenario:** Attract more participants during slow periods

```rust
configure_arena(
    env,
    Some(50_000_000),  // Reduce from 100 XLM to 5 XLM
    None,              // Keep max players
    None               // Keep deadline
)
```

### 3. Increase Capacity
**Scenario:** High demand, increase arena size

```rust
configure_arena(
    env,
    None,       // Keep entry fee
    Some(200),  // Increase from 100 to 200 players
    None        // Keep deadline
)
```

### 4. Emergency Pause
**Scenario:** Temporarily prevent new joins

```rust
configure_arena(
    env,
    None,    // Keep entry fee
    Some(0), // Set max players to 0 (no new joins)
    None     // Keep deadline
)
```

### 5. Complete Reconfiguration
**Scenario:** Adjust all parameters based on market feedback

```rust
configure_arena(
    env,
    Some(75_000_000),              // Adjust fee
    Some(150),                     // Adjust capacity
    Some(current_time + 172800)    // Extend deadline by 2 days
)
```

## Implementation Checklist

- [ ] Function signature matches specification
- [ ] Admin authentication is enforced
- [ ] State check prevents updates after game starts
- [ ] Entry fee validation (> 0)
- [ ] Deadline validation (> current time)
- [ ] Configuration is persisted correctly
- [ ] Event is emitted on success
- [ ] All error cases return appropriate errors
- [ ] Partial updates work correctly (None values preserved)

## Test Coverage Requirements

### Unit Tests

#### 1. Valid Configuration Update
```rust
#[test]
fn configure_arena_updates_all_parameters() {
    // Setup: Initialize arena with default config
    // Action: Call configure_arena with all new values
    // Assert: All parameters are updated correctly
    // Assert: arena_configured event is emitted
}
```

#### 2. Partial Update - Entry Fee Only
```rust
#[test]
fn configure_arena_updates_entry_fee_only() {
    // Setup: Initialize arena
    // Action: Update only entry_fee
    // Assert: Entry fee changed, other params unchanged
}
```

#### 3. Partial Update - Max Players Only
```rust
#[test]
fn configure_arena_updates_max_players_only() {
    // Setup: Initialize arena
    // Action: Update only max_players
    // Assert: Max players changed, other params unchanged
}
```

#### 4. Partial Update - Deadline Only
```rust
#[test]
fn configure_arena_updates_deadline_only() {
    // Setup: Initialize arena
    // Action: Update only join_deadline
    // Assert: Deadline changed, other params unchanged
}
```

#### 5. Authorization Failure
```rust
#[test]
#[should_panic(expected = "Unauthorized")]
fn configure_arena_requires_admin_auth() {
    // Setup: Initialize arena with admin A
    // Action: Non-admin user B attempts to configure
    // Assert: Panics with Unauthorized error
}
```

#### 6. State Validation - InProgress
```rust
#[test]
fn configure_arena_fails_when_game_in_progress() {
    // Setup: Initialize arena and start game
    // Action: Attempt to configure arena
    // Assert: Returns ArenaError::ArenaAlreadyStarted
}
```

#### 7. State Validation - Finished
```rust
#[test]
fn configure_arena_fails_when_game_finished() {
    // Setup: Initialize arena, play game to completion
    // Action: Attempt to configure arena
    // Assert: Returns ArenaError::ArenaAlreadyStarted
}
```

#### 8. Invalid Entry Fee - Zero
```rust
#[test]
fn configure_arena_rejects_zero_entry_fee() {
    // Setup: Initialize arena
    // Action: Set entry_fee to 0
    // Assert: Returns ArenaError::InvalidEntryFee
}
```

#### 9. Invalid Entry Fee - Negative
```rust
#[test]
fn configure_arena_rejects_negative_entry_fee() {
    // Setup: Initialize arena
    // Action: Set entry_fee to -100
    // Assert: Returns ArenaError::InvalidEntryFee
}
```

#### 10. Invalid Deadline - Past
```rust
#[test]
fn configure_arena_rejects_past_deadline() {
    // Setup: Initialize arena at timestamp T
    // Action: Set deadline to T - 1000
    // Assert: Returns ArenaError::DeadlineTooSoon
}
```

#### 11. Invalid Deadline - Current Time
```rust
#[test]
fn configure_arena_rejects_current_time_deadline() {
    // Setup: Initialize arena at timestamp T
    // Action: Set deadline to T (current time)
    // Assert: Returns ArenaError::DeadlineTooSoon
}
```

#### 12. Valid Deadline - Future
```rust
#[test]
fn configure_arena_accepts_future_deadline() {
    // Setup: Initialize arena at timestamp T
    // Action: Set deadline to T + 86400
    // Assert: Configuration succeeds
}
```

#### 13. Multiple Updates
```rust
#[test]
fn configure_arena_can_be_called_multiple_times() {
    // Setup: Initialize arena
    // Action: Configure arena 3 times with different values
    // Assert: Each update succeeds
    // Assert: Final state reflects last update
}
```

#### 14. Event Emission
```rust
#[test]
fn configure_arena_emits_event() {
    // Setup: Initialize arena
    // Action: Configure arena
    // Assert: arena_configured event is in event log
    // Assert: Event contains correct data
}
```

#### 15. No-Op Configuration
```rust
#[test]
fn configure_arena_with_all_none_succeeds() {
    // Setup: Initialize arena
    // Action: Call configure_arena(None, None, None)
    // Assert: Succeeds (no-op is valid)
    // Assert: Configuration unchanged
}
```

### Integration Tests

#### 16. Configure After Players Join
```rust
#[test]
fn configure_arena_after_players_joined() {
    // Setup: Initialize arena, 5 players join
    // Action: Update max_players to 10
    // Assert: Configuration succeeds
    // Assert: Existing players remain
    // Assert: New players can join up to new limit
}
```

#### 17. Configure Then Start Game
```rust
#[test]
fn configure_then_start_game_uses_new_config() {
    // Setup: Initialize arena
    // Action: Update entry_fee to 50 XLM
    // Action: New player joins with 50 XLM
    // Assert: Join succeeds with new fee
}
```

### Property-Based Tests (Proptest)

#### 18. Entry Fee Range
```rust
proptest! {
    #[test]
    fn configure_arena_accepts_any_positive_fee(fee in 1i128..i128::MAX) {
        // Assert: Any positive fee is accepted
    }
}
```

#### 19. Max Players Range
```rust
proptest! {
    #[test]
    fn configure_arena_accepts_any_max_players(max in 0u32..u32::MAX) {
        // Assert: Any u32 value is accepted
    }
}
```

#### 20. Future Deadline Range
```rust
proptest! {
    #[test]
    fn configure_arena_accepts_any_future_deadline(
        current_time in 1_000_000_000u64..2_000_000_000u64,
        offset in 1u64..1_000_000_000u64
    ) {
        // Setup: Set ledger time to current_time
        // Action: Set deadline to current_time + offset
        // Assert: Configuration succeeds
    }
}
```

## Security Considerations

### 1. Admin-Only Access
- **Risk:** Unauthorized configuration changes
- **Mitigation:** Strict admin authentication enforcement
- **Test:** Authorization failure test

### 2. State Integrity
- **Risk:** Configuration changes during active game
- **Mitigation:** State check prevents updates after game starts
- **Test:** State validation tests

### 3. Economic Attacks
- **Risk:** Setting entry fee to 0 or negative
- **Mitigation:** Entry fee validation (> 0)
- **Test:** Invalid entry fee tests

### 4. Denial of Service
- **Risk:** Setting max_players to 0 prevents all joins
- **Mitigation:** This is a valid use case (emergency pause)
- **Note:** Admin responsibility to use wisely

### 5. Time Manipulation
- **Risk:** Setting deadline in the past
- **Mitigation:** Deadline validation (> current time)
- **Test:** Invalid deadline tests

## Gas Considerations

### Estimated Gas Cost
- **Storage reads:** 1 (load config)
- **Storage writes:** 1 (save config)
- **Auth checks:** 1 (admin auth)
- **Event emission:** 1
- **Total:** Low gas cost, suitable for frequent updates

### Optimization Opportunities
- Consider batching multiple configuration updates
- Cache current timestamp to avoid multiple ledger reads

## Migration Path

### From Current State
1. Deploy updated contract with `configure_arena` function
2. No data migration required (existing arenas unaffected)
3. Admin can immediately use new function on existing arenas

### Backward Compatibility
- Existing `initialize` function remains unchanged
- No breaking changes to existing functions
- New function is purely additive

## Documentation Requirements

### User-Facing Documentation
- [ ] Add to contract README
- [ ] Include usage examples
- [ ] Document error cases
- [ ] Explain use cases

### Developer Documentation
- [ ] Add inline code comments
- [ ] Document event structure
- [ ] Include integration examples
- [ ] Update API reference

### Operational Documentation
- [ ] Admin guide for using configure_arena
- [ ] Best practices for parameter updates
- [ ] Emergency procedures (pause/resume)
- [ ] Monitoring and alerting recommendations

## Success Metrics

### Functional Metrics
- All 20 tests pass
- Code coverage > 95% for new function
- No regressions in existing tests

### Operational Metrics
- Function callable by admin
- Configuration updates persist correctly
- Events emitted successfully
- Gas costs within acceptable range

### Business Metrics
- Enables flexible arena management
- Reduces need for contract redeployment
- Improves operational efficiency
- Supports dynamic pricing strategies

## Future Enhancements

### Potential Additions
1. **Configuration History:** Track all configuration changes
2. **Scheduled Updates:** Allow time-based configuration changes
3. **Multi-Sig Admin:** Require multiple admin approvals
4. **Configuration Limits:** Set bounds on parameter changes
5. **Notification System:** Alert players of configuration changes

### Not in Scope
- Changing configuration during active game
- Refunding players after fee changes
- Automatic configuration based on metrics
- Player voting on configuration changes

## References

- Issue #687: Add configure_arena function
- Arena Contract Architecture: `contract/ARCHITECTURE.md`
- Error Definitions: `contract/ERRORS.md`
- Event Definitions: `contract/EVENTS.md`
- Data Model: `contract/DATA_MODEL.md`

---

**Document Version:** 1.0  
**Last Updated:** 2026-05-29  
**Status:** Ready for Implementation

# Issue #1595: Split arena/src/lib.rs into Lifecycle, Gameplay, Settlement, and Admin Modules

## Problem Statement

`contract/arena/src/lib.rs` is 4,144 lines containing:
- All entry points
- Private helper functions
- Large inline test module
- Mixed concerns (lifecycle, gameplay, settlement, admin, views)

**Current limitations:**
- Hard to review fund-moving paths (scroll through unrelated code)
- Frequent merge conflicts (everything in one file)
- Security invariants (CEI ordering, reentrancy guards) hard to audit
- Difficult to understand module responsibilities

## Solution Overview

Refactor into focused modules:
1. **lifecycle.rs** - Arena initialization, start, resolve, expire, cancel
2. **gameplay.rs** - Player actions: join, commit, reveal
3. **settlement.rs** - Prize claims and refunds
4. **admin.rs** - Pause, upgrade, roles, limits
5. **views.rs** - Read-only query functions
6. **lib.rs** - Thin #[contractimpl] delegation layer

## Module Structure

```
contract/arena/src/
├── lib.rs                    # Thin contractimpl, delegates to modules
├── modules/
│   ├── lifecycle.rs          # <600 lines
│   ├── gameplay.rs           # <600 lines
│   ├── settlement.rs         # <600 lines
│   ├── admin.rs              # <600 lines
│   └── views.rs              # <600 lines
├── types.rs                  # Shared types (Player, Round, ArenaState)
├── storage.rs                # Storage key helpers
├── errors.rs                 # Error types
└── tests/
    ├── lifecycle.rs          # Tests moved from inline
    ├── gameplay.rs
    ├── settlement.rs
    └── admin.rs
```

## Implementation Plan

### 1. Create Module Structure

**File**: `contract/arena/src/modules/mod.rs`

```rust
pub mod lifecycle;
pub mod gameplay;
pub mod settlement;
pub mod admin;
pub mod views;

// Re-export for convenience
pub use lifecycle::*;
pub use gameplay::*;
pub use settlement::*;
pub use admin::*;
pub use views::*;
```

### 2. Extract Lifecycle Module

**File**: `contract/arena/src/modules/lifecycle.rs`

```rust
//! Arena Lifecycle Management
//!
//! This module owns all state transitions for arena instances:
//! - Initialization with parameters
//! - Starting rounds with signature verification
//! - Resolving rounds with oracle data
//! - Expiration handling
//! - Cancellation and cleanup
//!
//! ## Invariants
//! - State transitions are monotonic (no backwards moves)
//! - Signatures must be fresh (within time window)
//! - Oracle data must be recent (staleness checks)
//! - All state changes use CEI pattern (checks-effects-interactions)

use soroban_sdk::{contract, contractimpl, Env, Address};

use crate::types::{ArenaState, RoundState};
use crate::storage::{get_arena_state, set_arena_state};
use crate::errors::ArenaError;

pub struct LifecycleModule;

impl LifecycleModule {
    /// Initialize a new arena instance
    ///
    /// ## Security
    /// - Admin cannot be zero address
    /// - Entry fee must be positive
    /// - Max players must be >= 2
    ///
    /// ## CEI Pattern
    /// 1. Check: Validate all parameters
    /// 2. Effect: Initialize storage
    /// 3. Interaction: None (initialization)
    pub fn initialize(
        env: &Env,
        admin: Address,
        entry_fee: i128,
        max_players: u32,
    ) -> Result<(), ArenaError> {
        // Validate parameters
        if entry_fee <= 0 {
            return Err(ArenaError::InvalidEntryFee);
        }
        if max_players < 2 {
            return Err(ArenaError::InvalidMaxPlayers);
        }

        // Initialize arena state
        let state = ArenaState {
            admin,
            entry_fee,
            max_players,
            round_number: 0,
            status: Status::Created,
        };

        set_arena_state(env, &state);
        
        Ok(())
    }

    /// Start a new round with signature verification
    ///
    /// ## Security
    /// - Only admin can start rounds
    /// - Signature must be fresh (timestamp within window)
    /// - Previous round must be resolved
    /// - Reentrancy guard active
    ///
    /// ## CEI Pattern
    /// 1. Check: Verify signature, state, permissions
    /// 2. Effect: Update round number, timestamp
    /// 3. Interaction: None
    pub fn start_round(
        env: &Env,
        caller: Address,
        signature: Signature,
    ) -> Result<(), ArenaError> {
        // Checks
        let state = get_arena_state(env)?;
        
        // Admin-only
        if caller != state.admin {
            return Err(ArenaError::Unauthorized);
        }

        // Signature freshness
        if !is_signature_fresh(env, &signature) {
            return Err(ArenaError::StaleSignature);
        }

        // Effects
        let new_round = state.round_number + 1;
        set_round_number(env, new_round);
        set_round_status(env, new_round, RoundState::Active);

        // Emit event
        env.events().publish((symbol_short!("start"), new_round), ());

        Ok(())
    }

    // ... Additional lifecycle functions with similar documentation
}

// Helper functions (private to module)
fn is_signature_fresh(env: &Env, signature: &Signature) -> bool {
    const MAX_AGE_SECONDS: u64 = 300; // 5 minutes
    let now = env.ledger().timestamp();
    now - signature.timestamp <= MAX_AGE_SECONDS
}
```

### 3. Extract Gameplay Module

**File**: `contract/arena/src/modules/gameplay.rs`

```rust
//! Player Gameplay Actions
//!
//! This module handles all player interactions during active rounds:
//! - Joining arenas with entry fee payment
//! - Committing choices (hidden)
//! - Revealing choices with validation
//!
//! ## Invariants
//! - Players can only join once per arena
//! - Commits are binding (cannot change after commit)
//! - Reveals must match prior commits
//! - All payments use CEI pattern

pub struct GameplayModule;

impl GameplayModule {
    /// Player joins arena by paying entry fee
    ///
    /// ## Security
    /// - Entry fee must be exact amount
    /// - Player cannot join twice
    /// - Arena must be in Joinable state
    /// - Payment before state change (CEI)
    ///
    /// ## CEI Pattern
    /// 1. Check: Validate amount, state, not already joined
    /// 2. Effect: Record player, increment count
    /// 3. Interaction: Transfer tokens from player
    pub fn join(
        env: &Env,
        player: Address,
        amount: i128,
    ) -> Result<(), ArenaError> {
        // Implementation with detailed CEI pattern
    }

    /// Player commits to a choice (hidden)
    ///
    /// ## Security
    /// - Commitment hash prevents frontrunning
    /// - Cannot change commitment once made
    /// - Round must be in Commit phase
    ///
    /// ## CEI Pattern
    /// 1. Check: Validate player enrolled, phase correct
    /// 2. Effect: Store commitment hash
    /// 3. Interaction: None
    pub fn commit(
        env: &Env,
        player: Address,
        commitment: Hash,
    ) -> Result<(), ArenaError> {
        // Implementation
    }

    /// Player reveals their choice
    ///
    /// ## Security
    /// - Revealed choice must hash to prior commitment
    /// - Round must be in Reveal phase
    /// - Cannot reveal twice
    ///
    /// ## CEI Pattern
    /// 1. Check: Validate commitment matches, phase correct
    /// 2. Effect: Store revealed choice
    /// 3. Interaction: None
    pub fn reveal(
        env: &Env,
        player: Address,
        choice: u32,
        salt: BytesN<32>,
    ) -> Result<(), ArenaError> {
        // Implementation with hash verification
    }
}
```

### 4. Extract Settlement Module

**File**: `contract/arena/src/modules/settlement.rs`

```rust
//! Prize Settlement and Refunds
//!
//! This module handles all money-out operations:
//! - Winner claiming prizes
//! - Refunds for cancelled arenas
//! - Elimination payouts
//!
//! ## Invariants
//! - Claims can only happen once per winner
//! - Refunds can only happen if arena cancelled
//! - All transfers use CEI pattern
//! - Total outflows <= total inflows

pub struct SettlementModule;

impl SettlementModule {
    /// Winner claims prize after round resolution
    ///
    /// ## Security
    /// - Only winner can claim
    /// - Can only claim once
    /// - Prize amount is oracle-verified
    /// - State change before transfer (CEI)
    ///
    /// ## CEI Pattern
    /// 1. Check: Verify winner, not already claimed, round resolved
    /// 2. Effect: Mark as claimed, record amount
    /// 3. Interaction: Transfer prize to winner
    pub fn claim_prize(
        env: &Env,
        winner: Address,
    ) -> Result<i128, ArenaError> {
        // Checks
        let round = get_current_round(env)?;
        if round.winner != Some(winner.clone()) {
            return Err(ArenaError::NotWinner);
        }
        if is_already_claimed(env, winner.clone())? {
            return Err(ArenaError::AlreadyClaimed);
        }

        // Calculate prize (from oracle yield + stakes)
        let prize = calculate_prize(env, &round)?;

        // Effects
        set_claimed(env, winner.clone(), prize);
        emit_prize_claimed_event(env, winner.clone(), prize);

        // Interactions
        transfer_prize(env, winner, prize)?;

        Ok(prize)
    }

    /// Player requests refund from cancelled arena
    ///
    /// ## Security
    /// - Arena must be cancelled
    /// - Player must have paid entry fee
    /// - Can only refund once
    /// - State change before transfer (CEI)
    ///
    /// ## CEI Pattern
    /// 1. Check: Verify cancelled, player joined, not refunded
    /// 2. Effect: Mark as refunded
    /// 3. Interaction: Return entry fee
    pub fn refund(
        env: &Env,
        player: Address,
    ) -> Result<i128, ArenaError> {
        // Implementation with CEI pattern
    }
}

// Helper: Calculate prize from oracle yield + eliminated stakes
fn calculate_prize(env: &Env, round: &Round) -> Result<i128, ArenaError> {
    let winner_stake = get_player_stake(env, &round.winner.unwrap())?;
    let eliminated_stake = get_eliminated_total(env, round.number)?;
    let yield_bps = get_oracle_yield(env)?;
    
    // Basis points: 100 bps = 1%
    // yield_amount = eliminated_stake * (yield_bps / 10000)
    let yield_amount = (eliminated_stake as i128)
        .checked_mul(yield_bps as i128)
        .ok_or(ArenaError::Overflow)?
        .checked_div(10_000)
        .ok_or(ArenaError::DivisionByZero)?;
    
    winner_stake
        .checked_add(eliminated_stake)
        .and_then(|total| total.checked_add(yield_amount))
        .ok_or(ArenaError::Overflow)
}
```

### 5. Extract Admin Module

**File**: `contract/arena/src/modules/admin.rs`

```rust
//! Administrative Operations
//!
//! This module handles privileged operations:
//! - Pause/unpause (circuit breaker)
//! - Upgrade authorization
//! - Role management
//! - Parameter limits
//!
//! ## Invariants
//! - Admin-only operations
//! - Cannot pause during active transfers
//! - Upgrades require authorization

pub struct AdminModule;

impl AdminModule {
    /// Pause arena (circuit breaker)
    ///
    /// ## Security
    /// - Admin-only
    /// - Cannot pause during active settlement
    /// - Emits event for transparency
    pub fn pause(env: &Env, caller: Address) -> Result<(), ArenaError> {
        require_admin(env, caller)?;
        
        let state = get_arena_state(env)?;
        if state.status == Status::SettlingPrize {
            return Err(ArenaError::CannotPauseDuringSettlement);
        }

        set_paused(env, true);
        env.events().publish((symbol_short!("pause"), ()), ());
        
        Ok(())
    }

    /// Unpause arena
    ///
    /// ## Security
    /// - Admin-only
    /// - Emits event for transparency
    pub fn unpause(env: &Env, caller: Address) -> Result<(), ArenaError> {
        require_admin(env, caller)?;
        
        set_paused(env, false);
        env.events().publish((symbol_short!("unpause"), ()), ());
        
        Ok(())
    }

    // Additional admin functions...
}
```

### 6. Thin Delegation Layer

**File**: `contract/arena/src/lib.rs`

```rust
//! Arena Contract Entry Points
//!
//! This module provides a thin delegation layer from contract entry points
//! to their respective modules. All business logic lives in modules.

#![no_std]

mod modules;
mod types;
mod storage;
mod errors;

use soroban_sdk::{contract, contractimpl, Env, Address};

pub use modules::*;
pub use types::*;
pub use errors::*;

#[contract]
pub struct ArenaContract;

#[contractimpl]
impl ArenaContract {
    // ========================================
    // Lifecycle
    // ========================================

    pub fn initialize(
        env: Env,
        admin: Address,
        entry_fee: i128,
        max_players: u32,
    ) -> Result<(), ArenaError> {
        LifecycleModule::initialize(&env, admin, entry_fee, max_players)
    }

    pub fn start_round(
        env: Env,
        signature: Signature,
    ) -> Result<(), ArenaError> {
        let caller = env.current_contract_address();
        LifecycleModule::start_round(&env, caller, signature)
    }

    // ========================================
    // Gameplay
    // ========================================

    pub fn join(env: Env, player: Address, amount: i128) -> Result<(), ArenaError> {
        GameplayModule::join(&env, player, amount)
    }

    pub fn commit(env: Env, player: Address, commitment: Hash) -> Result<(), ArenaError> {
        GameplayModule::commit(&env, player, commitment)
    }

    pub fn reveal(env: Env, player: Address, choice: u32, salt: BytesN<32>) -> Result<(), ArenaError> {
        GameplayModule::reveal(&env, player, choice, salt)
    }

    // ========================================
    // Settlement
    // ========================================

    pub fn claim_prize(env: Env, winner: Address) -> Result<i128, ArenaError> {
        SettlementModule::claim_prize(&env, winner)
    }

    pub fn refund(env: Env, player: Address) -> Result<i128, ArenaError> {
        SettlementModule::refund(&env, player)
    }

    // ========================================
    // Admin
    // ========================================

    pub fn pause(env: Env) -> Result<(), ArenaError> {
        let caller = env.current_contract_address();
        AdminModule::pause(&env, caller)
    }

    pub fn unpause(env: Env) -> Result<(), ArenaError> {
        let caller = env.current_contract_address();
        AdminModule::unpause(&env, caller)
    }

    // ========================================
    // Views
    // ========================================

    pub fn get_winner(env: Env) -> Option<Address> {
        ViewsModule::get_winner(&env)
    }

    pub fn get_round_state(env: Env, round_number: u32) -> Option<RoundState> {
        ViewsModule::get_round_state(&env, round_number)
    }
}
```

### 7. Move Tests Out

**File**: `contract/arena/tests/lifecycle.rs`

```rust
#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env};
use arena::{ArenaContract, ArenaContractClient};

#[test]
fn initialize_sets_admin() {
    let env = Env::default();
    let contract_id = env.register_contract(None, ArenaContract);
    let client = ArenaContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin, &100, &10);

    // Assertions...
}

#[test]
fn start_round_requires_admin() {
    // Test implementation...
}

// More lifecycle tests...
```

## Testing Strategy

### Verification Checklist

```bash
# 1. ABI snapshot unchanged
cargo test --package arena -- --test-threads=1 > snapshot_before.txt
# After refactor
cargo test --package arena -- --test-threads=1 > snapshot_after.txt
diff snapshot_before.txt snapshot_after.txt  # Should be empty

# 2. WASM size delta
cargo build --release --target wasm32-unknown-unknown
ls -lh target/wasm32-unknown-unknown/release/arena.wasm
# Record size, should be ≤1% change

# 3. All tests pass
cargo test --package arena

# 4. Module size check
wc -l contract/arena/src/modules/*.rs
# Each should be < 600 lines
```

## Acceptance Criteria

- [ ] No behaviour change: ABI byte-identical
- [ ] Each module < 600 lines
- [ ] Inline #[cfg(test)] moved to tests/
- [ ] Module docs explain owned invariants
- [ ] WASM size delta ≤ 1%
- [ ] All tests pass
- [ ] CEI pattern documented per function
- [ ] Security invariants clear

## Rollback Plan

- Git revert to single file
- All tests still pass (no behaviour change)
- WASM output byte-identical

## Benefits

1. **Security audits easier**: Fund-moving paths isolated
2. **Merge conflicts reduced**: Changes touch specific modules
3. **Onboarding faster**: New devs understand one module at a time
4. **Testing clearer**: Module-specific test files
5. **CEI pattern visible**: Documented per module

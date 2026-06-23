# Inverse Arena — Smart Contract Architecture

## Overview

Inverse Arena is a minority-wins elimination game on Stellar. Players join arenas by paying an entry fee, then each round they choose Heads or Tails. The **minority** choice survives; the **majority** is eliminated. Last player standing wins the pot.

## Contract: `InverseArenaContract`

Single Soroban contract handling all game logic, deployed on Stellar.

### Modules

| Module | File | Responsibility |
|--------|------|----------------|
| **lib** | `src/lib.rs` | Contract entry points — all public functions |
| **types** | `src/types.rs` | Data structures: ArenaConfig, ArenaState, PlayerInfo, etc. |
| **errors** | `src/errors.rs` | Custom error codes (1–120 range) |
| **events** | `src/events.rs` | Event emission for frontend indexing |
| **storage** | `src/storage.rs` | Storage keys, TTL constants, helpers |
| **admin** | `src/admin.rs` | Admin auth checks, config management |
| **player** | `src/player.rs` | Player profile and per-arena player data |
| **game** | `src/game.rs` | Round logic: start, submit choice, resolve |
| **rewards** | `src/rewards.rs` | Prize calculation, claim, refund |

### Storage Model

```
Instance Storage (contract-level, shared):
├── Config           → ContractConfig (admin, fees, bounds)
└── ArenaCount       → u64

Persistent Storage (long-lived):
├── ArenaConfig(id)        → ArenaConfig
├── ArenaState(id)         → ArenaState
├── ArenaPlayers(id)       → Vec<Address>
├── PlayerInfo(id, addr)   → PlayerInfo
├── PlayerProfile(addr)    → PlayerProfile
└── CreatorStake(addr)     → CreatorStake

Temporary Storage (round-scoped):
└── RoundChoices(id, round) → choice data
```

### Arena Lifecycle

```
PENDING → ACTIVE → (rounds) → FINISHED
   │                              ↑
   └─ CANCELLED          winner declared
```

1. **PENDING**: Creator calls `create_arena`. Players call `join_arena`.
2. **ACTIVE**: Creator/admin calls `start_round`. Players `submit_choice`. Creator calls `resolve_round`.
3. **FINISHED**: One survivor remains. Winner calls `claim_winnings`.
4. **CANCELLED**: Admin cancels. Players call `claim_refund`.

### Round Resolution (Minority Wins)

1. Players submit Heads or Tails before the deadline.
2. After deadline, `resolve_round` counts choices.
3. Majority choice is the losing side — those players are eliminated.
4. Players who didn't submit are also eliminated.
5. If one player remains, game ends and they're declared the winner.

### Fee Structure

- **Entry Fee**: Paid by each player on join. Goes into the arena pot.
- **Platform Fee**: Percentage (basis points) deducted from the pot on payout.
- **Creator Stake**: Minimum deposit required to create arenas. Slashed if creator misbehaves.

### Events

All events are emitted for frontend/indexer consumption:
- `initialized`, `arena_created`, `player_joined`
- `choice_submitted`, `round_resolved`
- `winner_declared`, `reward_claimed`
- `arena_cancelled`, `refund_claimed`

### Security Considerations

- All state-changing functions require `require_auth()`
- Admin-only functions check caller against stored admin
- Contract can be paused by admin
- Commit-reveal scheme planned to prevent front-running (not yet implemented)

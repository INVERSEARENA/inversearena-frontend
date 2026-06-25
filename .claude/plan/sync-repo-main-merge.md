## Implementation Plan: Sync Repo with INVERSEARENA/main & Resolve Merge Conflicts

### Task Type
- [x] Fullstack (→ Parallel)

### Branch State
| Remote | HEAD | Status |
|--------|------|--------|
| `INVERSEARENA/main` | `0a0739b6` | Upstream — 2 commits ahead of common base |
| `origin/main` | `828cdead` | Our fork — 1 commit ahead of common base |
| Local `main` | `828cdead` | Tracking `origin/main` |

### Divergent Commits
**INVERSEARENA/main (upstream):**
1. `28d3ac86` — feat(arena): global stats query, RWA yield adapter, capacity edge-case tests, event schema doc
2. `0a0739b6` — fix(contract): guard extend_persistent_ttl against non-existent keys

**origin/main (our fork):**
1. `828cdead` — feat: add staking contract, reentrancy guards, arena metadata, pause/unpause, expire arena, and oracle persistence

### Technical Solution
Merge `INVERSEARENA/main` into `main` (our fork) by cherry-picking the two upstream commits onto our branch and resolving conflicts. Strategy per conflict group:

**Group A — New files from upstream**: Keep both (no conflict)
- `docs/event-schema.md` (new upstream doc)

**Group B — `contract/arena/src/*` (newer codebase): Accept ours for storage, accept theirs for lib, merge rest**
- `contract/arena/src/storage.rs`: Keep **ours** (the `if has` guard is the actual fix)
- `contract/arena/src/lib.rs`: Accept **theirs** for reentrancy guard removal, keep **ours** for `expire_arena` and `DeadlineTooSoon`
- `contract/arena/src/events.rs`: Keep **ours** (adds `arena_expired` event)
- `contract/arena/src/types.rs`: Keep **ours** (adds `DeadlineTooSoon` error)

**Group C — `contracts/arena/src/*` (older codebase): Accept theirs (upstream features)**
- `events.rs`, `lib.rs`, `storage.rs`, `test.rs`, `types.rs`: Accept **theirs** (GlobalStats, RWA yield, simplified config)

**Group D — `contract/factory/src/*`: Keep ours (new features)**
- `lib.rs`, `storage.rs`, `types.rs`: Keep **ours** (pause/unpause, active pool tracking, pool metadata, arena listing)

**Group E — `contract/staking/src/*`: Keep ours (full implementation)**
- `lib.rs`: Keep **ours** (stake/unstake with share accounting)
- `types.rs`: Keep **ours** (StakePosition, StakerStats, StakingError)

**Group F — `backend/src/routes/oracle.ts`: Keep ours (refactored)**
- Keep **ours** (cache service integration, typed YieldData interface)

### Implementation Steps

**Step 1: Stash current state & fetch upstream**
```bash
git fetch INVERSEARENA
```

**Step 2: Create merge commit with conflict resolution**
```bash
git merge INVERSEARENA/main
```
This will produce conflicts. Resolve each group:

**Step 3: Resolve `contract/arena/src/lib.rs`**
- Accept INVERSEARENA's removal of `enter_reentrancy_guard`/`exit_reentrancy_guard` from `join_arena`, `cancel_arena`, `resolve_round`, `claim`
- Accept INVERSEARENA's if-let restructure for `load_max_players`
- Keep **our** `expire_arena` function (INVERSEARENA removed it)
- Keep **our** `DeadlineTooSoon` error usage in `expire_arena`

**Step 4: Resolve `contract/arena/src/storage.rs`**
- Accept **ours** (the `if env.storage().persistent().has(key)` guard) — this IS the fix from INVERSEARENA's commit `0a0739b6`, just implemented differently
- Keep **our** import ordering

**Step 5: Resolve `contract/arena/src/types.rs`**
- Accept **ours** (adds `DeadlineTooSoon = 28`)

**Step 6: Resolve `contract/arena/src/events.rs`**
- Accept **ours** (adds `arena_expired` event)

**Step 7: Resolve `contracts/arena/src/lib.rs`**
- Accept **theirs** entirely:
  - Remove `factory_address` parameter from `initialize`
  - Rename `token_address` → `token`
  - Remove token whitelist (`add_approved_token`, `remove_approved_token`, `get_approved_tokens`)
  - Remove `set_max_active_pools`
  - Remove `active_pools`/`max_active_pools_per_creator` from `ArenaConfig`
  - Add `get_global_stats()` with GlobalStats
  - Add `receive_rwa_yield()` with RwaYieldRecord
  - Simplified `deposit_creator_stake`/`withdraw_creator_stake`
  - Add `increment_arena_count`, `increment_live_survivors`, `decrement_live_survivors`, `add_to_global_pool`, `set_prize_pool` in `join`

**Step 8: Resolve `contracts/arena/src/storage.rs`**
- Accept **theirs** entirely:
  - Replace APPROVED_TOKENS_KEY/ACTIVE_POOLS_KEY with GLOBAL_STATS_KEY/RWA_COUNTER_KEY/PRIZE_POOL_KEY
  - Replace token whitelist functions with global stats functions
  - Replace active pool tracking with RWA yield record functions
  - Add `get_prize_pool`, `set_prize_pool`, `create_rwa_yield`, `load_rwa_yield`

**Step 9: Resolve `contracts/arena/src/types.rs`**
- Accept **theirs** entirely:
  - Add `GlobalStats` struct with `total_arenas`, `live_survivors`, `global_pool_total`
  - Add `RwaYieldRecord` struct with `id`, `adapter`, `yield_amount`, `received_at`, `source_label`
  - Rename `token_address` → `token` in `ArenaConfig`
  - Remove `max_active_pools_per_creator`, `active_pools`, `factory_address` from `ArenaConfig`
  - Remove `ApprovedToken` struct

**Step 10: Resolve `contracts/arena/src/events.rs`**
- Accept **theirs** entirely:
  - Replace `stake_deposited`/`stake_withdrawn` with `creator_stake_deposited`/`creator_stake_withdrawn`
  - Replace `token_approved`/`token_removed`/`max_pools_configured` with `rwa_yield_received`
  - Remove `player_auto_eliminated`

**Step 11: Resolve `contracts/arena/src/test.rs`**
- Accept **theirs** entirely:
  - Update all `initialize` calls to remove `factory_address` parameter (8th arg → 7 args)
  - Remove tests: `duplicate_join_rejected`, `join_when_full_rejected`, `join_after_deadline_rejected`, `join_non_existent_arena_rejected`, `join_active_arena_rejected`, `multiple_players_join_same_arena`
  - Remove tests: `non_admin_cannot_*` series (7 tests), `admin_succeeds_calling_admin_functions`
  - Replace with new tests: `capacity_minimum_two_players`, `capacity_join_at_max`, `capacity_large_arena_tie_round`, `capacity_hundred_players`, `global_stats_updated_on_join_and_elimination`, `rwa_yield_grows_prize_pool_and_returns_id`
  - Keep the original test functions that weren't changed

**Step 12: Resolve `contract/factory/src/lib.rs`**
- Accept **ours** entirely (INVERSEARENA has no changes here, the "conflict" is from our additions)

**Step 13: Resolve `contract/factory/src/storage.rs`**
- Accept **ours** entirely (our additions)

**Step 14: Resolve `contract/factory/src/types.rs`**
- Accept **ours** entirely (our additions)

**Step 15: Resolve `contract/staking/src/lib.rs`**
- Accept **ours** entirely (full staking implementation)

**Step 16: Resolve `contract/staking/src/types.rs`**
- Accept **ours** (keep the file — INVERSEARENA doesn't have it)

**Step 17: Resolve `backend/src/routes/oracle.ts`**
- Accept **ours** (cache service integration, typed defaults)

**Step 18: Keep new upstream file**
- Keep `docs/event-schema.md` (new upstream documentation)

**Step 19: Commit the merge**
```bash
git add .
git commit -m "merge: sync with INVERSEARENA/main, resolve conflicts"
```

### Key Files
| File | Operation | Description |
|------|-----------|-------------|
| `contract/arena/src/lib.rs` | Manual merge | Accept their reentrancy guard removal + if-let; keep our expire_arena |
| `contract/arena/src/storage.rs` | Keep ours | Accept our `if has` guard (same fix as theirs) |
| `contract/arena/src/types.rs` | Keep ours | Our `DeadlineTooSoon` addition |
| `contract/arena/src/events.rs` | Keep ours | Our `arena_expired` event addition |
| `contracts/arena/src/lib.rs` | Accept theirs | GlobalStats, RWA yield, simplified config |
| `contracts/arena/src/storage.rs` | Accept theirs | New storage keys for global stats, RWA, prize pool |
| `contracts/arena/src/types.rs` | Accept theirs | GlobalStats/RwaYieldRecord, simplified ArenaConfig |
| `contracts/arena/src/events.rs` | Accept theirs | Renamed stake events, removed token whitelist events |
| `contracts/arena/src/test.rs` | Accept theirs | New capacity/global stats/RWA tests |
| `contract/factory/src/lib.rs` | Keep ours | pause/unpause, release_arena, pool metadata, arena listing |
| `contract/factory/src/storage.rs` | Keep ours | Active pool count, pause state, pool storage |
| `contract/factory/src/types.rs` | Keep ours | ArenaMetadata, ArenaStatus, new errors |
| `contract/staking/src/lib.rs` | Keep ours | Full staking implementation |
| `contract/staking/src/types.rs` | Keep ours | Stake types and errors |
| `backend/src/routes/oracle.ts` | Keep ours | Cache service, typed defaults |
| `docs/event-schema.md` | Add theirs | New upstream documentation |

### Risks and Mitigation
| Risk | Mitigation |
|------|------------|
| **Dual codebases** (`contract/` vs `contracts/`) may have inconsistent merge outcomes | Handle each as a separate unit; verify tests pass for both |
| **Snapshots tests** may break due to struct changes | Run `cargo test test_snapshots -- --nocapture` and update byte arrays per CONTRIBUTING.md |
| **Reentrancy guard change** in `contract/arena/src/lib.rs` removes existing guards | The upstream already verified the CEI pattern is sufficient; keep their version |
| **`expire_arena` might conflict** with upstream's intention to remove it | Keep it — it's an independently useful feature that doesn't conflict structurally |
| **Staking contract** may need `contract/staking/src/types.rs` snapshot tests | Add snapshot tests if missing |

### Post-Merge Verification
```bash
# Verify merge completed
git log --oneline -5

# Rust contracts
cd contract && cargo test 2>&1 | tail -20
cd ../contracts && cargo test 2>&1 | tail -20

# Backend
cd ../backend && npm test 2>&1 | tail -20

# Check snapshot tests
cargo test test_snapshots -- --nocapture
```

### SESSION_IDs
- CODEX_SESSION: N/A (codex CLI not available in environment)
- GEMINI_SESSION: N/A (gemini CLI not available in environment)

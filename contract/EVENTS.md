# Contract Event Reference

Arena and factory events include a version marker (`v: u32`) in the
data payload. Consumers should check this field to detect schema changes
without requiring redeployment.

Current payload version: **1**

---

## Arena Contract

| Topic | Emitting Function | Data Fields | Description |
|-------|-------------------|-------------|-------------|
| `init` | `ArenaEvents::initialized()` | `(admin)` | Emitted when initialized occurs. |
| `join`, `player` | `ArenaEvents::player_joined()` | `(player_count)` | Emitted when player joined occurs. |
| `ban`, `admin` | `ArenaEvents::player_banned()` | `(player)` | Emitted when player banned occurs. |
| `unban`, `admin` | `ArenaEvents::player_unbanned()` | `(player)` | Emitted when player unbanned occurs. |
| `limits` | `ArenaEvents::player_limits_configured()` | `(min_players, max_players)` | Emitted when player limits configured occurs. |
| `fee_upd`, `admin` | `ArenaEvents::platform_fee_updated()` | `(new_fee_bps)` | Emitted when platform fee updated occurs. |
| `up_prop` | `ArenaEvents::upgrade_proposed()` | `(new_wasm_hash, proposed_at)` | Emitted when upgrade proposed occurs. |
| `upgrade` | `ArenaEvents::upgraded()` | `(new_wasm_hash)` | Emitted when upgraded occurs. |
| `started` | `ArenaEvents::game_started()` | `(round, duration_seconds)` | Emitted when game started occurs. |
| `resolved` | `ArenaEvents::round_resolved()` | `(round, eliminated, survivors)` | Emitted when round resolved occurs. |
| `tied` | `ArenaEvents::round_tied()` | `(round, survivors)` | Emitted when round tied occurs. |
| `elim`, `player` | `ArenaEvents::player_eliminated()` | `(round)` | Emitted when player eliminated occurs. |
| `finished` | `ArenaEvents::game_finished()` | `(winner, round)` | Emitted when game finished occurs. |
| `claimed`, `winner` | `ArenaEvents::prize_claimed()` | `(amount, yield_amount)` | Emitted when prize claimed occurs. |
| `admin` | `ArenaEvents::admin_changed()` | `(old_admin, new_admin)` | Emitted when admin changed occurs. |
| `paused`, `caller` | `ArenaEvents::paused()` | `(reason)` | Emitted when paused occurs. |
| `unpaused`, `caller` | `ArenaEvents::unpaused()` | `()` | Emitted when unpaused occurs. |
| `expired` | `ArenaEvents::arena_expired()` | `()` | Emitted when arena expired occurs. |
| `vaultdec` | `ArenaEvents::vault_balance_decreased()` | `(previous_balance, current_balance)` | Emitted when vault balance decreased occurs. |
| `Symbol::new(env`, `"vault_oracle_failed")` | `ArenaEvents::vault_oracle_failed()` | `(oracle)` | Emitted when the yield oracle cross-contract call fails. The arena falls back to a 0-bps yield, but surfaces the failure so operators can detect a misconfigured, unreachable, or malfunctioning oracle. |
| `Symbol::new(env`, `"oracle_freshness_observed")` | `ArenaEvents::oracle_freshness_observed()` | `(round, classification_code, age_secs)` | Emitted on every `resolve_round` attempt that reaches the oracle freshness check (#1512), success or rejection — `classification_code` is `OracleFreshness::as_code()`'s value. This is the signal a keeper-facing status / alerting pipeline watches for staleness, since it fires even when `age_secs` doesn't cross the `Stale` threshold. |
| `Symbol::new(env`, `"oracle_stale_rejected")` | `ArenaEvents::oracle_stale_rejected()` | `(round, age_secs)` | Emitted when `resolve_round` refuses to proceed because the oracle's observation is `Stale` (#1512). |
| `cancel`, `admin` | `ArenaEvents::arena_cancelled()` | `()` | Emitted when arena cancelled occurs. |
| `refund`, `player` | `ArenaEvents::refund_claimed()` | `()` | Emitted when refund claimed occurs. |
| `lboard` | `ArenaEvents::leaderboard_updated()` | `()` | Emitted when leaderboard updated occurs. |
| `commit`, `player` | `ArenaEvents::commitment_submitted()` | `(round)` | Emitted when commitment submitted occurs. |
| `reveal`, `player` | `ArenaEvents::choice_revealed()` | `(*choice, round)` | Emitted when choice revealed occurs. |

## Factory Contract

| Topic | Emitting Function | Data Fields | Description |
|-------|-------------------|-------------|-------------|
| `INIT` | `initialize()` | `(admin, min_stake)` | Emitted during initialize. |
| `UPGRADE` | `upgrade()` | `()` | Emitted during upgrade. |
| `WASM_UP` | `set_arena_wasm_hash()` | `(wasm_hash)` | Emitted during set_arena_wasm_hash. |
| `WL_ADD` | `add_to_whitelist()` | `(host)` | Emitted during add_to_whitelist. |
| `WL_REM` | `remove_from_whitelist()` | `(host)` | Emitted during remove_from_whitelist. |
| `VLT_ADD` | `add_approved_vault()` | `(vault)` | Emitted during add_approved_vault. |
| `VLT_REM` | `remove_approved_vault()` | `(vault)` | Emitted during remove_approved_vault. |
| `ORC_ADD` | `add_approved_oracle()` | `(oracle)` | Emitted during add_approved_oracle. |
| `ORC_REM` | `remove_approved_oracle()` | `(oracle)` | Emitted during remove_approved_oracle. |
| `TOK_ADD` | `add_supported_token()` | `(token)` | Emitted during add_supported_token. |
| `TOK_REM` | `remove_supported_token()` | `(token)` | Emitted during remove_supported_token. |
| `MXPLCFG` | `set_max_active_pools()` | `(max)` | Emitted during set_max_active_pools. |
| `PAUSED` | `pause()` | `()` | Emitted during pause. |
| `UNPAUS` | `unpause()` | `()` | Emitted during unpause. |
| `POOL_RLS` | `release_arena()` | `(record.creator)` | Emitted during release_arena. |
| `POOL_CRE` | `create_pool()` | `( pool_id, host, config.entry_fee, arena, config.min_players, config.max_players, config.round_duration, )` | Emitted during create_pool. |
| `STK_RCLM` | `reclaim_creator_stake()` | `(arena, record.creator, record.amount)` | Emitted during reclaim_creator_stake. |
| `POOL_ST` | `update_arena_status()` | `(pool_id, status)` | Emitted during update_arena_status. |
| `ADM_PROP` | `propose_admin()` | `(new_admin,)` | Emitted during propose_admin. |
| `ADM_CHG` | `accept_admin()` | `(old_admin, pending_admin)` | Emitted during accept_admin. |

## Staking Contract

| Topic | Emitting Function | Data Fields | Description |
|-------|-------------------|-------------|-------------|
| `INIT` | `initialize()` | `(admin, token)` | Emitted during initialize. |
| `PAUSED` | `pause()` | `()` | Emitted during pause. |
| `UNPAUS` | `unpause()` | `()` | Emitted during unpause. |
| `ADM_PROP` | `propose_admin()` | `(admin, new_admin)` | Emitted during propose_admin. |
| `ADM_CHG` | `accept_admin()` | `(old_admin, pending_admin)` | Emitted during accept_admin. |
| `STAKED` | `stake()` | `(staker, amount, shares)` | Emitted during stake. |
| `UNSTAK` | `unstake()` | `(staker, tokens, shares)` | Emitted during unstake. |
| `REWARDS` | `distribute_rewards()` | `(caller, amount)` | Emitted during distribute_rewards. |
| `RWDUR` | `set_reward_duration()` | `(duration)` | Emitted during set_reward_duration. |
| `UPGRADE` | `upgrade()` | `(new_wasm_hash)` | Emitted during upgrade. |
| `INIT` | `renew_storage()` | `(admin, token)` | Emitted during renew_storage. |

## Payout Contract

| Topic | Emitting Function | Data Fields | Description |
|-------|-------------------|-------------|-------------|
| `dst_reg`, `payout_id` | `register_destination()` | `(destination)` | Emitted during register_destination. |
| `payout`, `winner` | `distribute_winnings()` | `(payout_id, amount)` | Emitted during distribute_winnings. |
| `payout`, `recipient` | `distribute_batch()` | `(payout_id, amount)` | Emitted during distribute_batch. |
| `adm_prop` | `propose_admin()` | `(new_admin,)` | Emitted during propose_admin. |
| `adm_chg` | `accept_admin()` | `(old_admin, pending_admin)` | Emitted during accept_admin. |

## RWA Adapter Contract

| Topic | Emitting Function | Data Fields | Description |
|-------|-------------------|-------------|-------------|
| `init` | `initialize()` | `()` | Emitted during initialize. |
| `dep`, `from`, `amount` | `deposit()` | `(cfg.total_deposited)` | Emitted during deposit. |
| `short`, `from` | `withdraw_all()` | `(total, balance)` | Emitted during withdraw_all. |
| `wdraw`, `from`, `payable`, `payable.saturating_sub(pos.principal)` | `withdraw_all()` | `(cfg.total_deposited)` | Emitted during withdraw_all. |
| `sync` | `sync()` | `(index.value)` | Emitted during sync. |
| `admin_ch` | `accept_admin()` | `(old_admin, config.admin)` | Emitted during accept_admin. |
| `upgrade` | `upgrade()` | `(new_wasm_hash)` | Emitted during upgrade. |

## Oracle Contract

| Topic | Emitting Function | Data Fields | Description |
|-------|-------------------|-------------|-------------|
| `rate_set` | `set_yield_bps()` | `(rate_bps)` | Emitted during set_yield_bps. |
| `rate_obs` | `set_yield_bps()` | `(rate_bps, observed_at)` | Emitted during set_yield_bps. |
| `max_set` | `set_max_rate()` | `(max_rate_bps)` | Emitted during set_max_rate. |
| `adm_chg` | `accept_admin()` | `(old_admin, pending_admin)` | Emitted during accept_admin. |

## Oracle Contract (#1570)

Bounded, delayed rate updates. `rate_sch` / `par_sched` carry the scheduled
value plus its `effective_at`; `rate_appl` / `par_appl` fire when a due
schedule is persisted by the next admin write.

| Topic       | Emitting Function      | Data Fields                                      |
|-------------|------------------------|--------------------------------------------------|
| `rate_set`  | `set_yield_bps()`      | `(rate_bps: u32)` — applied immediately (delay 0) |
| `rate_sch`  | `set_yield_bps()`      | `(rate_bps: u32, effective_at: u64)` — scheduled |
| `rate_appl` | (settle on next write) | `(rate_bps: u32)` — due schedule applied        |
| `rate_obs`  | every application      | `(rate_bps: u32, observed_at: u64)` — freshness provenance (#1512); fires on immediate set, scheduled apply, and emergency zero |
| `maxd_set`  | `set_max_delta_bps()`  | `(max_delta_bps: u32)` — applied immediately     |
| `dly_set`   | `set_activation_delay()` | `(delay_secs: u64)` — applied immediately       |
| `max_set`   | `set_max_rate()`       | `(max_rate_bps: u32)` — applied immediately      |
| `par_sched` | `set_max_delta_bps()` / `set_activation_delay()` / `set_max_rate()` | `((which: Symbol, value, effective_at: u64))` with `which` in `max_delta` / `delay` / `max_rate` |
| `par_appl`  | (settle on next write) | `(params_effective_at: u64)` — due params applied |
| `zeroed`    | `set_rate_to_zero()`   | `(0u32)` — emergency zero                        |
| `adm_chg`   | `accept_admin()`       | `(old_admin: Address, new_admin: Address)`       |

---

## Versioning Policy

- The `v` field is included in every arena/factory event payload.
- When fields are added, removed, or reordered the version is bumped.
- Consumers should fall back gracefully on unknown versions.

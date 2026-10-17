# Arena Lobby Lifecycle

This document covers the lobby-phase host and player powers introduced for
issues #1577, #1579, #1580, and #1581.

## Leaving a lobby (#1580)

`leave_arena(player)` is callable by a joined player while the arena is `Open`
and `round_count == 0`.

- The entry fee is released from the yield vault through the adapter's partial
  `withdraw(from, amount)` and transferred back to the player.
- The player is removed from the paged roster and the survivor index; both
  `player_count` and `active_player_count` are decremented.
- `player_left` and `player_refunded` are emitted.
- Leaving is rejected once the first round has resolved (`ArenaAlreadyStarted`)
  or while the arena is `Active` (`InvalidGameState`).
- A player who leaves may join again before the deadline.

### Yield policy

Yield accrued during the lobby on the departing player's principal is forfeited
to the remaining pool. The refund is exactly the entry fee the player staked;
the adapter burns principal shares rounded up so the pool never pays out more
value than the shares removed.

### Vault shortfall

The adapter caps a payout at its actual token balance and emits a `short`
event. In that edge case the arena refunds the amount actually returned; the
operation stays atomic (a vault error reverts the whole call with
`VaultWithdrawFailed`).

## Banning a lobby player (#1581)

`ban_player(player)` is admin-only and remains a permanent join block.

- While `round_count == 0`, banning a joined player removes them from the
  roster and refunds the entry fee atomically, emitting `player_banned` and
  `player_refunded`.
- Once at least one round has resolved, `ban_player` returns
  `ArenaAlreadyStarted`. This is deliberate: a host must not be able to remove
  players mid-game, which would be a host-driven elimination in a model built
  on commit-reveal fairness.
- Banning an address that never joined only records the ban for future join
  attempts.

## Start deadlines and permissionless cancellation (#1579)

`PoolConfig.start_deadline` is a Unix timestamp. The factory validates it
against the creation ledger:

```
created_at + 300 <= start_deadline <= created_at + 2_592_000
```

The factory stores it on the arena via `set_start_deadline` immediately after
`initialize` (a separate entry point because `initialize` already uses
Soroban's ten-parameter limit).

- `join_arena` rejects at or after the deadline with `StartDeadlinePassed`.
- `cancel_unstarted()` is permissionless once the deadline is reached and
  `round_count == 0`. It reuses the normal cancellation path: the arena becomes
  `Cancelled`, players claim refunds through `claim_refund`, and the creator
  stake is returned.
- Before the deadline it returns `DeadlineTooSoon`; without a configured
  deadline it returns `NoStartDeadline`; after a round it returns
  `ArenaAlreadyStarted`.
- `get_start_deadline()` exposes the value for the lobby countdown.

## Metadata hashes (#1577)

`create_pool` accepts a `metadata_hash: BytesN<32>`, stores it in
`ArenaMetadata`, and appends it to the `POOL_CRE` event. `get_arena` returns it
so clients can verify the off-chain display data.

### Canonical JSON specification

Both the frontend (`frontend/src/shared-d/utils/metadata-hash.ts`) and backend
(`backend/src/utils/metadataHash.ts`) serialize metadata identically:

1. Encode as UTF-8.
2. Object keys are sorted lexicographically at every nesting level.
3. Emit no insignificant whitespace (no spaces after `:` or `,`).
4. Preserve array order.
5. Omit object values that are `undefined`; preserve `null`.
6. Hash the resulting bytes with SHA-256; represent the digest as lowercase
   hex.

No implicit Unicode normalization is performed. Producers should store and
submit text in NFC so that visually identical input (for example, composed vs.
decomposed accents) hashes consistently across clients.

Golden vector:

```json
{"banner":"https://example.com/banner.png","description":"Fast rounds","name":"Alpha Arena","rules":"Reveal before the deadline."}
```

SHA-256:

```
05f1a22d4e08e7e4cdde2423a6e59f3470fddc279e7dd33f98973a21fc6385e7
```

The backend rejects an upload whose canonical hash does not match the hash
committed on-chain. The frontend renders a `METADATA_VERIFIED` badge on a
match and `METADATA_MISMATCH` otherwise. Metadata is immutable after creation;
changing it requires a new pool (and therefore a new hash).

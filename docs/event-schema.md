# InverseArena Contract Event Schema

This document defines all events emitted by the `ArenaContract` so frontend indexers and WebSocket listeners can parse them deterministically.

## Encoding

Events are emitted via `env.events().publish((topic,), data)` using the Soroban SDK. The Horizon/RPC event stream encodes them as:

```json
{
  "type": "contract",
  "ledger": "<u32>",
  "ledgerClosedAt": "<ISO-8601>",
  "contractId": "<contract-address>",
  "topic": ["<Symbol>"],
  "value": { "xdr": "<base64>" }
}
```

Decode `topic[0]` as a Soroban `Symbol` (max 9 ASCII chars). Decode `value.xdr` per the type column below.

## Decoder versioning and ownership

`frontend/src/components/hook-d/sorobanEventParser.ts` owns the UI-domain decoder registry. The current raw Soroban envelope is schema version `1`; existing events that do not carry a `schemaVersion` field are interpreted as v1 for compatibility. Adding a new wire shape or changing a payload contract requires a new registry version and fixture coverage before consumers switch. Unknown event names and unknown versions are logged and ignored, never coerced into a known domain event. The version is local decoder metadata; it is not an extra Soroban topic and does not alter contract ABI.

The backend currently reads authoritative round state through Soroban view calls rather than decoding the frontend event stream. Any future backend event consumer must use the fixtures and mappings in this document and add the same raw-event fixtures to its suite before becoming authoritative.

---

## Events

### `INIT` — Arena Initialized

Emitted once when `initialize()` succeeds.

| Field  | XDR type | Description                      |
|--------|----------|----------------------------------|
| topic  | Symbol   | `"INIT"`                         |
| value  | Address  | The arena admin's account address |

**Frontend action:** Register the arena in your index; set status = `Open`.

---

### `CFGD` — Arena Configured

Emitted when `configure_arena()` succeeds (admin updates entry fee / max players / deadline).

| Field  | XDR type | Description |
|--------|----------|-------------|
| topic  | Symbol   | `"CFGD"`   |
| value  | void     | `()`        |

**Frontend action:** Re-fetch `get_config()` to refresh cached arena parameters.

---

### `START` — Game Started

Emitted when `start_game()` transitions state to `InProgress`.

| Field  | XDR type | Description |
|--------|----------|-------------|
| topic  | Symbol   | `"START"`  |
| value  | void     | `()`        |

**Frontend action:** Update arena status to `InProgress`; open the round submission UI.

---

### `FINISH` — Game Finished

Emitted when `finish_game()` is called or when `resolve_round()` finds ≤ 1 survivor.

| Field  | XDR type | Description |
|--------|----------|-------------|
| topic  | Symbol   | `"FINISH"` |
| value  | void     | `()`        |

**Frontend action:** Update arena status to `Finished`; show winner banner.

---

### `JOIN` — Player Joined

Emitted once per successful `join()` call.

| Field  | XDR type | Description                     |
|--------|----------|---------------------------------|
| topic  | Symbol   | `"JOIN"`                        |
| value  | Address  | The joining player's account address |

**Frontend action:** Increment live player count; add player to the lobby list.

---

### `CHOICE` — Choice Submitted

Emitted when a player submits their round choice via `submit_choice()`.

| Field  | XDR type | Description                            |
|--------|----------|----------------------------------------|
| topic  | Symbol   | `"CHOICE"`                             |
| value  | Address  | The player who submitted their choice  |

**Frontend action:** Mark player as "locked in" for the current round. Do not reveal the actual choice — only the address.

---

### `ELIM` — Player Eliminated

Emitted once per eliminated player in `resolve_round()`.

| Field  | XDR type | Description                       |
|--------|----------|-----------------------------------|
| topic  | Symbol   | `"ELIM"`                          |
| value  | Address  | The eliminated player's address   |

**Frontend action:** Remove player from the survivor list; animate elimination.

---

### `CLAIMED` — Prize Claimed

Emitted once when the winner calls `claim()` and the prize is transferred.

| Field  | XDR type | Description                      |
|--------|----------|----------------------------------|
| topic  | Symbol   | `"CLAIMED"`                      |
| value  | Address  | The winner's account address     |

**Frontend action:** Mark arena as fully settled; show payout confirmation.

---

### `RWAYLD` — RWA Yield Received

Emitted when an external RWA adapter deposits yield into the prize pool via `receive_rwa_yield()`.

| Field  | XDR type | Description                                        |
|--------|----------|----------------------------------------------------|
| topic  | Symbol   | `"RWAYLD"`                                         |
| value  | i128     | Yield amount deposited in stroops (1 XLM = 10⁷)   |

**Frontend action:** Increment the displayed prize pool total by the received amount.

---

## Indexer example (TypeScript)

```typescript
import { SorobanRpc } from '@stellar/stellar-sdk';

const TOPIC_MAP: Record<string, string> = {
  INIT:    'arena_initialized',
  CFGD:    'arena_configured',
  START:   'game_started',
  FINISH:  'game_finished',
  JOIN:    'player_joined',
  CHOICE:  'choice_submitted',
  ELIM:    'player_eliminated',
  CLAIMED: 'prize_claimed',
  RWAYLD:  'rwa_yield_received',
};

async function indexArenaEvents(
  server: SorobanRpc.Server,
  contractId: string,
  startLedger: number,
) {
  const events = await server.getEvents({
    startLedger,
    filters: [{ type: 'contract', contractIds: [contractId] }],
  });

  for (const event of events.events) {
    const topicSymbol = event.topic[0]?.value as string;
    const eventName = TOPIC_MAP[topicSymbol] ?? 'unknown';
    console.log(`[${event.ledger}] ${eventName}`, event.value);
    // dispatch to your store / WebSocket clients here
  }
}
```

---

## Notes

- All `Symbol` topic values are ≤ 9 ASCII characters (Soroban `symbol_short!` constraint).
- `i128` values are encoded as XDR `SCV_I128`; decode with `scValToNative` from `@stellar/stellar-sdk`.
- `Address` values are encoded as XDR `SCV_ADDRESS`; call `.toString()` on the decoded `Address` to get the strkey.
- `FINISH` can be emitted by either `finish_game()` (admin-driven) or `resolve_round()` (auto when ≤ 1 survivor). Index both paths.

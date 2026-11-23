# Path-Payment Arena Entries (#1716)

This document describes how a player can join an arena with an asset other than
the arena's stake token, without adding a new backend intent kind or contract
function.

## 1. Goal and boundary

The arena contract only knows `join_arena`, and the transaction-intent API only
knows a closed set of action kinds. Funded joins therefore keep
`kind: "join_arena"` on every intent and add frontend-only signing-policy keys
(`JOIN_PATH`, `PATH_PAYMENT`). No backend union or contract ABI changes.

The default UI mode stays **direct join**: the player must already hold the
stake token. Path funding is opt-in through the "Pay with" selector.

## 2. Quote layer

`frontend/src/shared/lib/stellar/path-payment-quote.ts` calls Horizon's
`GET /paths/strict-receive` endpoint with:

- `source_assets`: the selected source asset (`native` or `CODE:ISSUER`)
- `destination_asset_*`: the resolved stake token identity
- `destination_amount`: the exact arena entry fee

Every record is validated with zod before use. Records whose source or
destination does not match the request, or whose path contains an unreadable
asset, are dropped. Quotes are:

- **cheapest-first**: the smallest `source_amount` wins; ties break on shorter
  path length
- **slippage-capped**: `sendMax` is `ceil(sourceAmount × (10000 + bps) / 10000)`;
  the default is 100 bps (1%)
- **short-lived**: the default TTL is 30 seconds, stored on the quote itself as
  `createdAt` / `expiresAt` and checked again immediately before signing

A stale quote is never reused: the flow refreshes it. "No path" and "Horizon
unavailable" are distinct typed errors (`PathQuoteError.reason`).

## 3. Transaction shapes

### Bundled (single wallet signature)

`buildJoinWithPathPaymentTransaction` composes exactly two operations, in this
order:

1. `pathPaymentStrictReceive` — delivers `destinationAmount` of the stake token
   to the **signing player's own account**
2. `invokeHostFunction` — calls `join_arena` on the arena contract

The credit lands before the contract call in the same transaction, so the
contract can spend the fresh stake-token balance. The signing firewall's
`JOIN_PATH` policy accepts only this sequence: reversed order, a different
function name, a path payment crediting another account, or an extra operation
is rejected before any wallet prompt. `PATH_PAYMENT` accepts only a standalone
strict-receive operation.

### Two-step fallback

If bundled signing is rejected by the policy or explicitly requested, the flow
uses two resumable intents, both still `kind: "join_arena"`:

1. `join_funding:<arenaId>` — `PATH_PAYMENT`, funds the player's balance
2. `join_arena:<arenaId>` — `JOIN`, spends that balance

The abandoned bundled attempt uses `join_path:<arenaId>` but never reaches a
wallet when policy rejects it. As with all transaction intents, an unreachable
intents API is non-fatal: the wallet flow continues without resumability.

## 4. Failure handling

| Condition | UI behavior |
|---|---|
| Quote expired | Refresh automatically before confirmation; show an expiry warning while stale |
| Path disappeared between quote and submit | Clear the quote, show a retry message, do not submit a stale swap |
| Policy rejects bundled transaction | Fall back to the two-step flow and clear the abandoned attempt's error |
| Source asset lacks trustline | Asset-readiness gate blocks the join and offers remediation |
| Horizon unavailable | Distinct error from "no path"; retry action stays available |

## 5. Security invariants

- The quote client validates raw JSON rather than trusting SDK response shape.
- `sendMax` includes the disclosed slippage ceiling; the UI shows source amount,
  destination amount, path, slippage, maximum send and network fee.
- The signing policy reads both operations from the decoded XDR and requires
  the path-payment destination to equal the transaction source.
- Only `join_arena` is accepted as the bundled contract call; the intent kind
  remains `join_arena` so no backend closed union changes.
- Policy rejections are never rendered as "user cancelled": the wallet was not
  asked.

## 6. Tests

- `path-payment-quote.test.ts`: query encoding, cheapest selection, slippage,
  TTL, malformed records and unavailable Horizon.
- `path-payment-transaction.test.ts`: builder/policy cross-check for bundled and
  standalone transactions, including reordered, wrong-function and
  wrong-destination rejections.
- `JoinFundingPanel.test.tsx`: quote disclosure, source switching, stale quote
  refresh affordance and two-step notice.
- `useJoinFlow.path-payment.test.tsx`: source selection, stale refresh, policy
  fallback and explicit two-step mode.

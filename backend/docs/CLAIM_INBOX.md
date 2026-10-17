# Claim and Refund Inbox (#1489)

`GET /api/users/me/claim-inbox` is the wallet-scoped answer to "does this
wallet have money it can move, and if so what exactly do I press?". It replaces
the per-arena `claim-readiness` round trip with one call and merges three
sources that previously had to be consulted separately and could disagree:
Mongo payout records, PostgreSQL cancellation recovery, and on-chain arena
state.

The response schema lives in `src/types/claimInbox.ts`; this note covers
ownership, the state machine, and operational requirements.

## Ownership

- **ClaimInboxService** (`src/services/claimInboxService.ts`) owns aggregation,
  classification, the keyset page, and metrics. It takes both the verifier and
  the refund source by injection, so it can be exercised with no database and no
  network.
- **claimInboxVerifier.ts** owns the production on-chain read. It is split out
  of the service so the service does not import `onChainReader`, which reaches
  into the frontend package for its RPC gateway — a file the backend `tsconfig`
  cannot compile. See "Known constraint" below.
- **routes/claimInbox.ts** owns the HTTP boundary: auth, query bounds, cache
  headers, and the refund source backed by `CancellationRecoveryService`.
- **TransactionRepository.listByDestination** owns the owner-filtered,
  keyset-paginated payout read, in both the Mongo and in-memory
  implementations.

## Sources

| Source | Provides | Failure behaviour |
| --- | --- | --- |
| Mongo payouts | Winnings in flight, settled, failed | Page fails |
| Cancellation recovery (Postgres) | Refundable and refunded stakes | Logged, page served from payouts alone |
| On-chain arena state | Whether winnings are due at all | Affected positions become `unavailable` |

`summary` counts every position found, not only the ones on this page, so the
dashboard can render totals without paging through the inbox.

## The state machine

One item per `(wallet, arena)`. A wallet that won a pot *and* has a refundable
stake in the same arena gets one item with two components, never two rows —
two rows would make one position look claimable twice and the user would sign
twice.

| State | Meaning |
| --- | --- |
| `actionable` | There is a next action the user can take now |
| `pending` | A transaction is in flight; the chain decides |
| `completed` | Settled. Kept in history, never actionable |
| `blocked` | Known, and the wallet cannot act. Carries a reason that is a property of the position, not a transient failure |
| `unavailable` | The answer is unknown because a read failed. Carries a retry |

Amounts are stroop **strings**, never numbers. A pot above 2^53 stroops is
representable as a string and silently wrong as a double, and this is a balance.

### Why an unread chain is not an empty inbox

`unavailable` is a first-class state, and this is the property the endpoint
exists to protect. A failed read is not "not claimable" and not a zero amount.
Collapsing it into either would present a claimable payout as nothing to do,
and the user would discover the money when it was gone.

The classification order encodes which facts are local and which need the chain:

1. Refund-only positions are decided from the database and never blocked by a
   chain outage.
2. An `unknown` payout status is `unavailable` — the local record settles
   nothing, and calling it complete would drop real money off the actionable
   list.
3. A **settled** record with an unreadable arena is `unavailable`. Only the
   chain can confirm arrival; a cached row must not be presented as settlement.
4. **In flight** and **failed** payouts are local facts about our own payment
   pipeline, so they report `pending`/`blocked` even during an outage. Hiding
   "your payment is moving" behind an incident the user cannot act on would be
   strictly less useful.
5. Arena state decides whether winnings are due at all.

## Bounded verification

Arena reads run in parallel, capped two ways: `CLAIM_INBOX_MAX_VERIFY` arenas
per scan, and a wall-clock budget (`verifyBudgetMs`). Positions past the cap or
beyond the budget are `unavailable` with `reason: "rpc_unavailable"`, and the
page reports `verificationComplete: false` so a client can disclose it.

A verifier that resolves but omits an arena has not read that arena
successfully. `safeVerify` treats absence as failure, because treating it as a
silent success would let a position fall through to an arena-state guess and be
shown as claimable on no evidence at all.

## Pagination

Keyset on `(updatedAt desc, _id desc)`, not `skip`. An inbox grows while it is
being read; `skip` would make a row shift between pages and return it twice or
skip it entirely. New rows land *ahead* of an in-flight cursor because they are
newer, so an in-progress walk is stable.

The per-item `sortKey` is derived from the position's own records. A position
with no record timestamp falls back to a fixed epoch value, **not** to the read
time — a key derived from "now" would differ on every request and no cursor
could ever be stable.

### Required index

`listByDestination` needs `{ destinationAccount: 1, updatedAt: -1, _id: -1 }`,
declared in `src/db/models/transaction.model.ts`. Without it every inbox request
is a collection scan of the whole payouts collection. The trailing `_id` matches
the sort exactly so a page boundary is served from the index with no in-memory
sort. **Create the index before deploying the endpoint.**

## Configuration

`ASSET_ISSUERS` (comma-separated `CODE:ISSUER` pairs) supplies the issuers for
claim-inbox asset metadata. Issuers are never inferred: a credit asset with no
configured entry is reported with `issuer: null` and counted in
`claim_inbox_unconfigured_asset_total`, because a wrong issuer is worse than a
visible gap — a client would build a trustline against whichever account
appeared. A malformed entry fails at boot instead of being ignored. These must
match the frontend's `NEXT_PUBLIC_USDC_ISSUER` / `NEXT_PUBLIC_EURC_ISSUER`.

## Metrics

| Metric | Labels | Use |
| --- | --- | --- |
| `claim_inbox_scan_duration_seconds` | — | Scan cost; alert on p95 |
| `claim_inbox_verification_failures_total` | `reason` | Chain read health. `partial` means some arenas were omitted by a successful batch |
| `claim_inbox_items_total` | `state` | State mix over time |
| `claim_inbox_source_records_total` | `source` | Which source contributed |
| `claim_inbox_actionable_items` | — | Most recent page's actionable count |
| `claim_inbox_unconfigured_asset_total` | `code` | Missing `ASSET_ISSUERS` entries |

## Contract drift

`src/types/claimInbox.ts` publishes Zod schemas for OpenAPI alongside the
service's TypeScript interfaces, and asserts at compile time that the two
describe the same shape. The assertion is bidirectional, so a field added to
only one side fails the build. The client mirrors the same schemas in
`frontend/src/features/claim-inbox/types.ts` and validates responses with
`safeParse`, so a mismatch surfaces as an explicit parse error instead of
`undefined` rendered into a balance.

Note that the obvious formulation of that check — `type Extends<A, B> = B extends
A ? true : never` — is silently satisfied by `never` and would pass no matter how
far the two had drifted. `Assert<T extends true>` is what makes it bite.

## Known constraint

`onChainReader.ts` imports the frontend's RPC gateway via a relative path that
resolves outside the backend's `rootDir` and uses path aliases the backend does
not define. `tsc` reports it and `ts-jest` refuses to load it, so backend
integration tests cannot import that module. This is pre-existing and tracked
separately; the claim inbox is structured to avoid depending on it.

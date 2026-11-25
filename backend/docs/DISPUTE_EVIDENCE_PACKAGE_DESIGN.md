# Player Dispute Evidence Package — Design Note

Issue: #1517 "Create player dispute evidence packages for inconsistent arena outcomes"

This note defines the design for a new read endpoint that lets an authenticated
player generate a self-contained evidence package for one arena/round, so
support can investigate a disputed commit/reveal/elimination/refund/payout
outcome without chasing transaction hashes and screenshots across services.

## 1. Background

Relevant facts about a round's outcome already exist, but scattered:

- **Elimination/tally proof** — `RoundProofBundleService` (#1394) assembles a
  checksummed, verifiable record of who was eliminated and why, but it is a
  whole-round view (every player's choice) with no privacy scoping and no
  payout/refund/commit-status context.
- **Commit/reveal status** — `RoundService.getCommitStatus` (#1383) already
  answers "did my `submit_commitment`/`reveal_choice` land?" for one wallet.
- **Payout** — `Round.resolution.payouts` carries the settlement breakdown
  (#1407: principal/yieldAmount/platformFee/dust) for the round's winner.
- **Refund** — `CancellationRecoveryService` (#1398) tracks refund status per
  participant when an arena was cancelled.
- **Contract/config version** — `contractCapability.negotiateCapability`
  (#1409) and `ledgerClock.getCurrentLedgerSequence` give the on-chain arena
  contract version and the ledger it was read at.
- **Reorg awareness** — `ledgerContinuity.getRollbackGuard()` (#1490) reports
  whether a ledger rollback is currently being recovered from.

None of these compose into a single, player-scoped, offline-verifiable
artifact today. This issue is that composition — an *additive* read path, not
a change to any of the above.

## 2. Ownership

`DisputeEvidenceService` (`src/services/disputeEvidenceService.ts`) owns
assembly only. It derives nothing new about game outcomes — every fact in the
package is read from (and attributed to) the service that already owns it;
see the doc comment at the top of that file for the full list. This mirrors
`RoundProofBundleService`'s "pure read/derive path with no additional
on-chain calls of its own and no writes" stance.

Two of its dependencies (`RoundService.getCommitStatus`,
`CancellationRecoveryService.getArenaRecovery`) are accepted as small
structural interfaces (`CommitStatusReader`, `RefundStatusReader`) rather than
imported concrete classes, purely to keep this file's own compile/test surface
independent of those files' unrelated internals — the route
(`src/routes/arenas.ts`) wires the real implementations in.

## 3. Response shape

`GET /api/arenas/:id/rounds/:roundNumber/evidence` (auth required) returns
`{ success: true, data: DisputeEvidencePackage }` (`src/types/evidence.ts`):

- `identifiers` — `arenaId`, `arenaContractId`, `roundId`, `roundNumber`,
  `networkPassphrase`. Canonical, stable identifiers a support engineer can
  key any further lookup on.
- `configVersions` — negotiated on-chain arena contract version and the
  ledger sequence it (and the elimination proof) were read at.
- `freshness` — `generatedAt` plus `degraded` (true while a ledger rollback is
  being recovered from).
- `phase` — the round's own state/createdAt/updatedAt.
- `player` — the requesting wallet's own `eliminated`/`survived`/
  `revealedChoice`. Never another player's.
- `aggregate` — counts only (`totalActivePlayers`, `totalEliminated`,
  `totalSurvivors`, `headsCount`, `tailsCount`) — the anonymized view of
  everyone else in the round.
- `decisionRecords` — typed entries (`ELIMINATION`, `PAYOUT`, `REFUND`,
  `COMMIT_STATUS`, `LEDGER_CONTINUITY`), each naming its source service and a
  timestamp.
- `unavailable` — typed gaps (`EvidenceUnavailableReason`), each with a source
  timestamp, for anything that should exist but couldn't be produced.
- `schemaVersion` + `checksum` — a SHA-256 hex digest of the package's
  canonical (deterministically key-sorted) JSON form, excluding the checksum
  field itself. `src/utils/evidenceChecksum.ts`'s `verifyEvidencePackage` is
  the offline verifier both the support CLI
  (`scripts/verify-evidence-package.ts`) and this service's own tests use —
  see `docs/DISPUTE_EVIDENCE_RUNBOOK.md`.

## 4. Privacy scoping and bounding (acceptance criteria)

- **No arbitrary ledger/wallet enumeration**: the endpoint takes only
  `arenaId` + `roundNumber` in the path. The requesting wallet comes solely
  from the verified JWT (`req.user`), never from a query/body parameter — and
  the route explicitly rejects a request that supplies `walletAddress` or
  `userId` in the query string with `400 EVIDENCE_SCOPE_NOT_OVERRIDABLE`,
  rather than silently ignoring it.
- **Cross-wallet access**: a wallet with no footprint in the round (no
  recorded choice, no `allActivePlayerIds` membership, no elimination log
  entry, no payout, and a `missing` commit status) gets
  `403 EVIDENCE_NOT_PARTICIPANT` — never a redacted-but-200 response, which
  would otherwise let a caller distinguish "round exists but I'm not in it"
  from a real dataset by comparing payload shapes.
- **Anonymization**: the requesting player's own status is included in full;
  every other player is represented only through the `aggregate` counts. The
  full per-player proof bundle (`RoundProofBundleService`) is never returned
  verbatim — this service reads it internally to derive the requester's own
  `eliminated`/`survived` flags and the aggregate counts, then discards the
  rest.

## 5. Failure behavior

| Condition | Response |
|---|---|
| Arena does not exist | `404 ARENA_NOT_FOUND` |
| Round number does not exist for the arena | `404 ROUND_NOT_FOUND` |
| Requesting wallet has no footprint in the round | `403 EVIDENCE_NOT_PARTICIPANT` |
| `walletAddress`/`userId` present in the query string | `400 EVIDENCE_SCOPE_NOT_OVERRIDABLE` |
| Malformed `roundNumber`/`id` | `400 VALIDATION_ERROR` (Zod, same convention as the rest of `arenas.ts`) |
| No authenticated caller | `401 UNAUTHORIZED` |
| Round not yet resolved | `200` with `unavailable: [{ field: "eliminationProof", reason: "ROUND_NOT_RESOLVED" }]` — the round/arena/commit-status/refund sections still populate |
| Round predates the proof-bundle index (#1394) | `200` with `reason: "LEGACY_ROUND_NO_INDEX_DATA"` |
| Arena contract version / current ledger sequence can't be read (RPC down) | `200` with `reason: "CONTRACT_VERSION_UNAVAILABLE"` / `"LEDGER_SEQUENCE_UNAVAILABLE"` |
| A ledger rollback is being recovered from | `200` with `freshness.degraded: true` and `reason: "LEDGER_ROLLBACK_IN_PROGRESS"` |
| Backend read fails transiently | Falls through to `errorHandler` → `500` |

The endpoint never turns "we couldn't verify X" into a hard failure of the
whole package — every partial gap is represented, not swallowed, matching the
issue's "unavailable evidence is represented with typed reasons" criterion.
The exceptions are the three cases above where the *player themselves* cannot
be answered for (no such arena/round, or not their round) — those are real
errors, not evidence gaps.

## 6. Compatibility

Purely additive: a new route, a new service, a new type module. No existing
endpoint's request/response shape changes. `EVIDENCE_PACKAGE_SCHEMA_VERSION`
is bumped on any breaking shape change; `verifyEvidencePackage` refuses to
trust a package reporting a version it doesn't recognize rather than guessing
at its shape (mirrors `RoundProofBundleUnavailableError`'s "never synthesize a
degraded read" principle).

## 7. Edge cases

- **Deleted accounts / legacy events**: covered by the `LEGACY_ROUND_NO_INDEX_DATA` /
  `NO_COMMIT_RECORDED` paths above — the package still assembles with the gap
  named.
- **Incomplete projection / missing index data**: same as legacy rounds —
  `RoundProofBundleUnavailableError` is caught and reported, never retried
  into a fabricated bundle.
- **Large rounds**: no new O(players) work is added — `RoundProofBundleService`
  already bounds `playerChoices`/`allActivePlayerIds` at 500 (`RoundInputSchema`),
  and this service reads only membership (`.includes`) against those, never a
  fresh per-player computation.
- **Evidence generated during active play**: an unresolved round still
  produces a package — commit-status, phase and config sections are populated
  as of that moment, with the elimination proof explicitly marked
  `ROUND_NOT_RESOLVED` rather than the request failing outright.
- **Reorg**: `getRollbackGuard().isQuarantined()` is checked on every call;
  see the failure-behavior table above.
- **Tampering**: any post-generation edit to the package changes its canonical
  JSON form and therefore its recomputed checksum — `verifyEvidencePackage`
  reports `CHECKSUM_MISMATCH`.
- **Mixed versions**: a package from a future/older schema version is flagged
  `SCHEMA_VERSION_UNKNOWN` rather than partially trusted.

## 8. Out of scope / open questions

- **Payment-ledger cross-referencing**: `TransactionRecord` (the Stellar
  claim/withdrawal ledger in `sqlTransactionRepository.ts`) has no `roundId`/
  `userId`/`arenaId` column — only a caller-supplied `payoutId` string with no
  fixed convention anywhere in this codebase today. Reliably joining it to a
  specific round would mean inventing a convention this codebase doesn't
  have, which risks silently mismatching a wallet's unrelated payout to this
  round's evidence — worse than omitting it. This package instead reports the
  round-level `Payout` (settlement breakdown), which is exact and already
  attributable. Cross-referencing the claim transaction itself is flagged as
  follow-up work, not silently included.
- **Automated compensation/arbitration**: explicitly out of scope per the
  issue — this package is investigative evidence, not a decision.
- **UI**: no profile-page affordance is added in this change; the endpoint is
  usable directly by support today, and a "download evidence" UI action is a
  follow-up (same pattern `SETTLEMENT_RECEIPTS.md` used for its receipt
  endpoint before `DownloadReceiptButton` was wired up).

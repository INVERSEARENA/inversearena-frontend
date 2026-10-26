# Arena operations visibility: change feed, portfolio risk, replay timeline

Covers issues #1690 (protocol change feed), #1691 (wallet portfolio risk summary),
and #1692 (seekable spectator timeline). Each is implemented as a pure domain core
with unit tests. HTTP routes and UI components are not wired yet, for the reasons
given under each section.

## #1690 Protocol change feed

**Code:** `backend/src/domain/protocolChangeFeed.ts`, tests in
`backend/tests/unit/protocolChangeFeed.unit.test.ts`.

- `buildChangeFeed` accepts candidates from verified contract events and audited
  backend records. Candidates with `verified: false` are dropped.
- Entries are keyed by `<network>:<sourceType>:<sourceId>`, so duplicate delivery
  and replay collapse into one entry.
- Each entry carries source, network, ledger, effective time, actor class,
  resource, previous and new revision, impact, status, and a verification
  reference (tx hash or `audit:<id>`).
- Operator notes are never copied into an entry.
- Impact comes from a fixed `IMPACT_BY_KIND` table.
- A later change that names `revertsSourceId` marks the original `reverted`. The
  original stays in the feed.
- `pageChangeFeed` pages by an opaque cursor that encodes the last entry. If that
  entry is later pruned, paging resumes from the first entry that sorts after it.
- `countUnreadChanges` counts effective changes after the reader's last visit.
  Scheduled and cancelled changes are not counted.

**Not yet done:** the route (`GET /config/change-feed`), the source adapters for
contract admin events and `AuditLogModel`, the OpenAPI entry, metrics, the
operator correction procedure, the retention policy, and the frontend list. The
audit-record action list that maps to change kinds is not defined yet.

## #1691 Wallet portfolio risk summary

**Code:** `backend/src/domain/portfolioRiskRules.ts`, tests in
`backend/tests/unit/portfolioRiskRules.unit.test.ts`.

- `computePortfolioRiskSummary` groups exact minor-unit exposure by asset, vault,
  oracle, and lifecycle. It never converts or sums across assets.
- Each group carries its evidence (reserve, oracle freshness, registry, arena
  health, contract version, ledger). Missing evidence is `unavailable` with a
  reason. Verified groups are kept.
- Signals are `informational`, `attention`, or `action_required`. Severity is
  decided by the rules listed in the module. Each signal has a sorted list of
  reason codes.
- Duplicate positions, zero or malformed amounts, and positions observed past the
  snapshot ledger are excluded with an explicit reason.
- Every summary carries the non-advisory disclaimer.

**Not yet done:** the route (`GET /users/me/portfolio/risk`). The vault and oracle
identifiers are not reliably present in arena metadata yet, so the input adapter
needs an owner's decision. Also pending are the frontend drill-down, latency and
unavailable-rate metrics, and the written ruleset documentation for end users.

## #1692 Seekable spectator timeline

**Code:** `backend/src/domain/arenaReplaySegments.ts` and its tests in
`backend/tests/unit/arenaReplaySegments.unit.test.ts`. Frontend reducer
`frontend/src/shared/lib/replay/spectatorTimeline.ts`, tests in
`frontend/src/shared/lib/__tests__/spectatorTimeline.test.ts`.

- `buildReplayCheckpoints` stores projection states every N events.
  `projectionAtCount` folds forward from the nearest checkpoint, so seeking does
  not replay from genesis. A test checks that seeking matches folding from genesis.
- `buildReplaySegment` returns a bounded page of public events. It includes
  `previousCursor`, `nextCursor`, `projectionRevision`, `hasMore`, and a SHA-256
  checksum over the whole payload.
- Private data is excluded by construction. `CHOICE` events (unrevealed choices)
  and `UNKNOWN` events never appear in a segment. Cursors are raw event ids, so a
  page that is entirely private still advances the client.
- `verifyReplaySegment` reports `format_version_mismatch`,
  `contract_version_mismatch`, `cursor_gap`, or `checksum_mismatch`. On any of
  these the client does a full verified reload and shows an unavailable state.
- The frontend reducer handles play, pause, tick, step, seek, speed, go-live, and
  unavailable. It never moves the cursor outside the loaded events.

**Not yet done:** the segment route. Arena events are read from the chain
(`getArenaEvents`), and the repo does not store the canonical event log, so there
is nothing to page over yet. A persisted event store or a cache keyed by ledger is
the prerequisite. Also pending: the OpenAPI entry, the timeline UI, accessibility
review, the performance budget, and the replay-format document.

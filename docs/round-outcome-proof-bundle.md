# Round Outcome Proof Bundle (#1394)

This document is the design note for the round outcome proof bundle: a
self-contained, structurally verifiable record of how a resolved round's
survivor set was derived, published so a client does not have to blindly
trust the backend's own `resolution.eliminatedPlayers` / `survivors` verdict.

---

## 1. Why this exists

`RoundService.resolveRound` (`backend/src/services/roundService.ts`) derives
`eliminatedPlayers` by reading the on-chain `get_players()` result after
`resolve_round()` confirms (see #1098) and persists that verdict as the
round's `resolution`. Every client today (the frontend UI, third-party
integrators) has no choice but to trust that derivation — there is no way to
check it against the underlying inputs (who revealed what) without
re-deriving the elimination rule themselves from raw contract state.

The proof bundle closes that gap: it publishes the raw inputs
(`playerChoices`, `allActivePlayerIds`) alongside the backend's claimed
outputs (`tally`, `eliminatedPlayers`, `survivors`), so a client can
independently recompute the outputs from the inputs and compare.

---

## 2. Ownership

| Concern | Owner |
|---|---|
| Bundle assembly (read-only, no on-chain calls, no writes) | `RoundProofBundleService` (`backend/src/services/roundProofBundleService.ts`) |
| Persisting the raw inputs the bundle is assembled from | `RoundService.resolveRound` (`backend/src/services/roundService.ts`), via `RoundMetadata.allActivePlayerIds` |
| HTTP exposure | `GET /api/rounds/:id/proof-bundle` (`backend/src/routes/roundProofBundle.ts`) |
| Independent client-side recomputation (the actual "proof" step) | `recomputeSurvivorship` (`frontend/src/shared-d/utils/contract-state-parsers.ts`) — **not** the backend |
| Checksum / tamper-evidence verification | `verifyProofBundleChecksum` (same frontend file) |
| Network-scope guard | `assertProofBundleNetwork` (same frontend file) |
| Ground-truth elimination rule the bundle must faithfully mirror | `contract/arena/src/eliminations.rs` (`surviving_choice`, `is_eliminated`) + `contract/arena/src/lib.rs`'s `resolve_players` |

`RoundProofBundleService` never verifies anything — verification is
deliberately the client's job. A service that both assembles a claim and
attests to its own correctness would defeat the purpose of "don't trust the
backend's verdict."

---

## 3. The actual game mechanic (ground truth)

Inverse Arena is **minority-wins**: `contract/arena/src/eliminations.rs`'s
`surviving_choice` says the side with *fewer* revealed votes survives; the
majority is eliminated. A strict tie (both sides nonzero and equal) is
inconclusive — nobody is eliminated by this rule on a tie. If only one side
has any votes, that side survives (there is no opposing majority).

Critically, this is **not the only elimination path**.
`contract/arena/src/lib.rs`'s `resolve_players` does:

```rust
let should_eliminate = choice
    .map(|c| eliminations::is_eliminated(c, &tally))
    .unwrap_or(true);
```

A player who did not reveal a choice this round (`choice == None`) is
eliminated **unconditionally** — the `unwrap_or(true)` branch — independent
of the tally and even when the tally is a tie. This is confirmed by the
contract's own `non_revealing_player_is_eliminated` unit test
(`contract/arena/src/lib.rs`). Any correct recomputation of survivorship
must apply **both** rules:

1. **Minority-wins tally rule** — applies only to players who revealed.
2. **AFK rule** — applies only to active players who did *not* reveal;
   eliminates them unconditionally, regardless of rule 1's outcome.

An earlier draft of this feature's doc comments described non-revealers as
"eliminated by the same rule the contract applies" — that is incorrect and
has been corrected in the code comments. The two rules are independent, and
conflating them under-counts eliminations on any round with both a tie and
at least one non-revealer.

---

## 4. Bundle contents

`RoundProofBundle` (`backend/src/types/round.ts`, mirrored in
`frontend/src/shared-d/types/contract-state.ts`):

| Field | Meaning |
|---|---|
| `version` | Schema version (`ROUND_PROOF_BUNDLE_VERSION`). Bump on any breaking shape change. |
| `roundId`, `arenaId`, `roundNumber` | Identifies the round. |
| `network.passphrase`, `network.arenaContractId` | Which Stellar network / arena this bundle was assembled against. |
| `playerChoices` | Revealed choices only, sorted by `userId`. Recomputation input. |
| `allActivePlayerIds` | **All** players active entering this round — revealers and non-revealers — sorted. `allActivePlayerIds` minus the `userId`s in `playerChoices` gives the non-revealer set. |
| `tally` | Backend-claimed heads/tails count among revealers. |
| `eliminatedPlayers`, `survivors` | Backend-claimed outputs — the thing the client's recomputation verifies. |
| `checksum` | SHA-256 hex of the bundle's canonical JSON form (all fields except `checksum` itself, object keys sorted recursively), so any field tampered with in transit or storage is detectable. |
| `generatedAt` | ISO-8601 assembly timestamp. Not covered by any invariant — two assemblies of the same round may legitimately differ only in this field (and therefore in `checksum`, since it's included in the canonical form)... see §7 for why that's still safe. |

---

## 5. State transitions

```
Round: OPEN/CLOSED ──resolve_round()──▶ RESOLVED ──(settlement)──▶ SETTLED
                                            │                          │
                                            └──── proof bundle exists ─┘
                                                  (GET .../proof-bundle
                                                   works for either state)
```

- **Before resolution** (`OPEN`/`CLOSED`): no bundle exists.
  `GET /api/rounds/:id/proof-bundle` → `409 ROUND_NOT_RESOLVED`. This is not
  retried — "not resolved yet" is a semantically final answer for the
  current state, not a transient failure.
- **At resolution**: `RoundService.resolveRound` persists
  `allActivePlayerIds` (the full active-player set at that moment) into
  `RoundMetadata` in the *same* atomic transaction
  (`RoundRepository.resolveAtomically`) that persists `resolution`. There is
  no separate "bundle assembly" step at resolution time — the bundle is
  derived lazily, on read, from data that was already committed atomically.
- **RESOLVED or SETTLED**: the round's resolution is immutable (nothing
  ever un-resolves a round or edits `resolution`/`allActivePlayerIds` after
  the fact), so the proof bundle for a given `roundId` is immutable too.
  Repeated reads produce byte-identical bundles apart from `generatedAt`.

---

## 6. Failure behavior

| Condition | Behavior |
|---|---|
| Round does not exist | Plain `Error` → `404 ROUND_NOT_FOUND`. Not retried. |
| Round exists but not yet `RESOLVED`/`SETTLED` | `RoundNotResolvedError` → `409 ROUND_NOT_RESOLVED`. Not retried (there is nothing to prove yet, and retrying can't change that within a single request). |
| Round is `RESOLVED`/`SETTLED` but resolved **before** `allActivePlayerIds` was introduced (legacy data) | `RoundProofBundleUnavailableError` → `409 ROUND_PROOF_BUNDLE_UNAVAILABLE`. Not retried. We deliberately refuse to synthesize a degraded bundle by re-deriving `allActivePlayerIds` from `playerChoices` alone — that would silently drop non-revealers from `allActivePlayerIds` while `eliminatedPlayers` (from the untouched original `resolution`) could still legitimately reference them, producing a self-inconsistent bundle a client cannot correctly verify. See §8. |
| Resolved round has no `resolution` metadata at all | `RoundProofBundleAssemblyError` (partial-failure / restart-during-work: the state transition to `RESOLVED` committed but resolution metadata is missing or truncated — should be unreachable given the single-transaction write, but must never be papered over with a synthetic bundle if it happens). Retried up to `maxRetries` (default 2, linear backoff) in case of a transient read. |
| Arena has no on-chain `contractAddress` recorded in metadata | `RoundProofBundleAssemblyError`. A bundle with no `arenaContractId` cannot be network-matched by a client (§9), so this is a hard failure, not an empty-string default. Retried like other transient-looking errors. |
| Transient read error (e.g. a flaky DB read) | Retried up to `maxRetries` times with linear backoff (`retryDelayMs * attempt`), then surfaced as the last error → `500 PROOF_BUNDLE_ASSEMBLY_FAILED` (or the more specific mapped status if the last error was one of the above). |
| Duplicate delivery / concurrent requests for the same `roundId` | Safe — assembly is a pure read/derive over immutable, already-committed data (§5), so repeated or concurrent calls produce the same (modulo `generatedAt`) bundle. No idempotency key or dedup table is needed because there is nothing to deduplicate against — there's no write. |
| Restart mid-assembly | Safe for the same reason: assembly has no persisted intermediate state: a restart just means the next `GET` re-runs `assembleOnce` from scratch against the same immutable inputs. |

---

## 7. Compatibility constraints

- **REST compatibility**: `GET /api/rounds/:id/proof-bundle` is a wholly new
  endpoint. No existing endpoint's request/response shape changed.
- **Soroban compatibility**: `round_resolved_v2` (topic `rslvd2`) is a new,
  additive event topic, published alongside the unchanged `round_resolved`
  event. Existing indexers that only listen for `resolved` are unaffected;
  they simply never see `rslvd2` and keep working exactly as before. No
  existing `#[contracttype]` storage struct changed shape — `RoundResolution`
  and `eliminations::Tally` (the two structs `#[1394]` touched in
  `contract/arena/src/lib.rs`) are function-local, non-storage,
  non-`#[contracttype]` helper structs, so no XDR/storage migration or
  snapshot test update (see `CONTRIBUTING.md`'s "Snapshot Testing" section)
  is required.
- **`round_resolved_v2` payload versioning**: carries its own
  `ROUND_PROOF_EVENT_VERSION` (`contract/arena/src/events.rs`) as its final
  tuple field. Consumers should ignore unknown versions rather than fail
  parsing, in case a future change needs to add fields.
- **`RoundProofBundle` schema versioning**: carries `ROUND_PROOF_BUNDLE_VERSION`.
  Both the backend (`backend/src/types/round.ts`) and the frontend mirror
  (`frontend/src/shared-d/types/contract-state.ts`) must bump this in
  lockstep on any breaking shape change — there is no shared types package
  between the two, so this is a manual, documented contract rather than an
  enforced one. `recomputeSurvivorship` throws `ProofBundleShapeError` if it
  receives a bundle whose `version` it doesn't recognize, rather than
  guessing at an unfamiliar shape.
- **`RoundMetadata.allActivePlayerIds` storage shape**: additive, optional
  JSON field on `Round.metadata` (no Prisma migration needed — `metadata` is
  already a free-form `Json?` column). Rounds resolved before this field
  existed simply have `allActivePlayerIds: undefined`; see §6's legacy-round
  row for how that's handled (refuse to assemble, don't guess).
- **checksum stability**: the backend's `canonicalStringify` (sorted object
  keys, arrays kept in caller order) and the frontend's copy in
  `contract-state-parsers.ts` must stay byte-for-byte identical, since that's
  what makes `checksum` independently reproducible client-side. This is
  covered by a dedicated cross-module test (see §10) that hand-rolls a third,
  independent implementation of the same algorithm in the test itself and
  asserts all three agree — the closest available substitute for a shared
  package boundary.

---

## 8. Why non-revealers are not silently dropped (the bug this note documents fixing)

An earlier implementation attempt derived `allActivePlayerIds` inside
`RoundProofBundleService` from `round.playerChoices` (the revealers) instead
of from the true active-player set recorded at resolution time. Because the
contract eliminates non-revealers unconditionally (§3, rule 2),
`resolution.eliminatedPlayers` can legitimately contain player ids that never
appear in `playerChoices` at all. Deriving `allActivePlayerIds` from
`playerChoices` alone silently dropped those non-revealers from
`allActivePlayerIds` while `eliminatedPlayers` still referenced them — a
bundle that claims someone was eliminated without that person ever appearing
in the set of people who *could* have been eliminated. A client recomputing
survivorship from such a bundle would either error or (worse) silently
compute a wrong answer that happened to still match the backend's equally
wrong claim.

The fix: `RoundService.resolveRound` now persists `input.allActivePlayerIds`
(the true active-player set at resolution time, already computed and
available at that point — see `roundService.ts`) into `RoundMetadata`, and
`RoundProofBundleService` reads that persisted value rather than re-deriving
it. Rounds resolved before this fix shipped have no persisted value and are
handled per §6 (refuse, don't guess).

---

## 9. Edge cases

| Edge case | Handling |
|---|---|
| Duplicate delivery | Pure read/derive over immutable data — repeated calls are naturally idempotent (§6). |
| Stale reads | Not applicable in the traditional cache-invalidation sense: once a round is `RESOLVED`/`SETTLED`, its resolution never changes, so there is no "staleness" to go stale — the HTTP cache TTL (`cacheTTL.ROUND_PROOF_BUNDLE`, 300s) exists only to absorb request volume, not for correctness, and is intentionally finite (not infinite) so a corrected redeploy can still self-heal a bad cached entry within 5 minutes. |
| Partial failure / restart during work | See §6 — assembly has no persisted intermediate state, so a restart is equivalent to a fresh call. |
| Network mismatch (testnet vs. mainnet) | `bundle.network` records the passphrase + arena contract id the bundle was assembled against. `assertProofBundleNetwork` (frontend) throws `ProofBundleNetworkMismatchError` if a caller compares a bundle against a different expected network, rather than silently comparing incompatible data. |
| Maximum-size input | Bounded upstream by `RoundInputSchema`'s `.max(500)` on both `playerChoices` and `allActivePlayerIds` (`backend/src/types/round.ts`) — the bundle assembly path does not impose a second, independently-tunable limit that could drift out of sync with that one. Exercised by a 500-player unit test on both the backend assembly path and the frontend recomputation path. |
| Concurrent requests | Safe for the same reason as duplicate delivery — no shared mutable state is touched during assembly. |
| Tampering / transport corruption | Detected by `verifyProofBundleChecksum`, independent of whether the bundle's *contents* are internally consistent (that's `recomputeSurvivorship`'s job — see §10's "combined flow" test for why both checks are required together and neither alone is sufficient). |

---

## 10. Testing

- **Backend unit** (`backend/test/roundProofBundleService.unit.test.ts`):
  normal minority-wins assembly, AFK-eliminated non-revealers, tie tallies,
  single-player boundary, 500-player maximum-size boundary, idempotency
  under concurrent calls, every failure-behavior row in §6 (not-found,
  not-resolved, legacy-unavailable, missing-resolution, missing-contract-id),
  and both retry-then-succeed and retry-exhausted-then-fail paths.
- **Backend route** (`backend/tests/roundProofBundle.route.unit.test.ts`,
  `node:test` + `supertest`, run via `tsx --test` per this repo's convention
  for DB/Redis-touching route tests): auth enforcement, each HTTP status
  mapping, and a real Redis-cache-hit assertion (`X-Cache: HIT`, single DB
  read across two requests) proving the cache-middleware wiring actually
  works end-to-end.
- **Frontend unit**
  (`frontend/src/shared-d/utils/__tests__/contract-state-parsers.proof-bundle.test.ts`):
  `computeSurvivingChoice` against the same boundary cases as the contract's
  own `eliminations.rs` test module, `recomputeSurvivorship`'s normal /
  boundary / mismatch-detection / invalid-shape paths, `assertProofBundleNetwork`,
  and `verifyProofBundleChecksum`.
- **Cross-module integration**: the frontend test file hand-rolls a *third*,
  independent copy of the backend's `canonicalStringify` + SHA-256 algorithm
  directly in the test (not imported, since there is no shared package) and
  asserts it produces the same checksum as the frontend's own
  `verifyProofBundleChecksum` for the same bundle — proving the two
  implementations that must never drift apart in production (backend
  assembly vs. frontend verification) are compatible. A further test
  ("combined cross-module flow") demonstrates that checksum verification and
  survivorship recomputation are complementary and neither alone is
  sufficient: a self-consistent-but-factually-wrong bundle (attacker tampers
  with `survivors` and recomputes a matching checksum) passes checksum
  verification but fails survivorship agreement, which is exactly why a
  client must run both.
- **Contract**: no changes were needed to `contract/arena/src/eliminations.rs`
  or its existing test module — the ground truth was already correct and
  already tested; this feature only needed to observe it faithfully. The
  full contract workspace (`cargo test --workspace`, 228 tests) passes
  unchanged.

---

## 11. Non-goals

- This bundle does **not** carry a cryptographic signature from the backend
  or an on-chain attestation — `checksum` only proves the bundle wasn't
  corrupted or tampered with *after* assembly, not that the backend is
  honest at assembly time. A client that wants that stronger guarantee must
  independently read on-chain state (the `rslvd2` event, or `get_players()`)
  rather than trusting the backend's HTTP response at all; the bundle's
  purpose is only to make the backend's claim checkable against inputs the
  client can see, not to eliminate the backend as a trust boundary entirely.
- Salted commit-reveal secrecy (`frontend/src/shared-d/utils/commit-reveal.ts`)
  is out of scope here — the bundle only ever carries *revealed* choices,
  which are already public on-chain by the time a round resolves.

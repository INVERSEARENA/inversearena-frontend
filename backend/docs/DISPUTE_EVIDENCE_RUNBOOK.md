# Dispute Evidence Package — Support Runbook (#1517)

Use this when a player disputes a commit, reveal, elimination, refund or
payout outcome. Full design: `docs/DISPUTE_EVIDENCE_PACKAGE_DESIGN.md`.

## 1. Ask the player for a package

The player (authenticated, from their own session) requests:

```
GET /api/arenas/{arenaId}/rounds/{roundNumber}/evidence
```

and sends you the JSON response's `data` object (e.g. by saving it to a file
and attaching it to the support ticket). You never need their session token,
wallet secret, or any production credential to do anything below — the
package is self-contained.

## 2. Verify it hasn't been tampered with

No database or RPC access needed for this step — it's a pure offline check.

```
cd backend
npm run verify:evidence -- --file /path/to/evidence-package.json
```

- `PASS — checksum and schema version (N) verify.` → the JSON is exactly what
  the backend generated; safe to read at face value.
- `FAIL — CHECKSUM_MISMATCH: ...` → the file was edited after generation (by
  the player or in transit). Ask for a fresh copy before investigating
  further; do not trust any field in a failed package.
- `FAIL — SCHEMA_VERSION_UNKNOWN: ...` → the package is from a schema version
  this checkout's verifier doesn't know. Check out the version of this repo
  that matches when the package was generated (`freshness.generatedAt`), or
  update the verifier if this is an intentionally newer version.
- `FAIL — MALFORMED_PACKAGE: ...` → not a recognizable evidence package at
  all (wrong file, truncated, or hand-edited into an unrelated shape).

## 3. Read the package

- `identifiers` — the arena/round this is about. Cross-reference against
  other tickets/dashboards by these ids, not by anything the player typed.
- `player` — the player's own elimination/survival/revealed-choice. This is
  the answer to "was I eliminated" / "did my reveal count."
- `decisionRecords` — the backend's own record of each relevant decision
  (`ELIMINATION`, `PAYOUT`, `REFUND`, `COMMIT_STATUS`, `LEDGER_CONTINUITY`),
  each tagged with which service produced it and when.
- `unavailable` — anything the backend could not confirm, and why (see the
  design note's failure-behavior table for what each reason means). A
  non-empty `unavailable` is not itself evidence of a problem — e.g.
  `ROUND_NOT_RESOLVED` on a round still in progress is expected.
- `freshness.degraded: true` — a ledger rollback was being recovered from
  when this package was generated; treat every on-chain-derived claim in it
  (elimination proof, contract version, ledger sequence) as provisional and
  ask the player to regenerate the package once
  `docs/LEDGER_ROLLBACK_RUNBOOK.md`'s recovery has completed.

## 4. Reproducing the decision independently (no production credentials)

- The checksum/schema check in step 2 needs nothing beyond this repo
  checked out locally.
- To independently re-derive the elimination outcome the package's
  `decisionRecords[].data.proofBundleChecksum` (under the `ELIMINATION`
  record) points at, an engineer with read access to the arena contract's
  Soroban RPC endpoint (public testnet/mainnet RPC — not a production
  database credential) can re-run `RoundProofBundleService.getProofBundle`
  for `identifiers.roundId` against the same network
  (`identifiers.networkPassphrase`) and compare checksums.
- `configVersions.arenaContractVersion` / `ledgerSequence` are both
  independently re-derivable from the same public RPC endpoint — see
  `contractCapability.negotiateCapability` / `ledgerClock.getCurrentLedgerSequence`.

## 5. What this package deliberately does not cover

- The Stellar claim/withdrawal transaction ledger (`transactions` table) is
  not cross-referenced — see the design note's §8. If the dispute is about a
  claim transaction specifically, pull it directly via
  `GET /api/payouts/:id/receipt` (needs the payout id) instead.
- This package is evidence, not a verdict — it does not itself authorize a
  refund, compensation, or an on-chain state change. Escalate per your
  team's normal dispute-resolution process.

## 6. Escalation

If `unavailable` shows `PROOF_BUNDLE_ASSEMBLY_FAILED` (not one of the two
expected/typed gaps above) or the package's `phase.state` doesn't match what
the arena dashboard shows for the same round, escalate to backend on-call —
this indicates a genuine assembly failure or a data inconsistency between the
Postgres-backed round record and what the dashboard reads, not a normal
"nothing to show yet" gap.

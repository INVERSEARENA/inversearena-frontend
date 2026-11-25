# Design note: dependency threat gate (#1457)

## Problem

CI never audited the three lockfiles: `backend/package-lock.json`,
`frontend/pnpm-lock.yaml` and `contract/Cargo.lock`. A critical advisory in
`@stellar/stellar-sdk`, the wallet kit, `jsonwebtoken`, or a Rust crypto
crate such as `ed25519-dalek` could merge unnoticed. There was also no
reviewed, time-boxed way to accept a known advisory.

## Ownership

- Policy: `scripts/dependency-gate/policy.mjs`. It holds only pure functions
  and has no npm dependencies, so the gate can't itself be a supply-chain
  risk.
- CLI: `scripts/dependency-gate/gate.mjs`.
- Exceptions registry: `.github/dependency-exceptions.json`. Changes to it go
  through code review.
- CI: `.github/workflows/dependency-gate.yml`. It runs on lockfile or manifest
  changes, on pushes to `main`, and daily at 06:17 UTC.

## Policy

Findings from `npm audit`, `pnpm audit` and `cargo audit` are normalised to
`{ecosystem, package, id, aliases, severity, sensitive}`. Duplicates are
collapsed by ecosystem, package and advisory id.

| Severity | Sensitive package* | Result |
|---|---|---|
| critical | any | **block** |
| high | yes | **block** |
| high | no | reported only |
| moderate / low / info | any | reported only |

\* Sensitive means the wallet, Stellar/Soroban, JWT/crypto-primitive or WASM
toolchain. The list is `SENSITIVE_PACKAGE_PATTERNS`.

`cargo audit` reports CVSS vectors rather than severities, so severity is
derived from the CVSS v3.x base score. A missing vector, an unparseable one,
or a CVSS v4 vector is treated as `high`, which fails safe for sensitive
crates.

## Exceptions

Each exception looks like this:

```json
{ "id": "GHSA-…|RUSTSEC-…|CVE-…", "ecosystem": "npm|cargo", "package": "name",
  "reason": "why it is not exploitable here", "approvedBy": "@reviewer",
  "expires": "YYYY-MM-DD" }
```

- An exception matches on ecosystem, package **and** advisory id. The id can
  also match any alias, such as the CVE.
- `expires` is required and can be at most **90 days** away.
- Once an exception expires it stops applying. The advisory blocks again and
  the report flags the expired exception. The daily run makes this happen on
  time even when nobody opens a PR.
- An invalid entry never suppresses anything, and it fails the gate.
- Unused exceptions are reported so they can be cleaned up.

## Failure behaviour

- The audit tools exit non-zero when they find advisories. CI therefore
  judges each audit step by whether it produced parseable JSON.
- Each report is retried 3 times with backoff, to ride out registry or
  advisory-database blips.
- A report that is still missing or unparseable after retries **fails the
  gate closed** (`unavailable`).
- The gate exits `0` on pass, `1` when blocked, and `2` on a usage error.

## Observability

- Every step writes JSON lines to stdout: `dependency_audit_report`,
  `dependency_audit_retry`, `dependency_gate_report`,
  `dependency_gate_blocked`, `dependency_gate_excepted`, and
  `dependency_gate_result` (with counts and `latencyMs`).
- A Markdown table is written to the GitHub step summary.
- The reports and `gate-summary.json` are uploaded as build artifacts.

## Local use

```bash
make deps-gate-test   # run the gate's own tests (node:test, no install needed)
make deps-gate        # audit all lockfiles and apply the gate (needs cargo-audit)
```

## Compatibility

No runtime code changes. The existing CI workflows are untouched. The gate is
a separate workflow, so it can be made a required check whenever maintainers
decide. If the first run turns up existing advisories, each one needs either
an upgrade or a reviewed exception.

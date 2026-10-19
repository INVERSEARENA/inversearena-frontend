# Design note: release preflight (#1465)

## Problem

A release spans four independently-versioned artifact classes — Prisma
migrations, contract ABIs, runtime configuration, and the operator rollback
plan — but nothing checked them together before a deploy. A release could ship
a migration whose provider was wrong, an ABI snapshot that no longer matched
its contract, a production environment still holding a shipped placeholder
secret, or a destructive migration with no way back, and every mistake surfaced
only after the deploy.

## Ownership

- Policy: `scripts/release-preflight/policy.mjs` — pure functions, no
  dependencies, so the checker cannot itself be a supply-chain risk and every
  rule is testable in isolation.
- CLI / probes: `scripts/release-preflight/preflight.mjs`. It owns all
  filesystem reads and hands raw inputs to the policy functions.
- Tests: `scripts/release-preflight/preflight.test.mjs` (`node:test`).
- Operator entrypoint: `make preflight`, documented in `DEPLOYMENT.md`.

## State and transitions

The preflight is **read-only** and **stateless**. It reads a repository tree,
derives findings, and exits. There is no lock, no checkpoint, and nothing to
resume. Re-running it is idempotent: the same tree yields the same findings, so
"retry after a fix" is just running it again (covered by a test).

```text
collect(tree) ──► checkMigrations ─┐
              ├─► checkAbiSnapshots ┤
              ├─► checkConfig       ├─► findings ──► summarize ──► exit code
              └─► checkRollback    ─┘
```

`--dry-run` is accepted and is currently the only mode. It is explicit so the
interface can grow a write mode (e.g. emitting a rollback skeleton) without
changing callers, and so a reviewer sees that the command never mutates state.

## What it checks

| Check | Rule | Level |
| --- | --- | --- |
| `migrations` | `migration_lock.toml` provider is `postgresql` | error |
| `migrations` | every migration directory has `migration.sql`; names are unique; at least one migration exists | error |
| `rollback` | a destructive statement (`DROP TABLE/COLUMN/TYPE`, `TRUNCATE`, `DELETE FROM`) is either allowlisted or has a sidecar `rollback.sql` | error / warning |
| `abis` | each contract source exposes a readable `CONTRACT_VERSION`, and its `abi_snapshot.json` exists and is a non-empty JSON array | error |
| `config` | every required key is declared in `backend/.env.example` | error |
| `config` | in production, a required key's **real** value is not a shipped placeholder | error |
| `rollback` | `DEPLOYMENT.md` contains a rollback section; each migration is referenced there | error / warning |

Two deliberate asymmetries:

- **The `.env.example` value is never a finding.** The example is *supposed*
  to hold placeholders; only the real environment is inspected for them. The
  policy takes the two as separate inputs so they can never be conflated.
- **A destructive migration with a `rollback.sql` is a warning, not an error.**
  A human still has to confirm the rollback restores the dropped shape, but the
  release is not blocked on a mechanism that exists.

## Failure behaviour

- `summarize` returns `pass: true` only when no finding is at `error` level.
  Warnings are reported but do not block a release on their own.
- The CLI exits `0` on pass, `1` when blocked, and `2` on a usage error
  (unknown flag, bad `--environment`, unreadable tree).
- It fails **closed** on a missing artifact: a contract with no snapshot, a
  migration with no SQL, or a repository with no migrations is an error, not a
  silent skip. The one thing it will not do is contact the network or build
  WASM to *invent* the missing data.
- Content-level ABI drift (the snapshot existing but not matching a freshly
  built WASM) is intentionally left to `generate_abi_snapshots.sh --check`,
  which needs a build; the preflight only guarantees the snapshot is present
  and well-formed. The two are complementary and both run in CI.

## Compatibility

Additive tooling only: two new files under `scripts/release-preflight/`, two
new `Makefile` targets, and a `DEPLOYMENT.md` section. No runtime code, no
contract, no schema, and no existing endpoint changes. The preflight can be
made a required CI check whenever maintainers decide; until then `make
preflight` is an advisory local gate.

## Observability

Every finding and the final verdict are JSON lines on stdout
(`release_preflight_blocked`, `release_preflight_warning`,
`release_preflight_result` with `errorCount`, `warningCount`, and `latencyMs`),
so CI and the dependency gate consume the same shape. `--out` writes the full
result, and a Markdown summary is appended to `$GITHUB_STEP_SUMMARY` when set.

## Local use

```bash
make preflight-test                 # run the preflight's own tests (node:test)
make preflight                      # production check of the current tree
make preflight ENVIRONMENT=staging  # relax the production-only config check
```

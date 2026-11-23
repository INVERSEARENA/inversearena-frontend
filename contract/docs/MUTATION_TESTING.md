# Contract mutation testing

Mutation testing checks whether the tests actually notice behavior changes in
the contracts. `cargo-mutants` rewrites one expression at a time, runs the
tests, and records whether the mutation was caught. This complements
[coverage](COVERAGE.md): a covered line can still be unasserted.

## Commands

Run from the repository root. The workspace tests embed compiled WASM via
`include_bytes!`, so build the WASM first:

```bash
cd contract
RUSTUP_TOOLCHAIN=1.96.0 cargo build --workspace --target wasm32v1-none --release
RUSTUP_TOOLCHAIN=1.96.0 cargo mutants --in-place --no-shuffle
node scripts/mutations.mjs
node scripts/mutations.mjs --input mutants.out
node scripts/mutations.mjs --ratchet
```

`--in-place` is required here because the default scratch-tree copy omits the
prebuilt WASM. It edits the source tree while running: start from a clean tree
and let the command finish. `mutants.out/` is recreated on every run.

## Configuration

[`.cargo/mutants.toml`](../.cargo/mutants.toml) is read relative to the
`contract/` directory. It limits mutation generation to the tested contract
crates (arena, factory, fee-router, oracle, payout, rwa-adapter, staking),
excludes event helper and test-only files, and skips calls to logging and event
publishing helpers. `cap_lints = true` keeps mutants from failing on warnings,
and timeouts are scaled from the baseline with a two-minute floor.

[`mutation-thresholds.json`](../mutation-thresholds.json) defines the report
groups. `arena-state-machine` and `settlement-critical` require every viable
mutant to be caught, with at least one mutant each. `global` is report-only and
covers the entire run. Paths are relative to `contract/`; function names match
the final `::` component, so `claim` matches `ArenaContract::claim`.

## Toolchain caveat

`contract/rust-toolchain.toml` pins Rust 1.82 for bit-identical WASM builds
(issue #1638). The workspace crates use edition 2024, which 1.82 cannot build,
so the mutation workflow installs 1.96.0 and sets `RUSTUP_TOOLCHAIN=1.96.0`
for the WASM build and the run. Use the same override locally. Do not change
the pinned toolchain file; it governs release hashes, not mutation testing.

## Outcomes and survivor triage

| Outcome | Meaning | Action |
| --- | --- | --- |
| `CaughtMutant` | At least one test failed | Good; keep the assertion that caught it. |
| `MissedMutant` | Tests passed with the change | Add a focused assertion for the changed behavior, or document why the mutant is equivalent. |
| `Timeout` | The mutant hung the suite | Counted as missed and reported separately. Investigate the loop and consider a narrow `#[mutants::skip]`. |
| `Unviable` | The mutated code did not compile | Excluded from the caught percentage; usually no action. |
| `Success` / `Failure` | Unclassified result | Fails the check; inspect the log and fix the harness. |

Start triage from `contract/target/mutations/summary.md` and the `missed.txt`
and `timeout.txt` files in `contract/mutants.out/`. Each entry names the file,
line, and mutation; the matching log and diff are under `log/` and `diff/`.
Prefer strengthening an existing test over suppressing a mutant. Suppression
must be narrow and justified at the mutation site.

## Thresholds and ratcheting

The check exits 1 when a gated group is below `minimum_caught_pct`, has fewer
than `minimum_mutants` viable mutants, has no data, contains a timeout, or has
an unresolved outcome. The report-only group never fails the run.

```bash
node contract/scripts/mutations.mjs --ratchet
```

Ratcheting raises `minimum_caught_pct` to the whole-number caught percentage
and `minimum_mutants` to the observed count. It never lowers a threshold. A
new group starts at `minimum_mutants: 1` and must be populated before it can
pass. Lowering a threshold is a deliberate, reviewed JSON edit.

## CI outputs

The weekly `Contract Mutation Testing` workflow runs the script tests, builds
WASM, accepts cargo-mutants exit code 0 (all caught) or 2 (missed mutants for
the threshold script to judge), and hard-fails on codes 1, 3, 4, 5, 6, and 70.
It appends the table to the GitHub step summary and uploads the
`contract-mutants` artifact containing `contract/mutants.out/` and
`contract/target/mutations/summary.md`.

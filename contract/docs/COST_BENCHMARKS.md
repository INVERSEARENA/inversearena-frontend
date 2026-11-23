# Contract resource cost benchmarks

Contract CI records the resources each hot entry point consumes and fails when
a change makes one meaningfully more expensive (#1649). Players pay these costs
as fees, and large arenas run into the per-transaction limits.

## What is benchmarked

[`cost-bench/tests/cost_bench.rs`](../cost-bench/tests/cost_bench.rs) deploys
every contract from its **compiled WASM**: arena, factory, oracle, RWA adapter
and staking, plus a Stellar Asset Contract token. The measurements therefore
include VM instantiation and execution. Registering the native Rust contracts
would leave those costs out.

| Benchmark | Sizes | What is measured |
| --- | --- | --- |
| `arena/join_arena` | 10, 50, 100 players | the last join into a lobby of N−1 |
| `arena/submit_commitment` | 10, 50, 100 | the last commitment of the round |
| `arena/reveal_choice` | 10, 50, 100 | the last reveal of the round |
| `arena/resolve_round` | 10, 50, 100 (= `MAX_PLAYERS_ALLOWED`) | resolving a round with one minority survivor |
| `arena/claim` | 10, 50, 100 | the winner claiming the prize |
| `arena/claim_refund` | 10 | a refund after `force_cancel_arena` |
| `staking/stake`, `staking/unstake` | 2 stakers | staking into an existing pool, then withdrawing |

Each benchmark reads `env.cost_estimate().resources()` and `.fee()` after the
call: CPU instructions, memory, ledger entries and bytes read and written,
event bytes, and the estimated fee in stroops.

## Running locally

```bash
make contracts-cost-bench                       # build, run, compare with the baseline
node contract/scripts/cost-bench.mjs --bless    # accept the current costs as the new baseline
```

The script builds the WASM, runs the benchmarks with `COST_BENCH_OUT` set, and
compares the results with [`cost-baseline.json`](../cost-baseline.json). The
table is written to `contract/target/cost-bench/summary.md`. In CI it is also
written to the job summary.

Use the toolchain recorded in the baseline's `toolchain` field (the
`cost-bench` CI job pins it). Otherwise expect small differences and a
warning.

## Thresholds

A benchmark fails when a metric rises by more than its threshold:

| Metric | Max increase |
| --- | --- |
| CPU instructions, memory, read/write bytes | 5% |
| Event bytes | 10% |
| Read/write ledger entries | 0% (any extra entry fails) |

Thresholds can be tuned per metric in the baseline's `thresholds` object. The
check also fails when:

- a benchmark is added but not yet in the baseline (`--bless` it);
- a baseline benchmark is no longer produced;
- a result newly exceeds a network limit (`networkLimits`: 100M instructions,
  40 MB memory), even if the increase is within the threshold.

Results that were **already** over a limit when the baseline was blessed are
shown as "known" and do not fail the build. That way a pre-existing problem
stays visible without blocking unrelated work.

## Known issue: `resolve_round` exceeds transaction limits at scale

`resolve_round` cost grows linearly with the roster. As of the first baseline:

| Players | CPU instructions | Memory | Ledger writes |
| --- | ---: | ---: | ---: |
| 10 | 66.4M | 22.6 MB | 51 |
| 50 | 154.3M | 38.0 MB | 211 |
| 100 | 336.3M | 80.8 MB | 412 |

From 50 players, resolution exceeds the 100M-instruction transaction limit, so
an arena that fills up cannot resolve in a single transaction. The benchmark
records these numbers with an unlimited test budget, and the baseline marks
them as known.

Paged resolution (#1639) is the planned fix. Its error codes, types and storage
helpers are already in place, but the `resolve_round_page` and
`finalize_resolution` entry points are not. When they land, add benchmarks for
one page and for finalize at each roster size, check that every page stays
under the limits, and re-bless.

## Re-blessing the baseline

Re-bless when a cost change is intended, and explain it in the PR:

```bash
node contract/scripts/cost-bench.mjs --bless
git add contract/cost-baseline.json
```

The baseline diff shows reviewers exactly which costs moved.

**SDK and toolchain upgrades shift every baseline.** After bumping
`soroban-sdk` or the pinned rustc:

1. Update the toolchain in the `cost-bench` job of
   `.github/workflows/contract-ci.yml` if it changed.
2. Run `node contract/scripts/cost-bench.mjs` with the **old** baseline and
   save the table. It shows how much the upgrade moved each cost.
3. Run `--bless` with the new toolchain. The baseline records the `toolchain`
   and `sorobanSdk` versions it was blessed with.
4. Commit the upgrade and the re-blessed baseline in one PR, with the table
   from step 2 in the description.

## Reproducibility

Measurements are deterministic for a given WASM binary. The script builds with
`--remap-path-prefix` so that panic-location strings embed `/cargo/...` rather
than the builder's home directory. Without it, a WASM built on a laptop and one
built in CI differ in size, and VM parsing costs differ with them.

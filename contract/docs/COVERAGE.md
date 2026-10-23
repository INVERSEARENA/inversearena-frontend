# Contract test coverage

Contract CI measures line and branch coverage for every crate in the workspace
with [`cargo-llvm-cov`](https://github.com/taiki-e/cargo-llvm-cov) and fails
when a crate drops below its minimum in
[`coverage-thresholds.json`](../coverage-thresholds.json) (#1651).

## Running locally

Coverage uses a pinned nightly, because branch coverage and the
`coverage(off)` attribute are unstable. Use the same nightly as the `coverage`
job in `.github/workflows/contract-ci.yml`:

```bash
rustup toolchain install nightly-2026-10-01 --profile minimal -c llvm-tools-preview
rustup target add wasm32v1-none --toolchain nightly-2026-10-01
cargo install cargo-llvm-cov --locked   # or: cargo binstall cargo-llvm-cov

make contracts-coverage   # from the repo root
```

`make contracts-coverage` runs these steps:

```bash
cd contract
# 1. Tests embed compiled WASM with include_bytes!, so build it first, uninstrumented.
cargo +nightly-2026-10-01 build --workspace --target wasm32v1-none --release
# 2. Run the instrumented tests.
cargo +nightly-2026-10-01 llvm-cov --workspace --branch --no-report
# 3. Produce reports without re-running the tests.
IGNORE='(^|/)(test|tests|[a-z_]+_tests?|storage_layout_fixture)\.rs$'
cargo +nightly-2026-10-01 llvm-cov report --branch --html --output-dir target/coverage --ignore-filename-regex "$IGNORE"
cargo +nightly-2026-10-01 llvm-cov report --branch --json --summary-only --output-path target/coverage/summary.json --ignore-filename-regex "$IGNORE"
# 4. Check the per-crate thresholds.
node scripts/coverage.mjs
```

Open `contract/target/coverage/html/index.html` to see uncovered lines and
branches. Those are the fund-moving error paths reviewers will ask about.

## What is measured

- **Gated:** line and branch coverage per crate. Function coverage is reported
  but not gated.
- **Excluded:** test-only code. Files named `test.rs`, `tests.rs`,
  `*_test.rs`, `*_tests.rs` and `storage_layout_fixture.rs` are filtered out of
  the report. Inline `#[cfg(test)] mod test { … }` blocks carry
  `#[cfg_attr(coverage_nightly, coverage(off))]`. When you add an inline test
  module to a non-test file, add that attribute too, or its code will inflate
  the crate's numbers.
- **Not visible:** code that runs only inside a contract's compiled WASM, such
  as an arena registered with `env.register(crate::WASM, ())`. The WASM is not
  instrumented, so cover each path through the native contract as well.

## Thresholds and ratcheting

Thresholds start at the floor of each crate's measured coverage and only move
up:

```bash
node contract/scripts/coverage.mjs --ratchet   # after a coverage run
```

`--ratchet` raises each threshold to the floor of the current percentage and
never lowers one. In CI, a crate whose coverage has risen a whole point past
its threshold shows ⬆️ in the job summary as a reminder to ratchet. Lowering a
threshold is a deliberate edit to `coverage-thresholds.json` that needs a
justification in the PR.

A new crate fails the check until it has a threshold. Run `--ratchet` to add
one.

## CI outputs

The `coverage` job in Contract CI:

- writes a per-crate table to the job summary;
- uploads the `contract-coverage` artifact with `lcov.info` (for editors and
  coverage services) and the HTML report;
- caches the build with `Swatinem/rust-cache`. A warm run takes a few minutes,
  inside the 10-minute budget.

## Bumping the nightly

Change `NIGHTLY` in the workflow and the commands above together. Coverage
numbers can shift slightly between compiler versions. If a crate falls below
its threshold only because of the bump, say so in the PR and adjust it.

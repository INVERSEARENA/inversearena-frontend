# Smart Contract Test Coverage & Ratcheting Policy

> Reference Issue: [#1651](https://github.com/INVERSEARENA/inversearena-frontend/issues/1651) — Add contract test coverage reporting with thresholds in CI.

---

## 1. Overview & Objectives

Soroban smart contracts in the Inverse Arena protocol manage user funds (entry fees, prize pools, RWA yield routing, and claims). Unmeasured code coverage presents critical operational risks:
- Reviewers cannot easily verify whether fund-moving branches (e.g. error handling in `claim`, `refund`, `cancel`, and emergency pause paths) are covered by automated unit and integration tests.
- High-coverage contracts can regress silently across PR merges without continuous gates.

To address this, contract CI measures source line and branch coverage using `cargo-llvm-cov`, generates visual and machine-readable artifacts (HTML and LCOV), and enforces per-crate thresholds configured in `contract/baseline-coverage.json`.

---

## 2. Thresholds & Target Crates

Coverage is measured specifically across core protocol crates, filtering out test-only modules (`tests/`, `fixtures/`, and test mocks) to prevent synthetic test utilities from skewing production metrics:

| Crate | Minimum Line Coverage | Minimum Branch Coverage | Role |
| :--- | :---: | :---: | :--- |
| `arena` | **75.0%** | **55.0%** | Core round lifecycle, player joins, elimination, and prize claims |
| `factory` | **75.0%** | **55.0%** | Dynamic arena deployment and protocol administration |
| `payout` | **70.0%** | **50.0%** | Winnings calculation and yield distribution |
| `staking` | **70.0%** | **50.0%** | Collateral deposits and RWA yield vault routing |
| `rwa-adapter` | **65.0%** | **50.0%** | External yield provider protocol adapter |
| **Workspace Global** | **70.0%** | **50.0%** | Aggregated workspace floor across all contract code |

---

## 3. Running Coverage Locally

### Prerequisites

Ensure you have Rust and the LLVM source tools installed:

```bash
# Install cargo-llvm-cov
cargo install cargo-llvm-cov

# Add LLVM preview tools for your active Rust toolchain
rustup component add llvm-tools-preview
```

### Execution

From the repository root or the `contract/` directory:

```bash
cd contract

# 1. Run full coverage and verify against ratcheted thresholds
./scripts/check_contract_coverage.sh

# 2. Automatically ratchet thresholds upward if your new tests improved coverage
./scripts/check_contract_coverage.sh --ratchet
```

### Artifacts Generated

- **Interactive HTML Report**: `contract/target/llvm-cov/html/index.html` (open in your browser to inspect line-by-line coverage and missed branch paths).
- **LCOV Format**: `contract/target/llvm-cov/lcov.info` (can be integrated into IDEs like VS Code `Coverage Gutters`).
- **Markdown Summary**: `contract/target/llvm-cov/coverage-summary.md` (exported directly to `$GITHUB_STEP_SUMMARY` in CI).

---

## 4. Ratcheting Mechanism

To ensure coverage only increases over time and never regresses:
1. CI validates that each crate meets or exceeds `minLinePercent` and `minBranchPercent` from `contract/baseline-coverage.json`.
2. When a contributor significantly expands test coverage, running `./scripts/check_contract_coverage.sh --ratchet` updates the threshold baseline automatically.
3. Once merged into `main`, the higher threshold becomes the new non-negotiable floor for subsequent contributions.

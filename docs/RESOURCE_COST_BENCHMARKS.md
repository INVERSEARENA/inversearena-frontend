# Contract Resource Cost Benchmarks & CI Regression Gating

This document outlines the architecture, operation, and maintenance of the contract execution resource cost benchmark suite in Inverse Arena (#1649).

---

## 1. Context & Motivation

While CI previously enforced WebAssembly bytecode size budgets (64 KB ceiling per contract), runtime execution costs were unmetered. Changes to state layout, storage lookups, loops, or cryptographic verifications could silently inflate:
- CPU instructions
- Ledger entry reads & writes
- Ledger read & write byte sizes

Hot-path inflation directly increases transaction fees for players and risks hitting Soroban network transaction or invocation budget limits, particularly during large multi-player arena resolutions.

---

## 2. Metered Metrics

Using the Soroban host environment API `env.cost_estimate().resources()`, we measure invocation resources across five dimensions:

| Metric | Dimension | Description |
| :--- | :--- | :--- |
| `instructions` | Compute | Modelled CPU instructions executed during the top-level invocation |
| `read_entries` | Storage | Ledger storage entries read |
| `write_entries` | Storage | Ledger storage entries modified/written |
| `read_bytes` | Bandwidth | Cumulative bytes of ledger entries loaded |
| `write_bytes` | Bandwidth | Cumulative bytes of ledger entries persisted |

---

## 3. Entrypoint Coverage

The benchmark test suites (`contract/arena/src/resource_benchmarks.rs` and `contract/staking/src/resource_benchmarks.rs`) cover all critical contract hot paths:

1. **`join`**: `ArenaContract::join_arena` (player entry & initial deposit)
2. **`commit`**: `ArenaContract::submit_commitment` (hash commitment storage)
3. **`reveal`**: `ArenaContract::reveal_choice` (cryptographic commitment verification & choice registration)
4. **`resolve_10`**: `ArenaContract::resolve_round` (10-player resolution with yield accounting & survivor indexing)
5. **`resolve_100`**: `ArenaContract::resolve_round` (100-player resolution)
6. **`resolve_max`**: `ArenaContract::resolve_round` (at `MAX_PLAYERS_ALLOWED` = 100)
7. **`claim`**: `ArenaContract::claim` (winner prize distribution & yield payout)
8. **`refund`**: `ArenaContract::claim_refund` (cancelled arena player refund recovery)
9. **`stake`**: `StakingContract::stake` (token deposit & share issuance)
10. **`unstake`**: `StakingContract::unstake` (share redemption & token return)

---

## 4. Baseline File & Configuration

The baseline numbers are committed in `contract/baseline-resource-costs.json`:

```json
{
  "version": 1,
  "updatedAt": "2026-10-17T12:00:00Z",
  "defaultMaxAllowedRegressionPercent": 10.0,
  "entrypoints": {
    "join": {
      "instructions": 150000,
      "read_entries": 4,
      "write_entries": 3,
      "read_bytes": 1200,
      "write_bytes": 900,
      "maxAllowedRegressionPercent": 10.0
    },
    ...
  }
}
```

- `defaultMaxAllowedRegressionPercent`: Default regression threshold (10.0%).
- `maxAllowedRegressionPercent`: Can be configured per-entrypoint if specific operations require tighter or looser tolerance.

---

## 5. Running Benchmarks & CI Evaluation

### Locally

To run the benchmark suite and evaluate against baseline:

```bash
cd contract
./scripts/check_resource_costs.sh
```

### Updating the Baseline (`--bless`)

When intentional architectural changes, optimizations, or Soroban SDK upgrades alter execution costs, update the baseline:

```bash
cd contract
./scripts/check_resource_costs.sh --bless
```

This runs the benchmark suite, writes the new baseline metrics to `contract/baseline-resource-costs.json`, and updates the `updatedAt` timestamp. Commit the updated baseline along with your PR.

---

## 6. CI Integration & GitHub Step Summary

The Contract CI workflow (`.github/workflows/contract-ci.yml`) executes `./scripts/check_resource_costs.sh` on every push and pull request touching contract code.

- **Threshold Violations**: If any metric regresses by more than the allowed percentage without a baseline update, CI fails with exit code 1.
- **Job Summary Table**: The evaluator outputs a structured Markdown table to `$GITHUB_STEP_SUMMARY` detailing current vs. baseline numbers and regression deltas.
- **CI Artifacts**: Detailed reports and JSON metrics are saved to `contract/target/resource-metrics/` and uploaded as workflow artifacts.

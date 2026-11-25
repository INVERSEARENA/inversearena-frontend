# Performance Budgets & Baseline Artifacts

This repository enforces automated performance budgets across contracts, backend APIs, and frontend assets on every pull request.

## Baseline Artifacts

1. **Contracts WASM Sizes (`contract/baseline-wasm-sizes.json`)**:
   Tracks release WASM size per contract with a maximum regression tolerance of 5% and hard ceiling of 64 KB (65,536 bytes).
2. **Frontend Bundles (`frontend/bundle-size-baseline.json`)**:
   Tracks route and chunk sizes with a ceiling on total initial JavaScript and per-route regression limits.
3. **Backend API Benchmarks (`backend/benchmark-baseline.json`)**:
   Tracks p95 query and transaction latencies against seeded database fixtures.

## Running Checks Locally

```bash
# Evaluate all performance budgets against baseline artifacts
npx tsx scripts/check-perf-budgets.ts

# Evaluate WASM size budget directly
cd contract && ./scripts/optimize_and_check_wasm.sh
```

## CI Gate

The `Performance Budgets Gate` (`.github/workflows/perf-budgets.yml`) runs on PRs modifying contracts, frontend, or backend code, generating delta reports in `target/perf-budgets/report.md` and failing the build if regressions exceed allowed thresholds.

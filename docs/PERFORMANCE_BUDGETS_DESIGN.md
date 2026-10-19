# Pull-Request Performance Budgets with Baseline Artifacts

## 1. Ownership and Architecture

Performance budgets enforce quantitative boundaries on compiled contract bytecode sizes, client-side JavaScript bundles, and asynchronous API latency.

### Subsystem Boundaries
- **Contracts (`contract/`)**: WebAssembly bytecode size budget (max 64 KB per contract) evaluated post-compilation and post `wasm-opt -Oz`. Regressions against committed baseline artifacts (`contract/baseline-wasm-sizes.json`) are blocked if deltas exceed 5% or hard ceiling is breached.
- **Frontend (`frontend/`)**: Production JavaScript bundle size budget (per-chunk and total first-load JS) evaluated during Next.js build. Baseline artifact (`frontend/bundle-size-baseline.json`) records chunk sizes; budget enforcement prevents unbounded client bloat.
- **Backend (`backend/`)**: API query benchmark and latency budget evaluated against baseline timings (`backend/benchmark-baseline.json`). Regressions > 15% under identical fixture loads trigger gate warnings/failures.
- **CI / Orchestration (`scripts/check-perf-budgets.ts`)**: Unified orchestrator running in GitHub Actions (`.github/workflows/perf-budgets.yml`) that validates deltas, generates structured markdown summaries, and returns non-zero status on budget violations.

## 2. State Transitions & Lifecycle

```
[PR Opened / Synchronized]
         │
         ▼
[Build Artifacts]
 ├── contract wasm build -> target/wasm-metrics/sizes.json
 ├── frontend build     -> .next/bundle-metrics.json
 └── api benchmark      -> backend/reports/benchmark-metrics.json
         │
         ▼
[Delta Evaluation Against Baselines]
 ├── Compute: delta = (current - baseline) / baseline
 ├── Evaluate hard ceilings: current <= max_allowed
 └── Evaluate relative thresholds: delta <= max_allowed_regression_pct
         │
    ┌────┴────────────────────────┐
    ▼                             ▼
[Within Budget]             [Over Budget]
 ├── Emit Markdown report    ├── Emit failure report with exact module/chunk
 ├── Upload CI artifacts     ├── Post step summary / commit status
 └── Pass CI Gate            └── Block PR merge
```

## 3. Failure Behavior and Recovery

- **Missing Baseline**: If a baseline artifact is absent for a newly added contract or route, the orchestrator logs a warning, falls back to the hard ceiling limit, and emits an initialization recommendation.
- **Transitory Network / Runner Jitter**: Benchmark comparisons allow a configurable tolerance window (15% relative jitter) to prevent false positives on shared CI virtual machines.
- **Emergency Override**: PRs requiring intentional budget increases must update the baseline artifact in the same branch with an explicit rationale in the commit description.

## 4. Compatibility Constraints

- Preserves existing Soroban contract ABIs and REST interfaces.
- Uses typed interfaces (`PerformanceBudgetConfig`, `MetricDeltaReport`) at all boundaries.
- Produces deterministic JSON output compatible with existing CI artifact upload actions.

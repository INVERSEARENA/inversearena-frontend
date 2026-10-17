# Frontend CI: Next.js Production Build, ESLint Enforcement & Bundle Reporting

## Overview (#1642)

This document outlines the CI pipeline improvements for `inversearena-frontend`. Previously, CI only performed `tsc --noEmit` and Jest tests. Production build errors (route config invalidations, server/client boundary violations, SSR mismatches) and ESLint violations were only discovered at deploy time.

## Pipeline Architecture

The `.github/workflows/frontend-ci.yml` workflow enforces the following gates:

1. **Frozen Lockfile Installation (`--frozen-lockfile`)**
   - Strictly validates `pnpm-lock.yaml` integrity with `--frozen-lockfile --ignore-scripts`.
   - Prevents dependency drift between `package.json` and lockfiles.

2. **Next.js Build Cache (`actions/cache@v4`)**
   - Caches `frontend/.next/cache` keyed by OS and the hash of `frontend/pnpm-lock.yaml` plus application source files.
   - Restores incremental build caches to accelerate CI cycle time.

3. **ESLint Gate (`pnpm lint --max-warnings 0`)**
   - Enforces zero warnings and zero errors across the codebase.
   - Baselines legacy and experimental React 19 compiler rules with a documented burn-down plan (see `docs/ESLINT_BURNDOWN_PLAN.md`).

4. **TypeScript Typecheck (`tsc --noEmit`)**
   - Validates all TypeScript types across app pages, features, and components.

5. **Next.js Production Build (`pnpm build`)**
   - Executes `next build` under `NODE_ENV=production`.
   - Validates required runtime & build-time environment variable schemas (`StellarEnvSchema` in `src/lib/stellarConfig.ts`):
     - `NEXT_PUBLIC_STELLAR_NETWORK`: `testnet`
     - `NEXT_PUBLIC_SOROBAN_RPC_URL`: `https://soroban-testnet.stellar.org`
     - `NEXT_PUBLIC_HORIZON_URL`: `https://horizon-testnet.stellar.org`
     - `NEXT_PUBLIC_FACTORY_CONTRACT_ID`: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
     - `NEXT_PUBLIC_USDC_CONTRACT_ID`: `CDEVGFYSZ7R424P5FBRQ76S67T24QY4V3Y2N5P64Q76R424P5FBRQ76S`
     - `NEXT_PUBLIC_APP_ORIGIN`: `http://localhost:3000`
     - `NEXT_PUBLIC_DEMO_ARENA_ID`: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
     - `NEXT_TELEMETRY_DISABLED`: `1`

6. **Sentry Edge Case Handling**
   - When running in CI without `SENTRY_AUTH_TOKEN`, Sentry plugin source map upload is skipped via `dryRun: !process.env.SENTRY_AUTH_TOKEN` and webpack plugin disabling in `next.config.ts`.

7. **Bundle Size Summary to `$GITHUB_STEP_SUMMARY`**
   - Executes `node scripts/report-bundle-size.mjs`.
   - Formats chunk totals and validates tracked route budgets against `bundle-size-baseline.json`.
   - Automatically writes the Markdown table to the PR job summary.

8. **Jest Unit Tests (`jest --ci --runInBand --passWithNoTests`)**
   - Verifies 100% of unit tests pass with zero regressions.

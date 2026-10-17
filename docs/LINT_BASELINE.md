# Frontend ESLint Baseline & Debt Burn-down Plan (#1642)

## Context & Objectives
Issue #1642 introduces automated `eslint` and `next build` validation directly into the frontend CI workflow (`.github/workflows/frontend-ci.yml`).

Prior to #1642, lint violations were never checked during pull request validation, accumulating legacy technical debt across React 19 hook ergonomics and TypeScript type safety.

## Baseline Configuration
To prevent broken builds while allowing clean PRs to merge, `frontend/eslint.config.mjs` configures:
1. **Explicit Ignores:** `.next/**`, `out/**`, `build/**`, `next-env.d.ts`, `examples/**`, `coverage/**`.
2. **Legacy Rule Baselining:** Downgraded the following rules to `warn` for the legacy surface:
   - `@typescript-eslint/no-explicit-any`
   - `@typescript-eslint/no-require-imports`
   - `react-hooks/set-state-in-effect`
   - `react-hooks/immutability`
   - `react-hooks/error-boundaries`
   - `react/jsx-no-comment-textnodes`
   - `react/no-unescaped-entities`
   - `prefer-const`

## CI Enforcement Strategy
1. **Repository-Wide Baseline Check (`pnpm exec eslint --quiet`):**
   - Runs on every PR and main branch push.
   - Enforces **zero errors** across the entire codebase.
2. **Changed Files Zero-Warning Gate:**
   - In PR builds, `git diff --name-only origin/main...HEAD` detects modified TypeScript/TSX files.
   - `pnpm exec eslint --max-warnings=0` is run specifically against the modified files.
   - Any new code or modified existing file must have **0 warnings and 0 errors**.
3. **Burn-down Plan:**
   - **Phase 1 (Completed in #1642):** Eliminated build-blocking type errors in `profile/page.tsx` (`displayName`), `TotalYieldPot.tsx` (`exactOptionalPropertyTypes`), and `identity-value-objects.ts` (`Branded<T extends string | number>`).
   - **Phase 2:** Refactor `useServerTimeSync.ts` and `useWatchlist.ts` to replace synchronous `setState` in effects with event-driven or callback sync.
   - **Phase 3:** Address explicit `any` occurrences across `components/hook-d/`.

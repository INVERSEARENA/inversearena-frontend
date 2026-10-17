# ESLint Baseline and Burn-down Plan

## Context (#1642)

Enforcing `eslint --max-warnings 0` in CI requires managing legacy codebase patterns and React 19 / Next.js 16 compiler canary checks (`react-hooks/set-state-in-effect`, `react-hooks/immutability`).

To establish a strict CI gate without blocking immediate delivery, violations are addressed in two tiers:

1. **Fixed Immediately in #1642:**
   - Prefer-const in `src/components/arena/core/RoundResolvedOverlay.tsx`.
   - JSX comment child formatting in `src/components/arena-v2/withdrawal/SuccessHeader.tsx`.
   - Error boundary JSX try/catch violation in `src/app/arena/[id]/page.tsx`.
   - Unescaped HTML entities in `src/components/error-boundary/ErrorFallback.tsx`.
   - Unused disable directives across test suites.
   - Branded value object type constraints in `src/shared-d/utils/identity-value-objects.ts`.
   - Agent identity `displayName` interface typing in `src/shared-d/features/profile/types.ts`.

2. **Baselined with Burn-Down Milestones:**
   - `react-hooks/set-state-in-effect`: Setting state inside `useEffect` on mount (e.g. hydration checks `setMounted(true)`, client-side storage hydration).
     - *Burn-down Milestone:* Migrate client initialization to custom hooks (`useSyncExternalStore` or React 19 Actions).
   - `react-hooks/immutability`: Mutating function properties in `useNotification.ts`.
     - *Burn-down Milestone:* Return an object of functions rather than mutating the callable function instance.
   - `@typescript-eslint/no-unused-vars`: Unused parameter and import baselines.
     - *Burn-down Milestone:* Prefix unused parameters with `_` or prune unneeded imports during regular feature work.

## Enforcement Status

`pnpm lint --max-warnings 0` runs as a required gate in `.github/workflows/frontend-ci.yml`. Any new violations or regressions will fail the pull request.

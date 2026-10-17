import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "examples/**",
    "coverage/**",
  ]),
  // #1567 — the mock leaderboard module is test-only. Production code must
  // use `useLeaderboard` (GET /api/leaderboard) and `../utils/format`.
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/leaderboard/data/mockLeaderboard"],
              message:
                "mockLeaderboard is test-only (#1567). Use useLeaderboard + utils/format in production code.",
            },
          ],
        },
      ],
      // Baseline legacy rules downgraded to warnings for burn-down plan (#1642).
      // See docs/LINT_BASELINE.md for migration tracking.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/error-boundaries": "warn",
      "react/jsx-no-comment-textnodes": "warn",
      "react/no-unescaped-entities": "warn",
      "prefer-const": "warn",
    },
  },
]);

export default eslintConfig;

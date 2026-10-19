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
    },
  },
]);

export default eslintConfig;

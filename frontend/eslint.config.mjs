import { readdirSync } from "node:fs";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// #1598 — module boundaries (see ARCHITECTURE.md, "Frontend layout").
// A feature may use another feature only through its public `index.ts`,
// `shared/` never depends on `features/`, and production code never imports
// test doubles. Zones are derived from the directory so new features are
// covered without editing this file.
const FEATURES = readdirSync(new URL("./src/features", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const boundaryZones = [
  ...FEATURES.map((feature) => ({
    target: `./src/features/${feature}`,
    from: "./src/features",
    except: [
      `./${feature}`,
      ...FEATURES.filter((other) => other !== feature).map((other) => `./${other}/index.ts`),
    ],
    message: "Import another feature only through its public index (`@/features/<name>`).",
  })),
  {
    target: "./src/shared",
    from: "./src/features",
    message: "shared/ is a lower layer and must not depend on features/.",
  },
  {
    target: "./src",
    from: ["./src/test", "./src/__mocks__"],
    message: "Test doubles are for tests only; production code must not import them.",
  },
];

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
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    ignores: ["src/test/**", "src/__mocks__/**", "**/__tests__/**", "**/*.test.{ts,tsx,js,jsx}"],
    rules: {
      "import/no-restricted-paths": ["error", { zones: boundaryZones }],
    },
  },
]);

export default eslintConfig;

/**
 * ESLint configuration for InverseArena backend (#1650).
 * Enforces single config module architecture: direct process.env reads are banned outside src/config.
 */

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
    ],
  },
  {
    files: ["src/**/*.ts", "src/**/*.js"],
    ignores: ["src/config/**", "test/**", "tests/**"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Direct process.env reads are banned outside backend/src/config. Import 'config' from '@/config' or './config'.",
        },
      ],
    },
  },
];

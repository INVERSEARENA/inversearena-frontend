/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/test", "<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  testPathIgnorePatterns: [
    "/node_modules/",
    // node:test suites (run via `node --test` in CI)
    "<rootDir>/tests/request-validation\\.unit\\.test\\.ts",
    "<rootDir>/tests/roundRepository\\.unit\\.test\\.ts",
    "<rootDir>/tests/payment\\.unit\\.test\\.ts",
    "<rootDir>/tests/auth\\.unit\\.test\\.ts",
    "<rootDir>/tests/auth-middleware\\.unit\\.test\\.ts",
    "<rootDir>/tests/arenas\\.route\\.unit\\.test\\.ts",
    // Legacy script-style runners (no Jest `describe`/`it`)
    "<rootDir>/tests/leaderboard\\.test\\.ts",
    "<rootDir>/tests/security-headers\\.test\\.ts",
    "<rootDir>/tests/arena-participants\\.test\\.ts",
    "<rootDir>/tests/arenaStats\\.test\\.ts",
    "<rootDir>/tests/metrics\\.test\\.ts",
    "<rootDir>/tests/payment\\.integration\\.test\\.ts",
    "<rootDir>/tests/round\\.integration\\.test\\.ts",
  ],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
};

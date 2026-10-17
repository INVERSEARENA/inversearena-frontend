/** @type {import('ts-jest').JestConfigWithTsJest} */
const commonConfig = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json", isolatedModules: true }],
  },
  moduleNameMapper: {
    "^@creit-tech/stellar-wallets-kit$": "<rootDir>/../frontend/src/__mocks__/stellar-wallets-kit.ts",
    "^@/shared-d/(.*)$": "<rootDir>/../frontend/src/shared-d/$1",
    "^@/lib/(.*)$": "<rootDir>/../frontend/src/lib/$1",
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  detectOpenHandles: true,
};

// Node:test suites (run via `tsx --test` or `node --test` in CI) and legacy scripts
const nodeTestAndScriptIgnores = [
  "request-validation\\.unit\\.test\\.ts",
  "roundRepository\\.unit\\.test\\.ts",
  "payment\\.unit\\.test\\.ts",
  "auth\\.unit\\.test\\.ts",
  "auth-middleware\\.unit\\.test\\.ts",
  "arenas\\.route\\.unit\\.test\\.ts",
  "commitStatus\\.route\\.unit\\.test\\.ts",
  "evidence\\.route\\.unit\\.test\\.ts",
  "arenaService\\.deployment\\.unit\\.test\\.ts",
  "worker\\.route\\.unit\\.test\\.ts",
  "paymentWorker\\.test\\.ts",
  "adminReindexPool\\.unit\\.test\\.ts",
  "leaderboardPagination\\.unit\\.test\\.ts",
  "payoutIdUniqueness\\.unit\\.test\\.ts",
  "syncPlayersAuth\\.unit\\.test\\.ts",
  "ledgerClock\\.unit\\.test\\.ts",
  "maintenanceService\\.unit\\.test\\.ts",
  "maintenanceGuard\\.unit\\.test\\.ts",
  "adminMaintenance\\.unit\\.test\\.ts",
  "authDeviceSessions\\.unit\\.test\\.ts",
  "onChainReader\\.snapshot\\.unit\\.test\\.ts",
  "payoutsReceipt\\.unit\\.test\\.ts",
  "arenaYield\\.unit\\.test\\.ts",
  "pushService\\.unit\\.test\\.ts",
  "roundProofBundle\\.route\\.unit\\.test\\.ts",
  "onChainReader\\.factoryArenaPage\\.unit\\.test\\.ts",
  "arenaBackfillWorker\\.unit\\.test\\.ts",
  "arenaPoller\\.unit\\.test\\.ts",
  "arenaPollerConcurrency\\.unit\\.test\\.ts",
  "arenaPollerConcurrency\\.load\\.test\\.ts",
  "transactionIntent\\.unit\\.test\\.ts",
  "faultInjection\\.unit\\.test\\.ts",
  "contractCapability\\.integration\\.unit\\.test\\.ts",
  "arenaBackfill\\.integration\\.unit\\.test\\.ts",
  "arenaPollerConcurrency\\.integration\\.test\\.ts",
  "payment\\.integration\\.test\\.ts",
  "payment\\.xdr\\.integration\\.test\\.ts",
  "round\\.integration\\.test\\.ts",
  "roundResolution\\.unit\\.test\\.ts",
  "roundService\\.unit\\.test\\.ts",
  // Legacy script-style runners
  "leaderboard\\.test\\.ts",
  "security-headers\\.test\\.ts",
  "arenaStats\\.test\\.ts",
  "metrics\\.test\\.ts",
];

module.exports = {
  projects: [
    {
      ...commonConfig,
      displayName: "unit",
      roots: ["<rootDir>/tests/unit"],
      setupFilesAfterEnv: ["<rootDir>/tests/unit/setup.ts"],
      testPathIgnorePatterns: ["/node_modules/", ...nodeTestAndScriptIgnores],
    },
    {
      ...commonConfig,
      displayName: "integration",
      roots: ["<rootDir>/tests/integration"],
      setupFilesAfterEnv: ["<rootDir>/tests/integration/setup.ts"],
      testPathIgnorePatterns: ["/node_modules/", ...nodeTestAndScriptIgnores],
    },
  ],
};

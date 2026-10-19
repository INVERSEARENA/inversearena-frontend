/**
 * Tiered Jest projects (#1644).
 *
 *   tests/unit/             — no external services (Postgres/Redis/Mongo mocked
 *                             or in-memory). Safe for every PR.
 *   tests/integration/      — needs the docker-compose services (Postgres,
 *                             Redis, Mongo). Run in CI with service containers.
 *   tests/contract-fixtures/ — golden fixtures shared with the contracts.
 *
 * Helpers and shared setup live in tests/helpers/ and tests/setup/.
 * A handful of suites still run under `node --test` (see package.json
 * `test:node`) and are listed in `NODE_RUNNER_FILES` so Jest skips them.
 */

const NODE_RUNNER_FILES = [
  "request-validation.unit.test.ts",
  "roundRepository.unit.test.ts",
  "payment.unit.test.ts",
  "auth.unit.test.ts",
  "auth-middleware.unit.test.ts",
  "arenas.route.unit.test.ts",
  "commitStatus.route.unit.test.ts",
  "evidence.route.unit.test.ts",
  "arenaService.deployment.unit.test.ts",
  "worker.route.unit.test.ts",
  "paymentWorker.test.ts",
  "adminReindexPool.unit.test.ts",
  "leaderboardPagination.unit.test.ts",
  "payoutIdUniqueness.unit.test.ts",
  "syncPlayersAuth.unit.test.ts",
  "ledgerClock.unit.test.ts",
  "maintenanceService.unit.test.ts",
  "maintenanceGuard.unit.test.ts",
  "adminMaintenance.unit.test.ts",
  "authDeviceSessions.unit.test.ts",
  "onChainReader.snapshot.unit.test.ts",
  "payoutsReceipt.unit.test.ts",
  "contractCapability.integration.unit.test.ts",
  "roundProofBundle.route.unit.test.ts",
  "onChainReader.factoryArenaPage.unit.test.ts",
  "arenaBackfillWorker.unit.test.ts",
  "arenaBackfill.integration.unit.test.ts",
  "arenaPoller.unit.test.ts",
  "arenaPollerConcurrency.unit.test.ts",
  "arenaPollerConcurrency.load.test.ts",
  "arenaPollerConcurrency.integration.test.ts",
  "transactionIntent.unit.test.ts",
  "faultInjection.unit.test.ts",
  "participantEligibility.unit.test.ts",
];

/** Legacy script-style runners (no Jest describe/it). */
const LEGACY_SCRIPT_RUNNERS = [
  "leaderboard.test.ts",
  "security-headers.test.ts",
  "arenaStats.test.ts",
  "metrics.test.ts",
  "payment.integration.test.ts",
  "round.integration.test.ts",
];

const nodeRunnerIgnore = NODE_RUNNER_FILES.map(
  (f) => `<rootDir>/tests/(unit|integration)/${f.replace(/\./g, "\\.")}`,
);

const legacyIgnore = LEGACY_SCRIPT_RUNNERS.map(
  (f) => `<rootDir>/tests/(unit|integration)/${f.replace(/\./g, "\\.")}`,
);

const shared = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json", isolatedModules: true }],
    "^.+\\.jsx?$": ["ts-jest", { tsconfig: "tsconfig.json", isolatedModules: true }],
  },
  transformIgnorePatterns: ["node_modules/(?!(@creit-tech|@jsr)/)"],
  moduleNameMapper: {
    "^@creit-tech/stellar-wallets-kit$":
      "<rootDir>/tests/__mocks__/@creit-tech/stellar-wallets-kit.ts",
    "^@/shared-d/(.*)$": "<rootDir>/../frontend/src/shared-d/$1",
    "^@/lib/(.*)$": "<rootDir>/../frontend/src/lib/$1",
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  detectOpenHandles: true,
};

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  projects: [
    {
      ...shared,
      displayName: "unit",
      roots: ["<rootDir>/src", "<rootDir>/tests/unit"],
      testPathIgnorePatterns: [
        "/node_modules/",
        ...nodeRunnerIgnore,
        ...legacyIgnore,
      ],
      setupFilesAfterEnv: ["<rootDir>/tests/setup/unit-setup.ts"],
    },
    {
      ...shared,
      displayName: "integration",
      roots: ["<rootDir>/tests/integration"],
      testPathIgnorePatterns: [
        "/node_modules/",
        ...nodeRunnerIgnore,
        ...legacyIgnore,
      ],
      setupFilesAfterEnv: ["<rootDir>/tests/setup/setup.ts"],
      // Integration suites share a database — never parallelise them.
      maxWorkers: 1,
    },
  ],
};

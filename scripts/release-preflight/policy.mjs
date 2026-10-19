// Pure policy for the release preflight (#1465).
//
// Everything here is a deterministic function of its arguments: no filesystem,
// no network, no environment. `preflight.mjs` owns the I/O probes and hands
// their results in; the tests exercise these functions directly. That split is
// what lets the preflight run in CI without a database, a Stellar node, or a
// compiled WASM — and lets a failure be reproduced from the JSON it prints.

export const RELEASE_PREFLIGHT_SCHEMA_VERSION = 1;

/** Prisma's migration lock provider; anything else is an incompatible release. */
export const EXPECTED_MIGRATION_PROVIDER = "postgresql";

/**
 * Config keys a release cannot start without. Kept deliberately short: the
 * point is to fail loudly on a deploy that forgot the essentials, not to mirror
 * every optional tuning knob in `.env.example`.
 */
export const DEFAULT_REQUIRED_CONFIG_KEYS = [
  "DATABASE_URL",
  "MONGODB_URI",
  "REDIS_URL",
  "JWT_SECRET",
  "ADMIN_API_KEY",
  "SOROBAN_RPC_URL",
  "STELLAR_NETWORK_PASSPHRASE",
  "ARENA_FACTORY_CONTRACT_ID",
  "PAYOUT_CONTRACT_ID",
];

/**
 * Values shipped in `.env.example` that must never reach production. A release
 * that leaves any of these in the real environment is incompatible, so the
 * preflight fails it rather than letting the placeholder ship.
 */
export const DEFAULT_PLACEHOLDER_SECRETS = [
  "change-me-in-production",
  "change-me-minimum-32-characters-long",
];

const DESTRUCTIVE_PATTERNS = [
  { kind: "drop_table", pattern: /\bDROP\s+TABLE\b/i },
  { kind: "drop_column", pattern: /\bDROP\s+COLUMN\b/i },
  { kind: "drop_type", pattern: /\bDROP\s+TYPE\b/i },
  { kind: "truncate", pattern: /\bTRUNCATE\b/i },
  { kind: "delete_from", pattern: /\bDELETE\s+FROM\b/i },
];

function finding(check, level, code, artifact, message) {
  return { check, level, code, artifact, message };
}

/**
 * Destructive statements in one migration's SQL.
 *
 * Line comments are stripped first so a commented-out `DROP TABLE` (a common
 * way to leave a rollback breadcrumb in place) is not mistaken for a live
 * statement. Detection is intentionally syntactic: the preflight does not try
 * to parse SQL, it only needs to know whether a human must supply a rollback.
 */
export function detectDestructiveStatements(sql) {
  if (typeof sql !== "string") return [];
  const uncommented = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  const found = [];
  for (const { kind, pattern } of DESTRUCTIVE_PATTERNS) {
    const match = pattern.exec(uncommented);
    if (match) found.push({ kind, statement: match[0].replace(/\s+/g, " ").trim().toUpperCase() });
  }
  return found;
}

/**
 * Validate the migration set.
 *
 * @param {object} input
 * @param {Array<{name: string, hasSql: boolean, sql: string|null, hasRollback: boolean}>} input.migrations
 * @param {string} input.provider value of `migration_lock.toml`'s provider
 * @param {string[]} [input.allowlist] `"<migration>:<kind>"` entries accepted as reviewed
 */
export function checkMigrations({ migrations, provider, allowlist = [] }) {
  const findings = [];
  const allow = new Set(allowlist);

  if (provider !== EXPECTED_MIGRATION_PROVIDER) {
    findings.push(
      finding(
        "migrations",
        "error",
        "migration_provider_mismatch",
        "backend/prisma/migrations/migration_lock.toml",
        `expected provider "${EXPECTED_MIGRATION_PROVIDER}", found ${JSON.stringify(provider)}`,
      ),
    );
  }

  if (migrations.length === 0) {
    findings.push(
      finding("migrations", "error", "no_migrations", "backend/prisma/migrations", "no migration directories found"),
    );
  }

  const seen = new Set();
  for (const migration of migrations) {
    if (seen.has(migration.name)) {
      findings.push(
        finding("migrations", "error", "duplicate_migration", migration.name, "duplicate migration directory name"),
      );
    }
    seen.add(migration.name);

    if (!migration.hasSql) {
      findings.push(
        finding("migrations", "error", "migration_missing_sql", migration.name, "migration directory has no migration.sql"),
      );
      continue;
    }

    for (const { kind, statement } of detectDestructiveStatements(migration.sql ?? "")) {
      if (allow.has(`${migration.name}:${kind}`)) continue;
      findings.push(
        finding(
          "rollback",
          migration.hasRollback ? "warn" : "error",
          `destructive_${kind}`,
          migration.name,
          `${statement} without a reviewed rollback plan${
            migration.hasRollback ? " (rollback.sql present — confirm it restores the dropped shape)" : ""
          }`,
        ),
      );
    }
  }

  return findings;
}

/**
 * Validate ABI snapshots.
 *
 * @param {object} input
 * @param {Array<{name: string, hasSnapshot: boolean, isJsonArray: boolean, contractVersion: number|null}>} input.contracts
 */
export function checkAbiSnapshots({ contracts }) {
  const findings = [];

  for (const contract of contracts) {
    if (contract.contractVersion === null) {
      findings.push(
        finding(
          "abis",
          "error",
          "contract_version_unreadable",
          contract.name,
          "could not read CONTRACT_VERSION from the contract source",
        ),
      );
    }
    if (!contract.hasSnapshot) {
      findings.push(
        finding("abis", "error", "abi_snapshot_missing", contract.name, "no abi_snapshot.json"),
      );
      continue;
    }
    if (!contract.isJsonArray) {
      findings.push(
        finding(
          "abis",
          "error",
          "abi_snapshot_invalid",
          contract.name,
          "abi_snapshot.json is not a non-empty JSON array",
        ),
      );
    }
  }

  return findings;
}

/**
 * Parse a KEY=VALUE env file, returning the set of uncommented keys and a
 * `KEY -> value` map. Commented-out lines are ignored — an optional knob that
 * ships commented is intentionally not required.
 */
export function parseEnvExample(text) {
  const keys = new Set();
  const values = new Map();
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    keys.add(key);
    values.set(key, line.slice(eq + 1).trim());
  }
  return { keys, values };
}

/**
 * Validate configuration for a release.
 *
 * Two distinct inputs, deliberately not conflated:
 *  - `envExampleText` is the shipped `backend/.env.example`, which is checked
 *    for whether each required key is *declared*. Its placeholder values are
 *    expected and never flagged.
 *  - `envValues` is the *actual* environment the release will run in. Only here
 *    can a placeholder be a real defect, so the production check runs against
 *    it. When omitted (an offline dry run) no environment values are inspected
 *    and only declared-key coverage is reported.
 *
 * @param {object} input
 * @param {string} input.envExampleText contents of the shipped `.env.example`
 * @param {Record<string, string|undefined>} [input.envValues] the real environment
 * @param {string[]} [input.requiredKeys]
 * @param {"development"|"staging"|"production"} [input.environment]
 * @param {string[]} [input.placeholders]
 */
export function checkConfig({
  envExampleText,
  envValues = {},
  requiredKeys = DEFAULT_REQUIRED_CONFIG_KEYS,
  environment = "production",
  placeholders = DEFAULT_PLACEHOLDER_SECRETS,
}) {
  const findings = [];
  const { keys } = parseEnvExample(envExampleText);

  for (const key of requiredKeys) {
    if (!keys.has(key)) {
      findings.push(
        finding("config", "error", "required_config_missing", "backend/.env.example", `${key} is not declared`),
      );
    }
  }

  if (environment === "production") {
    for (const key of requiredKeys) {
      const value = envValues[key];
      if (value !== undefined && placeholders.includes(value)) {
        findings.push(
          finding(
            "config",
            "error",
            "placeholder_secret_in_production",
            key,
            `${key} is still a shipped placeholder ${JSON.stringify(value)} in the release environment`,
          ),
        );
      }
    }
  }

  return findings;
}

/**
 * Validate that a rollback plan exists for the release.
 *
 * @param {object} input
 * @param {Array<{name: string, hasRollback: boolean}>} input.migrations
 * @param {string} input.rollbackDoc text of the operator rollback documentation
 */
export function checkRollback({ migrations, rollbackDoc }) {
  const findings = [];
  const doc = String(rollbackDoc ?? "");

  if (!/rollback/i.test(doc)) {
    findings.push(
      finding("rollback", "error", "rollback_doc_missing", "DEPLOYMENT.md", "no rollback section found"),
    );
  }

  for (const migration of migrations) {
    // Only destructive migrations have to name a mechanism; additive ones are
    // safe to leave in place on rollback.
    if (migration.hasRollback) continue;
    if (!doc.includes(migration.name)) {
      findings.push(
        finding(
          "rollback",
          "warn",
          "migration_not_in_rollback_doc",
          migration.name,
          "migration is not referenced in the rollback documentation",
        ),
      );
    }
  }

  return findings;
}

/**
 * Collapse findings into the machine-readable dry-run result.
 *
 * `pass` is true only when nothing is at `error` level. Warnings are reported
 * so an operator sees them, but do not block the release on their own.
 */
export function summarize(findings) {
  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warn");
  const checks = {};
  for (const f of findings) {
    checks[f.check] ??= { errors: 0, warnings: 0 };
    if (f.level === "error") checks[f.check].errors += 1;
    else checks[f.check].warnings += 1;
  }
  return {
    schemaVersion: RELEASE_PREFLIGHT_SCHEMA_VERSION,
    pass: errors.length === 0,
    errorCount: errors.length,
    warningCount: warnings.length,
    checks,
    findings,
  };
}

// Dependency threat gate policy (#1457). Design note: docs/design/dependency-threat-gate.md
//
// Pure functions only: report normalisation, severity derivation, exception
// validation and the block/allow decision. The CLI (gate.mjs) handles I/O.

/** @typedef {"npm" | "cargo"} Ecosystem */
/** @typedef {"info" | "low" | "moderate" | "high" | "critical"} Severity */
/**
 * @typedef {object} Finding
 * @property {Ecosystem} ecosystem
 * @property {string} source      which report produced it (backend, frontend, contract)
 * @property {string} id          primary advisory id (GHSA-…, RUSTSEC-…, or npm numeric id)
 * @property {string[]} aliases   other ids for the same advisory (CVE, GHSA)
 * @property {string} package
 * @property {Severity} severity
 * @property {string} title
 * @property {string} url
 * @property {boolean} sensitive  wallet / crypto / contract toolchain package
 */
/**
 * @typedef {object} DependencyException
 * @property {string} id
 * @property {Ecosystem} ecosystem
 * @property {string} package
 * @property {string} reason
 * @property {string} approvedBy
 * @property {string} expires     ISO date (YYYY-MM-DD or full timestamp)
 */

export const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** Longest an exception may stay open; forces periodic re-review. */
export const MAX_EXCEPTION_DAYS = 90;

/**
 * Packages whose compromise directly threatens keys, signatures or on-chain
 * funds. `high` advisories in these block CI, not only `critical` ones.
 */
export const SENSITIVE_PACKAGE_PATTERNS = [
  // wallet + Stellar client toolchain
  /^@stellar\//, /^@creit-tech\//, /^stellar-/, /^soroban-/, /^@jsr\/creit-tech__/,
  // auth / crypto primitives (JS)
  /^jsonwebtoken$/, /^jws$/, /^jwa$/, /^tweetnacl/, /^@noble\//, /^elliptic$/, /^bn\.js$/,
  /^bip39$/, /^ed25519/, /^sodium/, /^libsodium/, /^crypto-js$/, /^node-forge$/,
  // crypto primitives (Rust)
  /^ed25519(-dalek)?$/, /^curve25519-dalek$/, /^x25519-dalek$/, /^k256$/, /^p256$/, /^ecdsa$/,
  /^sha2$/, /^sha3$/, /^hmac$/, /^ring$/, /^rand(_core|_chacha)?$/, /^getrandom$/,
  /^wasmi/, /^wasmparser$/,
];

export function isSensitivePackage(name) {
  return SENSITIVE_PACKAGE_PATTERNS.some((pattern) => pattern.test(name));
}

function normalizeSeverity(value) {
  const s = String(value ?? "").toLowerCase();
  if (s === "medium") return "moderate";
  if (s === "none") return "info";
  return s in SEVERITY_RANK ? /** @type {Severity} */ (s) : "high"; // unknown → fail safe
}

function ghsaFromUrl(url) {
  const match = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(url ?? "");
  return match ? match[0] : null;
}

// ---- CVSS v3.x base score (cargo-audit reports vectors, not severities) ---------

const CVSS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
};

function roundUp(value) {
  const int = Math.round(value * 100000);
  return int % 10000 === 0 ? int / 100000 : (Math.floor(int / 10000) + 1) / 10;
}

/** Base score for a CVSS:3.0/3.1 vector, or null if it cannot be parsed. */
export function cvss3BaseScore(vector) {
  if (typeof vector !== "string" || !/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = Object.fromEntries(vector.split("/").slice(1).map((part) => part.split(":")));
  const scopeChanged = m.S === "C";
  const pr = { N: 0.85, L: scopeChanged ? 0.68 : 0.62, H: scopeChanged ? 0.5 : 0.27 }[m.PR];
  const av = CVSS.AV[m.AV], ac = CVSS.AC[m.AC], ui = CVSS.UI[m.UI];
  const c = CVSS.CIA[m.C], i = CVSS.CIA[m.I], a = CVSS.CIA[m.A];
  if ([pr, av, ac, ui, c, i, a].some((v) => v === undefined) || !["U", "C"].includes(m.S)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  return roundUp(Math.min((scopeChanged ? 1.08 : 1) * (impact + exploitability), 10));
}

export function severityFromScore(score) {
  if (score === null) return "high";
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  if (score > 0) return "low";
  return "info";
}

// ---- report normalisation ----------------------------------------------------------

/** `npm audit --json` (auditReportVersion 2, npm ≥ 7). */
export function normalizeNpmAudit(report, source) {
  if (!report || typeof report !== "object" || typeof report.vulnerabilities !== "object") {
    throw new Error(`${source}: not an npm audit v2 report`);
  }
  /** @type {Finding[]} */
  const findings = [];
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || via === null) continue; // transitive pointer, reported under its own key
      const ghsa = ghsaFromUrl(via.url);
      const name = via.name ?? vuln.name;
      findings.push({
        ecosystem: "npm", source, id: ghsa ?? String(via.source), aliases: ghsa ? [String(via.source)] : [],
        package: name, severity: normalizeSeverity(via.severity ?? vuln.severity), title: via.title ?? "", url: via.url ?? "",
        sensitive: isSensitivePackage(name),
      });
    }
  }
  return findings;
}

/** `pnpm audit --json` (npm v6-style `advisories` map). */
export function normalizePnpmAudit(report, source) {
  if (!report || typeof report !== "object" || typeof report.advisories !== "object") {
    throw new Error(`${source}: not a pnpm audit report`);
  }
  return Object.values(report.advisories).map((adv) => {
    const ghsa = adv.github_advisory_id ?? ghsaFromUrl(adv.url);
    return {
      ecosystem: "npm", source, id: ghsa ?? String(adv.id), aliases: [String(adv.id), ...(adv.cves ?? [])].filter((a) => a !== ghsa),
      package: adv.module_name, severity: normalizeSeverity(adv.severity), title: adv.title ?? "", url: adv.url ?? "",
      sensitive: isSensitivePackage(adv.module_name),
    };
  });
}

/** `cargo audit --json`. Severity is derived from the CVSS vector. */
export function normalizeCargoAudit(report, source) {
  if (!report || typeof report !== "object" || typeof report.vulnerabilities !== "object") {
    throw new Error(`${source}: not a cargo audit report`);
  }
  return (report.vulnerabilities.list ?? []).map((entry) => {
    const adv = entry.advisory ?? {};
    const name = entry.package?.name ?? adv.package;
    const severity = adv.informational ? "info" : severityFromScore(cvss3BaseScore(adv.cvss));
    return {
      ecosystem: "cargo", source, id: adv.id, aliases: adv.aliases ?? [], package: name, severity,
      title: adv.title ?? "", url: adv.url ?? "", sensitive: isSensitivePackage(name),
    };
  });
}

/** Same advisory reached via several paths / reports counts once. */
export function dedupeFindings(findings) {
  const seen = new Map();
  for (const finding of findings) {
    const key = `${finding.ecosystem}:${finding.package}:${finding.id}`;
    const prev = seen.get(key);
    if (!prev || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[prev.severity]) {
      seen.set(key, prev ? { ...finding, source: `${prev.source},${finding.source}` } : finding);
    }
  }
  return [...seen.values()];
}

// ---- exceptions --------------------------------------------------------------------

function parseDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Split the exceptions file into usable, expired and invalid entries.
 * Invalid entries never suppress anything.
 */
export function validateExceptions(file, now = new Date()) {
  const result = { active: [], expired: [], invalid: [] };
  if (!file || file.version !== 1 || !Array.isArray(file.exceptions)) {
    result.invalid.push({ entry: file, problems: ["exceptions file must be {\"version\":1,\"exceptions\":[…]}"] });
    return result;
  }
  const maxExpiry = now.getTime() + MAX_EXCEPTION_DAYS * 24 * 3600 * 1000;
  for (const entry of file.exceptions) {
    const problems = [];
    for (const field of ["id", "package", "reason", "approvedBy", "expires"]) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") problems.push(`missing ${field}`);
    }
    if (!["npm", "cargo"].includes(entry?.ecosystem)) problems.push("ecosystem must be npm or cargo");
    const expires = parseDate(entry?.expires);
    if (entry?.expires && !expires) problems.push("expires is not a valid date");
    if (expires && expires.getTime() > maxExpiry) problems.push(`expires is more than ${MAX_EXCEPTION_DAYS} days away`);
    if (problems.length > 0) result.invalid.push({ entry, problems });
    else if (expires.getTime() <= now.getTime()) result.expired.push(entry);
    else result.active.push(entry);
  }
  return result;
}

function exceptionMatches(exception, finding) {
  return exception.ecosystem === finding.ecosystem
    && exception.package === finding.package
    && (exception.id === finding.id || finding.aliases.includes(exception.id));
}

/** Does this finding block the build absent an exception? */
export function isBlocking(finding) {
  if (finding.severity === "critical") return true;
  return finding.severity === "high" && finding.sensitive;
}

/**
 * The gate decision.
 * @param {Finding[]} findings
 * @param {ReturnType<typeof validateExceptions>} exceptions
 * @param {string[]} unavailable  reports that could not be produced/parsed
 */
export function evaluateGate(findings, exceptions, unavailable = []) {
  const blocked = [], excepted = [], reported = [];
  const used = new Set();
  for (const finding of dedupeFindings(findings)) {
    if (!isBlocking(finding)) { reported.push(finding); continue; }
    const exception = exceptions.active.find((e) => exceptionMatches(e, finding));
    if (exception) { excepted.push({ finding, exception }); used.add(exception); continue; }
    const expired = exceptions.expired.find((e) => exceptionMatches(e, finding));
    blocked.push(expired ? { ...finding, expiredException: expired.expires } : finding);
  }
  const unused = exceptions.active.filter((e) => !used.has(e));
  const pass = blocked.length === 0 && exceptions.invalid.length === 0 && unavailable.length === 0;
  return { pass, blocked, excepted, reported, unused, expired: exceptions.expired, invalid: exceptions.invalid, unavailable };
}

export const DEFAULT_CONFIG = {
  enforceAfter: "2026-01-01T00:00:00Z",
  botAllowlist: [
    "renovate[bot]",
    "dependabot[bot]",
    "drips-wave",
    "github-actions[bot]",
  ],
  duplicateThreshold: 0.8,
  staleDays: 30,
  staleCommentDays: 7,
  duplicateLabel: "duplicate",
  maxPrsScanned: 200,
  dryRun: false,
};

export function loadConfig(text) {
  const parsed = JSON.parse(text);
  const cfg = { ...DEFAULT_CONFIG, ...parsed };
  if (!Array.isArray(cfg.botAllowlist)) throw new Error("botAllowlist must be an array");
  if (typeof cfg.duplicateThreshold !== "number") throw new Error("duplicateThreshold must be number");
  if (typeof cfg.staleDays !== "number") throw new Error("staleDays must be number");
  if (typeof cfg.staleCommentDays !== "number") throw new Error("staleCommentDays must be number");
  if (typeof cfg.maxPrsScanned !== "number") throw new Error("maxPrsScanned must be number");
  if (typeof cfg.dryRun !== "boolean") throw new Error("dryRun must be boolean");
  if (typeof cfg.duplicateLabel !== "string" || !cfg.duplicateLabel) throw new Error("duplicateLabel required");
  Date.parse(cfg.enforceAfter);
  return cfg;
}

export function isBot(author, config) {
  return config.botAllowlist.includes(author);
}

export function isEnforced(createdAt, config) {
  const created = Date.parse(createdAt);
  const enforceAfter = Date.parse(config.enforceAfter);
  if (Number.isNaN(created) || Number.isNaN(enforceAfter)) return true;
  return created >= enforceAfter;
}

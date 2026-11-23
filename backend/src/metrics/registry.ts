/**
 * Metrics Registry Helper (#1750).
 *
 * Provides central registration, convention enforcement (prefixes, units, label sets),
 * bounded cardinality guards (#1274), and duplicate metric detection.
 */

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  type CounterConfiguration,
  type HistogramConfiguration,
  type GaugeConfiguration,
} from "prom-client";

export const register = new Registry();

export interface MetricDefinitionMeta {
  name: string;
  type: "counter" | "gauge" | "histogram";
  help: string;
  domain: string;
  labelNames?: string[];
}

const registeredMetricDefinitions = new Map<string, MetricDefinitionMeta>();

/**
 * Standard allowed metric prefixes.
 * All new metrics must start with `inversearena_` or one of the recognized legacy prefixes.
 */
export const ALLOWED_PREFIXES = [
  "inversearena_",
  "http_",
  "worker_",
  "round_",
  "txs_",
  "claim_inbox_",
  "creator_",
  "fee_eligibility_",
  "active_stake_",
  "ttl_keeper_",
  "cache_",
] as const;

/**
 * Global label allowlist for bounded cardinality enforcement (#1274).
 */
export const ALLOWED_LABEL_NAMES = new Set([
  "action",
  "asset",
  "boundary",
  "classification",
  "code",
  "collection",
  "consumer",
  "contract",
  "datastore",
  "event",
  "field",
  "from_state",
  "job_type",
  "key",
  "kind",
  "lifecycle_state",
  "limit",
  "metadata_class",
  "method",
  "mode",
  "namespace",
  "operation",
  "oracle_contract",
  "outcome",
  "purpose",
  "queue",
  "reason",
  "result",
  "route",
  "section",
  "slot",
  "source",
  "state",
  "status",
  "table",
  "to_state",
  "user_id", // bounded in tests / mock contexts
  "violation_type",
  "worker",
]);

/**
 * Validates Prometheus naming conventions and label allowlists.
 */
export function validateMetricConventions(
  name: string,
  type: "counter" | "gauge" | "histogram",
  labelNames: string[] = [],
): void {
  // 1. Prometheus valid identifier check
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
    throw new Error(`Metric name '${name}' contains invalid Prometheus characters`);
  }

  // 2. Prefix check
  const hasAllowedPrefix = ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
  if (!hasAllowedPrefix) {
    throw new Error(
      `Metric name '${name}' must begin with 'inversearena_' or an approved subsystem prefix (${ALLOWED_PREFIXES.join(
        ", ",
      )})`,
    );
  }

  // 3. Unit / Suffix convention check
  if (type === "counter" && !name.endsWith("_total")) {
    throw new Error(`Counter metric '${name}' must end with '_total'`);
  }
  if (type === "histogram") {
    const validHistogramSuffixes = ["_seconds", "_ms", "_ledgers", "_bucket", "_bytes"];
    const hasValidSuffix = validHistogramSuffixes.some((s) => name.endsWith(s)) || name.includes("per_request");
    if (!hasValidSuffix) {
      throw new Error(
        `Histogram metric '${name}' should specify units in its suffix (e.g. '_seconds', '_ms', '_ledgers')`,
      );
    }
  }

  // 4. Label name allowlist and convention check
  for (const label of labelNames) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) {
      throw new Error(`Label name '${label}' in metric '${name}' contains invalid characters`);
    }
    if (!ALLOWED_LABEL_NAMES.has(label)) {
      throw new Error(
        `Label name '${label}' in metric '${name}' is not in the approved label allowlist (cardinality guard #1274)`,
      );
    }
  }
}

export function registerMetricMeta(meta: MetricDefinitionMeta): void {
  const existing = registeredMetricDefinitions.get(meta.name);
  if (existing) {
    if (existing.type !== meta.type) {
      throw new Error(
        `Metric '${meta.name}' is already registered with type '${existing.type}', conflicting with '${meta.type}'`,
      );
    }
    return;
  }
  registeredMetricDefinitions.set(meta.name, meta);
}

export interface MetricFactoryOptions<T extends string = string> {
  domain: string;
  skipConventionCheck?: boolean;
}

export function createCounter<T extends string = string>(
  config: CounterConfiguration<T>,
  options: MetricFactoryOptions<T> = { domain: "general" },
): Counter<T> {
  if (!options.skipConventionCheck) {
    validateMetricConventions(config.name, "counter", (config.labelNames as string[]) ?? []);
  }

  registerMetricMeta({
    name: config.name,
    type: "counter",
    help: config.help,
    domain: options.domain,
    labelNames: (config.labelNames as string[]) ?? [],
  });

  const existing = register.getSingleMetric(config.name);
  if (existing) {
    return existing as Counter<T>;
  }

  return new Counter({
    ...config,
    registers: [register],
  });
}

export function createGauge<T extends string = string>(
  config: GaugeConfiguration<T>,
  options: MetricFactoryOptions<T> = { domain: "general" },
): Gauge<T> {
  if (!options.skipConventionCheck) {
    validateMetricConventions(config.name, "gauge", (config.labelNames as string[]) ?? []);
  }

  registerMetricMeta({
    name: config.name,
    type: "gauge",
    help: config.help,
    domain: options.domain,
    labelNames: (config.labelNames as string[]) ?? [],
  });

  const existing = register.getSingleMetric(config.name);
  if (existing) {
    return existing as Gauge<T>;
  }

  return new Gauge({
    ...config,
    registers: [register],
  });
}

export function createHistogram<T extends string = string>(
  config: HistogramConfiguration<T>,
  options: MetricFactoryOptions<T> = { domain: "general" },
): Histogram<T> {
  if (!options.skipConventionCheck) {
    validateMetricConventions(config.name, "histogram", (config.labelNames as string[]) ?? []);
  }

  registerMetricMeta({
    name: config.name,
    type: "histogram",
    help: config.help,
    domain: options.domain,
    labelNames: (config.labelNames as string[]) ?? [],
  });

  const existing = register.getSingleMetric(config.name);
  if (existing) {
    return existing as Histogram<T>;
  }

  return new Histogram({
    ...config,
    registers: [register],
  });
}

export function getRegisteredMetricDefinitions(): MetricDefinitionMeta[] {
  return Array.from(registeredMetricDefinitions.values());
}

export function resetMetricsRegistry(): void {
  register.clear();
  registeredMetricDefinitions.clear();
}

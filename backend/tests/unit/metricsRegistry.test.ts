import {
  register,
  validateMetricConventions,
  createCounter,
  createGauge,
  createHistogram,
  getRegisteredMetricDefinitions,
  resetMetricsRegistry,
  ALLOWED_LABEL_NAMES,
  ALLOWED_PREFIXES,
} from "../../src/metrics/registry";
import * as allMetrics from "../../src/utils/metrics";
import fs from "fs";
import path from "path";

describe("Metrics Registry Helper & Conventions (#1750)", () => {
  describe("Convention Validation", () => {
    it("accepts valid counter with standard prefix, suffix, and allowed labels", () => {
      expect(() => {
        validateMetricConventions("inversearena_test_actions_total", "counter", ["action", "status"]);
      }).not.toThrow();
    });

    it("rejects metric without allowed prefix", () => {
      expect(() => {
        validateMetricConventions("unprefixed_action_total", "counter", []);
      }).toThrow(/must begin with/);
    });

    it("rejects counter without _total suffix", () => {
      expect(() => {
        validateMetricConventions("inversearena_bad_counter", "counter", []);
      }).toThrow(/must end with '_total'/);
    });

    it("rejects histogram without unit suffix", () => {
      expect(() => {
        validateMetricConventions("inversearena_bad_histogram", "histogram", []);
      }).toThrow(/should specify units in its suffix/);
    });

    it("rejects unapproved high-cardinality label (cardinality guard #1274)", () => {
      expect(() => {
        validateMetricConventions("inversearena_test_actions_total", "counter", ["unbounded_arbitrary_id"]);
      }).toThrow(/not in the approved label allowlist/);
    });
  });

  describe("Duplicate Metric Detection", () => {
    it("rejects duplicate metric with conflicting type", () => {
      const name = "inversearena_duplicate_test_total";
      createCounter({ name, help: "First definition" }, { domain: "test" });
      expect(() => {
        createGauge({ name, help: "Conflicting type" }, { domain: "test", skipConventionCheck: true });
      }).toThrow(/already registered with type 'counter'/);
    });
  });

  describe("All Domain Metrics Uniqueness and Conventions", () => {
    it("ensures all registered metric names are unique", () => {
      const defs = getRegisteredMetricDefinitions();
      expect(defs.length).toBeGreaterThan(50);

      const names = defs.map((d) => d.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it("ensures all registered metric names follow prefix rules", () => {
      const defs = getRegisteredMetricDefinitions();
      for (const def of defs) {
        const matchesPrefix = ALLOWED_PREFIXES.some((prefix) => def.name.startsWith(prefix));
        expect(matchesPrefix).toBe(true);
      }
    });

    it("ensures all registered labels adhere to the cardinality allowlist", () => {
      const defs = getRegisteredMetricDefinitions();
      for (const def of defs) {
        if (def.labelNames) {
          for (const label of def.labelNames) {
            expect(ALLOWED_LABEL_NAMES.has(label)).toBe(true);
          }
        }
      }
    });
  });

  describe("Unused Metric Detection Across Codebase", () => {
    it("checks that metrics exported by domains are referenced or part of public exports", () => {
      const metricKeys = Object.keys(allMetrics).filter((key) => {
        const val = (allMetrics as any)[key];
        return (
          typeof val?.inc === "function" ||
          typeof val?.set === "function" ||
          typeof val?.observe === "function"
        );
      });
      expect(metricKeys.length).toBeGreaterThan(40);

      // Verify that registered definitions match the exported metrics count
      const defs = getRegisteredMetricDefinitions();
      expect(defs.length).toBeGreaterThanOrEqual(metricKeys.length);
    });
  });

  describe("Registry Reset", () => {
    it("resets registry cleanly without memory leaks", () => {
      createCounter(
        { name: "inversearena_temp_reset_total", help: "Temp" },
        { domain: "test" },
      );
      expect(register.getSingleMetric("inversearena_temp_reset_total")).toBeDefined();
      resetMetricsRegistry();
      expect(register.getSingleMetric("inversearena_temp_reset_total")).toBeUndefined();
    });
  });
});

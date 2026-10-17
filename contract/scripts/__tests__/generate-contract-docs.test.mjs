import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractContractErrors,
  extractContractEvents,
  extractContractApi,
  generateErrorsMarkdown,
  generateEventsMarkdown,
  generateContractsMarkdown,
  collectAllContractsData,
  run,
} from "../generate-contract-docs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_ROOT = path.resolve(__dirname, "../..");

describe("generate-contract-docs", () => {
  describe("extractContractErrors", () => {
    it("extracts ArenaError variants, codes, and doc comments", () => {
      const arenaDir = path.join(CONTRACT_ROOT, "arena");
      const { enumName, variants } = extractContractErrors(arenaDir);

      assert.equal(enumName, "ArenaError");
      assert.ok(variants.length >= 40, `Expected at least 40 ArenaError variants, got ${variants.length}`);

      const unauth = variants.find((v) => v.name === "Unauthorized");
      assert.ok(unauth);
      assert.equal(unauth.code, 1);
      assert.ok(unauth.description.includes("authorized"));

      const stale = variants.find((v) => v.name === "StaleOracleData");
      assert.ok(stale);
      assert.equal(stale.code, 40);
      assert.ok(stale.description.includes("oracle"));
    });

    it("extracts FactoryError variants and codes", () => {
      const factoryDir = path.join(CONTRACT_ROOT, "factory");
      const { enumName, variants } = extractContractErrors(factoryDir);

      assert.equal(enumName, "FactoryError");
      assert.ok(variants.length >= 20);

      const notInit = variants.find((v) => v.name === "NotInitialized");
      assert.ok(notInit);
      assert.equal(notInit.code, 1);
    });

    it("extracts StakingError variants and codes", () => {
      const stakingDir = path.join(CONTRACT_ROOT, "staking");
      const { enumName, variants } = extractContractErrors(stakingDir);

      assert.equal(enumName, "StakingError");
      assert.ok(variants.length >= 10);
    });

    it("extracts PayoutError variants and codes", () => {
      const payoutDir = path.join(CONTRACT_ROOT, "payout");
      const { enumName, variants } = extractContractErrors(payoutDir);

      assert.equal(enumName, "PayoutError");
      assert.ok(variants.length >= 12);
    });

    it("extracts OracleError and RwaError", () => {
      const oracleDir = path.join(CONTRACT_ROOT, "oracle");
      const { enumName: oName, variants: oVariants } = extractContractErrors(oracleDir);
      assert.equal(oName, "OracleError");
      assert.ok(oVariants.length >= 4);

      const rwaDir = path.join(CONTRACT_ROOT, "rwa-adapter");
      const { enumName: rName, variants: rVariants } = extractContractErrors(rwaDir);
      assert.equal(rName, "RwaError");
      assert.ok(rVariants.length >= 10);
    });
  });

  describe("extractContractEvents", () => {
    it("extracts Arena contract events from events.rs", () => {
      const arenaDir = path.join(CONTRACT_ROOT, "arena");
      const events = extractContractEvents(arenaDir);

      assert.ok(events.length >= 25, `Expected >= 25 arena events, got ${events.length}`);
      const joinEv = events.find((e) => e.topics.includes("join"));
      assert.ok(joinEv, "Expected join event");
      assert.ok(joinEv.emittingFn.includes("player_joined"));
    });

    it("extracts Factory contract events from publish calls", () => {
      const factoryDir = path.join(CONTRACT_ROOT, "factory");
      const events = extractContractEvents(factoryDir);

      assert.ok(events.length >= 15);
      const poolCre = events.find((e) => e.topics.includes("POOL_CRE"));
      assert.ok(poolCre, "Expected POOL_CRE event");
    });

    it("extracts Staking and Payout contract events", () => {
      const stakingDir = path.join(CONTRACT_ROOT, "staking");
      const stakingEvents = extractContractEvents(stakingDir);
      assert.ok(stakingEvents.length >= 8);

      const payoutDir = path.join(CONTRACT_ROOT, "payout");
      const payoutEvents = extractContractEvents(payoutDir);
      assert.ok(payoutEvents.length >= 4);
    });
  });

  describe("Markdown rendering and CLI drift checks", () => {
    it("generates markdown strings containing essential tables", () => {
      const data = collectAllContractsData(CONTRACT_ROOT);

      const errorsMd = generateErrorsMarkdown(data);
      assert.ok(errorsMd.includes("# Inverse Arena — contract error registry & client handling"));
      assert.ok(errorsMd.includes("Arena Contract"));
      assert.ok(errorsMd.includes("Factory Contract"));
      assert.ok(errorsMd.includes("Staking Contract"));
      assert.ok(errorsMd.includes("`Unauthorized`"));
      assert.ok(errorsMd.includes("`StaleOracleData`"));

      const eventsMd = generateEventsMarkdown(data);
      assert.ok(eventsMd.includes("# Contract Event Reference"));
      assert.ok(eventsMd.includes("Arena Contract"));
      assert.ok(eventsMd.includes("Factory Contract"));
      assert.ok(eventsMd.includes("`join`"));

      const contractsMd = generateContractsMarkdown(data);
      assert.ok(contractsMd.includes("# Smart Contracts API Documentation"));
      assert.ok(contractsMd.includes("## Arena"));
    });

    it("passes CLI drift check on generated files", () => {
      const exitCode = run(["--check"]);
      assert.equal(exitCode, 0, "Expected --check to pass with exit code 0");
    });

    it("prints help message with --help", () => {
      const exitCode = run(["--help"]);
      assert.equal(exitCode, 0);
    });
  });
});

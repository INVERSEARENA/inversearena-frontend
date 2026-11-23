/**
 * Local-stack seed coverage (#1647).
 *
 * Asserts the seed script declares every arena lifecycle state the acceptance
 * criteria require, and that the Makefile exposes the one-command entry points.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");

describe("dev stack seed (#1647)", () => {
  const seedSource = readFileSync(join(ROOT, "scripts", "seed-arenas.ts"), "utf8");
  const makefile = readFileSync(join(ROOT, "Makefile"), "utf8");
  const compose = readFileSync(join(ROOT, "docker-compose.dev.yml"), "utf8");

  it("seeds open, active, finished, and cancelled arenas", () => {
    for (const state of ["Open", "InProgress", "Finished", "Cancelled"]) {
      expect(seedSource).toContain(`"${state}"`);
    }
  });

  it("creates funded test accounts", () => {
    expect(seedSource).toContain("player-1");
    expect(seedSource).toContain("admin");
    expect(seedSource).toContain("TEST_ACCOUNTS");
  });

  it("writes a seed state file so dev-reset can clean up", () => {
    expect(seedSource).toContain(".seed-state.json");
    expect(seedSource).toContain("--reset");
  });

  it("Makefile exposes dev, dev-reset, and dev-seed", () => {
    expect(makefile).toMatch(/^dev:/m);
    expect(makefile).toMatch(/^dev-reset:/m);
    expect(makefile).toMatch(/^dev-seed:/m);
    expect(makefile).toContain("scripts/dev-stack.sh up");
    expect(makefile).toContain("scripts/dev-stack.sh reset");
  });

  it("compose file brings up quickstart, postgres, redis, and mongo", () => {
    for (const service of ["quickstart", "postgres", "redis", "mongo"]) {
      expect(compose).toContain(`${service}:`);
    }
    expect(compose).toContain("stellar/quickstart");
  });

  it("dev-stack.sh writes a deployment manifest consumed by both apps", () => {
    const stack = readFileSync(join(ROOT, "scripts", "dev-stack.sh"), "utf8");
    expect(stack).toContain("deployment-manifest.json");
    expect(stack).toContain("backend/.env");
    expect(stack).toContain("frontend/.env.local");
    expect(stack).toContain("seed-arenas.ts");
  });
});

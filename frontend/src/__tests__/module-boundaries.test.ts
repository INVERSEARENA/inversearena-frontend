/**
 * @jest-environment node
 *
 * Module boundary rules (#1598, ARCHITECTURE.md §8), checked against the real
 * ESLint config. ESLint loads its flat config with a native dynamic import,
 * which Jest's module runtime cannot host, so the cases run in one child
 * Node process.
 */
import { execFileSync } from "node:child_process";

interface BoundaryCase {
  file: string;
  source: string;
}

const CASES: Record<string, BoundaryCase> = {
  crossFeatureInternal: {
    file: "src/features/staking/probe.ts",
    source: 'import { useWallet } from "@/features/wallet/hooks/useWallet";',
  },
  crossFeatureIndex: {
    file: "src/features/staking/probe.ts",
    source: 'import { useWallet } from "@/features/wallet";',
  },
  ownInternal: {
    file: "src/features/wallet/probe.ts",
    source: 'import { useWallet } from "@/features/wallet/hooks/useWallet";',
  },
  sharedToFeature: {
    file: "src/shared/lib/probe.ts",
    source: 'import { useWallet } from "@/features/wallet";',
  },
  productionToTestDouble: {
    file: "src/components/probe.ts",
    source: 'import * as fixtures from "@/test/mockLeaderboard";',
  },
  testToTestDouble: {
    file: "src/components/__tests__/probe.test.ts",
    source: 'import * as fixtures from "@/test/mockLeaderboard";',
  },
};

function restrictedPathViolations(): Record<string, number> {
  const script = `
    import { ESLint } from "eslint";
    const cases = JSON.parse(process.env.BOUNDARY_CASES);
    const eslint = new ESLint();
    const out = {};
    for (const [name, { file, source }] of Object.entries(cases)) {
      const [result] = await eslint.lintText(source + "\\nexport {};\\n", { filePath: file });
      out[name] = result.messages.filter((m) => m.ruleId === "import/no-restricted-paths").length;
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, BOUNDARY_CASES: JSON.stringify(CASES) },
    encoding: "utf8",
  });
  return JSON.parse(output) as Record<string, number>;
}

describe("module boundaries", () => {
  it("enforces feature, shared and test-double import rules", () => {
    expect(restrictedPathViolations()).toEqual({
      crossFeatureInternal: 1,
      crossFeatureIndex: 0,
      ownInternal: 0,
      sharedToFeature: 1,
      productionToTestDouble: 1,
      testToTestDouble: 0,
    });
  }, 120_000);
});

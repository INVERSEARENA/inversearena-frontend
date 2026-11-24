import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const PINS = {
  node: "20.20.2",
  npm: "10.9.9",
  pnpm: "10.11.1",
  rust: "1.96.0",
  rustCi: "1.96.0",
  rustNightly: "nightly-2026-10-01",
  stellarCli: "22.6.0",
  preCommit: "4.7.0",
};

test("pinned toolchain files exist and match", () => {
  assert.equal(read(".node-version").trim(), PINS.node);
  const rust = read("rust-toolchain.toml");
  assert.match(rust, /channel = "1.96.0"/);
  assert.match(rust, /"wasm32-unknown-unknown"/);
  assert.match(rust, /"wasm32v1-none"/);
  const contractRust = read("contract/rust-toolchain.toml");
  assert.match(contractRust, /channel = "1.96.0"/);
});

test("devcontainer config is parseable and pinned", () => {
  const dc = JSON.parse(read(".devcontainer/devcontainer.json"));
  assert.equal(dc.build.args.NODE_VERSION, PINS.node);
  assert.equal(dc.build.args.NPM_VERSION, PINS.npm);
  assert.equal(dc.build.args.PNPM_VERSION, PINS.pnpm);
  assert.equal(dc.build.args.RUST_VERSION, PINS.rust);
  assert.equal(dc.build.args.RUST_CI_VERSION, PINS.rustCi);
  assert.equal(dc.build.args.RUST_NIGHTLY_VERSION, PINS.rustNightly);
  assert.equal(dc.build.args.STELLAR_CLI_VERSION, PINS.stellarCli);
  assert.equal(dc.build.args.PRE_COMMIT_VERSION, PINS.preCommit);
  assert.deepEqual(dc.forwardPorts, [3000, 3001, 4000, 5433, 6380, 8000, 27018]);
  assert.ok(dc.postCreateCommand.includes("post-create.sh"));
  assert.ok(dc.features["ghcr.io/devcontainers/features/docker-in-docker:2"]);

  const dockerfile = read(".devcontainer/Dockerfile");
  for (const [k, v] of Object.entries({
    NODE_VERSION: PINS.node,
    NPM_VERSION: PINS.npm,
    PNPM_VERSION: PINS.pnpm,
    RUST_VERSION: PINS.rust,
    RUST_CI_VERSION: PINS.rustCi,
    RUST_NIGHTLY_VERSION: PINS.rustNightly,
    STELLAR_CLI_VERSION: PINS.stellarCli,
    PRE_COMMIT_VERSION: PINS.preCommit,
  })) {
    assert.match(dockerfile, new RegExp(`ARG ${k}=${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.match(dockerfile, /STELLAR_CLI_SHA256_X86_64=00936c190cb8be4adc1251c758656fff697d7f60e967ed3a782c9d981d0def20/);
  assert.match(dockerfile, /STELLAR_CLI_SHA256_AARCH64=ae07920d46363724e3af27570b41884dacf4e2c73d6184ec816766e3da31179d/);
});

test("docker compose services and ports are present", () => {
  const compose = read("docker-compose.dev.yml");
  for (const svc of ["quickstart:", "postgres:", "redis:", "mongo:"]) {
    assert.ok(compose.includes(svc), `missing service ${svc}`);
  }
  for (const port of ['"3000"', '"3001"', '"4000"', '"5433"', '"6380"', '"8000"', '"27018"']) {
    // ports are in devcontainer; compose has infra ports
  }
  assert.match(compose, /5433:5432/);
  assert.match(compose, /6380:6379/);
  assert.match(compose, /8000:8000/);
  assert.match(compose, /27018:27017/);
});

test("Makefile has required targets and dev wiring", () => {
  const makefile = read("Makefile");
  for (const target of ["check-toolchain", "check-fast", "dev-doctor", "pr-triage-test"]) {
    assert.match(makefile, new RegExp(`^${target}:`, "m"), `missing target ${target}`);
  }
  assert.match(makefile, /dev:.*\n\tbash scripts\/dev-stack\.sh up/);
});

test("package manager and engines pins", () => {
  const rootPkg = JSON.parse(read("package.json"));
  assert.equal(rootPkg.packageManager, `pnpm@${PINS.pnpm}`);
  assert.equal(rootPkg.engines?.node, PINS.node);
  assert.equal(rootPkg.private, true);
  assert.equal(rootPkg.dependencies, undefined);
  assert.equal(rootPkg.devDependencies, undefined);

  const ws = read("pnpm-workspace.yaml");
  for (const pkg of ["frontend", "backend", "packages/*", "tools/*", "scripts", "docs-portal"]) {
    assert.match(ws, new RegExp(`- ${pkg.replace(/[/*]/g, "\\$&")}`), `workspace includes ${pkg}`);
  }
  assert.match(ws, /onlyBuiltDependencies:/);

  const frontend = JSON.parse(read("frontend/package.json"));
  const backend = JSON.parse(read("backend/package.json"));
  assert.equal(frontend.packageManager, `pnpm@${PINS.pnpm}`);
  assert.equal(backend.packageManager, undefined);
});

test("dev-stack env and modes are correct", () => {
  const sh = read("scripts/dev-stack.sh");
  assert.match(sh, /MONGODB_URI=/);
  assert.match(sh, /PORT=3001/);
  assert.match(sh, /NEXT_PUBLIC_API_BASE_URL=http:\/\/\$\{DEVSTACK_HOST\}:3001/);
  assert.doesNotMatch(sh, /NEXT_PUBLIC_BACKEND_URL=/);
  assert.match(sh, /npx tsx \.\.\/scripts\/seed-arenas\.ts|tsx \.\.\/scripts\/seed-arenas\.ts/);
  assert.match(sh, /DEVSTACK_HOST="\$\{DEVSTACK_HOST:-localhost\}"/);
  assert.match(sh, /--check|check\)/);
  assert.match(sh, /--print-env|print-env\)/);
  assert.match(sh, /22\.6\.0/);
  assert.match(sh, /MONGO_URI=\$MONGODB_URI\n/);
});

test("pre-commit config maps to check-fast and toolchain tests", () => {
  const pre = read(".pre-commit-config.yaml");
  assert.match(pre, /rev: v6\.0\.0/);
  for (const mode of ["backend", "frontend", "contract-fmt", "contract", "ops-cli", "deps-gate-self"]) {
    assert.match(pre, new RegExp(`scripts/check-fast\\.sh ${mode}`));
  }
  assert.match(pre, /node --test scripts\/toolchain-config\.test\.mjs/);
});

test("check-fast has required modes", () => {
  const sh = read("scripts/check-fast.sh");
  for (const mode of ["backend", "frontend", "contract-fmt", "contract", "ops-cli", "deps-gate-self", "all"]) {
    assert.match(sh, new RegExp(`${mode}\\)`));
  }
});

test("dev-stack check mode validates without starting services", () => {
  const result = spawnSync("bash", ["scripts/dev-stack.sh", "--check"], {
    cwd: ROOT,
    env: { ...process.env, DEVSTACK_HOST: "localhost" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout + result.stderr, /check|ok|valid/i);
});

test("toolchain docs mention pinned versions", () => {
  const readme = read("README.md");
  const contributing = read("CONTRIBUTING.md");
  assert.match(readme, /20\.20\.2/);
  assert.match(readme, /1\.96\.0/);
  assert.match(contributing, /check-fast|check-toolchain|dev-doctor/);
});

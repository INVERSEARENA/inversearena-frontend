#!/usr/bin/env node
/**
 * Lint: `process.env` may only be read in src/config/env.ts (#1650).
 *
 * Everything else uses `env.NAME` (typed, declared in the schema) or
 * `processEnv` (for injectable-env config helpers), so every variable the
 * backend reads is declared, validated at boot and documented in the
 * generated .env.example.
 *
 * Uses the TypeScript parser, so comments and strings that mention
 * process.env are not flagged, while `process.env.X`, `process.env[x]`,
 * `process["env"]` and `const { env } = process` all are. Test files are
 * exempt: tests set variables directly.
 *
 *   npm run lint
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(join(ROOT, "package.json"))("typescript");

const ALLOWED = new Set(["src/config/env.ts"]);
const isTest = (path) => /(^|\/)__tests__\//.test(path) || /\.test\.ts$/.test(path);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.ts$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield path;
  }
}

const isProcess = (node) => ts.isIdentifier(node) && node.text === "process";

/** Every `process.env` access in one source text, as 1-based line/column. */
export function findEnvAccesses(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits = [];
  const report = (node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    hits.push({ line: line + 1, column: character + 1 });
  };
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && isProcess(node.expression) && node.name.text === "env") report(node);
    if (
      ts.isElementAccessExpression(node) &&
      isProcess(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "env"
    ) {
      report(node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isProcess(node.initializer) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some((element) => (element.propertyName ?? element.name).getText(source) === "env")
    ) {
      report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function main() {
  const violations = [];
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const path = relative(ROOT, file).split("\\").join("/");
    if (ALLOWED.has(path) || isTest(path)) continue;
    for (const hit of findEnvAccesses(path, readFileSync(file, "utf8"))) violations.push(`${path}:${hit.line}:${hit.column}`);
  }
  if (violations.length > 0) {
    console.error(
      `process.env is read outside src/config/env.ts (${violations.length}):\n` +
        violations.map((v) => `  ${v}`).join("\n") +
        "\nDeclare the variable in src/config/env.ts and read it with `env.NAME` (or pass `processEnv` to an injectable config helper).",
    );
    return 1;
  }
  console.log("env access: ok");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const portalDir = resolve(dirname(scriptPath), "..");
const repoRoot = resolve(portalDir, "..");
const defaultOutDir = join(portalDir, "data", "contracts");
const skippedCrates = new Set(["cost-bench"]);

export function demoteDocHeadings(doc) {
  return doc
    .split("\n")
    .map((line) => line.replace(/^(#{1,5})\s/, (_, hashes) => `${hashes}### `))
    .join("\n");
}

export function parseRustDocEntries(source, sourcePath) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const entries = [];
  let docs = [];
  let traitDepth = 0;

  const flush = (line, kind, name) => {
    const doc = demoteDocHeadings(
      docs
        .join("\n")
        .split("\n")
        .map((part) => part.replace(/\s+$/, ""))
        .join("\n")
        .replace(/^(?:\n)+|(?:\n)+$/g, "")
        .replace(/\n{3,}/g, "\n\n"),
    );
    if (doc) entries.push({ sourcePath, line, kind, name, doc });
    docs = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const docMatch = line.match(/^\s*\/\/[!/]?\s?(.*)$/);
    if (docMatch && !line.trim().startsWith("// ")) {
      docs.push(docMatch[1]);
      continue;
    }
    if (/^\s*#\[/.test(line) || /^\s*\/\//.test(line)) continue;
    if (/^\s*$/.test(line)) {
      docs = [];
      continue;
    }

    const traitStart = line.match(/^\s*pub trait\s+([A-Za-z0-9_]+)/);
    const impl = line.match(/^\s*(?:pub\s+)?impl(?:<[^>]*>)?\s+([A-Za-z0-9_]+)/);
    const fn = line.match(
      /^\s*(?:pub(?:\([^)]+\)\s+)?\s+)?(?:const\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/,
    );
    const isPublicFn = /^\s*pub(?:\([^)]+\)\s+)?\s+(?:const\s+)?(?:async\s+)?fn\s+/.test(line);

    if (traitStart) {
      flush(index + 1, "pub trait", traitStart[1]);
      traitDepth = 1;
      continue;
    }
    if (impl) {
      flush(index + 1, "impl", impl[1]);
      continue;
    }
    if (fn && (isPublicFn || traitDepth > 0)) {
      flush(index + 1, isPublicFn ? "pub fn" : "fn", fn[1]);
      continue;
    }

    docs = [];

    if (traitDepth > 0) {
      traitDepth += (line.match(/\{/g) ?? []).length;
      traitDepth -= (line.match(/\}/g) ?? []).length;
      if (traitDepth < 0) traitDepth = 0;
    }
  }

  return entries;
}

export function collectContractPages({ rootDir = repoRoot } = {}) {
  const contractDir = join(rootDir, "contract");
  const pages = new Map();

  const crates = readdirSync(contractDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !skippedCrates.has(entry.name))
    .map((entry) => entry.name)
    .filter((crate) => existsSync(join(contractDir, crate, "src")))
    .sort();

  for (const crate of crates) {
    const srcDir = join(contractDir, crate, "src");
    const entries = [];

    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".rs")) continue;

        const sourcePath = relative(rootDir, fullPath).split("\\").join("/");
        const source = readFileSync(fullPath, "utf8");
        entries.push(...parseRustDocEntries(source, sourcePath));
      }
    };

    walk(srcDir);
    entries.sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) || left.line - right.line || left.name.localeCompare(right.name),
    );

    const lines = [`# ${crate} contract API`, "", `Source: \`contract/${crate}/src\``, ""];

    if (entries.length === 0) {
      lines.push("No documented public entries found.", "");
    }

    let currentFile = null;
    for (const entry of entries) {
      if (entry.sourcePath !== currentFile) {
        lines.push(`## \`${entry.sourcePath}\``, "");
        currentFile = entry.sourcePath;
      }
      lines.push(`### ${entry.kind} \`${entry.name}\` — line ${entry.line}`, "", entry.doc, "");
    }

    pages.set(`${crate}.md`, `${lines.join("\n").trimEnd()}\n`);
  }

  const index = [
    "# Contract API reference",
    "",
    "Generated from Rust doc comments in `contract/*/src`. Benchmark crates are excluded.",
    "",
    ...crates.map((crate) => `- [${crate}](./${crate}.md)`),
    "",
  ];
  pages.set("index.md", `${index.join("\n").trimEnd()}\n`);

  return pages;
}

export function compareContractPages(pages, outDir) {
  const problems = [];

  for (const [fileName, content] of pages) {
    const filePath = join(outDir, fileName);
    if (!existsSync(filePath)) {
      problems.push(`missing ${filePath}`);
      continue;
    }
    if (readFileSync(filePath, "utf8") !== content) problems.push(`outdated ${filePath}`);
  }

  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && !pages.has(entry.name)) {
      problems.push(`unexpected ${join(outDir, entry.name)}`);
    }
  }

  return problems;
}

function writePages(pages, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const [fileName, content] of pages) writeFileSync(join(outDir, fileName), content);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const check = process.argv.includes("--check");
  const pages = collectContractPages();

  if (check) {
    const problems = compareContractPages(pages, defaultOutDir);
    if (problems.length > 0) {
      console.error(`Contract docs are out of date:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
      console.error("Run node docs-portal/scripts/generate-contract-docs.mjs and commit the result.");
      process.exitCode = 1;
    } else {
      console.log(`Contract docs match ${pages.size} generated pages.`);
    }
  } else {
    writePages(pages, defaultOutDir);
    console.log(`Wrote ${pages.size} contract docs pages to ${defaultOutDir}`);
  }
}

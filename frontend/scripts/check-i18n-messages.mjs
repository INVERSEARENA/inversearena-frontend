#!/usr/bin/env node
/**
 * i18n message-catalog gate (#1575).
 *
 * Fails (exit 1) when:
 *  1. any locale catalog is missing keys that `en.json` has, or has extra
 *     keys `en.json` lacks — so a new message can never ship translated to
 *     only one language;
 *  2. a message leaf is not a non-empty string;
 *  3. a namespace referenced via useTranslations/getTranslations does not
 *     exist in `en.json`;
 *  4. a fully-qualified dotted key referenced in source (`t("a.b.c")`) does
 *     not resolve in `en.json`.
 *
 * Run: node scripts/check-i18n-messages.mjs   (or `pnpm i18n:check`)
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, "..");
const messagesDir = join(frontendRoot, "src", "i18n", "messages");
const srcDir = join(frontendRoot, "src");
const DEFAULT_LOCALE = "en";

/** @returns {Promise<Map<string, unknown>>} locale → parsed catalog */
async function loadCatalogs() {
  const files = (await readdir(messagesDir)).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error(`no message catalogs found in ${messagesDir}`);
  }
  const catalogs = new Map();
  for (const file of files) {
    const locale = file.replace(/\.json$/, "");
    const raw = await readFile(join(messagesDir, file), "utf8");
    catalogs.set(locale, JSON.parse(raw));
  }
  if (!catalogs.has(DEFAULT_LOCALE)) {
    throw new Error(`default locale catalog ${DEFAULT_LOCALE}.json is missing`);
  }
  return catalogs;
}

/** Flatten nested objects to dotted leaf paths. */
function flatten(obj, prefix = "", out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

async function* walkSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "__mocks__") {
        continue;
      }
      yield* walkSourceFiles(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

async function main() {
  const errors = [];
  const catalogs = await loadCatalogs();
  const base = flatten(catalogs.get(DEFAULT_LOCALE));

  // 1 + 2: parity and leaf types against the default locale.
  for (const [locale, catalog] of catalogs) {
    const flat = flatten(catalog);
    for (const path of base.keys()) {
      if (!flat.has(path)) {
        errors.push(`[${locale}] missing key: ${path}`);
      } else if (typeof flat.get(path) !== "string" || flat.get(path).length === 0) {
        errors.push(`[${locale}] empty or non-string leaf: ${path}`);
      }
    }
    for (const path of flat.keys()) {
      if (!base.has(path)) {
        errors.push(`[${locale}] key not present in ${DEFAULT_LOCALE}: ${path}`);
      }
    }
  }
  for (const [path, value] of base) {
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`[${DEFAULT_LOCALE}] empty or non-string leaf: ${path}`);
    }
  }

  const namespaces = new Set([...base.keys()].map((k) => k.split(".")[0]));
  const usedNamespaces = new Set();
  const keyRefs = [];

  // Namespaces may be nested paths ("landing.nav"), so a namespace resolves
  // when it is a prefix of at least one message key.
  const hasNamespace = (ns) =>
    namespaces.has(ns) ||
    [...base.keys()].some((k) => k.startsWith(`${ns}.`));

  const resolves = (key) =>
    base.has(key) ||
    [...base.keys()].some((k) => k.endsWith(`.${key}`));

  for await (const file of walkSourceFiles(srcDir)) {
    const code = await readFile(file, "utf8");

    // `const t = useTranslations("ns")` / `const t = await getTranslations("ns")`
    // → variable-to-namespace map for this file.
    const bindings = new Map();
    for (const match of code.matchAll(
      /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g,
    )) {
      bindings.set(match[1], match[2]);
      usedNamespaces.add(match[2]);
      if (!hasNamespace(match[2])) {
        errors.push(`[${DEFAULT_LOCALE}] namespace "${match[2]}" used in ${file} but not defined in ${DEFAULT_LOCALE}.json`);
      }
    }

    // t("key") / tCommon("a.b") — resolve against the bound namespace.
    for (const match of code.matchAll(/\b(\w+)\(\s*["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)["']/g)) {
      const [, fn, key] = match;
      const ns = bindings.get(fn);
      if (!ns) continue; // not a translation call in this file
      keyRefs.push({ file, fn, key, ns });
    }
  }

  for (const { file, fn, key, ns } of keyRefs) {
    const qualified = key.includes(".") ? key : `${ns}.${key}`;
    if (!base.has(qualified) && !resolves(key)) {
      errors.push(
        `${fn}("${key}") in ${file} not found in ${DEFAULT_LOCALE}.json (expected "${qualified}")`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(`i18n check failed with ${errors.length} problem(s):\n`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(
    `i18n check passed: ${catalogs.size} locale(s), ${base.size} keys, ${usedNamespaces.size} namespace(s) in use.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

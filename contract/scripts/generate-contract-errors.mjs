#!/usr/bin/env node
/**
 * Generate contract error mappings from the compiled contract specs (#1597).
 *
 * Every `#[contracterror]` enum is embedded in its WASM's `contractspecv0`
 * section as an `SCSpecUdtErrorEnumV0` entry. This script decodes those
 * entries and writes, from that single source of truth:
 *
 *   - frontend/src/shared/lib/stellar/contract-errors.generated.ts — codes keyed
 *     by (contract, code), so arena code 5 and factory code 5 never collide;
 *   - the generated tables in contract/ERRORS.md, between the
 *     BEGIN/END GENERATED CONTRACT ERRORS markers.
 *
 * Usage (build the WASM first: `cargo build --workspace --target wasm32v1-none --release`):
 *   node contract/scripts/generate-contract-errors.mjs          # write outputs
 *   node contract/scripts/generate-contract-errors.mjs --check  # exit 1 on drift
 *
 * The XDR is decoded with the frontend's @stellar/stellar-sdk, so run
 * `pnpm install` in frontend/ first.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WASM_DIR = join(ROOT, "contract", "target", "wasm32v1-none", "release");
const TS_OUT = join(ROOT, "frontend", "src", "shared", "lib", "stellar", "contract-errors.generated.ts");
const DOC_OUT = join(ROOT, "contract", "ERRORS.md");
const BEGIN = "<!-- BEGIN GENERATED CONTRACT ERRORS (contract/scripts/generate-contract-errors.mjs) -->";
const END = "<!-- END GENERATED CONTRACT ERRORS -->";

/** Contract kind (the key clients use) → compiled WASM file name. */
const CONTRACTS = [
  ["arena", "arena.wasm"],
  ["factory", "factory.wasm"],
  ["fee_router", "inverse_fee_router.wasm"],
  ["oracle", "oracle.wasm"],
  ["payout", "payout.wasm"],
  ["rwa_adapter", "rwa_adapter.wasm"],
  ["staking", "staking.wasm"],
];

const { contract, xdr } = createRequire(join(ROOT, "frontend", "package.json"))("@stellar/stellar-sdk");

/** Read the single error enum a contract's spec declares. */
function readErrorEnum(kind, wasmFile) {
  const spec = contract.Spec.fromWasm(readFileSync(join(WASM_DIR, wasmFile)));
  const enums = spec.entries
    .filter((entry) => entry.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtErrorEnumV0().value)
    .map((entry) => entry.value());
  if (enums.length !== 1) {
    throw new Error(`${kind}: expected exactly one #[contracterror] enum, found ${enums.length}`);
  }
  const [errorEnum] = enums;
  const cases = errorEnum
    .cases()
    .map((errorCase) => ({
      code: errorCase.value(),
      name: errorCase.name().toString(),
      doc: errorCase.doc().toString(),
    }))
    .sort((a, b) => a.code - b.code);
  for (let i = 1; i < cases.length; i += 1) {
    if (cases[i].code === cases[i - 1].code) {
      throw new Error(`${kind}: duplicate error code ${cases[i].code}`);
    }
  }
  return { kind, enumName: errorEnum.name().toString(), cases };
}

function renderTs(enums) {
  const body = enums
    .map(({ kind, enumName, cases }) => {
      const codes = cases.map(({ code, name }) => `      ${code}: "${name}",`).join("\n");
      return `  ${kind}: {\n    enumName: "${enumName}",\n    codes: {\n${codes}\n    },\n  },`;
    })
    .join("\n");
  return `/**
 * Contract error codes generated from the compiled contract specs (#1597).
 *
 * DO NOT EDIT. Regenerate with \`node contract/scripts/generate-contract-errors.mjs\`
 * after building the contracts; Contract CI fails when this file drifts from
 * the WASM. Codes are only unique per contract, so always look one up by
 * (contract, code).
 */
export const CONTRACT_ERRORS = {
${body}
} as const;

export type ContractKind = keyof typeof CONTRACT_ERRORS;

/** Variant names of one contract's error enum. */
export type ContractErrorName<K extends ContractKind> = Extract<
  (typeof CONTRACT_ERRORS)[K]["codes"][keyof (typeof CONTRACT_ERRORS)[K]["codes"]],
  string
>;
`;
}

/** First paragraph of a doc comment, flattened to one Markdown table cell. */
function docCell(doc) {
  const paragraph = doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  return paragraph ? paragraph.replace(/\|/g, "\\|") : "—";
}

function renderDocSection(enums) {
  const tables = enums.map(({ kind, enumName, cases }) => {
    const rows = cases.map(({ code, name, doc }) => `| ${code} | \`${name}\` | ${docCell(doc)} |`);
    return [`### \`${kind}\` — \`${enumName}\``, "", "| Code | Variant | Meaning |", "| --- | --- | --- |", ...rows].join("\n");
  });
  return [BEGIN, "", ...tables.flatMap((table) => [table, ""]), END].join("\n");
}

function replaceGeneratedSection(markdown, section) {
  const start = markdown.indexOf(BEGIN);
  const end = markdown.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${relative(ROOT, DOC_OUT)} is missing the generated-section markers`);
  }
  return markdown.slice(0, start) + section + markdown.slice(end + END.length);
}

/** Compare ignoring CRLF, so a Windows checkout does not report false drift. */
const normalize = (text) => text.replace(/\r\n/g, "\n");

function main() {
  const check = process.argv.includes("--check");
  const enums = CONTRACTS.map(([kind, wasm]) => readErrorEnum(kind, wasm));
  const outputs = [
    [TS_OUT, renderTs(enums)],
    [DOC_OUT, replaceGeneratedSection(normalize(readFileSync(DOC_OUT, "utf8")), renderDocSection(enums))],
  ];

  let drift = false;
  for (const [path, content] of outputs) {
    let current = "";
    try {
      current = normalize(readFileSync(path, "utf8"));
    } catch {
      // A missing file is drift in --check mode and is created otherwise.
    }
    if (current === content) continue;
    if (check) {
      drift = true;
      console.error(`Drift: ${relative(ROOT, path)} does not match the contract specs.`);
    } else {
      writeFileSync(path, content);
      console.log(`Wrote ${relative(ROOT, path)}`);
    }
  }
  if (drift) {
    console.error("Run `node contract/scripts/generate-contract-errors.mjs` and commit the result.");
    process.exit(1);
  }
  if (check) console.log("Contract error mappings match the contract specs.");
}

main();

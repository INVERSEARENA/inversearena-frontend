#!/usr/bin/env node

/**
 * generate-contract-docs.mjs
 *
 * Unified documentation generator for Inverse Arena Soroban smart contracts.
 * Extracts contract error codes, event topics/payloads, and public APIs directly
 * from Rust source code and doc comments, producing:
 *   - contract/ERRORS.md
 *   - contract/EVENTS.md
 *   - contract/CONTRACTS.md
 *
 * Supports CI drift checking via the `--check` flag.
 *
 * Usage:
 *   node contract/scripts/generate-contract-docs.mjs           # Regenerate docs
 *   node contract/scripts/generate-contract-docs.mjs --check   # Verify docs match (fails CI on diff)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root contract directory: <repo_root>/contract
const CONTRACT_ROOT = path.resolve(__dirname, "..");

const KNOWN_CONTRACTS = [
  { id: "arena", name: "Arena Contract", crate: "contract/arena" },
  { id: "factory", name: "Factory Contract", crate: "contract/factory" },
  { id: "staking", name: "Staking Contract", crate: "contract/staking" },
  { id: "payout", name: "Payout Contract", crate: "contract/payout" },
  { id: "rwa-adapter", name: "RWA Adapter Contract", crate: "contract/rwa-adapter" },
  { id: "oracle", name: "Oracle Contract", crate: "contract/oracle" },
];

// Fallback user messages mapping for well-known contract panic codes
const KNOWN_USER_MESSAGES = {
  arena: {
    1: "You do not have permission to perform this action.",
    2: "Cannot cancel a game that has already started.",
    3: "This arena has not been initialized yet.",
    4: "This action cannot be done in the current round state.",
    5: "The round has not started yet.",
    6: "The grace period for this round has not elapsed yet.",
    7: "Your revealed choice and salt do not match your commitment.",
    8: "You have not submitted a commitment for this round.",
    9: "You have already revealed your choice for this round.",
    10: "This arena has already been initialized.",
    11: "The game is not finished yet.",
    12: "You have already claimed your prize.",
    13: "You have been eliminated from this arena.",
    14: "There is no pending admin transfer to accept.",
    15: "The vault address provided is invalid.",
    16: "The contract is paused. State-changing actions are temporarily disabled.",
    17: "This action cannot be performed in the current arena state.",
    18: "This arena has not been initialized yet.",
    19: "Not enough players to start a round. At least 2 active players are required.",
    20: "You have been banned from joining arenas.",
    21: "You cannot join your own arena.",
    22: "This arena is full. No more players can join.",
    23: "Invalid player limits configured.",
    24: "A reentrant call was detected. Please wait for the current operation to finish.",
    25: "You have already claimed your refund.",
    26: "You can only claim a refund when the arena has been cancelled.",
    27: "You are not registered as a player in this arena.",
    28: "The required deadline has not passed yet. Please wait.",
    29: "You have already joined this arena.",
    30: "The upgrade timelock has not elapsed yet. Please wait.",
    31: "No pending upgrade was found. Propose an upgrade first.",
    32: "The entry fee must be greater than zero.",
    33: "The commitment phase has ended. You can no longer submit choices for this round.",
    34: "Invalid round duration. Please check the duration parameter.",
    35: "Vault deposit failed. The token transfer has been rolled back.",
    36: "Platform fee exceeds maximum configured threshold.",
    37: "Arena has already started; new participants cannot join.",
    38: "Leaderboard limit must be between 1 and 100.",
    39: "Freshness policy warning age cannot exceed maximum age.",
    40: "Oracle observation is stale. Retry when oracle publishes a fresh observation.",
  },
  factory: {
    1: "Factory has not been initialized yet.",
    2: "Factory is already initialized.",
    3: "You do not have permission to perform this action.",
    4: "Invalid stake amount.",
    5: "Insufficient creator stake provided.",
    6: "Target arena was not found.",
    7: "Stake amount is below configured minimum threshold.",
    8: "Host is not on the factory whitelist.",
    9: "Arena WASM hash has not been configured.",
    10: "Factory pool limit reached.",
    11: "Invalid vault address provided.",
    12: "Invalid oracle address provided.",
    13: "Maximum active pools limit reached.",
    14: "Pool could not be found.",
    15: "Factory is currently paused.",
    16: "Token is not supported for pool creation.",
    17: "Entry fee is below minimum required threshold.",
    18: "Invalid arena configuration provided.",
    19: "No pending admin proposal exists.",
    20: "Stake scaling arithmetic overflowed.",
    100: "Stake amount does not meet the rules for creating a pool.",
    101: "This token is not supported for pool creation.",
  },
  staking: {
    1: "Staking is not available yet.",
    2: "Staking is already set up.",
    3: "Staking is temporarily unavailable.",
    4: "Enter an amount greater than zero.",
    5: "You do not have that many shares to unstake.",
    6: "This deposit is too small for the current pool value. Stake more.",
    7: "The first deposit must be at least the minimum initial stake.",
    8: "No shares outstanding in the staking pool.",
    9: "No pending admin transfer has been proposed.",
    10: "Staking arithmetic calculation overflowed.",
  },
  payout: {
    1: "Payout contract is not initialized.",
    2: "Payout contract is already initialized.",
    3: "You do not have permission to execute payouts.",
    4: "A payout with this identifier has already been executed.",
    5: "Payout amount is invalid.",
    6: "Batch payout contains no recipients.",
    8: "Contract balance is insufficient for this payout.",
    9: "Batch contains duplicate recipient addresses.",
    10: "Batch recipient count exceeds maximum allowable limit.",
    11: "No pending admin transfer has been proposed.",
    12: "Payout recipient does not match pre-registered destination address.",
    13: "No destination has been registered for this payout id.",
  },
  oracle: {
    1: "Oracle is not initialized.",
    2: "Oracle is already initialized.",
    3: "Yield rate exceeds configured maximum basis points.",
    4: "No pending admin transfer has been proposed.",
  },
  "rwa-adapter": {
    1: "RWA Adapter is not initialized.",
    2: "RWA Adapter is already initialized.",
    3: "No active deposit found for caller.",
    4: "Caller is not authorized.",
    5: "Deposit has already been withdrawn.",
    6: "Insufficient vault balance.",
    7: "Yield rate calculation overflowed.",
    8: "Invalid amount provided.",
    9: "No pending admin transfer has been proposed.",
    10: "Caller is not an admin.",
  },
};

/**
 * Extracts error enum variants, codes, and doc comments from a contract.
 */
export function extractContractErrors(contractDir) {
  let typesPath = path.join(contractDir, "src", "types.rs");
  if (!fs.existsSync(typesPath)) {
    typesPath = path.join(contractDir, "src", "lib.rs");
  }
  if (!fs.existsSync(typesPath)) {
    return { enumName: "", variants: [] };
  }

  const src = fs.readFileSync(typesPath, "utf8");
  const enumMatch = src.match(/pub enum (\w+Error)\s*\{([\s\S]*?)\n\}/);
  if (!enumMatch) {
    return { enumName: "", variants: [] };
  }

  const enumName = enumMatch[1];
  const body = enumMatch[2];
  const lines = body.split("\n");
  const variants = [];
  let currentDocs = [];
  let nextCode = 1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("///")) {
      currentDocs.push(trimmed.replace(/^\/\/\/\s*/, ""));
    } else if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("#")) {
      const vMatch = trimmed.match(/^(\w+)(?:\s*=\s*(\d+))?,?/);
      if (vMatch) {
        const name = vMatch[1];
        const code = vMatch[2] ? parseInt(vMatch[2], 10) : nextCode;
        nextCode = code + 1;
        const description = currentDocs.join(" ").trim();
        variants.push({
          name,
          code,
          description: description || name,
        });
        currentDocs = [];
      }
    }
  }

  return { enumName, variants };
}

/**
 * Extracts balanced parenthesis arguments from `publish(...)`.
 */
function extractPublishCalls(content) {
  const results = [];
  const publishRegex = /env\.events\(\)\s*\.publish\s*\(/g;
  let match;
  while ((match = publishRegex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    let depth = 1;
    let inString = false;
    let stringChar = "";
    let arg1 = "";
    let arg2 = "";
    let currentArg = 1;

    for (let i = startIdx; i < content.length; i++) {
      const char = content[i];
      if (inString) {
        if (char === stringChar && content[i - 1] !== "\\") {
          inString = false;
        }
      } else {
        if (char === '"' || char === "'") {
          inString = true;
          stringChar = char;
        } else if (char === "(" || char === "[" || char === "{") {
          depth++;
        } else if (char === ")" || char === "]" || char === "}") {
          depth--;
          if (depth === 0) break;
        } else if (char === "," && depth === 1) {
          currentArg = 2;
          continue;
        }
      }

      if (currentArg === 1) {
        arg1 += char;
      } else {
        arg2 += char;
      }
    }

    results.push({
      rawTopics: arg1.replace(/\s+/g, " ").trim(),
      rawData: arg2.replace(/\s+/g, " ").trim(),
      index: match.index,
    });
  }
  return results;
}

/**
 * Formats raw Rust topic expression into a clean markdown symbol or topic list.
 */
function formatTopics(rawTopics) {
  let cleaned = rawTopics;
  // Unwrap outer tuple if present
  if (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (cleaned.endsWith(",")) {
    cleaned = cleaned.slice(0, -1).trim();
  }

  // Parse items
  const items = cleaned.split(",").map((s) => s.trim()).filter(Boolean);
  const formatted = items.map((item) => {
    // symbol_short!("FOO")
    const shortMatch = item.match(/symbol_short!\("([^"]+)"\)/);
    if (shortMatch) {
      return `\`${shortMatch[1]}\``;
    }
    // Symbol::new(env, "FOO")
    const newMatch = item.match(/Symbol::new\([^,]+,\s*"([^"]+)"\)/);
    if (newMatch) {
      return `\`${newMatch[1]}\``;
    }
    // Variable / argument
    const varClean = item.replace(/\.clone\(\)/g, "");
    return `\`${varClean}\``;
  });

  return formatted.join(", ");
}

/**
 * Formats raw Rust data payload expression into readable field signatures.
 */
function formatDataPayload(rawData) {
  let cleaned = rawData.replace(/\.clone\(\)/g, "");
  if (cleaned === "()") return "`()`";
  if (!cleaned.startsWith("(") && !cleaned.endsWith(")")) {
    return `\`(${cleaned})\``;
  }
  return `\`${cleaned}\``;
}

/**
 * Extracts event definitions from a contract's source files.
 */
export function extractContractEvents(contractDir) {
  const events = [];
  const srcDir = path.join(contractDir, "src");
  if (!fs.existsSync(srcDir)) return events;

  // 1. Check if dedicated events.rs exists (e.g. in Arena)
  const eventsRsPath = path.join(srcDir, "events.rs");
  if (fs.existsSync(eventsRsPath)) {
    const content = fs.readFileSync(eventsRsPath, "utf8");
    const fnRegex =
      /((?:[ \t]*\/\/\/[^\n]*\n)*)[ \t]*pub fn\s+(\w+)\s*\((.*?)\)\s*\{([\s\S]*?)\}/g;
    let match;
    while ((match = fnRegex.exec(content)) !== null) {
      const docComments = match[1]
        .split("\n")
        .map((l) => l.trim().replace(/^\/\/\/\s*/, ""))
        .filter(Boolean)
        .join(" ");
      const fnName = match[2];
      const fnArgs = match[3];
      const fnBody = match[4];

      const publishCalls = extractPublishCalls(fnBody);
      for (const call of publishCalls) {
        events.push({
          emittingFn: `ArenaEvents::${fnName}()`,
          topics: formatTopics(call.rawTopics),
          data: formatDataPayload(call.rawData),
          description: docComments || `Emitted when ${fnName.replace(/_/g, " ")} occurs.`,
        });
      }
    }
    return events;
  }

  // 2. Scan all .rs files in src/ for publish calls
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".rs") && !f.includes("test"));
  for (const f of files) {
    const filePath = path.join(srcDir, f);
    const content = fs.readFileSync(filePath, "utf8");
    const publishCalls = extractPublishCalls(content);

    for (const call of publishCalls) {
      // Find enclosing function name by looking backwards
      const preceding = content.slice(0, call.index);
      const fnMatches = [...preceding.matchAll(/pub fn\s+(\w+)\s*\(/g)];
      const emittingFn =
        fnMatches.length > 0 ? `${fnMatches[fnMatches.length - 1][1]}()` : "contract call";

      events.push({
        emittingFn,
        topics: formatTopics(call.rawTopics),
        data: formatDataPayload(call.rawData),
        description: `Emitted during ${emittingFn.replace("()", "")}.`,
      });
    }
  }

  return events;
}

/**
 * Extracts storage keys, errors, and public functions for CONTRACTS.md.
 */
export function extractContractApi(contractDir) {
  const result = { storageKeys: [], errors: [], functions: [] };
  const srcDir = path.join(contractDir, "src");
  if (!fs.existsSync(srcDir)) return result;

  // Storage keys
  const storagePath = path.join(srcDir, "storage.rs");
  if (fs.existsSync(storagePath)) {
    const content = fs.readFileSync(storagePath, "utf8");
    const match = content.match(/pub enum DataKey\s*\{([\s\S]*?)\}/);
    if (match) {
      result.storageKeys = match[1]
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0 && !k.startsWith("//"));
    }
  }

  // Errors
  const { variants } = extractContractErrors(contractDir);
  result.errors = variants.map((v) => `${v.name} = ${v.code}`);

  // Functions
  const libPath = path.join(srcDir, "lib.rs");
  if (fs.existsSync(libPath)) {
    const content = fs.readFileSync(libPath, "utf8");
    const implBlocks = [
      ...content.matchAll(/#\[contractimpl\][\s\S]*?impl[\s\S]*?\{([\s\S]*?^\})/gm),
    ];
    for (const block of implBlocks) {
      const fns = [
        ...block[1].matchAll(/pub fn\s+(\w+)\s*\((.*?)\)(?:\s*->\s*(.*?))?\s*\{/g),
      ];
      for (const fn of fns) {
        const name = fn[1];
        const args = fn[2].replace(/\s+/g, " ").trim();
        const ret = fn[3] ? ` -> ${fn[3].trim()}` : "";
        result.functions.push(`pub fn ${name}(${args})${ret}`);
      }
    }
  }

  return result;
}

/**
 * Generates the complete content for contract/ERRORS.md.
 */
export function generateErrorsMarkdown(contractsData) {
  let doc = `# Inverse Arena — contract error registry & client handling

Soroban contracts signal failures with **numeric panic / contract error codes**. Those codes surface in RPC responses (especially failed \`simulateTransaction\`) as host errors, for example:

\`\`\`text
HostError: Error(Contract, #4)
\`\`\`

The frontend must map these numbers to **user-facing copy**. This file is the **source of truth** for on-chain numeric codes. The TypeScript map \`CONTRACT_PANIC_USER_MESSAGES\` in \`frontend/src/shared-d/utils/contract-error-registry.ts\` must stay aligned with the tables below.

---

## How errors reach the client

1. **Simulation** — \`Server.simulateTransaction\` (or equivalent) returns an error object or message containing \`HostError\` / \`Error(Contract, #N)\`.
2. **Submission** — Horizon / Soroban RPC may return operation-level errors (\`op_underfunded\`, \`tx_bad_auth\`, etc.).
3. **Wallet** — Signing can fail with user cancellation strings.

The app normalizes (1)–(3) through \`parseContractError()\` in \`frontend/src/shared-d/utils/contract-error.ts\`. UI layers should prefer **\`parseStellarError()\`** in \`stellar-transactions.ts\`, which delegates to the same pipeline for non-\`ContractError\` values so wording stays consistent.

---

## On-chain numeric codes (registry)

Codes are grouped by **range** so each crate can reserve a band. Implement new variants in Rust with \`#[contracterror]\` (or equivalent) using **exactly** the numbers listed here, then update this document and \`contract-error-registry.ts\` together.

### General — \`1\`–\`99\` (any contract)

| Code | Name | Meaning (engineering) | User-facing message |
|------|------|------------------------|---------------------|
| 1 | \`Unauthorized\` | Caller not allowed to perform the action | You do not have permission to perform this action. |
| 2 | \`InvalidInput\` | Args failed validation | The supplied values are invalid. Please check them and try again. |
| 3 | \`InsufficientBalance\` | Token balance too low | Your balance is too low for this operation. |
| 4 | \`InvalidState\` | Wrong pool / game phase | This action cannot be done in the current game or pool state. |
| 5 | \`AlreadyExists\` | Duplicate resource | This resource already exists. |
| 6 | \`NotFound\` | Missing pool / record | The pool or resource could not be found. |
| 7 | \`DeadlineExpired\` | Time window closed | The time window for this action has closed. |
| 8 | \`CapacityExceeded\` | Arena / pool full | The arena has reached its maximum capacity. |
`;

  for (const c of contractsData) {
    if (!c.errors.variants || c.errors.variants.length === 0) continue;
    doc += `\n### ${c.name} — Rust \`${c.errors.enumName}\` (\`${c.crate}\`)\n\n`;
    doc += `The ${c.id} contract uses \`#[contracterror]\` with explicit \`repr(u32)\` values. These are the codes emitted by \`${c.errors.enumName}\`:\n\n`;
    doc += `| Code | Variant | Meaning / Description | User-facing message |\n`;
    doc += `|------|---------|-----------------------|---------------------|\n`;

    const userMap = KNOWN_USER_MESSAGES[c.id] || {};
    for (const v of c.errors.variants) {
      const userMsg = userMap[v.code] || userMap[v.name] || "-";
      const cleanDesc = v.description.replace(/\|/g, "\\|").replace(/\n/g, " ");
      doc += `| ${v.code} | \`${v.name}\` | ${cleanDesc} | ${userMsg} |\n`;
    }
  }

  doc += `
---

## Infrastructure / network errors (non-contract codes)

These are **not** WASM contract panics; they come from Horizon, RPC, or the wallet. The frontend maps them to \`ContractErrorCode\` string enums in \`contract-error.ts\` (e.g. \`BAD_AUTH\`, \`INSUFFICIENT_FUNDS\`). Keep user-facing defaults in \`DEFAULT_MESSAGES\` there so they match product copy.

| Pattern / source | \`ContractErrorCode\` | Default user message (summary) |
|--------------------|---------------------|--------------------------------|
| \`tx_bad_auth\` | \`BAD_AUTH\` | Wallet / signature problem |
| \`op_underfunded\`, “insufficient” | \`INSUFFICIENT_FUNDS\` | Balance too low |
| \`tx_too_late\` | \`TRANSACTION_TIMEOUT\` | Transaction expired |
| User rejected / cancelled | \`USER_REJECTED\` | User cancelled |
| Zod / validation | \`VALIDATION_FAILED\` | Invalid input |
| Simulation / \`HostError\` | \`SIMULATION_FAILED\` | Simulation failed (detail may include on-chain code) |
| Account 404 | \`ACCOUNT_NOT_FOUND\` | Fund the account |

---

## Frontend checklist

1. Wrap contract calls in \`try/catch\` and use **\`parseContractError(err, fnName)\`** (or **\`parseStellarError(err)\`** for display-only).
2. For \`ContractError\`, show **\`error.message\`**; optionally log **\`error.code\`**, **\`error.fn\`**, and **\`error.cause\`** for diagnostics.
3. When adding a Rust \`ContractError\` variant, **update this file and \`contract-error-registry.ts\` in the same PR**.

---

## Review

Frontend changes that alter user-visible strings for the above codes should be reviewed by the frontend team. Rust changes that introduce or renumber codes must update this registry before merge.
`;

  return doc;
}

/**
 * Generates the complete content for contract/EVENTS.md.
 */
export function generateEventsMarkdown(contractsData) {
  let doc = `# Contract Event Reference

Arena and factory events include a version marker (\`v: u32\`) in the
data payload. Consumers should check this field to detect schema changes
without requiring redeployment.

Current payload version: **1**

---
`;

  for (const c of contractsData) {
    if (!c.events || c.events.length === 0) continue;
    doc += `\n## ${c.name}\n\n`;
    doc += `| Topic | Emitting Function | Data Fields | Description |\n`;
    doc += `|-------|-------------------|-------------|-------------|\n`;

    for (const e of c.events) {
      const cleanDesc = e.description.replace(/\|/g, "\\|").replace(/\n/g, " ");
      doc += `| ${e.topics} | \`${e.emittingFn}\` | ${e.data} | ${cleanDesc} |\n`;
    }
  }

  doc += `
---

## Versioning Policy

- The \`v\` field is included in every arena/factory event payload.
- When fields are added, removed, or reordered the version is bumped.
- Consumers should fall back gracefully on unknown versions.
`;

  return doc;
}

/**
 * Generates the complete content for contract/CONTRACTS.md.
 */
export function generateContractsMarkdown(contractsData) {
  let doc = `# Smart Contracts API Documentation\n\n`;

  for (const c of contractsData) {
    doc += `## ${c.name.replace(" Contract", "")}\n\n`;

    if (c.api.storageKeys.length > 0) {
      doc += `### Storage Keys\n`;
      for (const k of c.api.storageKeys) {
        doc += `- \`${k}\`\n`;
      }
      doc += `\n`;
    }

    if (c.api.errors.length > 0) {
      doc += `### Errors\n`;
      for (const e of c.api.errors) {
        doc += `- \`${e}\`\n`;
      }
      doc += `\n`;
    }

    if (c.api.functions.length > 0) {
      doc += `### Functions\n`;
      for (const fn of c.api.functions) {
        doc += `- \`${fn}\`\n`;
      }
      doc += `\n`;
    }
  }

  return doc;
}

/**
 * Collects data from all contracts.
 */
export function collectAllContractsData(baseDir = CONTRACT_ROOT) {
  return KNOWN_CONTRACTS.map((contract) => {
    const contractDir = path.join(baseDir, contract.id);
    const errors = extractContractErrors(contractDir);
    const events = extractContractEvents(contractDir);
    const api = extractContractApi(contractDir);
    return {
      ...contract,
      errors,
      events,
      api,
    };
  });
}

/**
 * Main execution runner.
 */
export function run(args = process.argv.slice(2)) {
  const isCheck = args.includes("--check");
  const isHelp = args.includes("--help") || args.includes("-h");

  if (isHelp) {
    console.log(`
Usage:
  node contract/scripts/generate-contract-docs.mjs [options]

Options:
  --check    Verify that generated docs match on-disk docs without modifying files (CI drift check)
  --help     Show this help message

Generated files:
  contract/ERRORS.md
  contract/EVENTS.md
  contract/CONTRACTS.md
`);
    return 0;
  }

  const contractsData = collectAllContractsData(CONTRACT_ROOT);

  const errorsMd = generateErrorsMarkdown(contractsData);
  const eventsMd = generateEventsMarkdown(contractsData);
  const contractsMd = generateContractsMarkdown(contractsData);

  const targetErrorsPath = path.join(CONTRACT_ROOT, "ERRORS.md");
  const targetEventsPath = path.join(CONTRACT_ROOT, "EVENTS.md");
  const targetContractsPath = path.join(CONTRACT_ROOT, "CONTRACTS.md");

  const files = [
    { path: targetErrorsPath, content: errorsMd, name: "ERRORS.md" },
    { path: targetEventsPath, content: eventsMd, name: "EVENTS.md" },
    { path: targetContractsPath, content: contractsMd, name: "CONTRACTS.md" },
  ];

  if (isCheck) {
    let hasDrift = false;
    for (const f of files) {
      if (!fs.existsSync(f.path)) {
        console.error(`❌ [DRIFT] File ${f.name} does not exist at ${f.path}`);
        hasDrift = true;
        continue;
      }
      const existing = fs.readFileSync(f.path, "utf8").replace(/\r\n/g, "\n");
      const generated = f.content.replace(/\r\n/g, "\n");
      if (existing !== generated) {
        console.error(`❌ [DRIFT] File ${f.name} has drifted from source code definitions!`);
        hasDrift = true;
      }
    }

    if (hasDrift) {
      console.error(
        "\nRun 'node contract/scripts/generate-contract-docs.mjs' to regenerate documentation and commit the changes."
      );
      return 1;
    }

    console.log("✅ All contract documentation files (ERRORS.md, EVENTS.md, CONTRACTS.md) are up to date!");
    return 0;
  }

  // Write mode
  for (const f of files) {
    fs.writeFileSync(f.path, f.content, "utf8");
    console.log(`✅ Generated ${f.name} (${f.content.length} bytes)`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const exitCode = run();
  process.exit(exitCode);
}

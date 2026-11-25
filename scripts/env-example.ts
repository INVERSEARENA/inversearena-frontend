#!/usr/bin/env tsx
/**
 * Generate frontend/.env.example and backend/.env.example from the typed
 * environment schemas (#1650), so the examples cannot drift from the code.
 *
 *   npx tsx scripts/env-example.ts                     # write both
 *   npx tsx scripts/env-example.ts backend --check     # exit 1 if backend/.env.example is stale
 *
 * Each app's schema imports only zod, resolved from that app's node_modules,
 * so checking one app needs only that app installed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The subset of each app's EnvVarSpec the generator reads. */
export interface DocumentedVar {
  section: string;
  description: string;
  example?: string;
  default?: string;
  required?: boolean;
  secret?: boolean;
}

export interface EnvExample {
  /** Repo-relative path of the schema, named in the header. */
  schemaPath: string;
  vars: Readonly<Record<string, DocumentedVar>>;
}

const WIDTH = 80;

function comment(text: string): string[] {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line.length + 1 + word.length > WIDTH && line !== "#") {
      lines.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  lines.push(line);
  return lines;
}

function notes(spec: DocumentedVar): string {
  const parts: string[] = [];
  if (spec.required) parts.push("Required.");
  if (spec.default !== undefined) parts.push(`Default: ${spec.default}.`);
  if (spec.secret) parts.push("Secret: never commit a real value.");
  return parts.join(" ");
}

/**
 * Required variables are written uncommented. Optional ones are commented out
 * so their defaults apply until someone sets them. A secret only shows an
 * example when its schema gives a safe local one (a localhost URL); real
 * secrets such as signing keys declare no example and stay empty.
 */
export function renderEnvExample({ schemaPath, vars }: EnvExample): string {
  const out = [
    `# Generated from ${schemaPath} by scripts/env-example.ts. Do not edit:`,
    "# change the schema and run `npx tsx scripts/env-example.ts`.",
    "#",
    "# Required variables are uncommented. Optional ones are commented out and",
    "# fall back to the default noted above them.",
  ];
  let section: string | undefined;
  for (const [name, spec] of Object.entries(vars)) {
    if (spec.section !== section) {
      section = spec.section;
      const heading = `# ── ${section} `;
      out.push("", heading + "─".repeat(Math.max(3, WIDTH - heading.length)));
    }
    out.push("", ...comment(spec.description));
    const extra = notes(spec);
    if (extra) out.push(...comment(extra));
    const value = spec.example ?? spec.default ?? "";
    out.push(spec.required ? `${name}=${value}` : `# ${name}=${value}`);
  }
  return `${out.join("\n")}\n`;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const APPS = {
  async frontend(): Promise<EnvExample> {
    const { CLIENT_ENV_VARS, SERVER_ENV_VARS } = await import("../frontend/src/shared/config/env/spec");
    return { schemaPath: "frontend/src/shared/config/env/spec.ts", vars: { ...CLIENT_ENV_VARS, ...SERVER_ENV_VARS } };
  },
  async backend(): Promise<EnvExample> {
    const { ENV_VARS } = await import("../backend/src/config/env");
    return { schemaPath: "backend/src/config/env.ts", vars: ENV_VARS };
  },
};

async function main(argv: string[]): Promise<number> {
  const check = argv.includes("--check");
  const requested = argv.filter((arg) => !arg.startsWith("--"));
  const apps = (requested.length ? requested : Object.keys(APPS)) as Array<keyof typeof APPS>;
  let stale = 0;
  for (const app of apps) {
    if (!(app in APPS)) throw new Error(`Unknown app "${app}"; expected one of ${Object.keys(APPS).join(", ")}`);
    const path = join(ROOT, app, ".env.example");
    const expected = renderEnvExample(await APPS[app]());
    if (check) {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        // A missing file is stale too.
      }
      if (current !== expected) {
        console.error(`${app}/.env.example is out of date with its schema. Run \`npx tsx scripts/env-example.ts ${app}\` and commit.`);
        stale += 1;
      } else {
        console.log(`${app}/.env.example is up to date.`);
      }
    } else {
      writeFileSync(path, expected);
      console.log(`Wrote ${app}/.env.example`);
    }
  }
  return stale > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

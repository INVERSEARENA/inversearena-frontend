import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const portalDir = resolve(dirname(scriptPath), "..");
const repoRoot = resolve(portalDir, "..");
const defaultArtifact = join(portalDir, "data", "openapi.json");

export function validateOpenApiDocument(document) {
  const problems = [];

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return ["document must be an object"];
  }
  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.1")) {
    problems.push("openapi must be 3.1.x");
  }
  if (!document.paths || typeof document.paths !== "object" || Object.keys(document.paths).length === 0) {
    problems.push("paths must contain at least one entry");
  }
  if (!document.components?.securitySchemes?.bearerAuth) {
    problems.push("components.securitySchemes.bearerAuth must exist");
  }

  return problems;
}

export function assertOpenApiDocument(document) {
  const problems = validateOpenApiDocument(document);
  if (problems.length > 0) throw new Error(`Invalid OpenAPI document: ${problems.join("; ")}`);
  return document;
}

export function generateOpenApiArtifact({ backendDir = join(repoRoot, "backend") } = {}) {
  const registerPaths = join(backendDir, "src", "openapi", "registerPaths.ts");
  if (!existsSync(registerPaths)) throw new Error(`Missing backend OpenAPI source: ${registerPaths}`);

  const tempDir = mkdtempSync(join(tmpdir(), "docs-portal-openapi-"));
  const entryPath = join(tempDir, "generate.mts");
  const outputPath = join(tempDir, "openapi.json");

  try {
    const moduleUrl = pathToFileURL(registerPaths).href;
    writeFileSync(
      entryPath,
      [
        `import { writeFileSync } from "node:fs";`,
        `import * as openApiModule from ${JSON.stringify(moduleUrl)};`,
        `const generateOpenApiDocument = openApiModule.generateOpenApiDocument ?? openApiModule.default?.generateOpenApiDocument;`,
        `if (typeof generateOpenApiDocument !== "function") throw new Error("generateOpenApiDocument export not found");`,
        `writeFileSync(process.argv[2], JSON.stringify(generateOpenApiDocument(), null, 2) + "\\n");`,
        "",
      ].join("\n"),
    );

    const localTsx = join(backendDir, "node_modules", ".bin", "tsx");
    const command = existsSync(localTsx) ? localTsx : "npx";
    const args = existsSync(localTsx) ? [entryPath, outputPath] : ["--no-install", "tsx", entryPath, outputPath];
    const result = spawnSync(command, args, { cwd: backendDir, encoding: "utf8" });

    if (result.error || result.status !== 0) {
      const detail = result.stderr?.trim() || result.error?.message || "unknown error";
      throw new Error(
        `Could not run the backend OpenAPI generator. Install backend dependencies with "npm ci" in backend/ and retry.\n${detail}`,
      );
    }

    const content = readFileSync(outputPath, "utf8");
    assertOpenApiDocument(JSON.parse(content));
    return content;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function main() {
  const check = process.argv.includes("--check");
  const content = generateOpenApiArtifact();

  if (!check) {
    mkdirSync(dirname(defaultArtifact), { recursive: true });
    writeFileSync(defaultArtifact, content);
    console.log(`Wrote ${defaultArtifact}`);
    return;
  }

  if (!existsSync(defaultArtifact)) {
    mkdirSync(dirname(defaultArtifact), { recursive: true });
    writeFileSync(defaultArtifact, content);
    console.log(`Created missing ${defaultArtifact}; commit it to enable drift checks.`);
    return;
  }

  if (readFileSync(defaultArtifact, "utf8") !== content) {
    console.error(`${defaultArtifact} is out of date.`);
    console.error("Run node docs-portal/scripts/generate-openapi.mjs and commit the result.");
    process.exitCode = 1;
    return;
  }

  console.log(`OpenAPI artifact matches the generated document.`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

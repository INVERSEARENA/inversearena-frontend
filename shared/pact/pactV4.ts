import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PactV4ProviderState {
  name: string;
  params?: Record<string, unknown>;
}

export interface PactV4Request {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface PactV4MatchingRule {
  match: "type" | "regex" | "integer" | "decimal" | "boolean";
  regex?: string;
}

export interface PactV4Response {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  matchingRules?: {
    body?: Record<string, { matchers: PactV4MatchingRule[] }>;
  };
}

export interface PactV4Interaction {
  type: "Synchronous/HTTP";
  description: string;
  providerStates?: PactV4ProviderState[];
  request: PactV4Request;
  response: PactV4Response;
}

export interface PactV4File {
  consumer: { name: string };
  provider: { name: string };
  interactions: PactV4Interaction[];
  metadata: {
    pactSpecification: { version: "4.0" };
  };
}

export class PactV4Consumer {
  private interactions: PactV4Interaction[] = [];

  constructor(
    private readonly consumerName: string,
    private readonly providerName: string,
    private readonly pactDir: string,
  ) {}

  addInteraction(interaction: Omit<PactV4Interaction, "type">): this {
    this.interactions.push({
      type: "Synchronous/HTTP",
      ...interaction,
    });
    return this;
  }

  /**
   * Spin up a local mock HTTP server serving the registered interactions,
   * run the consumer test callback, assert every interaction was exercised,
   * and write the Pact v4 JSON file to disk.
   */
  async executeTest(
    testFn: (mockServerUrl: string) => Promise<void>,
  ): Promise<string> {
    const exercised = new Set<string>();

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const reqMethod = (req.method ?? "GET").toUpperCase();

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const match = this.interactions.find((inter) => {
          if (inter.request.method !== reqMethod) return false;
          if (inter.request.path !== reqUrl.pathname) return false;
          if (inter.request.query) {
            for (const [k, v] of Object.entries(inter.request.query)) {
              const expected = Array.isArray(v) ? v[0] : v;
              if (reqUrl.searchParams.get(k) !== expected) return false;
            }
          }
          return true;
        });

        if (!match) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Unexpected Pact request: ${reqMethod} ${reqUrl.pathname}${reqUrl.search}`,
            }),
          );
          return;
        }

        exercised.add(match.description);
        res.writeHead(match.response.status, {
          "Content-Type": "application/json",
          ...(match.response.headers ?? {}),
        });
        res.end(
          match.response.body !== undefined
            ? JSON.stringify(match.response.body)
            : "",
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to bind Pact mock server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await testFn(baseUrl);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }

    const unexercised = this.interactions
      .filter((i) => !exercised.has(i.description))
      .map((i) => i.description);
    if (unexercised.length > 0) {
      throw new Error(
        `Pact consumer test did not exercise all interactions: ${unexercised.join(", ")}`,
      );
    }

    const pactFile: PactV4File = {
      consumer: { name: this.consumerName },
      provider: { name: this.providerName },
      interactions: this.interactions,
      metadata: {
        pactSpecification: { version: "4.0" },
      },
    };

    fs.mkdirSync(this.pactDir, { recursive: true });
    const fileName = `${this.consumerName}-${this.providerName}.json`
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-");
    const outPath = path.join(this.pactDir, fileName);
    fs.writeFileSync(outPath, JSON.stringify(pactFile, null, 2) + "\n", "utf8");
    return outPath;
  }
}

export type StateHandler = (params?: Record<string, unknown>) => Promise<void> | void;

export interface ProviderVerificationOptions {
  pactFilePath: string;
  baseUrl: string;
  stateHandlers: Record<string, StateHandler>;
}

/**
 * Recursively verify that `actual` contains every field/element shape
 * expected by `expected` (consumer-driven contract: extra provider fields
 * are allowed, missing or mismatched fields fail verification).
 */
export function assertContractShape(
  expected: unknown,
  actual: unknown,
  jsonPath = "$",
): string[] {
  const errors: string[] = [];

  if (expected === null) {
    if (actual !== null) {
      errors.push(`${jsonPath}: expected null, got ${typeof actual}`);
    }
    return errors;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      errors.push(`${jsonPath}: expected array, got ${typeof actual}`);
      return errors;
    }
    if (expected.length > 0 && actual.length === 0) {
      errors.push(`${jsonPath}: expected non-empty array matching example element`);
      return errors;
    }
    if (expected.length > 0) {
      for (let i = 0; i < actual.length; i++) {
        errors.push(...assertContractShape(expected[0], actual[i], `${jsonPath}[${i}]`));
      }
    }
    return errors;
  }

  if (typeof expected === "object") {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
      errors.push(`${jsonPath}: expected object, got ${actual === null ? "null" : typeof actual}`);
      return errors;
    }
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, expVal] of Object.entries(expected as Record<string, unknown>)) {
      if (!(key in actualRecord)) {
        errors.push(`${jsonPath}.${key}: missing required contract field`);
        continue;
      }
      errors.push(...assertContractShape(expVal, actualRecord[key], `${jsonPath}.${key}`));
    }
    return errors;
  }

  if (typeof expected !== typeof actual) {
    errors.push(`${jsonPath}: expected ${typeof expected}, got ${typeof actual}`);
  }
  return errors;
}

export async function verifyPactFile(options: ProviderVerificationOptions): Promise<void> {
  const raw = fs.readFileSync(options.pactFilePath, "utf8");
  const pact = JSON.parse(raw) as PactV4File;
  const failures: string[] = [];

  for (const interaction of pact.interactions) {
    if (interaction.providerStates) {
      for (const state of interaction.providerStates) {
        const handler = options.stateHandlers[state.name];
        if (!handler) {
          failures.push(
            `[${interaction.description}] Missing provider state handler for "${state.name}"`,
          );
          continue;
        }
        await handler(state.params);
      }
    }

    const url = new URL(interaction.request.path, options.baseUrl);
    if (interaction.request.query) {
      for (const [k, v] of Object.entries(interaction.request.query)) {
        const val = Array.isArray(v) ? v[0] : v;
        url.searchParams.set(k, val);
      }
    }

    const res = await fetch(url.toString(), {
      method: interaction.request.method,
      headers: {
        "Content-Type": "application/json",
        ...(interaction.request.headers ?? {}),
      },
      body:
        interaction.request.body !== undefined
          ? JSON.stringify(interaction.request.body)
          : undefined,
    });

    if (res.status !== interaction.response.status) {
      failures.push(
        `[${interaction.description}] Status mismatch: expected ${interaction.response.status}, got ${res.status}`,
      );
      continue;
    }

    if (interaction.response.body !== undefined) {
      const actualBody = await res.json();
      const shapeErrors = assertContractShape(interaction.response.body, actualBody);
      for (const err of shapeErrors) {
        failures.push(`[${interaction.description}] ${err}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Pact provider verification failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  }
}

/**
 * Extract typed mock response fixtures directly from a generated Pact v4 file
 * so frontend hook tests stay 100% synchronized with the published contract.
 */
export function getMockResponseFromPact<T = unknown>(
  pactFilePath: string,
  description: string,
): T {
  const raw = fs.readFileSync(pactFilePath, "utf8");
  const pact = JSON.parse(raw) as PactV4File;
  const interaction = pact.interactions.find((i) => i.description === description);
  if (!interaction) {
    throw new Error(`Pact interaction "${description}" not found in ${pactFilePath}`);
  }
  return interaction.response.body as T;
}

/**
 * Creator configuration templates (#1689).
 *
 * Covers the ownership, concurrency, validation, schema-version and
 * malformed-input edges the acceptance criteria call for.
 */
import type { PrismaClient } from "@prisma/client";
import {
  CreatorTemplateService,
  type DeploymentCapabilities,
} from "../creatorTemplateService";
import {
  migrateTemplatePayload,
  validateTemplatePayload,
  TEMPLATE_SCHEMA_VERSION,
  type ArenaTemplatePayload,
} from "../arenaTemplateSchema";

const readIntegrationLifecycle = jest.fn(async () => ({} as Record<string, "Active" | "Deprecated" | "Disabled">));

jest.mock("../creatorTemplateLifecycle", () => ({
  readIntegrationLifecycle: (...args: unknown[]) => readIntegrationLifecycle(...(args as [])),
}));

const OWNER = "GOWNER";
const OTHER = "GOTHER";
const ASSET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VAULT = "C" + "B".repeat(55);
const ORACLE = "C" + "D".repeat(55);

function payload(overrides: Partial<ArenaTemplatePayload> = {}): ArenaTemplatePayload {
  return {
    stakeAmountMinor: "100000000",
    assetDecimals: 7,
    asset: ASSET,
    capacity: 50,
    roundSpeed: "1M",
    roundDurationSeconds: 60,
    yieldVault: VAULT,
    oracle: ORACLE,
    ...overrides,
  };
}

interface Row {
  id: string;
  ownerAddress: string;
  name: string;
  schemaVersion: number;
  status: string;
  payload: unknown;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

function makePrisma() {
  const rows = new Map<string, Row>();
  let counter = 0;
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "id" && typeof value === "object" && value !== null && "not" in (value as Record<string, unknown>)) {
        return row.id !== (value as { not: string }).not;
      }
      return (row as unknown as Record<string, unknown>)[key] === value;
    });

  const prisma = {
    creatorTemplate: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].filter((row) => matches(row, where)),
      ),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].find((row) => matches(row, where)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        counter += 1;
        const now = new Date();
        const row: Row = {
          ...data,
          id: `template-${counter}`,
          schemaVersion: data.schemaVersion ?? TEMPLATE_SCHEMA_VERSION,
          status: data.status ?? "active",
          revision: data.revision ?? 1,
          createdAt: now,
          updatedAt: now,
        };
        rows.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("not found");
        const updated = { ...row, ...data, updatedAt: new Date() };
        rows.set(updated.id, updated);
        return updated;
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        rows.delete(where.id);
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows };
}

function service(prisma: PrismaClient, capabilities: DeploymentCapabilities = {}) {
  return new CreatorTemplateService(prisma, capabilities);
}

describe("creator configuration templates", () => {
  beforeEach(() => {
    readIntegrationLifecycle.mockClear();
    readIntegrationLifecycle.mockResolvedValue({});
  });

  it("keeps templates scoped to their owner", async () => {
    const { prisma } = makePrisma();
    const templates = service(prisma);
    const created = await templates.createTemplate(OWNER, { name: "weekday", payload: payload() });

    await expect(templates.getTemplate(OTHER, created.id)).rejects.toMatchObject({
      status: 404,
      code: "TEMPLATE_NOT_FOUND",
    });
    await expect(templates.updateTemplate(OTHER, created.id, { expectedRevision: 1 })).rejects.toMatchObject({
      status: 404,
    });
    await expect(templates.deleteTemplate(OTHER, created.id)).rejects.toMatchObject({ status: 404 });

    const otherList = await templates.listTemplates(OTHER);
    expect(otherList.items).toHaveLength(0);
  });

  it("refuses a duplicate name for the same wallet", async () => {
    const { prisma } = makePrisma();
    const templates = service(prisma);
    await templates.createTemplate(OWNER, { name: "weekday", payload: payload() });
    await expect(
      templates.createTemplate(OWNER, { name: "weekday", payload: payload() }),
    ).rejects.toMatchObject({ status: 409, code: "TEMPLATE_NAME_TAKEN" });
  });

  it("refuses a concurrent edit", async () => {
    const { prisma } = makePrisma();
    const templates = service(prisma);
    const created = await templates.createTemplate(OWNER, { name: "weekday", payload: payload() });

    await templates.updateTemplate(OWNER, created.id, { expectedRevision: 1, payload: payload({ capacity: 60 }) });
    await expect(
      templates.updateTemplate(OWNER, created.id, { expectedRevision: 1, payload: payload({ capacity: 70 }) }),
    ).rejects.toMatchObject({ status: 409, code: "TEMPLATE_REVISION_CONFLICT" });
  });

  it("reports a deprecated integration field by field", async () => {
    readIntegrationLifecycle.mockResolvedValue({
      [`vault:${VAULT}`]: "Deprecated",
    });
    const { prisma } = makePrisma();
    const templates = service(prisma);

    await expect(
      templates.createTemplate(OWNER, { name: "stale", payload: payload() }),
    ).rejects.toMatchObject({ status: 422, code: "TEMPLATE_INVALID" });

    const remediation = validateTemplatePayload(payload(), {
      lifecycle: { [`vault:${VAULT}`]: "Deprecated" },
    });
    expect(remediation).toEqual([
      expect.objectContaining({ field: "yieldVault", code: "VAULT_DEPRECATED" }),
    ]);
  });

  it("reports changed protocol bounds", async () => {
    const remediation = validateTemplatePayload(payload({ capacity: 5000 }), { lifecycle: {} });
    expect(remediation).toEqual([
      expect.objectContaining({ field: "capacity", code: "CAPACITY_OUT_OF_RANGE" }),
    ]);
  });

  it("reports a stake below the protocol minimum", async () => {
    const remediation = validateTemplatePayload(payload({ stakeAmountMinor: "1000" }), { lifecycle: {} });
    expect(remediation).toEqual([
      expect.objectContaining({ field: "stakeAmountMinor", code: "STAKE_BELOW_MINIMUM" }),
    ]);
  });

  it("migrates a legacy version and refuses an unknown one", () => {
    const migrated = migrateTemplatePayload(0, { stakeAmount: "100", currency: "USDC", capacity: 50 });
    expect(migrated).not.toBeNull();
    expect(migrated).not.toHaveProperty("stakeAmount");

    expect(migrateTemplatePayload(TEMPLATE_SCHEMA_VERSION + 1, { capacity: 50 })).toBeNull();
  });

  it("refuses to apply a template whose schema is newer than the deployment", async () => {
    const { prisma, rows } = makePrisma();
    const templates = service(prisma);
    const created = await templates.createTemplate(OWNER, { name: "future", payload: payload() });
    const row = rows.get(created.id)!;
    rows.set(created.id, { ...row, schemaVersion: TEMPLATE_SCHEMA_VERSION + 1 });

    await expect(templates.prepareForUse(OWNER, created.id)).rejects.toMatchObject({
      status: 422,
      code: "TEMPLATE_SCHEMA_UNSUPPORTED",
    });
  });

  it("clones, archives and deletes a template", async () => {
    const { prisma } = makePrisma();
    const templates = service(prisma);
    const created = await templates.createTemplate(OWNER, { name: "weekday", payload: payload() });

    const clone = await templates.cloneTemplate(OWNER, created.id, "weekday v2");
    expect(clone.name).toBe("weekday v2");

    const archived = await templates.setArchived(OWNER, created.id, true);
    expect(archived.status).toBe("archived");

    const listed = await templates.listTemplates(OWNER);
    expect(listed.items.map((item) => item.name)).toEqual(["weekday v2"]);

    await templates.deleteTemplate(OWNER, clone.id);
    const after = await templates.listTemplates(OWNER, { includeArchived: true });
    expect(after.items.map((item) => item.name)).toEqual(["weekday"]);
  });

  it("rejects a malformed imported payload", async () => {
    const { prisma } = makePrisma();
    const templates = service(prisma);
    await expect(
      templates.createTemplate(OWNER, {
        name: "broken",
        payload: payload({ asset: "not-a-contract" }),
      }),
    ).rejects.toMatchObject({ status: 422, code: "TEMPLATE_INVALID" });
  });
});

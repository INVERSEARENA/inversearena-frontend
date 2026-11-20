import { describe, expect, it, jest } from "@jest/globals";
import type { PrismaClient } from "@prisma/client";
import {
  NotificationLinkError,
  NotificationLinkService,
} from "../../src/services/notificationLinkService";

const START_MS = Date.parse("2026-11-20T12:00:00.000Z");

interface FakePrisma {
  codes: any[];
  links: any[];
  client: PrismaClient;
}

function makePrisma(): FakePrisma {
  const codes: any[] = [];
  const links: any[] = [];
  let sequence = 0;

  const client = {
    notificationLinkCode: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `code-${++sequence}`,
          usedAt: null,
          createdAt: new Date(START_MS),
          ...data,
        };
        codes.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          codes.find(
            (row) =>
              row.channel === where.channel &&
              row.codeHash === where.codeHash &&
              row.usedAt === null &&
              row.expiresAt.getTime() > where.expiresAt.gt.getTime(),
          ) ?? null
        );
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = codes.find((candidate) => candidate.id === where.id);
        if (!row || row.usedAt !== null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    notificationChannelLink: {
      upsert: jest.fn(async ({ where, create, update, select }: any) => {
        const conflict = links.find(
          (row) => row.channel === create.channel && row.externalId === create.externalId,
        );
        if (conflict && conflict.userId !== create.userId) {
          throw new Error("unique constraint failed");
        }
        let row = links.find(
          (candidate) =>
            candidate.userId === where.userId_channel.userId &&
            candidate.channel === where.userId_channel.channel,
        );
        if (row) {
          Object.assign(row, update);
        } else {
          row = {
            id: `link-${++sequence}`,
            createdAt: new Date(START_MS),
            ...create,
          };
          links.push(row);
        }
        return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
      }),
      findMany: jest.fn(async ({ where }: any) =>
        links.filter((row) => row.userId === where.userId && row.active !== false),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        links.find(
          (row) =>
            row.userId === where.userId &&
            row.channel === where.channel &&
            row.active === where.active,
        ) ?? null,
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = links.length;
        for (let i = links.length - 1; i >= 0; i -= 1) {
          if (links[i].userId === where.userId && links[i].channel === where.channel) {
            links.splice(i, 1);
          }
        }
        return { count: before - links.length };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of links) {
          if (
            row.channel === where.channel &&
            (where.externalId === undefined || row.externalId === where.externalId) &&
            (where.userId === undefined || row.userId === where.userId)
          ) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
  } as unknown as PrismaClient;

  return { codes, links, client };
}

function makeService(
  fake: FakePrisma,
  nowMs: { value: number } = { value: START_MS },
): NotificationLinkService {
  return new NotificationLinkService(fake.client, {
    secret: "test-link-secret",
    ttlMs: 10 * 60 * 1000,
    now: () => new Date(nowMs.value),
  });
}

describe("NotificationLinkService (#1735)", () => {
  it("returns a one-time code but stores only its HMAC digest", async () => {
    const fake = makePrisma();
    const service = makeService(fake);

    const { code, expiresAt } = await service.createCode("user-1", "telegram");

    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(expiresAt.getTime()).toBe(START_MS + 10 * 60 * 1000);
    expect(fake.codes).toHaveLength(1);
    expect(fake.codes[0].codeHash).not.toBe(code);
    expect(fake.codes[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("redeems a code once and binds the bot destination to the code owner", async () => {
    const fake = makePrisma();
    const service = makeService(fake);
    const { code } = await service.createCode("user-1", "discord");

    const result = await service.consumeCode("discord", code.toLowerCase(), "discord-user-1", {
      displayName: "player#0001",
    });

    expect(result.userId).toBe("user-1");
    expect(result.link.externalId).toBe("discord-user-1");
    expect(result.link.displayName).toBe("player#0001");
    expect(fake.codes[0].usedAt).toBeInstanceOf(Date);

    await expect(service.consumeCode("discord", code, "discord-user-2")).rejects.toEqual(
      expect.any(NotificationLinkError),
    );
    expect(fake.links).toHaveLength(1);
  });

  it("rejects expired codes", async () => {
    const fake = makePrisma();
    const now = { value: START_MS };
    const service = makeService(fake, now);
    const { code } = await service.createCode("user-1", "telegram");
    now.value += 10 * 60 * 1000 + 1;

    await expect(service.consumeCode("telegram", code, "chat-1")).rejects.toMatchObject({
      code: "INVALID_CODE",
    });
    expect(fake.links).toHaveLength(0);
  });

  it("maps a destination already owned by another wallet to ALREADY_LINKED", async () => {
    const fake = makePrisma();
    const service = makeService(fake);
    fake.links.push({
      id: "existing",
      userId: "user-2",
      channel: "telegram",
      externalId: "chat-1",
      active: true,
      createdAt: new Date(START_MS),
    });
    const { code } = await service.createCode("user-1", "telegram");

    await expect(service.consumeCode("telegram", code, "chat-1")).rejects.toMatchObject({
      code: "ALREADY_LINKED",
    });
  });

  it("deactivates links when a platform reports a dead destination", async () => {
    const fake = makePrisma();
    const service = makeService(fake);
    const { code } = await service.createCode("user-1", "telegram");
    await service.consumeCode("telegram", code, "chat-dead");

    await service.deactivateByExternalId("telegram", "chat-dead");

    expect(fake.links[0].active).toBe(false);
    expect(await service.getActiveLink("user-1", "telegram")).toBeNull();
  });
});

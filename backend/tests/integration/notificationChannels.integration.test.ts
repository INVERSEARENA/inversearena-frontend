import { randomBytes } from "crypto";
import { prisma } from "../../src/db/prisma";
import { NotificationCrypto } from "../../src/services/notificationCrypto";
import { NotificationLinkService } from "../../src/services/notificationLinkService";
import { NotificationPreferencesService } from "../../src/services/notificationPreferencesService";
import { WebhookChannel } from "../../src/services/channels/webhookChannel";

/**
 * Persistence-level coverage for the #1735 channel tables. Runs with the
 * Postgres service container in CI; skips harmlessly without DATABASE_URL.
 */
describe("notification channel persistence (#1735)", () => {
  const enabled = Boolean(process.env.DATABASE_URL);
  const wallet = `GNOTIFY${Date.now()}`;
  let userId = "";
  let arenaId = "";

  beforeAll(async () => {
    if (!enabled) return;
    const user = await prisma.user.create({ data: { walletAddress: wallet } });
    userId = user.id;
    const arena = await prisma.arena.create({
      data: { metadata: { createdBy: wallet, name: "Notification test arena" } },
    });
    arenaId = arena.id;
  });

  afterAll(async () => {
    if (!enabled || !userId) return;
    await prisma.notificationDelivery.deleteMany({ where: { userId } });
    await prisma.notificationChannelPreference.deleteMany({ where: { userId } });
    await prisma.notificationLinkCode.deleteMany({ where: { userId } });
    await prisma.notificationChannelLink.deleteMany({ where: { userId } });
    await prisma.notificationPreference.deleteMany({ where: { userId } });
    await prisma.arenaNotificationWebhook.deleteMany({ where: { createdBy: userId } });
    if (arenaId) await prisma.arena.delete({ where: { id: arenaId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  it("stores one-time bot codes as digests and redeems them once", async () => {
    if (!enabled) return;
    const links = new NotificationLinkService(prisma, {
      secret: "integration-link-secret",
      ttlMs: 60_000,
    });

    const { code } = await links.createCode(userId, "telegram");
    const stored = await prisma.notificationLinkCode.findFirst({ where: { userId } });
    expect(stored?.codeHash).not.toBe(code);
    expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);

    const consumed = await links.consumeCode("telegram", code, "telegram-chat-1");
    expect(consumed.userId).toBe(userId);
    const used = await prisma.notificationLinkCode.findUnique({ where: { id: stored!.id } });
    expect(used?.usedAt).toBeInstanceOf(Date);
    await expect(links.consumeCode("telegram", code, "telegram-chat-2")).rejects.toMatchObject({
      code: "INVALID_CODE",
    });
  });

  it("persists granular preferences and retry/dead-letter state", async () => {
    if (!enabled) return;
    const prefs = new NotificationPreferencesService(prisma);

    await prefs.updatePreferences(userId, { telegramEnabled: false });
    await prefs.updateChannelPreferences(userId, [
      { eventType: "payout", channel: "telegram", enabled: true },
    ]);
    expect(await prefs.isChannelEventEnabled(userId, "payout", "telegram")).toBe(true);
    expect(await prefs.isChannelEventEnabled(userId, "round", "telegram")).toBe(false);

    const deliveryId = await prefs.recordDelivery(userId, "payout", "telegram", "payout:test", {
      arenaId,
      message: { title: "Payout", body: "You won", url: `/arena/${arenaId}` },
    });
    await prefs.markRetrying(deliveryId, 1, new Date(Date.now() - 1000), "temporary");
    const due = await prefs.getDueRetries();
    expect(due.some((row) => row.id === deliveryId)).toBe(true);

    await prefs.markDeadLettered(deliveryId, 5, "exhausted");
    const history = await prefs.getDeliveryHistory(userId);
    const record = history.find((row) => row.id === deliveryId);
    expect(record?.status).toBe("dead_letter");
    expect(record?.attempts).toBe(5);
  });

  it("encrypts community webhook URLs at rest and lists a masked URL", async () => {
    if (!enabled) return;
    const crypto = new NotificationCrypto(randomBytes(32));
    const webhooks = new WebhookChannel(prisma, { crypto });
    const url = "https://discord.com/api/webhooks/123/secret";

    const created = await webhooks.createWebhook(arenaId, userId, url, "Community");
    const stored = await prisma.arenaNotificationWebhook.findUnique({ where: { id: created.id } });
    expect(stored?.url).not.toContain("secret");
    expect(crypto.decrypt(stored!.url)).toBe(url);
    expect(created.urlMasked).not.toContain("secret");
    expect((await webhooks.listWebhooks(arenaId))[0].urlMasked).toBe(created.urlMasked);
  });
});

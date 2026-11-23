import { describe, expect, it, jest } from "@jest/globals";
import {
  NotificationPipelineService,
  type DispatchNotificationInput,
} from "../../src/services/notificationPipelineService";
import type {
  NotificationChannel,
  NotificationChannelType,
  ChannelSendResult,
} from "../../src/services/notificationChannel";
import type {
  DueDelivery,
  NotificationPreferencesService,
} from "../../src/services/notificationPreferencesService";

const NOW = new Date("2026-11-20T12:00:00.000Z");

interface PrefsMock {
  isChannelEventEnabled: jest.Mock;
  hasDelivered: jest.Mock;
  recordDelivery: jest.Mock;
  markSent: jest.Mock;
  deleteDelivery: jest.Mock;
  markRetrying: jest.Mock;
  markDeadLettered: jest.Mock;
  getDueRetries: jest.Mock;
}

function makePrefs(): PrefsMock {
  return {
    isChannelEventEnabled: jest.fn(async () => true),
    hasDelivered: jest.fn(async () => false),
    recordDelivery: jest.fn(async () => "delivery-1"),
    markSent: jest.fn(async () => undefined),
    deleteDelivery: jest.fn(async () => undefined),
    markRetrying: jest.fn(async () => undefined),
    markDeadLettered: jest.fn(async () => undefined),
    getDueRetries: jest.fn(async () => []),
  };
}

function prefsService(mock: PrefsMock): NotificationPreferencesService {
  return mock as unknown as NotificationPreferencesService;
}

function makeChannel(
  channel: NotificationChannelType,
  result: ChannelSendResult,
): NotificationChannel & { send: jest.Mock } {
  return {
    channel,
    send: jest.fn(async () => result),
  } as unknown as NotificationChannel & { send: jest.Mock };
}

function makeInput(overrides: Partial<DispatchNotificationInput> = {}): DispatchNotificationInput {
  return {
    eventType: "round",
    dedupeKey: "round:arena-1:1",
    userIds: ["user-1"],
    arenaId: "arena-1",
    message: {
      title: "Round resolved",
      body: "The next commit window is opening.",
      url: "/arena/arena-1",
      tag: "round-1",
    },
    ...overrides,
  };
}

function dueRecord(attempts: number): DueDelivery {
  return {
    id: "delivery-1",
    userId: "user-1",
    type: "round",
    channel: "telegram",
    status: "retrying",
    dedupeKey: "round:arena-1:1",
    createdAt: NOW,
    attempts,
    context: {
      arenaId: "arena-1",
      message: {
        title: "Round resolved",
        body: "The next commit window is opening.",
        url: "/arena/arena-1",
        tag: "round-1",
      },
    },
  };
}

describe("NotificationPipelineService (#1735)", () => {
  it("honors per-event/per-channel preferences and delivery dedupe", async () => {
    const prefs = makePrefs();
    const telegram = makeChannel("telegram", { status: "delivered" });
    const pipeline = new NotificationPipelineService({
      prefs: prefsService(prefs),
      channels: { telegram },
      now: () => NOW,
    });

    prefs.isChannelEventEnabled.mockResolvedValueOnce(false);
    expect(await pipeline.dispatch(makeInput({ channels: ["telegram"] }))).toEqual({
      delivered: 0,
      failed: 0,
      retrying: 0,
      skipped: 1,
    });
    expect(prefs.recordDelivery).not.toHaveBeenCalled();

    prefs.isChannelEventEnabled.mockResolvedValueOnce(true);
    prefs.hasDelivered.mockResolvedValueOnce(true);
    expect(await pipeline.dispatch(makeInput({ channels: ["telegram"] }))).toEqual({
      delivered: 0,
      failed: 0,
      retrying: 0,
      skipped: 1,
    });
    expect(telegram.send).not.toHaveBeenCalled();

    prefs.isChannelEventEnabled.mockResolvedValueOnce(true);
    const result = await pipeline.dispatch(makeInput({ channels: ["telegram"] }));
    expect(result.delivered).toBe(1);
    expect(prefs.recordDelivery).toHaveBeenCalledWith(
      "user-1",
      "round",
      "telegram",
      "round:arena-1:1",
      expect.objectContaining({ arenaId: "arena-1", message: expect.any(Object) }),
    );
    expect(prefs.markSent).toHaveBeenCalledWith("delivery-1");
  });

  it("uses exponential backoff and dead-letters after the retry budget", async () => {
    const prefs = makePrefs();
    const telegram = makeChannel("telegram", {
      status: "retryable",
      error: "temporary outage",
    });
    const pipeline = new NotificationPipelineService({
      prefs: prefsService(prefs),
      channels: { telegram },
      maxAttempts: 3,
      baseBackoffMs: 1000,
      now: () => NOW,
    });

    const initial = await pipeline.dispatch(makeInput({ channels: ["telegram"] }));
    expect(initial.retrying).toBe(1);
    expect(prefs.markRetrying).toHaveBeenLastCalledWith(
      "delivery-1",
      1,
      new Date(NOW.getTime() + 1000),
      "temporary outage",
    );

    prefs.getDueRetries.mockResolvedValueOnce([dueRecord(1)]);
    const second = await pipeline.processDueRetries();
    expect(second.retrying).toBe(1);
    expect(prefs.markRetrying).toHaveBeenLastCalledWith(
      "delivery-1",
      2,
      new Date(NOW.getTime() + 2000),
      "temporary outage",
    );

    prefs.getDueRetries.mockResolvedValueOnce([dueRecord(2)]);
    const terminal = await pipeline.processDueRetries();
    expect(terminal.failed).toBe(1);
    expect(prefs.markDeadLettered).toHaveBeenLastCalledWith(
      "delivery-1",
      3,
      "temporary outage",
    );
    expect(prefs.markRetrying).toHaveBeenCalledTimes(2);
  });

  it("dead-letters permanent failures and deletes skipped ledger rows", async () => {
    const prefs = makePrefs();
    const discord = makeChannel("discord", { status: "failed", error: "invalid link" });
    const pipeline = new NotificationPipelineService({
      prefs: prefsService(prefs),
      channels: { discord },
      now: () => NOW,
    });

    const result = await pipeline.dispatch(makeInput({ channels: ["discord"] }));
    expect(result.failed).toBe(1);
    expect(prefs.markDeadLettered).toHaveBeenCalledWith("delivery-1", 1, "invalid link");

    const skippedPrefs = makePrefs();
    const skippedChannel = makeChannel("telegram", { status: "skipped", error: "not linked" });
    const skippedPipeline = new NotificationPipelineService({
      prefs: prefsService(skippedPrefs),
      channels: { telegram: skippedChannel },
      now: () => NOW,
    });
    expect((await skippedPipeline.dispatch(makeInput({ channels: ["telegram"] }))).skipped).toBe(1);
    expect(skippedPrefs.deleteDelivery).toHaveBeenCalledWith("delivery-1");
  });

  it("fans out to every user but sends one webhook delivery per arena", async () => {
    const prefs = makePrefs();
    const webhook = makeChannel("webhook", { status: "delivered" });
    const pipeline = new NotificationPipelineService({
      prefs: prefsService(prefs),
      channels: { webhook },
      now: () => NOW,
    });

    const result = await pipeline.dispatch(
      makeInput({ channels: ["webhook"], userIds: ["host-1", "host-1", "host-2"] }),
    );
    expect(result.delivered).toBe(1);
    expect(webhook.send).toHaveBeenCalledTimes(1);
    expect(prefs.isChannelEventEnabled).toHaveBeenCalledTimes(1);
    expect(prefs.isChannelEventEnabled).toHaveBeenCalledWith("host-1", "round", "webhook");
  });
});

/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { createHmac } from "crypto";

jest.mock("next/cache", () => ({
  revalidateTag: jest.fn(),
  revalidatePath: jest.fn(),
}));

import { POST } from "../route";
import { revalidateTag, revalidatePath } from "next/cache";
import { LANDING_STATS_TAG } from "@/shared/lib/landingStats";

const SECRET = "revalidation-shared-secret";

function sign(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function requestWith(headers: Record<string, string>, body: string): NextRequest {
  return new NextRequest("https://app.example.com/api/revalidate", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/revalidate (#1626)", () => {
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REVALIDATION_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.REVALIDATION_WEBHOOK_SECRET;
  });

  it("revalidates the landing tag and path on a valid signature", async () => {
    const body = JSON.stringify({ reason: "factory_upgrade", requestId: "req-1" });
    const timestamp = String(now);
    const res = await POST(
      requestWith(
        {
          "content-type": "application/json",
          "x-revalidate-signature": sign(SECRET, timestamp, body),
          "x-revalidate-timestamp": timestamp,
        },
        body,
      ),
    );

    expect(res.status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith(LANDING_STATS_TAG);
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("rejects a missing signature", async () => {
    const body = JSON.stringify({ reason: "x" });
    const res = await POST(
      requestWith({ "content-type": "application/json", "x-revalidate-timestamp": String(now) }, body),
    );

    expect(res.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature", async () => {
    const body = JSON.stringify({ reason: "x" });
    const res = await POST(
      requestWith(
        {
          "content-type": "application/json",
          "x-revalidate-signature": "sha256=deadbeef",
          "x-revalidate-timestamp": String(now),
        },
        body,
      ),
    );

    expect(res.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("rejects a timestamp outside the replay window", async () => {
    const body = JSON.stringify({ reason: "x" });
    const staleTimestamp = String(now - 4000);
    const res = await POST(
      requestWith(
        {
          "content-type": "application/json",
          "x-revalidate-signature": sign(SECRET, staleTimestamp, body),
          "x-revalidate-timestamp": staleTimestamp,
        },
        body,
      ),
    );

    expect(res.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("returns 503 when the secret is not configured", async () => {
    delete process.env.REVALIDATION_WEBHOOK_SECRET;
    const body = JSON.stringify({ reason: "x" });
    const res = await POST(
      requestWith(
        {
          "content-type": "application/json",
          "x-revalidate-signature": sign(SECRET, String(now), body),
          "x-revalidate-timestamp": String(now),
        },
        body,
      ),
    );

    expect(res.status).toBe(503);
  });
});

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { revalidateTag, revalidatePath } from "next/cache";
import { serverEnv } from "@/shared/config/env/server";
import { LANDING_STATS_TAG } from "@/shared/lib/landingStats";

/**
 * On-chain configuration-change revalidation endpoint (#1626).
 *
 * The backend's RevalidationService POSTs here (signed) when it observes a
 * protocol configuration change on chain. This handler drops the ISR caches
 * that would otherwise serve stale data until their 60s window elapsed:
 *
 *  - `revalidateTag(LANDING_STATS_TAG)` drops the tagged landing-stats fetch,
 *    so the next request to `/` re-fetches it.
 *  - `revalidatePath("/")` marks the landing route itself stale, covering any
 *    other server-side fetch on the page.
 *
 * Authentication: HMAC-SHA256 over `${timestamp}.${rawBody}` with the shared
 * secret. The timestamp header bounds replay; a request older than the window
 * (or more than a small skew in the future) is rejected. Comparison is
 * constant-time.
 *
 * This route must run on the Node.js runtime: it uses `crypto` and the revalidate
 * APIs, neither of which is available in the Edge runtime under Next 16.
 */
export const runtime = "nodejs";

export const REVALIDATE_SIGNATURE_HEADER = "x-revalidate-signature";
export const REVALIDATE_TIMESTAMP_HEADER = "x-revalidate-timestamp";

/** Allowed clock skew / replay window in seconds. */
const MAX_SKEW_SECONDS = 300;

function verifySignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const expected =
    "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = serverEnv.REVALIDATION_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "REVALIDATION_WEBHOOK_SECRET not configured" },
      { status: 503 },
    );
  }

  const signature = request.headers.get(REVALIDATE_SIGNATURE_HEADER);
  const timestamp = request.headers.get(REVALIDATE_TIMESTAMP_HEADER);
  if (!signature || !timestamp) {
    return NextResponse.json({ error: "Missing signature or timestamp" }, { status: 401 });
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return NextResponse.json({ error: "Invalid timestamp" }, { status: 401 });
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > MAX_SKEW_SECONDS) {
    return NextResponse.json({ error: "Timestamp outside replay window" }, { status: 401 });
  }

  // Raw bytes, not a re-serialization of the parsed body: the sender HMACs the
  // exact wire payload, and JSON round-tripping is not byte-stable.
  const rawBody = await request.text();
  if (!verifySignature(secret, timestamp, rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  revalidateTag(LANDING_STATS_TAG);
  revalidatePath("/");

  return NextResponse.json({ revalidated: true, tag: LANDING_STATS_TAG });
}

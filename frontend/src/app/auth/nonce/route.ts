import { NextRequest, NextResponse } from "next/server";

import { nonceRateLimitConfig } from "@/server/rate-limit/config";
import { buildRateLimitRejection } from "@/server/rate-limit/limiter";

type NonceRequestBody = {
  walletAddress?: string;
};

export async function POST(request: NextRequest) {
  let body: NonceRequestBody = {};

  try {
    body = (await request.json()) as NonceRequestBody;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const walletAddress = body.walletAddress?.trim();
  const limited = await buildRateLimitRejection({
    config: nonceRateLimitConfig,
    request,
    walletAddress,
  });
  if (limited) {
    return limited;
  }

  const nonce = crypto.randomUUID();
  return NextResponse.json({
    nonce,
    expiresInSeconds: 300,
  });
}

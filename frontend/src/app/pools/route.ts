import { NextRequest, NextResponse } from "next/server";

import { poolsRateLimitConfig } from "@/server/rate-limit/config";
import { buildRateLimitRejection } from "@/server/rate-limit/limiter";

type CreatePoolBody = {
  name?: string;
  walletAddress?: string;
};

export async function POST(request: NextRequest) {
  let body: CreatePoolBody = {};

  try {
    body = (await request.json()) as CreatePoolBody;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const walletAddress = body.walletAddress?.trim();
  const limited = await buildRateLimitRejection({
    config: poolsRateLimitConfig,
    request,
    walletAddress,
  });
  if (limited) {
    return limited;
  }

  return NextResponse.json(
    {
      id: `pool-${crypto.randomUUID()}`,
      name: body.name?.trim() || "Untitled Pool",
      createdAt: new Date().toISOString(),
    },
    { status: 201 }
  );
}

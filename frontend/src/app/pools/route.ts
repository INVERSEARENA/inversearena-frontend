import { NextRequest, NextResponse } from "next/server";

import { poolsRateLimitConfig } from "@/server/rate-limit/config";
import { buildRateLimitRejection } from "@/server/rate-limit/limiter";
import { CreatePoolBodySchema } from "./validation";

export async function POST(request: NextRequest) {
  let payload: unknown = {};

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsedBody = CreatePoolBodySchema.safeParse(payload);
  if (!parsedBody.success) {
    return NextResponse.json(
      {
        error: "Validation error",
        issues: parsedBody.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 }
    );
  }

  const walletAddress = parsedBody.data.walletAddress;
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
      name: parsedBody.data.name || "Untitled Pool",
      createdAt: new Date().toISOString(),
    },
    { status: 201 }
  );
}

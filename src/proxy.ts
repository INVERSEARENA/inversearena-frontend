import { NextRequest, NextResponse } from "next/server";
import { parseAllowedOrigins } from "@/shared-d/utils/security-validation";

function getAllowedOrigins(): string[] {
  const configuredOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  const appOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN;
  const defaults =
    process.env.NODE_ENV === "development"
      ? ["http://localhost:3000", "http://127.0.0.1:3000"]
      : [];

  return Array.from(
    new Set([
      ...configuredOrigins,
      ...(appOrigin ? [appOrigin] : []),
      ...defaults,
    ])
  );
}

function buildCsp(allowedOrigins: string[]) {
  const isDev = process.env.NODE_ENV !== "production";

  const connectSrc = [
    "'self'",
    ...allowedOrigins,
    "https://horizon-testnet.stellar.org",
    "https://soroban-testnet.stellar.org",
    "https://api.coingecko.com",
  ];

  if (isDev) {
    connectSrc.push("ws:", "wss:");
  }

  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (isDev) {
    scriptSrc.push("'unsafe-eval'");
  }

  const policies = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    `connect-src ${connectSrc.join(" ")}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  if (!isDev) {
    policies.push("upgrade-insecure-requests");
  }

  return policies.join("; ");
}

function applySecurityHeaders(response: NextResponse, allowedOrigins: string[]) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), interest-cohort=()"
  );
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set("Content-Security-Policy", buildCsp(allowedOrigins));
}

function applyCorsHeaders(
  response: NextResponse,
  requestOrigin: string | null,
  allowedOrigins: string[]
) {
  if (!requestOrigin) {
    return;
  }

  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Origin", requestOrigin);
  response.headers.set("Access-Control-Allow-Credentials", "true");
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );

  if (!allowedOrigins.includes(requestOrigin)) {
    response.headers.delete("Access-Control-Allow-Origin");
  }
}

export function proxy(request: NextRequest) {
  const allowedOrigins = getAllowedOrigins();
  const requestOrigin = request.headers.get("origin");
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/");

  if (isApiRoute && requestOrigin && !allowedOrigins.includes(requestOrigin)) {
    const forbidden = NextResponse.json(
      { error: "Origin not allowed by CORS policy" },
      { status: 403 }
    );
    applySecurityHeaders(forbidden, allowedOrigins);
    return forbidden;
  }

  const response =
    isApiRoute && request.method === "OPTIONS"
      ? new NextResponse(null, { status: 204 })
      : NextResponse.next();

  applySecurityHeaders(response, allowedOrigins);

  if (isApiRoute) {
    applyCorsHeaders(response, requestOrigin, allowedOrigins);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};


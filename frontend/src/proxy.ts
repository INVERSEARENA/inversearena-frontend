import { NextRequest, NextResponse } from "next/server";
import { parseAllowedOrigins } from "@/shared-d/utils/security-validation";
import { HSTS_HEADER_VALUE, generateNonce } from "@/lib/csp";

const DEFAULT_TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
const DEFAULT_TESTNET_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_MAINNET_HORIZON_URL = "https://horizon.stellar.org";
const DEFAULT_MAINNET_SOROBAN_RPC_URL = "https://mainnet.sorobanrpc.com";

function toOrigin(url: string): string {
  const candidate = url.trim();

  try {
    return new URL(candidate).origin;
  } catch {
    return candidate;
  }
}

function getNetworkConnectSources(): string[] {
  const isMainnet =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK?.toLowerCase() === "mainnet";
  const horizonUrl =
    process.env.NEXT_PUBLIC_HORIZON_URL ??
    (isMainnet ? DEFAULT_MAINNET_HORIZON_URL : DEFAULT_TESTNET_HORIZON_URL);
  const sorobanRpcUrl =
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
    (isMainnet ? DEFAULT_MAINNET_SOROBAN_RPC_URL : DEFAULT_TESTNET_SOROBAN_RPC_URL);
  const horizonOrigin = toOrigin(horizonUrl);
  const sorobanOrigin = toOrigin(sorobanRpcUrl);
  return [horizonOrigin, sorobanOrigin];
}

function getAllowedOrigins(): string[] {
  let configuredOrigins: string[];
  try {
    configuredOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ALLOWED_ORIGINS configuration: ${message}`);
  }

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

function buildCsp(allowedOrigins: string[], nonce: string) {
  const isDev = process.env.NODE_ENV !== "production";

  const connectSrc = Array.from(
    new Set([
      "'self'",
      ...allowedOrigins,
      ...getNetworkConnectSources(),
      "https://api.coingecko.com",
    ])
  );

  if (isDev) {
    connectSrc.push("ws:", "wss:");
  }

  // #1296 — no 'unsafe-inline': an injected inline <script> must not run.
  // 'self' is kept for pre-CSP3 browsers (which honour the nonce but ignore
  // 'strict-dynamic'); 'strict-dynamic' lets the nonce'd framework bootstrap
  // load the rest of the chunk graph. Next's dev runtime still needs
  // 'unsafe-eval'.
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (isDev) {
    scriptSrc.push("'unsafe-eval'");
  }

  // #1451 — style-src: nonce allows Next.js-injected <style nonce="…"> tags;
  // 'unsafe-inline' is kept as a fallback for pre-CSP3 browsers that do not
  // understand nonces. Fonts from googleapis are explicitly allowed.
  const styleSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'unsafe-inline'",
    "https://fonts.googleapis.com",
  ];

  // #1451 — img-src: restrict to explicitly trusted origins instead of the
  // broad `https:` wildcard that previously allowed loading images from any
  // HTTPS host. data: and blob: are kept for canvas exports and wallet QR codes.
  const imgSrc = [
    "'self'",
    "data:",
    "blob:",
    "https://assets.coingecko.com",
    "https://stellar.org",
    "https://www.stellar.org",
  ];

  const policies = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    `style-src ${styleSrc.join(" ")}`,
    "font-src 'self' https://fonts.gstatic.com data:",
    `img-src ${imgSrc.join(" ")}`,
    `connect-src ${connectSrc.join(" ")}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // #1451 — worker-src: Next.js service worker and webpack HMR workers must
    // be loaded from the same origin; blob: is needed for dynamic workers
    // created by the Stellar SDK and some wallet connectors.
    "worker-src 'self' blob:",
    // #1451 — manifest-src: restrict the web app manifest to same-origin to
    // prevent a cross-origin manifest from altering the installed PWA identity.
    "manifest-src 'self'",
  ];

  if (!isDev) {
    policies.push("upgrade-insecure-requests");
  }

  return policies.join("; ");
}

function applySecurityHeaders(
  response: NextResponse,
  allowedOrigins: string[],
  nonce: string
) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), interest-cohort=()"
  );
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  // #1296 — instruct browsers to enforce HTTPS-only for this origin.
  response.headers.set("Strict-Transport-Security", HSTS_HEADER_VALUE);
  response.headers.set("Content-Security-Policy", buildCsp(allowedOrigins, nonce));
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

  // Fresh per-request CSP nonce (#1296). Exposed to the app on the forwarded
  // request headers as `x-nonce`; the root layout reads it and hands it to
  // next-themes so its inline anti-flash <script> is allowed without
  // 'unsafe-inline'.
  const nonce = generateNonce();

  if (isApiRoute && requestOrigin && !allowedOrigins.includes(requestOrigin)) {
    const forbidden = NextResponse.json(
      { error: "Origin not allowed by CORS policy" },
      { status: 403 }
    );
    applySecurityHeaders(forbidden, allowedOrigins, nonce);
    return forbidden;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response =
    isApiRoute && request.method === "OPTIONS"
      ? new NextResponse(null, { status: 204 })
      : NextResponse.next({ request: { headers: requestHeaders } });

  applySecurityHeaders(response, allowedOrigins, nonce);

  if (isApiRoute) {
    applyCorsHeaders(response, requestOrigin, allowedOrigins);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

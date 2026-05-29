import { createApp, AppDependencies } from "../src/app";
import type { PaymentService } from "../src/services/paymentService";
import type { PaymentWorker } from "../src/workers/paymentWorker";
import type { TransactionRepository } from "../src/repositories/transactionRepository";
import type { AdminService } from "../src/services/adminService";
import type { AuthService } from "../src/services/authService";
import type { Request, Response } from "express";

// ── Mock dependencies ──────────────────────────────────────────────
const mockDeps: AppDependencies = {
  paymentService: {} as PaymentService,
  paymentWorker: {} as PaymentWorker,
  transactions: {} as TransactionRepository,
  adminService: {} as AdminService,
  authService: {
    verifyToken: async () => ({ userId: "test-user" }),
  } as AuthService,
};

// ── Helper to capture response headers ────────────────────────────
function makeReq(path: string = "/health"): Request {
  return {
    path,
    method: "GET",
    headers: {},
  } as unknown as Request;
}

function makeRes(): {
  headers: Record<string, string>;
  statusCode: number;
  json: (body: unknown) => void;
  send: (body: unknown) => void;
  set: (key: string, value: string) => void;
  setHeader: (key: string, value: string) => void;
  getHeader: (key: string) => string | undefined;
} {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    json(body: unknown) {
      void body;
    },
    send(body: unknown) {
      void body;
    },
    set(key: string, value: string) {
      headers[key.toLowerCase()] = value;
    },
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
    },
    getHeader(key: string) {
      return headers[key.toLowerCase()];
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

async function testHSTSHeader() {
  console.log("🧪 Test: HSTS header is set with 1-year max-age");

  const app = createApp(mockDeps);
  const req = makeReq("/health");
  const res = makeRes();

  // Simulate middleware execution
  await new Promise<void>((resolve) => {
    app(req as Request, res as Response, () => resolve());
  });

  const hstsHeader = res.headers["strict-transport-security"];

  const assertions = [
    hstsHeader !== undefined,
    hstsHeader?.includes("max-age=31536000"),
    hstsHeader?.includes("includeSubDomains"),
    hstsHeader?.includes("preload"),
  ];

  if (assertions.every(Boolean)) {
    console.log("✅ PASS: HSTS header is correctly configured");
    console.log(`   Header: ${hstsHeader}`);
  } else {
    console.log("❌ FAIL: HSTS header is missing or incorrect");
    console.log(`   Expected: max-age=31536000; includeSubDomains; preload`);
    console.log(`   Received: ${hstsHeader}`);
    process.exit(1);
  }
}

async function testReferrerPolicyHeader() {
  console.log("\n🧪 Test: Referrer-Policy is set to strict-origin-when-cross-origin");

  const app = createApp(mockDeps);
  const req = makeReq("/health");
  const res = makeRes();

  await new Promise<void>((resolve) => {
    app(req as Request, res as Response, () => resolve());
  });

  const referrerPolicy = res.headers["referrer-policy"];

  if (referrerPolicy === "strict-origin-when-cross-origin") {
    console.log("✅ PASS: Referrer-Policy is correctly set");
    console.log(`   Header: ${referrerPolicy}`);
  } else {
    console.log("❌ FAIL: Referrer-Policy is missing or incorrect");
    console.log(`   Expected: strict-origin-when-cross-origin`);
    console.log(`   Received: ${referrerPolicy}`);
    process.exit(1);
  }
}

async function testCrossOriginOpenerPolicy() {
  console.log("\n🧪 Test: Cross-Origin-Opener-Policy is set to same-origin");

  const app = createApp(mockDeps);
  const req = makeReq("/health");
  const res = makeRes();

  await new Promise<void>((resolve) => {
    app(req as Request, res as Response, () => resolve());
  });

  const coopHeader = res.headers["cross-origin-opener-policy"];

  if (coopHeader === "same-origin") {
    console.log("✅ PASS: Cross-Origin-Opener-Policy is correctly set");
    console.log(`   Header: ${coopHeader}`);
  } else {
    console.log("❌ FAIL: Cross-Origin-Opener-Policy is missing or incorrect");
    console.log(`   Expected: same-origin`);
    console.log(`   Received: ${coopHeader}`);
    process.exit(1);
  }
}

async function testCrossOriginResourcePolicy() {
  console.log("\n🧪 Test: Cross-Origin-Resource-Policy is set to cross-origin");

  const app = createApp(mockDeps);
  const req = makeReq("/health");
  const res = makeRes();

  await new Promise<void>((resolve) => {
    app(req as Request, res as Response, () => resolve());
  });

  const corpHeader = res.headers["cross-origin-resource-policy"];

  if (corpHeader === "cross-origin") {
    console.log("✅ PASS: Cross-Origin-Resource-Policy is correctly set");
    console.log(`   Header: ${corpHeader}`);
  } else {
    console.log("❌ FAIL: Cross-Origin-Resource-Policy is missing or incorrect");
    console.log(`   Expected: cross-origin`);
    console.log(`   Received: ${corpHeader}`);
    process.exit(1);
  }
}

async function testXFrameOptions() {
  console.log("\n🧪 Test: X-Frame-Options is set (Helmet default)");

  const app = createApp(mockDeps);
  const req = makeReq("/health");
  const res = makeRes();

  await new Promise<void>((resolve) => {
    app(req as Request, res as Response, () => resolve());
  });

  const xFrameOptions = res.headers["x-frame-options"];

  if (xFrameOptions) {
    console.log("✅ PASS: X-Frame-Options is set");
    console.log(`   Header: ${xFrameOptions}`);
  } else {
    console.log("❌ FAIL: X-Frame-Options is missing");
    process.exit(1);
  }
}

async function testPermittedCrossDomainPolicies() {
  console.log("\n🧪 Test: X-Permitted-Cross-Domain-Policies is set to none");

  const app = createApp(mockDeps);
  const req = makeReq("/health");
  const res = makeRes();

  await new Promise<void>((resolve) => {
    app(req as Request, res as Response, () => resolve());
  });

  const pcdpHeader = res.headers["x-permitted-cross-domain-policies"];

  if (pcdpHeader === "none") {
    console.log("✅ PASS: X-Permitted-Cross-Domain-Policies is correctly set");
    console.log(`   Header: ${pcdpHeader}`);
  } else {
    console.log("❌ FAIL: X-Permitted-Cross-Domain-Policies is missing or incorrect");
    console.log(`   Expected: none`);
    console.log(`   Received: ${pcdpHeader}`);
    process.exit(1);
  }
}

async function testAllSecurityHeaders() {
  console.log("\n🧪 Test: All security headers are present");

  const app = createApp(mockDeps);
  const req = makeReq("/health");
  const res = makeRes();

  await new Promise<void>((resolve) => {
    app(req as Request, res as Response, () => resolve());
  });

  const requiredHeaders = [
    "strict-transport-security",
    "referrer-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "x-frame-options",
    "x-permitted-cross-domain-policies",
    "x-content-type-options",
    "x-dns-prefetch-control",
  ];

  const missingHeaders = requiredHeaders.filter(
    (header) => !res.headers[header]
  );

  if (missingHeaders.length === 0) {
    console.log("✅ PASS: All required security headers are present");
    console.log("\n📋 Security Headers Summary:");
    requiredHeaders.forEach((header) => {
      console.log(`   ${header}: ${res.headers[header]}`);
    });
  } else {
    console.log("❌ FAIL: Some security headers are missing");
    console.log(`   Missing: ${missingHeaders.join(", ")}`);
    process.exit(1);
  }
}

async function runTests() {
  try {
    await testHSTSHeader();
    await testReferrerPolicyHeader();
    await testCrossOriginOpenerPolicy();
    await testCrossOriginResourcePolicy();
    await testXFrameOptions();
    await testPermittedCrossDomainPolicies();
    await testAllSecurityHeaders();
    console.log("\n🎉 All security header tests passed");
  } catch (error) {
    console.error("Test suite failed:", error);
    process.exit(1);
  }
}

runTests();

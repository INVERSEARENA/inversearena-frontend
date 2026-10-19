import { Router, type RequestHandler } from "express";
import { Contract, Networks, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { asyncHandler } from "../middleware/validate";
import { createRateLimitMiddleware, getPoolsRateLimitConfig } from "../middleware/rateLimit";
import { apiError } from "../utils/apiError";

const submitSchema = z.object({
  contact: z.string().trim().min(3).max(320),
  intent: z.string().trim().min(10).max(4000),
});
const reviewSchema = z.object({ note: z.string().trim().max(2000).optional() });
const approveSchema = reviewSchema.extend({ adminWallet: z.string().regex(/^G[A-Z2-7]{55}$/) });
const confirmSchema = z.object({ txHash: z.string().regex(/^[a-f0-9]{64}$/i) });

function openApplicationWhere(wallet: string) {
  return { wallet, status: { in: ["PENDING", "APPROVED"] } };
}

export function createHostWhitelistRouter(
  prisma: PrismaClient,
  requireAuth: RequestHandler,
  adminAuth: RequestHandler,
): Router {
  const router = Router();

  router.post(
    "/whitelist-applications",
    requireAuth,
    createRateLimitMiddleware(getPoolsRateLimitConfig()),
    asyncHandler(async (req, res) => {
      const wallet = req.user?.walletAddress;
      if (!wallet) throw apiError(401, "UNAUTHENTICATED", "Wallet authentication required");
      const input = submitSchema.parse(req.body);
      const existing = await prisma.hostWhitelistApplication.findFirst({ where: openApplicationWhere(wallet) });
      if (existing) throw apiError(409, "APPLICATION_OPEN", "This wallet already has an open whitelist application");
      const application = await prisma.hostWhitelistApplication.create({ data: { wallet, ...input } });
      res.status(201).json(application);
    }),
  );

  router.get(
    "/whitelist/status",
    requireAuth,
    asyncHandler(async (req, res) => {
      const wallet = req.user?.walletAddress;
      if (!wallet) throw apiError(401, "UNAUTHENTICATED", "Wallet authentication required");
      const application = await prisma.hostWhitelistApplication.findFirst({ where: { wallet }, orderBy: { createdAt: "desc" } });
      // Confirmed means the reconciler observed add_to_whitelist on-chain.
      res.json({ isWhitelisted: application?.status === "CONFIRMED", application });
    }),
  );
  router.get(
    "/whitelist-applications/me",
    requireAuth,
    asyncHandler(async (req, res) => {
      const wallet = req.user?.walletAddress;
      if (!wallet) throw apiError(401, "UNAUTHENTICATED", "Wallet authentication required");
      res.json(await prisma.hostWhitelistApplication.findMany({ where: { wallet }, orderBy: { createdAt: "desc" } }));
    }),
  );

  const admin = Router();
  admin.use(adminAuth);
  admin.get("/whitelist-applications", asyncHandler(async (_req, res) => {
    res.json(await prisma.hostWhitelistApplication.findMany({ orderBy: { createdAt: "desc" } }));
  }));
  admin.post("/whitelist-applications/:id/approve", asyncHandler(async (req, res) => {
    const input = approveSchema.parse(req.body);
    const application = await prisma.hostWhitelistApplication.findUnique({ where: { id: req.params.id } });
    if (!application) throw apiError(404, "APPLICATION_NOT_FOUND", "Whitelist application not found");
    if (application.status !== "PENDING") throw apiError(409, "INVALID_STATE", "Only pending applications can be approved");

    const contractId = process.env.ARENA_FACTORY_CONTRACT_ID;
    const rpcUrl = process.env.SOROBAN_RPC_URL;
    const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
    if (!contractId || !rpcUrl) throw apiError(503, "FACTORY_NOT_CONFIGURED", "Factory transaction preparation is unavailable");
    const server = new rpc.Server(rpcUrl);
    const account = await server.getAccount(input.adminWallet);
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: passphrase })
      .addOperation(new Contract(contractId).call("add_to_whitelist", nativeToScVal(application.wallet, { type: "address" })))
      .setTimeout(300)
      .build();
    const updated = await prisma.hostWhitelistApplication.update({
      where: { id: application.id },
      data: { status: "APPROVED", reviewer: req.adminId ?? "admin", reviewNote: input.note, unsignedXdr: tx.toXDR(), reviewedAt: new Date() },
    });
    res.json(updated);
  }));
  admin.post("/whitelist-applications/:id/reject", asyncHandler(async (req, res) => {
    const input = reviewSchema.parse(req.body);
    const application = await prisma.hostWhitelistApplication.findUnique({ where: { id: req.params.id } });
    if (!application) throw apiError(404, "APPLICATION_NOT_FOUND", "Whitelist application not found");
    if (application.status !== "PENDING") throw apiError(409, "INVALID_STATE", "Only pending applications can be rejected");
    res.json(await prisma.hostWhitelistApplication.update({ where: { id: application.id }, data: { status: "REJECTED", reviewer: req.adminId ?? "admin", reviewNote: input.note, reviewedAt: new Date() } }));
  }));
  admin.post("/whitelist-applications/:id/confirm", asyncHandler(async (req, res) => {
    const { txHash } = confirmSchema.parse(req.body);
    const application = await prisma.hostWhitelistApplication.findUnique({ where: { id: req.params.id } });
    if (!application || application.status !== "APPROVED") throw apiError(409, "INVALID_STATE", "Only approved applications can be confirmed");
    // The reconciler calls this endpoint only after observing a successful
    // add_to_whitelist invocation; approval alone never implies on-chain state.
    res.json(await prisma.hostWhitelistApplication.update({ where: { id: application.id }, data: { status: "CONFIRMED", txHash, confirmedAt: new Date() } }));
  }));

  router.use("/admin", admin);
  return router;
}

import type { NextFunction, Request, Response } from "express";
import type { TransactionIntentService } from "../services/transactionIntentService";
import { apiError } from "../utils/apiError";
import { contextLogger } from "../utils/logger";

/**
 * The frontend has no wallet-login (JWT) flow wired up anywhere yet — every
 * existing frontend-to-backend call in this repo is unauthenticated fetch(),
 * including calls to routes nominally gated by requireAuth server-side. Wiring
 * a real login flow is a separate, larger feature outside #1381's scope, so
 * ownership here is self-reported: the caller states which wallet the intent
 * belongs to, the same way client-supplied `publicKey`/`walletAddress` fields
 * already flow through this codebase's Zod-validated request bodies
 * elsewhere. This is a real, deliberate trade-off, not an oversight — see
 * docs/TRANSACTION_INTENTS.md §1. An intent never grants on-chain authority
 * (only the wallet's own signature can move funds, and that signature is
 * never captured server-side), so a caller mis-stating another wallet's
 * address can at most pollute that wallet's *bookkeeping* rows, not act on
 * its behalf.
 */
function ownerWallet(req: Request): string {
  const wallet =
    (req.body as { ownerWallet?: unknown })?.ownerWallet ?? (req.query as { ownerWallet?: unknown })?.ownerWallet;
  if (typeof wallet !== "string" || !wallet) {
    throw apiError(400, "VALIDATION_ERROR", "ownerWallet is required");
  }
  return wallet;
}

export class TransactionIntentsController {
  constructor(private readonly intents: TransactionIntentService) {}

  create = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const wallet = ownerWallet(req);
    const result = await this.intents.createOrResumeIntent(req.body, wallet);
    contextLogger().info(
      { intentId: result.intent.id, kind: result.intent.kind, mode: result.mode },
      "Transaction intent created or resumed"
    );
    res.status(result.mode === "created" ? 201 : 200).json(result);
  };

  getById = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const wallet = ownerWallet(req);
    const intent = await this.intents.getIntent(req.params.id!, wallet);
    res.json(intent);
  };

  markAwaitingSignature = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const wallet = ownerWallet(req);
    const intent = await this.intents.markAwaitingSignature(req.params.id!, wallet);
    res.json(intent);
  };

  recordSignatureFailure = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const wallet = ownerWallet(req);
    const { reason } = req.body as { reason: "rejected" | "expired" };
    const intent = await this.intents.recordSignatureRejectedOrExpired(req.params.id!, wallet, reason);
    res.json(intent);
  };

  attachSignedXdr = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const wallet = ownerWallet(req);
    const { signedXdr } = req.body as { signedXdr: string };
    const intent = await this.intents.attachSignedXdr(req.params.id!, wallet, signedXdr);
    res.json(intent);
  };

  recordSubmissionOutcome = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const wallet = ownerWallet(req);
    const body = req.body as
      | { status: "confirmed"; txHash: string }
      | { status: "failed"; errorMessage: string };
    const intent = await this.intents.recordSubmissionOutcome(req.params.id!, wallet, body);
    contextLogger().info(
      { intentId: intent.id, kind: intent.kind, status: intent.status },
      "Transaction intent reached a submission outcome"
    );
    res.json(intent);
  };
}

import { Router } from "express";
import { z } from "zod";
import { asyncHandler, validateBody } from "../middleware/validate";
import { verifyWebhookSignature } from "../middleware/verifyWebhook";
import { getKeyring } from "../config/secretKeyring";
import type { RevalidationService } from "../services/revalidationService";

/**
 * Inbound on-chain configuration-change webhook (#1626).
 *
 * The on-chain watcher (or an operator tool) POSTs here when it observes a
 * protocol configuration change — a factory/arena/payout contract upgrade, a
 * fee schedule revision, or a new deployment. This handler is a thin shell
 * around {@link RevalidationService.revalidateConfig}: it authenticates the
 * caller with the same HMAC keyring mechanism as the oracle webhook (#1127,
 * #1456) and maps the payload to a revalidation.
 *
 * Authentication reuses `ORACLE_WEBHOOK_SECRET` deliberately: it is the
 * existing inbound webhook key with rotation support, and the on-chain watcher
 * is the same trusted infrastructure. A separate secret would add rotation
 * surface without changing the trust boundary.
 *
 * The route is mounted behind a raw-body JSON parser (see app.ts) so the HMAC
 * is computed over the exact bytes the sender transmitted, not a
 * re-serialization of the parsed object.
 */

const ConfigChangedSchema = z.object({
  /** Short label for logs, e.g. "factory_upgrade", "fee_schedule". */
  reason: z.string().trim().min(1).max(120),
  /**
   * Contract ids whose derived caches must be dropped. Optional: a change with
   * no specific contract (e.g. a fee schedule tweak) still purges the global
   * configuration tags.
   */
  contracts: z.array(z.string().regex(/^C[A-Z2-7]{55}$/, "must be a Soroban contract id")).max(50).optional(),
});

export function createWebhooksRouter(revalidationService: RevalidationService): Router {
  const router = Router();

  router.post(
    "/config-changed",
    asyncHandler(async (req, res, next) => {
      const keyring = getKeyring("webhook");
      if (!keyring) {
        res.status(503).json({ error: "ORACLE_WEBHOOK_SECRET not configured" });
        return;
      }
      verifyWebhookSignature(keyring)(req, res, next);
    }),
    validateBody(ConfigChangedSchema),
    asyncHandler(async (req, res) => {
      const { reason, contracts } = req.body as z.infer<typeof ConfigChangedSchema>;
      const result = await revalidationService.revalidateConfig(reason, contracts ?? []);
      res.status(200).json({
        revalidated: true,
        requestId: result.requestId,
        purgedTags: result.purgedTags,
        invalidatedContracts: result.invalidatedContracts,
        frontendNotified: result.frontendNotified,
      });
    }),
  );

  return router;
}

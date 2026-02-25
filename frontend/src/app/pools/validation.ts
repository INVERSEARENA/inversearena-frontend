import { z } from "zod";

import { StellarPublicKeySchema } from "../../shared-d/utils/security-validation.ts";

export const CreatePoolBodySchema = z.object({
  name: z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
    z.string().max(256, "Pool name must be 256 characters or less").optional()
  ),
  walletAddress: z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
    StellarPublicKeySchema.optional()
  ),
});

export type CreatePoolBody = z.infer<typeof CreatePoolBodySchema>;

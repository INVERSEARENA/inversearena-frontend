import { z } from "zod";
import {
  ArenaCapacitySchema,
  PoolCurrencySchema,
  PositiveAmountSchema,
  RoundSpeedSchema,
} from "@/shared/lib/security-validation";

export const CreatePoolParamsSchema = z.object({
  stakeAmount: PositiveAmountSchema,
  currency: PoolCurrencySchema,
  roundSpeed: RoundSpeedSchema,
  arenaCapacity: ArenaCapacitySchema,
  /** Seconds from now until the lobby stops accepting joins (#1579). */
  startDeadlineSeconds: z.number().int().positive().max(2_592_000).optional(),
  /** SHA-256 of the canonical metadata JSON (#1577), as 32 bytes. */
  metadataHash: z.instanceof(Uint8Array).optional(),
});

export type CreatePoolParamsValidated = z.infer<typeof CreatePoolParamsSchema>;

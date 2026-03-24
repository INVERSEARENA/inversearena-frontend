import { z } from "zod";
import {
  ArenaCapacitySchema,
  PoolCurrencySchema,
  PositiveAmountSchema,
  RoundSpeedSchema,
} from "@/shared-d/utils/security-validation";

export const CreatePoolParamsSchema = z.object({
  stakeAmount: PositiveAmountSchema,
  currency: PoolCurrencySchema,
  roundSpeed: RoundSpeedSchema,
  arenaCapacity: ArenaCapacitySchema,
});

export type CreatePoolParamsValidated = z.infer<typeof CreatePoolParamsSchema>;

import type { Request, Response } from "express";
import { z } from "zod";
import type { WebhookService } from "../services/webhooks/webhookService";

const CreateSubscriptionSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  secret: z.string().min(32, "Secret must be at least 32 characters"),
  eventFilters: z.array(z.string()).optional(),
});

const ReplayDeliverySchema = z.object({
  subscriptionId: z.string().uuid(),
  outboxEventId: z.string().uuid(),
});

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export class WebhookSubscriptionController {
  constructor(private readonly webhookService: WebhookService) {}

  /**
   * Create a new webhook subscription.
   */
  createSubscription = async (req: Request, res: Response): Promise<void> => {
    const body = CreateSubscriptionSchema.parse(req.body);
    const result = await this.webhookService.createSubscription(body);
    res.status(201).json(result);
  };

  /**
   * List delivery logs for a subscription.
   */
  listDeliveryLogs = async (req: Request, res: Response): Promise<void> => {
    const { subscriptionId } = req.params;
    const { limit, offset } = QuerySchema.parse(req.query);

    const logs = await this.webhookService.getDeliveryLogs(subscriptionId, limit, offset);
    res.status(200).json(logs);
  };

  /**
   * Manually replay a delivery.
   */
  replayDelivery = async (req: Request, res: Response): Promise<void> => {
    const { subscriptionId, outboxEventId } = ReplayDeliverySchema.parse(req.body);
    const result = await this.webhookService.replayDelivery(subscriptionId, outboxEventId);
    res.status(200).json(result);
  };
}

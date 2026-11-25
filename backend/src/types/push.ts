/**
 * Web Push Notification Types
 */

export interface PushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  expirationTime?: number | null;
  createdAt: Date;
  lastUsedAt?: Date;
}

export interface PushAlert {
  id: string;
  type: AlertType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  ttl?: number; // Time to live in seconds
  createdAt: Date;
  expiresAt?: Date;
}

export type AlertType = 
  | 'round_start'
  | 'round_end'
  | 'elimination'
  | 'winner'
  | 'payout'
  | 'arena_update'
  | 'system';

export interface PushJobData {
  alertId: string;
  subscriptionId: string;
  alert: PushAlert;
  subscription: PushSubscription;
  attemptNumber?: number;
  idempotencyKey: string; // Prevents duplicate sends after worker restart
}

export interface BulkPushJobData {
  alertId: string;
  alert: PushAlert;
  subscriptionIds: string[];
  batchId: string;
}

export interface PushResult {
  subscriptionId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  shouldPrune?: boolean; // Subscription expired/invalid
  deliveryLatencyMs?: number;
}

export interface PushDeliveryMetrics {
  alertId: string;
  totalSubscriptions: number;
  successful: number;
  failed: number;
  pruned: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

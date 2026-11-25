import type { RetentionConfig } from "../config/workerConfig";

export type RetentionStrategy = "delete" | "archive" | "pseudonymize" | "partition";
export interface RetentionPolicy {
  model: string;
  ageColumn: string;
  retentionDays: number | ((config: RetentionConfig) => number);
  strategy: RetentionStrategy;
  batchSize: number;
  legalHoldColumn?: string;
  where?: Record<string, unknown>;
  description: string;
}

/** Central registry consumed by the worker and operational policy docs. */
export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  { model: "elimination_logs", ageColumn: "createdAt", retentionDays: (c) => c.eliminationLogsArchiveAfterMonths * 30, strategy: "partition", batchSize: 0, description: "Partitioned audit history moved to the cold archive schema." },
  { model: "transactions", ageColumn: "createdAt", retentionDays: (c) => c.transactionsArchiveAfterMonths * 30, strategy: "partition", batchSize: 0, description: "Partitioned financial history moved to the cold archive schema." },
  { model: "notificationDelivery", ageColumn: "createdAt", retentionDays: 365, strategy: "delete", batchSize: 500, where: { status: { in: ["sent", "delivered", "failed"] } }, description: "Terminal notification delivery ledger entries; pending deliveries are retained." },
  { model: "webhookDeliveryLog", ageColumn: "createdAt", retentionDays: 90, strategy: "delete", batchSize: 500, where: { status: { in: ["delivered", "failed"] } }, description: "Completed webhook delivery attempts; pending retries and active subscription state are retained." },
  { model: "messageReport", ageColumn: "createdAt", retentionDays: 365, strategy: "delete", batchSize: 200, where: { status: { in: ["reviewed", "dismissed"] } }, description: "Closed moderation reports after the review retention window; pending reports are treated as legal holds." },
  { model: "arenaMessage", ageColumn: "createdAt", retentionDays: 365, strategy: "delete", batchSize: 500, where: { status: { in: ["muted", "deleted"] } }, description: "Moderated chat history after one year; active messages remain available." },
];

export function retentionPolicyDays(policy: RetentionPolicy, config: RetentionConfig): number {
  return typeof policy.retentionDays === "function" ? policy.retentionDays(config) : policy.retentionDays;
}

export function renderRetentionPolicyMarkdown(): string {
  const rows = RETENTION_POLICIES.map((policy) =>
    `| \`${policy.model}\` | \`${policy.ageColumn}\` | ${typeof policy.retentionDays === "number" ? `${policy.retentionDays} days` : "Configured by worker settings"} | ${policy.strategy} | ${policy.batchSize || "Partition"} | ${policy.description} |`,
  );
  return [
    "# Data retention policy (generated from `backend/src/workers/retentionPolicies.ts`)",
    "",
    "The retention worker applies these policies in batches. Partitioned financial and audit tables are detached into the `archive` schema; the worker does not drop archived history. Mongo authentication artifacts keep their TTL-backed cleanup policy in the worker.",
    "",
    "| Model/table | Age column | Retention | Strategy | Batch size | Notes |",
    "|---|---|---:|---|---:|---|",
    ...rows,
    "",
    "Policies may declare an explicit legal-hold column and always preserve open work: pending notifications, pending webhook retries, pending moderation reports, and active chat are excluded by their policy filters.",
    "",
  ].join("\n");
}

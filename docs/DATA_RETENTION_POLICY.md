# Data retention policy (generated from `backend/src/workers/retentionPolicies.ts`)

The retention worker applies these policies in batches. Partitioned financial and audit tables are detached into the `archive` schema; the worker does not drop archived history. Mongo authentication artifacts keep their TTL-backed cleanup policy in the worker.

| Model/table | Age column | Retention | Strategy | Batch size | Notes |
|---|---|---:|---|---:|---|
| `elimination_logs` | `createdAt` | Configured by worker settings | partition | Partition | Partitioned audit history moved to the cold archive schema. |
| `transactions` | `createdAt` | Configured by worker settings | partition | Partition | Partitioned financial history moved to the cold archive schema. |
| `notificationDelivery` | `createdAt` | 365 days | delete | 500 | Terminal notification delivery ledger entries. |
| `webhookDeliveryLog` | `createdAt` | 90 days | delete | 500 | Webhook delivery attempts; active subscription state is retained. |
| `messageReport` | `createdAt` | 365 days | delete | 200 | Moderation reports after the review retention window. |
| `arenaMessage` | `createdAt` | 365 days | delete | 500 | Arena chat history after one year. |

Rows under legal hold are excluded when a policy declares a legal-hold column. A policy without a legal-hold column has no model-level legal-hold capability.

Regenerate this file with `tsx backend/scripts/render-retention-policy.ts` from the repository root.

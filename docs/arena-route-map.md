# Arena route consolidation (#1754)

| Previous path | Canonical path | Behavior |
| --- | --- | --- |
| `/arena-v2` | `/arena` | Permanent redirect |
| `/arena-v2/settings` | `/arena/settings` | Permanent redirect |
| `/dashboard/settings` | `/arena/settings` | Permanent redirect |
| `/arena-v2/waiting` | `/arena/waiting` | Permanent redirect |
| `/arena-v2/withdrawal-success` | `/arena/withdrawal-success` | Permanent redirect |
| `/arena-v2/share-test` | `/dev/share-test` | Permanent redirect |

Route implementations live under `src/features/arena/pages`; the App Router files
under `/arena` are thin mounting points. Authenticated arena and dashboard routes
remain excluded from the public sitemap.

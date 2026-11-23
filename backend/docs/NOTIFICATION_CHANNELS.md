# Notification channels

Notification scheduling is transport independent: callers decide the alert type, audience, and payload, while `NotificationDispatcher` applies channel preferences, delivery deduplication, retries, and the shared `NotificationDelivery` ledger. Each transport implements `NotificationChannel` with subscription validation, send behavior, and error classification.

`PushService` remains responsible for Web Push subscription storage and encryption. Its Web Push channel implements RFC 8291 payload encryption and VAPID authentication. A 404 or 410 response expires and removes only that endpoint. Other delivery failures remain retryable; successful delivery to any device marks the user's notification sent, preserving existing fanout behavior.

New transports should implement `NotificationChannel`, provide a channel-specific subscription store, and call the shared dispatcher. Scheduling code should not add transport-specific preference or ledger logic.

// @ts-ignore
import * as Sentry from "@sentry/node";
// @ts-ignore
import { ProfilingIntegration } from "@sentry/profiling-node";

export const initSentry = () => {
    if (process.env.SENTRY_DSN) {
        Sentry.init({
            dsn: process.env.SENTRY_DSN,
            integrations: [
                new ProfilingIntegration(),
            ],
            tracesSampleRate: 1.0,
            profilesSampleRate: 1.0,
            beforeSend: (event) => {
                // Redact JWT_SECRET in case it accidentally leaks into Sentry payload
                if (process.env.JWT_SECRET && event.exception?.values?.[0]?.value?.includes(process.env.JWT_SECRET)) {
                    event.exception.values[0].value = event.exception.values[0].value.replace(
                        process.env.JWT_SECRET,
                        "[REDACTED]"
                    );
                }
                return event;
            },
            environment: process.env.NODE_ENV || "development",
        });
    }
};

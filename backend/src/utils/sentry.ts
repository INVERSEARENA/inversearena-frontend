// @ts-ignore
import * as Sentry from "@sentry/node";
// @ts-ignore
import { ProfilingIntegration } from "@sentry/profiling-node";
import { redactSecrets } from "../../../frontend/src/shared-d/security/redaction";

export const initSentry = () => {
    if (process.env.SENTRY_DSN) {
        Sentry.init({
            dsn: process.env.SENTRY_DSN,
            integrations: [
                new ProfilingIntegration(),
            ],
            tracesSampleRate: 1.0,
            profilesSampleRate: 1.0,
            beforeSend: (event: any) => {
                const configuredSecrets = [
                    process.env.JWT_SECRET,
                    process.env.ADMIN_API_KEY,
                ].filter(Boolean) as string[];
                return redactSecrets(event, { configuredSecrets });
            },
            environment: process.env.NODE_ENV || "development",
        });
    }
};

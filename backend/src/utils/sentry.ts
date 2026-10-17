// @ts-ignore
import * as Sentry from "@sentry/node";
// @ts-ignore
import { ProfilingIntegration } from "@sentry/profiling-node";
import { redactSecrets } from "../../../frontend/src/shared-d/security/redaction";
import { config } from "../config";

export const initSentry = () => {
    if (config.SENTRY_DSN) {
        Sentry.init({
            dsn: config.SENTRY_DSN,
            integrations: [
                new ProfilingIntegration(),
            ],
            tracesSampleRate: 1.0,
            profilesSampleRate: 1.0,
            beforeSend: (event: any) => {
                const configuredSecrets = [
                    config.JWT_SECRET,
                    config.ADMIN_API_KEY,
                ].filter(Boolean) as string[];
                return redactSecrets(event, { configuredSecrets });
            },
            environment: config.NODE_ENV || "development",
        });
    }
};

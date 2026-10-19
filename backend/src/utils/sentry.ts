// @ts-ignore
import * as Sentry from "@sentry/node";
// @ts-ignore
import { ProfilingIntegration } from "@sentry/profiling-node";
import { redactSecrets } from "../../../frontend/src/shared/lib/security/redaction";
import { env } from "../config/env";

export const initSentry = () => {
    if (env.SENTRY_DSN) {
        Sentry.init({
            dsn: env.SENTRY_DSN,
            integrations: [
                new ProfilingIntegration(),
            ],
            tracesSampleRate: 1.0,
            profilesSampleRate: 1.0,
            beforeSend: (event: any) => {
                const configuredSecrets = [
                    env.JWT_SECRET,
                    env.ADMIN_API_KEY,
                ].filter(Boolean) as string[];
                return redactSecrets(event, { configuredSecrets });
            },
            environment: env.NODE_ENV || "development",
        });
    }
};

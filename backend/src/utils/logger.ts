import pino from "pino";
import { trace } from "@opentelemetry/api";
// @ts-ignore
import * as Sentry from "@sentry/node";
import { redactSecrets } from "../../../frontend/src/shared/lib/security/redaction";
import { getRequestId } from "./requestContext";
import { env } from "../config/env";

const redactPaths = [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.body.password",
    "req.body.token",
    "JWT_SECRET",
    "ADMIN_API_KEY",
];

export const maskWalletAddress = (address?: string) => {
    if (!address || address.length < 12) return address;
    return `${address.slice(0, 8)}...${address.slice(-4)}`;
};

const configuredSecrets = [
    env.JWT_SECRET,
    env.ADMIN_API_KEY,
].filter(Boolean) as string[];

const INVALID_TRACE_ID = "00000000000000000000000000000000";

export function activeTraceContext(): { traceId: string; spanId: string } | undefined {
    const span = trace.getActiveSpan();
    if (!span) return undefined;
    const { traceId, spanId } = span.spanContext();
    if (!traceId || traceId === INVALID_TRACE_ID) return undefined;
    return { traceId, spanId };
}

export const logger = pino({
    level: env.LOG_LEVEL || "info",
    redact: {
        paths: redactPaths,
        censor: "[REDACTED]",
    },
    mixin() {
        return activeTraceContext() ?? {};
    },
    formatters: {
        level: (label) => {
            return { level: label };
        },
        log: (object) =>
            redactSecrets(object, { configuredSecrets }) as Record<string, unknown>,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
});

/** A child logger carrying the current request id, for service-layer logs (#661). */
export const contextLogger = () => {
    const requestId = getRequestId();
    return requestId ? logger.child({ requestId }) : logger;
};

export const reportErrorToSentry = (err: Error, context?: Record<string, any>) => {
    Sentry.withScope((scope: any) => {
        // Tie the Sentry event back to the originating request (#661) and active trace (#1844).
        const requestId = getRequestId();
        if (requestId) scope.setTag("requestId", requestId);
        const traceCtx = activeTraceContext();
        if (traceCtx) {
            scope.setTag("traceId", traceCtx.traceId);
            scope.setTag("spanId", traceCtx.spanId);
        }

        if (context) {
            if (context.userWallet) {
                context.userWalletMasked = maskWalletAddress(context.userWallet);
                delete context.userWallet;
            }
            scope.setExtras(context);

            if (context.arenaId) scope.setTag("arenaId", context.arenaId);
            if (context.poolId) scope.setTag("poolId", context.poolId);
            if (context.userWalletMasked) scope.setTag("userWallet", context.userWalletMasked);
        }
        Sentry.captureException(err);
    });
};

import pino from "pino";
// @ts-ignore
import * as Sentry from "@sentry/node";

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

export const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    redact: {
        paths: redactPaths,
        censor: "[REDACTED]",
    },
    formatters: {
        level: (label) => {
            return { level: label };
        },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
});

export const reportErrorToSentry = (err: Error, context?: Record<string, any>) => {
    Sentry.withScope((scope) => {
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

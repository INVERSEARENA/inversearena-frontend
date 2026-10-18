export interface BuildRateLimitKeysOptions {
  ip: string;
  walletAddress?: string | null;
  dualScope?: boolean;
  appNamespace?: string;
}

/**
 * Builds standard Redis rate-limit keys.
 *
 * When `dualScope` is true and a wallet is supplied, returns two independent keys:
 * one scoped to IP and one scoped to wallet.
 *
 * An optional `appNamespace` can be provided (or set via `RATE_LIMIT_APP_NAMESPACE`)
 * to prevent collisions between different applications sharing the same Redis instance.
 */
export function buildRateLimitKeys(options: BuildRateLimitKeysOptions): string[] {
  const { ip, walletAddress, dualScope, appNamespace } = options;
  const envNamespace = process.env.RATE_LIMIT_APP_NAMESPACE;
  const namespacePrefix = appNamespace ?? (envNamespace ? `${envNamespace}:` : "");
  const normalizedWallet = walletAddress ? walletAddress.toLowerCase().trim() : null;

  if (dualScope && normalizedWallet) {
    return [
      `${namespacePrefix}ip:${ip}`,
      `${namespacePrefix}wallet:${normalizedWallet}`,
    ];
  }

  if (normalizedWallet) {
    return [`${namespacePrefix}ip:${ip}:wallet:${normalizedWallet}`];
  }

  return [`${namespacePrefix}ip:${ip}`];
}

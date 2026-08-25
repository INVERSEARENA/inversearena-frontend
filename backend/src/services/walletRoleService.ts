// Stellar public keys start with G and are exactly 56 alphanumeric (base32) characters.
const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

export function isValidStellarAddress(address: string): boolean {
  return STELLAR_PUBLIC_KEY_REGEX.test(address);
}

function getAdminWalletAllowlist(): Set<string> {
  const raw = process.env.ADMIN_WALLET_ADDRESSES ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

/**
 * Server-side check for whether a connected Stellar wallet is an authorized
 * arena operator/admin. Backed by the ADMIN_WALLET_ADDRESSES allowlist so
 * client-side "wallet connected" state can never be mistaken for authorization.
 */
export function isAuthorizedAdminWallet(address: string): boolean {
  if (!isValidStellarAddress(address)) return false;
  return getAdminWalletAllowlist().has(address);
}

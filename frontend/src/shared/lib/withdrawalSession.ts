/**
 * Utilities for the single-use withdrawal-success session guard (#1298).
 *
 * Before navigating to `/arena-v2/withdrawal-success`, the withdrawal flow
 * must call `markWithdrawalComplete()` to store a one-time token in
 * sessionStorage.  The success page calls `consumeWithdrawalToken()` which
 * returns `true` exactly once and immediately removes the token, preventing
 * the page from being rendered again on refresh or from a crafted URL.
 */

export const WITHDRAWAL_TOKEN_KEY = "ia_withdrawal_success_token";

/**
 * Write a one-time token into sessionStorage before navigating to the
 * withdrawal-success page.  Call this from the code that processes the
 * on-chain transaction and then redirects.
 */
export function markWithdrawalComplete(): void {
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(WITHDRAWAL_TOKEN_KEY, "1");
  }
}

/**
 * Read and immediately remove the one-time token.
 *
 * @returns `true` if a valid token was present (the navigation originated
 *          from the real withdrawal flow), `false` if the token is absent
 *          (direct URL access / forged query params).
 */
export function consumeWithdrawalToken(): boolean {
  if (typeof sessionStorage === "undefined") {
    // SSR environment — no session storage available; treat as invalid.
    return false;
  }
  const present = sessionStorage.getItem(WITHDRAWAL_TOKEN_KEY) !== null;
  sessionStorage.removeItem(WITHDRAWAL_TOKEN_KEY);
  return present;
}

/**
 * SEP-24 Anchor Deposit Integration (#1734)
 *
 * Interactive deposit flow against a configured Stellar anchor (testnet:
 * Stellar test anchor). Launched from asset-readiness when a player has no
 * stake asset, tracking the deposit transaction until funds arrive and then
 * resuming the join.
 *
 * Protocol sequence:
 *   1. SEP-1  : Discover anchor info from the TOML file
 *   2. SEP-10  : Authenticate the wallet with the anchor
 *   3. SEP-24  : Open an interactive deposit URL in a popup
 *   4. Poll    : Poll the transaction status until completion or failure
 *   5. Resume  : Re-check asset readiness and resume the join flow
 *
 * External dependencies (Stellar SDK, fetch to the anchor) are mocked here
 * because no external anchor is available in this environment. The mock
 * returns a working interactive URL and simulates a successful deposit.
 * The real implementation would use @stellar/stellar-sdk's
 * Anchors and Server classes.
 *
 * Feature-flagged per network: only enabled on testnet (the test anchor is
 * configured). On mainnet the deposit flow is disabled until a production
 * anchor is configured.
 *
 * @module
 */

import { localStorageManager, StorageKey } from "../localStorage";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AnchorConfig {
  /** Anchor home domain (e.g. "https://testanchor.stellar.org"). */
  homeDomain: string;
  /** Asset code the anchor deposits (e.g. "USDC"). */
  asset: string;
  /** Asset issuer on this network. */
  assetIssuer: string;
  /** Whether this anchor is enabled for the current network. */
  enabled: boolean;
}

export interface Sep24DepositParams {
  /** Wallet public key of the depositor. */
  walletAddress: string;
  /** Asset code to deposit. */
  assetCode: string;
  /** Optional amount to pre-fill in the anchor UI. */
  amount?: string;
  /** Anchor config to use. */
  anchor: AnchorConfig;
}

export interface Sep24DepositResult {
  /** Interactive URL to open in a popup. */
  url: string;
  /** Transaction id assigned by the anchor. */
  transactionId: string;
  /** The deposit identifier for polling. */
  depositId: string;
}

export type Sep24TransactionStatus =
  | "pending"
  | "incomplete"
  | "no_market"
  | "too_small"
  | "too_large"
  | "completed"
  | "error";

export interface Sep24TransactionInfo {
  id: string;
  status: Sep24TransactionStatus;
  amountIn: string;
  amountOut: string;
  amountFee: string;
  kind: "deposit";
  startedAt: number;
  completedAt: number | null;
  stellarTransactionId: string | null;
  externalTransactionId: string | null;
  moreInfoUrl: string | null;
  errorMessage: string | null;
}

// ── Anchor Config ─────────────────────────────────────────────────────────────

/**
 * Testnet anchor config. Uses the Stellar test anchor which is publicly
 * available for development. On mainnet, this would be configured via
 * environment variables.
 */
export const TESTNET_ANCHOR: AnchorConfig = {
  homeDomain: "https://testanchor.stellar.org",
  asset: "USDC",
  assetIssuer: "",
  enabled: true,
};

/**
 * Get the anchor config for a given network.
 */
export function getAnchorConfig(network: "testnet" | "mainnet"): AnchorConfig | null {
  if (network === "testnet") {
    return TESTNET_ANCHOR;
  }
  // Mainnet anchor is not configured yet — feature-flagged off.
  return null;
}

// ── SEP-1: Discovery (mocked) ──────────────────────────────────────────────────

interface AnchorToml {
  transferServer: string;
  sep24Server: string;
  kycServer: string;
}

/**
 * SEP-1: Fetch and parse the anchor's TOML file.
 *
 * Mocked: returns a fixed TOML describing the test anchor's endpoints.
 * The real implementation would fetch `{homeDomain}/.well-known/stellar.toml`
 * and parse it with the Stellar SDK's StellarTomlResolver.
 */
export async function discoverAnchor(homeDomain: string): Promise<AnchorToml> {
  // Mock: return fixed endpoints based on the home domain
  return {
    transferServer: `${homeDomain}/transfer`,
    sep24Server: `${homeDomain}/sep24`,
    kycServer: `${homeDomain}/kyc`,
  };
}

// ── SEP-10: Auth (mocked) ──────────────────────────────────────────────────────

/**
 * SEP-10: Authenticate the wallet with the anchor.
 *
 * Mocked: returns a fake auth token. The real implementation would:
 *   1. GET /auth?account={walletAddress} to get a challenge transaction
 *   2. Sign the challenge with the wallet
 *   3. POST /auth with the signed transaction to get a JWT token
 */
export async function authenticateWithAnchor(
  _walletAddress: string,
  _homeDomain: string,
): Promise<{ token: string; expiresAt: number }> {
  // Mock: return a fake JWT token
  return {
    token: `mock_sep10_token_${Date.now()}`,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  };
}

// ── SEP-24: Interactive Deposit (mocked) ───────────────────────────────────────

/**
 * SEP-24: Initiate an interactive deposit.
 *
 * Mocked: returns a fake interactive URL and transaction id. The real
 * implementation would POST to the anchor's /sep24/transactions/deposit/interactive
 * endpoint with the auth token and asset parameters.
 */
export async function initiateDeposit(
  params: Sep24DepositParams,
  authToken: string,
): Promise<Sep24DepositResult> {
  if (!params.anchor.enabled) {
    throw new Sep24Error("ANCHOR_DISABLED", "This anchor is not enabled for the current network");
  }

  // Mock: generate a fake interactive URL and transaction id
  const transactionId = `mock_tx_${Date.now()}`;
  const url = `${params.anchor.homeDomain}/sep24/deposit?transaction_id=${transactionId}&asset_code=${params.assetCode}&account=${params.walletAddress}&amount=${params.amount ?? ""}`;

  return {
    url,
    transactionId,
    depositId: transactionId,
  };
}

// ── Polling (mocked) ────────────────────────────────────────────────────────────

/**
 * Poll the anchor for the deposit transaction status.
 *
 * Mocked: returns a "pending" status for the first 2 polls, then "completed".
 * The real implementation would GET /sep24/transaction?id={transactionId}
 * with the auth token.
 */
export async function pollDepositStatus(
  transactionId: string,
  _authToken: string,
): Promise<Sep24TransactionInfo> {
  // Mock: simulate a pending → completed flow based on time
  const elapsed = Date.now() - parseInt(transactionId.replace("mock_tx_", ""), 10);
  const isCompleted = elapsed > 2000; // Complete after 2 seconds

  return {
    id: transactionId,
    status: isCompleted ? "completed" : "pending",
    amountIn: "10",
    amountOut: "10",
    amountFee: "0",
    kind: "deposit",
    startedAt: Date.now() - elapsed,
    completedAt: isCompleted ? Date.now() : null,
    stellarTransactionId: isCompleted ? "mock_stellar_tx_hash" : null,
    externalTransactionId: "mock_ext_id",
    moreInfoUrl: null,
    errorMessage: null,
  };
}

// ── Error ───────────────────────────────────────────────────────────────────────

export class Sep24Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Sep24Error";
  }
}

// ── Popup Management ───────────────────────────────────────────────────────────

let popupWindow: Window | null = null;

/**
 * Open the interactive deposit URL in a popup window.
 *
 * Handles popup blockers by returning a flag so the caller can show a
 * fallback link.
 */
export function openDepositPopup(url: string): boolean {
  popupWindow = window.open(url, "sep24_deposit", "width=480,height=720,scrollbars=yes");

  if (!popupWindow) {
    // Popup was blocked — caller should show a fallback link
    return false;
  }

  popupWindow.focus();
  return true;
}

/**
 * Close the deposit popup if it's open.
 */
export function closeDepositPopup(): void {
  if (popupWindow && !popupWindow.closed) {
    popupWindow.close();
  }
  popupWindow = null;
}

// ── Pending Deposit Persistence ─────────────────────────────────────────────────

interface PendingDeposit {
  transactionId: string;
  assetCode: string;
  walletAddress: string;
  authToken: string;
  startedAt: number;
}

/**
 * Persist a pending deposit so it can be resumed across page reloads.
 */
export function savePendingDeposit(deposit: PendingDeposit): void {
  localStorageManager.setItem(StorageKey.PENDING_DEPOSIT, deposit);
}

/**
 * Load a pending deposit from local storage (for resume on reload).
 */
export function loadPendingDeposit(): PendingDeposit | null {
  const deposit = localStorageManager.getItem<PendingDeposit | null>(StorageKey.PENDING_DEPOSIT, null);
  if (!deposit || typeof deposit.transactionId !== "string" || typeof deposit.walletAddress !== "string") return null;
  return deposit;
}

/**
 * Clear the pending deposit from local storage.
 */
export function clearPendingDeposit(): void {
  localStorageManager.removeItem(StorageKey.PENDING_DEPOSIT);
}

// ── Full Flow ─────────────────────────────────────────────────────────────────

export interface Sep24FlowResult {
  success: boolean;
  transactionId: string;
  status: Sep24TransactionStatus;
  amountIn: string;
  errorMessage: string | null;
}

/**
 * Run the complete SEP-24 deposit flow:
 *   1. Discover anchor (SEP-1)
 *   2. Authenticate (SEP-10)
 *   3. Initiate deposit (SEP-24)
 *   4. Open popup
 *   5. Poll until completion
 *
 * This is the entry point called from asset-readiness when a player has
 * no stake asset. The caller is responsible for re-checking asset readiness
 * after this resolves.
 */
export async function runSep24DepositFlow(
  params: Sep24DepositParams,
): Promise<Sep24FlowResult> {
  const anchor = params.anchor;

  // 1. SEP-1: Discover anchor
  await discoverAnchor(anchor.homeDomain);

  // 2. SEP-10: Authenticate
  const auth = await authenticateWithAnchor(params.walletAddress, anchor.homeDomain);

  // 3. SEP-24: Initiate deposit
  const deposit = await initiateDeposit(params, auth.token);

  // 4. Open popup
  const popupOk = openDepositPopup(deposit.url);
  if (!popupOk) {
    // Popup was blocked — still proceed with polling so the user can
    // use a manual fallback link
    // Persist so the user can resume after reloading
    savePendingDeposit({
      transactionId: deposit.transactionId,
      assetCode: params.assetCode,
      walletAddress: params.walletAddress,
      authToken: auth.token,
      startedAt: Date.now(),
    });
  }

  // 5. Poll for completion
  const maxAttempts = 60;
  const pollIntervalMs = 2000;
  let lastStatus: Sep24TransactionInfo | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    lastStatus = await pollDepositStatus(deposit.transactionId, auth.token);

    if (lastStatus.status === "completed") {
      clearPendingDeposit();
      closeDepositPopup();
      return {
        success: true,
        transactionId: deposit.transactionId,
        status: "completed",
        amountIn: lastStatus.amountIn,
        errorMessage: null,
      };
    }

    if (lastStatus.status === "error") {
      clearPendingDeposit();
      closeDepositPopup();
      return {
        success: false,
        transactionId: deposit.transactionId,
        status: "error",
        amountIn: lastStatus.amountIn,
        errorMessage: lastStatus.errorMessage ?? "Deposit failed at the anchor",
      };
    }
  }

  // Timed out
  clearPendingDeposit();
  closeDepositPopup();
  return {
    success: false,
    transactionId: deposit.transactionId,
    status: lastStatus?.status ?? "pending",
    amountIn: lastStatus?.amountIn ?? "0",
    errorMessage: "Deposit polling timed out. Check the anchor's status page.",
  };
}

/**
 * Resume a pending deposit that was started in a previous session.
 *
 * Called on app load if `loadPendingDeposit()` returns a deposit.
 */
export async function resumePendingDeposit(): Promise<Sep24FlowResult | null> {
  const pending = loadPendingDeposit();
  if (!pending) return null;

  const maxAttempts = 60;
  const pollIntervalMs = 2000;
  let lastStatus: Sep24TransactionInfo | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    lastStatus = await pollDepositStatus(pending.transactionId, pending.authToken);

    if (lastStatus.status === "completed") {
      clearPendingDeposit();
      return {
        success: true,
        transactionId: pending.transactionId,
        status: "completed",
        amountIn: lastStatus.amountIn,
        errorMessage: null,
      };
    }

    if (lastStatus.status === "error") {
      clearPendingDeposit();
      return {
        success: false,
        transactionId: pending.transactionId,
        status: "error",
        amountIn: lastStatus.amountIn,
        errorMessage: lastStatus.errorMessage ?? "Deposit failed",
      };
    }
  }

  clearPendingDeposit();
  return {
    success: false,
    transactionId: pending.transactionId,
    status: lastStatus?.status ?? "pending",
    amountIn: lastStatus?.amountIn ?? "0",
    errorMessage: "Resumed deposit polling timed out",
  };
}

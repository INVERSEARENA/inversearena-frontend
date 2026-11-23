/** Status of the backend wallet session exposed by `useSession()`. */
export type SessionStatus =
  | "loading"
  | "unauthenticated"
  | "authenticating"
  | "authenticated"
  | "refreshing"
  | "error";

/** Token pair issued by `POST /api/auth/verify` and `POST /api/auth/refresh`. */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SessionState {
  status: SessionStatus;
  walletAddress: string | null;
  /** Epoch milliseconds at which the current access token expires (0 if unknown). */
  expiresAt: number;
  error: string | null;
}

/** Functions the login flow needs from the connected wallet. */
export interface ChallengeSigner {
  walletAddress: string;
  /**
   * Signs an arbitrary UTF-8 message (Freighter / xBull `signMessage`).
   * Wallets return raw strings, hex, or `{ signature }` / `{ signedMessage }`
   * objects; `normalizeSignature` handles all of them.
   */
  signMessage?: (message: string) => Promise<unknown>;
  /** Signs a challenge transaction XDR when `signMessage` is unavailable. */
  signTransaction: (xdr: string) => Promise<string>;
}

export interface LoginProof {
  signature?: string;
  signedChallengeXdr?: string;
}

export interface AuthChallenge {
  nonce: string;
  expiresAt?: string;
}

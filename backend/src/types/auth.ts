export interface AuthUser {
  id: string;
  walletAddress: string;
  displayName?: string;
  joinedAt: Date;
  lastLoginAt: Date;
}

export interface JwtPayload {
  sub: string;    // user ObjectId
  wallet: string; // walletAddress — included to avoid DB lookup per request
  type: "access" | "refresh";
  iat?: number;
  exp?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

import type { NextFunction, Request, Response } from "express";
import type { AuthService } from "../services/authService";
import { UserModel } from "../db/models/user.model";
import { apiError } from "../utils/apiError";
import {
  NonceRequestSchema,
  RefreshSchema,
  VerifySchema,
} from "../validation/authSchemas";

export class AuthController {
  constructor(private readonly authService: AuthService) {}

  requestNonce = async (req: Request, res: Response): Promise<void> => {
    const { walletAddress } = NonceRequestSchema.parse(req.body);
    const result = await this.authService.requestNonce(walletAddress);
    res.status(201).json(result);
  };

  verify = async (req: Request, res: Response): Promise<void> => {
    const { walletAddress, signature } = VerifySchema.parse(req.body);
    const result = await this.authService.verifySignatureAndLogin(walletAddress, signature);
    res.json(result);
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = RefreshSchema.parse(req.body);
    const tokens = await this.authService.refreshTokens(refreshToken);
    res.json(tokens);
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    const { jti } = req.user!;
    await this.authService.logout(jti);
    res.json({ message: "Logged out successfully" });
  };

  revokeAllSessions = async (req: Request, res: Response): Promise<void> => {
    const { id, walletAddress } = req.user!;
    const revoked = await this.authService.revokeAllSessions(walletAddress, id);
    res.json({ message: "All sessions revoked", revoked });
  };

  me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { id } = req.user!;
    const user = await UserModel.findById(id).lean();
    if (!user) {
      next(apiError(404, "USER_NOT_FOUND", "User not found"));
      return;
    }
    res.json({
      id: user._id.toString(),
      walletAddress: user.walletAddress,
      displayName: user.displayName ?? null,
      joinedAt: user.joinedAt,
      lastLoginAt: user.lastLoginAt,
    });
  };
}

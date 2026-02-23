import type { Request, Response } from "express";
import { z } from "zod";
import type { AuthService } from "../services/authService";
import { UserModel } from "../db/models/user.model";

const PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

const NonceRequestSchema = z.object({
  walletAddress: z
    .string()
    .trim()
    .regex(PUBLIC_KEY_REGEX, "Invalid Stellar wallet address"),
});

const VerifySchema = z.object({
  walletAddress: z
    .string()
    .trim()
    .regex(PUBLIC_KEY_REGEX, "Invalid Stellar wallet address"),
  signature: z.string().min(1, "Signature is required"),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

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

  me = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.user!;
    const user = await UserModel.findById(id).lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
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

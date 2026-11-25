import type { Request, Response } from "express";
import { z } from "zod";
import { isAuthorizedAdminWallet, isValidStellarAddress } from "../services/walletRoleService";

const WalletRoleQuerySchema = z.object({
  address: z.string().min(1).max(64),
});

export class WalletRoleController {
  checkRole = async (req: Request, res: Response): Promise<void> => {
    const { address } = WalletRoleQuerySchema.parse(req.query);

    if (!isValidStellarAddress(address)) {
      res.status(400).json({ error: { code: "INVALID_ADDRESS" } });
      return;
    }

    res.json({ address, isAdmin: isAuthorizedAdminWallet(address) });
  };
}

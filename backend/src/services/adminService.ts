import { createHash, randomBytes } from "crypto";
import { AuditLogModel } from "../db/models/auditLog.model";
import { ConfirmationTokenModel } from "../db/models/confirmationToken.model";
import type { AuditLogEntry, RequestTokenResult } from "../types/admin";

const DEFAULT_TTL_SECONDS = 900; // 15 minutes

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function ttlSeconds(): number {
  const env = Number(process.env.ADMIN_TOKEN_TTL_SECONDS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TTL_SECONDS;
}

export class AdminService {
  async requestToken(
    adminId: string,
    action: string,
    resourceId: string
  ): Promise<RequestTokenResult> {
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + ttlSeconds() * 1000);

    await ConfirmationTokenModel.create({
      adminId,
      tokenHash,
      action,
      resourceId,
      used: false,
      expiresAt,
    });

    return { token: rawToken, expiresAt };
  }

  async verifyAndConsumeToken(
    rawToken: string,
    action: string,
    resourceId: string,
    adminId: string
  ): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const record = await ConfirmationTokenModel.findOne({ tokenHash });

    if (!record) {
      const err = Object.assign(new Error("Confirmation token not found"), { status: 404 });
      throw err;
    }
    if (record.used) {
      const err = Object.assign(new Error("Confirmation token already used"), { status: 409 });
      throw err;
    }
    if (record.expiresAt < new Date()) {
      const err = Object.assign(new Error("Confirmation token expired"), { status: 410 });
      throw err;
    }
    if (record.action !== action || record.resourceId !== resourceId) {
      const err = Object.assign(
        new Error("Confirmation token action or resource mismatch"),
        { status: 403 }
      );
      throw err;
    }
    if (record.adminId !== adminId) {
      const err = Object.assign(new Error("Confirmation token belongs to a different admin"), {
        status: 403,
      });
      throw err;
    }

    await ConfirmationTokenModel.findByIdAndUpdate(record._id, { used: true });
  }

  async log(entry: AuditLogEntry): Promise<void> {
    await AuditLogModel.create(entry);
  }
}

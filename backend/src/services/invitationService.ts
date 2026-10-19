import { createHash, randomBytes } from "crypto";
import { PrismaClient } from "@prisma/client";

export interface Invitation {
  code: string;
  arenaId: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  maxUses: number;
  usedCount: number;
  isActive: boolean;
}

export interface InvitationVerification {
  isValid: boolean;
  error?: string;
  invitation?: Invitation;
}

const INVITATION_VALIDITY_HOURS = 24;
const INVITATION_MAX_USES = 100;

export class InvitationService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Generate a new invitation code for an arena.
   * The code is a HMAC-SHA256 hash of random data + arena ID.
   */
  async createInvitation(
    arenaId: string,
    createdBy: string,
    expiryHours: number = INVITATION_VALIDITY_HOURS,
  ): Promise<Invitation> {
    const randomData = randomBytes(32).toString("hex");
    const hmac = createHash("sha256");
    hmac.update(`${randomData}:${arenaId}:${Date.now()}`);
    const code = hmac.digest("hex").substring(0, 24);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);

    return {
      code,
      arenaId,
      createdBy,
      createdAt: now,
      expiresAt,
      maxUses: INVITATION_MAX_USES,
      usedCount: 0,
      isActive: true,
    };
  }

  /**
   * Verify an invitation code for a specific arena.
   * Checks:
   * - Code exists and matches arena
   * - Code has not expired
   * - Code has not exceeded max uses
   * - Code is still active
   */
  async verifyInvitation(code: string, arenaId: string): Promise<InvitationVerification> {
    if (!code || typeof code !== "string" || code.length !== 24) {
      return {
        isValid: false,
        error: "INVALID_INVITATION_CODE",
      };
    }

    if (!arenaId || typeof arenaId !== "string") {
      return {
        isValid: false,
        error: "INVALID_ARENA_ID",
      };
    }

    const now = new Date();

    // Verify the invitation exists
    const invitationCode = code.toLowerCase();
    const invitation = await this.prisma.invitation.findUnique({
      where: {
        code_arenaId: {
          code: invitationCode,
          arenaId,
        },
      },
    });

    if (!invitation) {
      return {
        isValid: false,
        error: "INVITATION_NOT_FOUND",
      };
    }

    // Check if expired
    if (invitation.expiresAt < now) {
      return {
        isValid: false,
        error: "INVITATION_EXPIRED",
      };
    }

    // Check if max uses exceeded
    if (invitation.usedCount >= invitation.maxUses) {
      return {
        isValid: false,
        error: "INVITATION_MAX_USES_EXCEEDED",
      };
    }

    // Check if still active
    if (!invitation.isActive) {
      return {
        isValid: false,
        error: "INVITATION_INACTIVE",
      };
    }

    return {
      isValid: true,
      invitation: {
        code: invitation.code,
        arenaId: invitation.arenaId,
        createdBy: invitation.createdBy,
        createdAt: invitation.createdAt,
        expiresAt: invitation.expiresAt,
        maxUses: invitation.maxUses,
        usedCount: invitation.usedCount,
        isActive: invitation.isActive,
      },
    };
  }

  /**
   * Increment the use count for an invitation.
   */
  async recordInvitationUse(code: string, arenaId: string): Promise<void> {
    await this.prisma.invitation.update({
      where: {
        code_arenaId: {
          code: code.toLowerCase(),
          arenaId,
        },
      },
      data: {
        usedCount: {
          increment: 1,
        },
      },
    });
  }

  /**
   * Revoke an invitation (mark as inactive).
   */
  async revokeInvitation(code: string, arenaId: string): Promise<void> {
    await this.prisma.invitation.update({
      where: {
        code_arenaId: {
          code: code.toLowerCase(),
          arenaId,
        },
      },
      data: {
        isActive: false,
      },
    });
  }

  /**
   * List all active invitations for an arena.
   */
  async listInvitations(arenaId: string): Promise<Invitation[]> {
    const invitations = await this.prisma.invitation.findMany({
      where: { arenaId, isActive: true },
      orderBy: { createdAt: "desc" },
    });

    return invitations.map((inv) => ({
      code: inv.code,
      arenaId: inv.arenaId,
      createdBy: inv.createdBy,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      maxUses: inv.maxUses,
      usedCount: inv.usedCount,
      isActive: inv.isActive,
    }));
  }
}

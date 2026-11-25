import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PrismaClient } from "@prisma/client";
import { ReferralService } from "../../src/services/referralService";

// Note: These are basic unit tests. Integration tests would require a test DB.
// For now, we test the logic without actual DB calls by mocking Prisma.

test("ReferralService: generateReferralCode creates unique code", async () => {
  const mockPrisma = {
    referralCode: {
      create: async (args: any) => {
        assert(args.data.code, "Code should be generated");
        assert(args.data.referrerId === "user-123");
        assert(args.data.attributionWindowExpiresAt instanceof Date);
        return { id: "code-1", ...args.data };
      },
    },
  } as any;

  const service = new ReferralService(mockPrisma);
  const code = await service.generateReferralCode("user-123");
  assert(code, "Code should be returned");
  assert(code.length > 0, "Code should not be empty");
});

test("ReferralService: attributeSignup prevents self-referral", async () => {
  const referrerId = "user-1";
  const mockPrisma = {
    referralCode: {
      findUnique: async () => ({
        id: "code-1",
        referrerId,
        attributionWindowExpiresAt: new Date(Date.now() + 1000000),
        code: "ABC123",
      }),
    },
  } as any;

  const service = new ReferralService(mockPrisma);
  // Same user trying to refer themselves
  const result = await service.attributeSignup("ABC123", referrerId);
  assert.equal(result, null, "Self-referral should be rejected");
});

test("ReferralService: attributeSignup rejects expired code", async () => {
  const referrerId = "user-1";
  const refereeId = "user-2";
  const mockPrisma = {
    referralCode: {
      findUnique: async () => ({
        id: "code-1",
        referrerId,
        attributionWindowExpiresAt: new Date(Date.now() - 1000), // Expired
        code: "ABC123",
      }),
    },
  } as any;

  const service = new ReferralService(mockPrisma);
  const result = await service.attributeSignup("ABC123", refereeId);
  assert.equal(result, null, "Expired code should be rejected");
});

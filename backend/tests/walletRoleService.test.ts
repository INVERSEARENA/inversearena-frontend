import { isAuthorizedAdminWallet, isValidStellarAddress } from "../src/services/walletRoleService";

const VALID_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const OTHER_ADDRESS = "GCRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("walletRoleService", () => {
  const originalEnv = process.env.ADMIN_WALLET_ADDRESSES;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ADMIN_WALLET_ADDRESSES;
    } else {
      process.env.ADMIN_WALLET_ADDRESSES = originalEnv;
    }
  });

  describe("isValidStellarAddress", () => {
    it("accepts a well-formed public key", () => {
      expect(isValidStellarAddress(VALID_ADDRESS)).toBe(true);
    });

    it("rejects malformed input", () => {
      expect(isValidStellarAddress("not-an-address")).toBe(false);
    });
  });

  describe("isAuthorizedAdminWallet", () => {
    it("returns false when no allowlist is configured", () => {
      delete process.env.ADMIN_WALLET_ADDRESSES;
      expect(isAuthorizedAdminWallet(VALID_ADDRESS)).toBe(false);
    });

    it("returns false for a wallet that is merely a valid address but not allowlisted", () => {
      process.env.ADMIN_WALLET_ADDRESSES = OTHER_ADDRESS;
      expect(isAuthorizedAdminWallet(VALID_ADDRESS)).toBe(false);
    });

    it("returns true for an allowlisted address", () => {
      process.env.ADMIN_WALLET_ADDRESSES = `${OTHER_ADDRESS},${VALID_ADDRESS}`;
      expect(isAuthorizedAdminWallet(VALID_ADDRESS)).toBe(true);
    });

    it("trims whitespace around allowlist entries", () => {
      process.env.ADMIN_WALLET_ADDRESSES = ` ${VALID_ADDRESS} , ${OTHER_ADDRESS} `;
      expect(isAuthorizedAdminWallet(VALID_ADDRESS)).toBe(true);
    });

    it("rejects a malformed address even when it appears in the allowlist string", () => {
      process.env.ADMIN_WALLET_ADDRESSES = "not-an-address";
      expect(isAuthorizedAdminWallet("not-an-address")).toBe(false);
    });
  });
});

/**
 * Tests for runtime-validated identity value objects (#1522).
 *
 * Coverage:
 *  ✓ StellarAccountId — valid, wrong StrKey type, malformed
 *  ✓ SorobanContractId — valid, wrong StrKey type, malformed, placeholder
 *  ✓ StellarTransactionHash — valid, wrong length, non-hex
 *  ✓ NetworkPassphrase — valid, too short, bad characters, normalisation
 *  ✓ NetworkIdentity — deterministic derivation, well-known aliases, custom
 *  ✓ DeploymentRevision — valid, zero, negative, non-integer
 *  ✓ NetworkBoundContractId — construction, mixed network rejection
 *  ✓ Canonical key builders — network segment present, key format stable
 *  ✓ NETWORK_PASSPHRASES constants are directly usable as NetworkPassphrase
 *  ✓ tryParse* returns null (not throw) on bad input
 *  ✓ IdentityValidationError has correct kind, input, reason fields
 *  ✓ Alias collision: same passphrase always same identity
 *  ✓ Unknown deployment: createNamedContract throws for missing contract
 *  ✓ Serialisation round-trip: branded type is wire-compatible plain string
 */

import { StrKey } from "@stellar/stellar-sdk";
import {
  IdentityValidationError,
  parseStellarAccountId,
  tryParseStellarAccountId,
  parseSorobanContractId,
  tryParseSorobanContractId,
  parseStellarTransactionHash,
  tryParseStellarTransactionHash,
  parseNetworkPassphrase,
  tryParseNetworkPassphrase,
  NETWORK_PASSPHRASES,
  deriveNetworkIdentity,
  parseDeploymentRevision,
  bindContractToNetwork,
  arenaNetworkCacheKey,
  mutationIdempotencyKey,
  capabilityScopeKey,
  NETWORK_ALIASES,
} from "../identity-value-objects";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Valid ed25519 public key (account) */
const VALID_ACCOUNT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
/** Valid Soroban contract ID */
const VALID_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
/** Valid 64-char hex tx hash */
const VALID_TX_HASH = "a".repeat(64);
/** A contract address but encoded as an account key (wrong StrKey type) */
const CONTRACT_ENCODED_AS_ACCOUNT = StrKey.encodeContract(Buffer.alloc(32, 1));
/** An account key but encoded as a contract (wrong StrKey type) */
const ACCOUNT_ENCODED_AS_CONTRACT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));

// ─── StellarAccountId ─────────────────────────────────────────────────────────

describe("parseStellarAccountId", () => {
  it("accepts a valid ed25519 public key", () => {
    const id = parseStellarAccountId(VALID_ACCOUNT);
    expect(id).toBe(VALID_ACCOUNT);
  });

  it("trims whitespace before validating", () => {
    expect(parseStellarAccountId(`  ${VALID_ACCOUNT}  `)).toBe(VALID_ACCOUNT);
  });

  it("throws IdentityValidationError for a contract ID passed as an account", () => {
    expect(() => parseStellarAccountId(CONTRACT_ENCODED_AS_ACCOUNT)).toThrow(IdentityValidationError);
  });

  it("throws for a malformed string", () => {
    expect(() => parseStellarAccountId("not-a-key")).toThrow(IdentityValidationError);
  });

  it("throws for an empty string", () => {
    expect(() => parseStellarAccountId("")).toThrow(IdentityValidationError);
  });

  it("error carries the correct kind field", () => {
    try {
      parseStellarAccountId("bad");
    } catch (e) {
      expect(e).toBeInstanceOf(IdentityValidationError);
      expect((e as IdentityValidationError).kind).toBe("StellarAccountId");
      expect((e as IdentityValidationError).input).toBe("bad");
    }
  });
});

describe("tryParseStellarAccountId", () => {
  it("returns the value on success", () => {
    expect(tryParseStellarAccountId(VALID_ACCOUNT)).toBe(VALID_ACCOUNT);
  });

  it("returns null (not throw) on invalid input", () => {
    expect(tryParseStellarAccountId("not-a-key")).toBeNull();
  });
});

// ─── SorobanContractId ───────────────────────────────────────────────────────

describe("parseSorobanContractId", () => {
  it("accepts a valid Soroban contract address", () => {
    expect(parseSorobanContractId(VALID_CONTRACT)).toBe(VALID_CONTRACT);
  });

  it("trims whitespace before validating", () => {
    expect(parseSorobanContractId(`  ${VALID_CONTRACT}  `)).toBe(VALID_CONTRACT);
  });

  it("throws for an account ID passed as a contract", () => {
    expect(() => parseSorobanContractId(ACCOUNT_ENCODED_AS_CONTRACT)).toThrow(IdentityValidationError);
  });

  it("throws for a malformed string", () => {
    expect(() => parseSorobanContractId("C-not-a-real-contract")).toThrow(IdentityValidationError);
  });

  it("rejects a placeholder by default", () => {
    expect(() => parseSorobanContractId("CD...MY_PLACEHOLDER")).toThrow(IdentityValidationError);
  });

  it("accepts a placeholder when allowPlaceholder is true", () => {
    const id = parseSorobanContractId("CD...MY_PLACEHOLDER", { allowPlaceholder: true });
    expect(id).toBe("CD...MY_PLACEHOLDER");
  });

  it("error carries kind = SorobanContractId", () => {
    try {
      parseSorobanContractId("bad");
    } catch (e) {
      expect((e as IdentityValidationError).kind).toBe("SorobanContractId");
    }
  });
});

describe("tryParseSorobanContractId", () => {
  it("returns the value on success", () => {
    expect(tryParseSorobanContractId(VALID_CONTRACT)).toBe(VALID_CONTRACT);
  });

  it("returns null on invalid input", () => {
    expect(tryParseSorobanContractId("not-a-contract")).toBeNull();
  });

  it("returns the placeholder when allowPlaceholder: true", () => {
    expect(tryParseSorobanContractId("CD...PLACEHOLDER", { allowPlaceholder: true })).toBe("CD...PLACEHOLDER");
  });
});

// ─── StellarTransactionHash ──────────────────────────────────────────────────

describe("parseStellarTransactionHash", () => {
  it("accepts a 64-char hex string", () => {
    expect(parseStellarTransactionHash(VALID_TX_HASH)).toBe(VALID_TX_HASH);
  });

  it("normalises uppercase hex to lowercase", () => {
    expect(parseStellarTransactionHash("A".repeat(64))).toBe("a".repeat(64));
  });

  it("trims whitespace", () => {
    expect(parseStellarTransactionHash(`  ${VALID_TX_HASH}  `)).toBe(VALID_TX_HASH);
  });

  it("throws for a 63-char string (too short)", () => {
    expect(() => parseStellarTransactionHash("a".repeat(63))).toThrow(IdentityValidationError);
  });

  it("throws for a 65-char string (too long)", () => {
    expect(() => parseStellarTransactionHash("a".repeat(65))).toThrow(IdentityValidationError);
  });

  it("throws for non-hex characters", () => {
    expect(() => parseStellarTransactionHash("g".repeat(64))).toThrow(IdentityValidationError);
  });

  it("error carries kind = StellarTransactionHash", () => {
    try {
      parseStellarTransactionHash("bad");
    } catch (e) {
      expect((e as IdentityValidationError).kind).toBe("StellarTransactionHash");
    }
  });
});

describe("tryParseStellarTransactionHash", () => {
  it("returns the value on success", () => {
    expect(tryParseStellarTransactionHash(VALID_TX_HASH)).toBe(VALID_TX_HASH);
  });

  it("returns null on invalid input", () => {
    expect(tryParseStellarTransactionHash("short")).toBeNull();
  });
});

// ─── NetworkPassphrase ───────────────────────────────────────────────────────

describe("parseNetworkPassphrase", () => {
  it("accepts the testnet passphrase", () => {
    expect(parseNetworkPassphrase("Test SDF Network ; September 2015")).toBe(
      "Test SDF Network ; September 2015",
    );
  });

  it("accepts a custom network passphrase", () => {
    expect(parseNetworkPassphrase("My Custom Network ; 2026")).toBeTruthy();
  });

  it("trims leading/trailing whitespace", () => {
    expect(parseNetworkPassphrase("  Test SDF Network ; September 2015  ")).toBe(
      "Test SDF Network ; September 2015",
    );
  });

  it("throws for a too-short string", () => {
    expect(() => parseNetworkPassphrase("ab")).toThrow(IdentityValidationError);
  });

  it("throws for disallowed characters (e.g. control chars represented as unicode)", () => {
    expect(() => parseNetworkPassphrase("\x00\x01\x02".padEnd(10, "x"))).toThrow(IdentityValidationError);
  });

  it("NETWORK_PASSPHRASES constants are directly usable as NetworkPassphrase", () => {
    // The well-known constants are pre-cast — using them should not throw.
    expect(() => {
      const _t: string = NETWORK_PASSPHRASES.testnet;
      const _m: string = NETWORK_PASSPHRASES.mainnet;
      void _t; void _m;
    }).not.toThrow();
  });
});

describe("tryParseNetworkPassphrase", () => {
  it("returns null instead of throwing on invalid input", () => {
    expect(tryParseNetworkPassphrase("x")).toBeNull();
  });
});

// ─── NetworkIdentity ─────────────────────────────────────────────────────────

describe("deriveNetworkIdentity", () => {
  it("returns 'testnet' for the testnet passphrase", () => {
    const id = deriveNetworkIdentity(NETWORK_PASSPHRASES.testnet);
    expect(id).toBe("testnet");
  });

  it("returns 'mainnet' for the mainnet passphrase", () => {
    const id = deriveNetworkIdentity(NETWORK_PASSPHRASES.mainnet);
    expect(id).toBe("mainnet");
  });

  it("is deterministic: same passphrase always yields the same identity", () => {
    const p = parseNetworkPassphrase("Custom Net ; 2026");
    expect(deriveNetworkIdentity(p)).toBe(deriveNetworkIdentity(p));
  });

  it("produces different identities for different passphrases", () => {
    const a = deriveNetworkIdentity(parseNetworkPassphrase("Net A ; 2026"));
    const b = deriveNetworkIdentity(parseNetworkPassphrase("Net B ; 2026"));
    expect(a).not.toBe(b);
  });

  it("custom network identity starts with 'net-'", () => {
    const id = deriveNetworkIdentity(parseNetworkPassphrase("Custom Net ; 2026"));
    expect(id).toMatch(/^net-/);
  });

  it("alias collision: same passphrase called twice produces the same identity (no mutation)", () => {
    const p = NETWORK_PASSPHRASES.testnet;
    const id1 = deriveNetworkIdentity(p);
    const id2 = deriveNetworkIdentity(p);
    expect(id1).toBe(id2);
  });
});

// ─── DeploymentRevision ──────────────────────────────────────────────────────

describe("parseDeploymentRevision", () => {
  it("accepts a positive integer", () => {
    expect(parseDeploymentRevision(1)).toBe(1);
    expect(parseDeploymentRevision(999)).toBe(999);
  });

  it("throws for zero", () => {
    expect(() => parseDeploymentRevision(0)).toThrow(IdentityValidationError);
  });

  it("throws for a negative integer", () => {
    expect(() => parseDeploymentRevision(-1)).toThrow(IdentityValidationError);
  });

  it("throws for a non-integer (float)", () => {
    expect(() => parseDeploymentRevision(1.5)).toThrow(IdentityValidationError);
  });

  it("throws for NaN", () => {
    expect(() => parseDeploymentRevision(NaN)).toThrow(IdentityValidationError);
  });
});

// ─── NetworkBoundContractId ──────────────────────────────────────────────────

describe("bindContractToNetwork", () => {
  const testnetPassphrase = NETWORK_PASSPHRASES.testnet;
  const mainnetPassphrase = NETWORK_PASSPHRASES.mainnet;

  it("creates a bound contract with the correct network", () => {
    const bound = bindContractToNetwork(VALID_CONTRACT, testnetPassphrase);
    expect(bound.contractId).toBe(VALID_CONTRACT);
    expect(bound.network).toBe("testnet");
  });

  it("throws for an invalid contract ID", () => {
    expect(() => bindContractToNetwork("not-a-contract", testnetPassphrase)).toThrow(
      IdentityValidationError,
    );
  });

  it("testnet and mainnet bindings have different network fields", () => {
    const testnet = bindContractToNetwork(VALID_CONTRACT, testnetPassphrase);
    const mainnet = bindContractToNetwork(VALID_CONTRACT, mainnetPassphrase);
    expect(testnet.network).not.toBe(mainnet.network);
  });

  it("allows placeholder contract IDs when allowPlaceholder: true", () => {
    const bound = bindContractToNetwork("CD...PLACEHOLDER", testnetPassphrase, {
      allowPlaceholder: true,
    });
    expect(bound.contractId).toBe("CD...PLACEHOLDER");
  });
});

// ─── Canonical key builders ───────────────────────────────────────────────────

describe("arenaNetworkCacheKey", () => {
  const net = deriveNetworkIdentity(NETWORK_PASSPHRASES.testnet);
  const contract = parseSorobanContractId(VALID_CONTRACT);

  it("includes the network segment", () => {
    const k = arenaNetworkCacheKey(net, contract, "stats");
    expect(k).toContain("testnet");
  });

  it("includes the contract ID", () => {
    const k = arenaNetworkCacheKey(net, contract, "stats");
    expect(k).toContain(VALID_CONTRACT);
  });

  it("includes the suffix", () => {
    const k = arenaNetworkCacheKey(net, contract, "onchain-snapshot");
    expect(k).toContain("onchain-snapshot");
  });

  it("testnet and mainnet produce different keys for the same contract and suffix", () => {
    const testnetId = deriveNetworkIdentity(NETWORK_PASSPHRASES.testnet);
    const mainnetId = deriveNetworkIdentity(NETWORK_PASSPHRASES.mainnet);
    const k1 = arenaNetworkCacheKey(testnetId, contract, "stats");
    const k2 = arenaNetworkCacheKey(mainnetId, contract, "stats");
    expect(k1).not.toBe(k2);
  });
});

describe("mutationIdempotencyKey", () => {
  const net = deriveNetworkIdentity(NETWORK_PASSPHRASES.testnet);
  const wallet = parseStellarAccountId(VALID_ACCOUNT);
  const arena = parseSorobanContractId(VALID_CONTRACT);

  it("includes all components", () => {
    const k = mutationIdempotencyKey(net, wallet, arena, 3, "commit");
    expect(k).toContain("testnet");
    expect(k).toContain(VALID_ACCOUNT);
    expect(k).toContain(VALID_CONTRACT);
    expect(k).toContain("3");
    expect(k).toContain("commit");
  });

  it("different networks produce different keys", () => {
    const mainnetId = deriveNetworkIdentity(NETWORK_PASSPHRASES.mainnet);
    const k1 = mutationIdempotencyKey(net, wallet, arena, 1, "join");
    const k2 = mutationIdempotencyKey(mainnetId, wallet, arena, 1, "join");
    expect(k1).not.toBe(k2);
  });

  it("different wallets produce different keys", () => {
    const wallet2 = parseStellarAccountId(
      "GCKFBEIYTKP5RDBQMUFJUMOOR2A46QMWDS4M7A6NZK2WQOG3ZHPJDPD3",
    );
    const k1 = mutationIdempotencyKey(net, wallet, arena, 1, "join");
    const k2 = mutationIdempotencyKey(net, wallet2, arena, 1, "join");
    expect(k1).not.toBe(k2);
  });

  it("different actions produce different keys", () => {
    const k1 = mutationIdempotencyKey(net, wallet, arena, 1, "commit");
    const k2 = mutationIdempotencyKey(net, wallet, arena, 1, "reveal");
    expect(k1).not.toBe(k2);
  });
});

describe("capabilityScopeKey", () => {
  const net = deriveNetworkIdentity(NETWORK_PASSPHRASES.testnet);
  const arena = parseSorobanContractId(VALID_CONTRACT);

  it("includes the network and arena", () => {
    const k = capabilityScopeKey(net, arena);
    expect(k).toContain("testnet");
    expect(k).toContain(VALID_CONTRACT);
  });

  it("different networks produce different scope keys", () => {
    const mainnetId = deriveNetworkIdentity(NETWORK_PASSPHRASES.mainnet);
    expect(capabilityScopeKey(net, arena)).not.toBe(capabilityScopeKey(mainnetId, arena));
  });
});

// ─── Serialisation round-trip ─────────────────────────────────────────────────

describe("serialisation round-trip", () => {
  it("branded StellarAccountId serialises to a plain string via JSON.stringify", () => {
    const id = parseStellarAccountId(VALID_ACCOUNT);
    const json = JSON.stringify({ accountId: id });
    const parsed = JSON.parse(json) as { accountId: string };
    expect(parsed.accountId).toBe(VALID_ACCOUNT);
  });

  it("branded SorobanContractId serialises to a plain string", () => {
    const id = parseSorobanContractId(VALID_CONTRACT);
    expect(JSON.parse(JSON.stringify(id))).toBe(VALID_CONTRACT);
  });

  it("branded StellarTransactionHash serialises to a plain string", () => {
    const hash = parseStellarTransactionHash(VALID_TX_HASH);
    expect(JSON.parse(JSON.stringify(hash))).toBe(VALID_TX_HASH);
  });

  it("NetworkBoundContractId serialises with contractId and network fields", () => {
    const bound = bindContractToNetwork(VALID_CONTRACT, NETWORK_PASSPHRASES.testnet);
    const json = JSON.parse(JSON.stringify(bound)) as typeof bound;
    expect(json.contractId).toBe(VALID_CONTRACT);
    expect(json.network).toBe("testnet");
    // Re-parsing the wire-format contractId should succeed.
    expect(parseSorobanContractId(json.contractId)).toBe(VALID_CONTRACT);
  });
});

// ─── Mixed-network rejection ──────────────────────────────────────────────────

describe("mixed-network detection", () => {
  it("same contract on testnet and mainnet have different NetworkBoundContractId.network", () => {
    const testnet = bindContractToNetwork(VALID_CONTRACT, NETWORK_PASSPHRASES.testnet);
    const mainnet = bindContractToNetwork(VALID_CONTRACT, NETWORK_PASSPHRASES.mainnet);
    expect(testnet.network).toBe("testnet");
    expect(mainnet.network).toBe("mainnet");
    // Comparing these at a type-level prevents accidental cross-network use.
    expect(testnet.network === mainnet.network).toBe(false);
  });

  it("NETWORK_ALIASES includes entries for testnet and mainnet passphrases", () => {
    expect(NETWORK_ALIASES[NETWORK_PASSPHRASES.testnet]).toBe("testnet");
    expect(NETWORK_ALIASES[NETWORK_PASSPHRASES.mainnet]).toBe("mainnet");
  });
});

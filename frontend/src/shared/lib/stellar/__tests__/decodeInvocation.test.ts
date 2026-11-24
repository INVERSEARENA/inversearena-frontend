import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  decodeInvocation,
  formatTokenAmount,
  type ContractManifestEntry,
} from "../decodeInvocation";

const SOURCE_KEY = Keypair.random().publicKey();
const ARENA_CONTRACT_ID = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const FACTORY_CONTRACT_ID = "CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5";
const STAKING_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC_CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const TAMPERED_CONTRACT_ID = "CD72Z6Y4C7X3I55T4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE32KXVY77";

const TEST_MANIFEST: ContractManifestEntry[] = [
  { id: ARENA_CONTRACT_ID, name: "Arena Contract" },
  { id: FACTORY_CONTRACT_ID, name: "Arena Factory" },
  { id: STAKING_CONTRACT_ID, name: "Staking Vault" },
  { id: USDC_CONTRACT_ID, name: "USDC Token", symbol: "USDC", decimals: 7 },
];

function buildGoldenInvokeXdr(
  contractId: string,
  fnName: string,
  args: xdr.ScVal[],
  authEntries: xdr.SorobanAuthorizationEntry[] = [],
): string {
  const account = new Account(SOURCE_KEY, "100");
  const contract = new Contract(contractId);
  const op = contract.call(fnName, ...args);
  if (authEntries.length > 0 && op.switch().name === "invokeHostFunction") {
    op.body().invokeHostFunctionOp().auth(authEntries);
  }
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

describe("decodeInvocation (#1829)", () => {
  it("formats token amounts with decimals accurately", () => {
    expect(formatTokenAmount(10_000_000n, 7)).toBe("1");
    expect(formatTokenAmount(15_500_000n, 7)).toBe("1.55");
    expect(formatTokenAmount(500_000n, 7)).toBe("0.05");
  });

  it("decodes join invocation with token transfer sub-invocation", () => {
    const player = Address.fromString(SOURCE_KEY);
    const transferAuth = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: player.toScAddress(),
          nonce: xdr.Int64.fromString("12345"),
          signatureExpirationLedger: 500000,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(ARENA_CONTRACT_ID).toScAddress(),
            functionName: "join",
            args: [player.toScVal(), nativeToScVal(100_000_000n, { type: "i128" })],
          }),
        ),
        subInvocations: [
          new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(USDC_CONTRACT_ID).toScAddress(),
                functionName: "transfer",
                args: [
                  player.toScVal(),
                  Address.fromString(ARENA_CONTRACT_ID).toScVal(),
                  nativeToScVal(100_000_000n, { type: "i128" }),
                ],
              }),
            ),
            subInvocations: [],
          }),
        ],
      }),
    });

    const xdrStr = buildGoldenInvokeXdr(
      ARENA_CONTRACT_ID,
      "join",
      [player.toScVal(), nativeToScVal(100_000_000n, { type: "i128" })],
      [transferAuth],
    );

    const summary = decodeInvocation(xdrStr, {
      networkPassphrase: Networks.TESTNET,
      knownContracts: TEST_MANIFEST,
    });

    expect(summary.isKnownContract).toBe(true);
    expect(summary.isBlocked).toBe(false);
    expect(summary.contractName).toBe("Arena Contract");
    expect(summary.functionName).toBe("join");
    expect(summary.args[0].label).toBe("player");
    expect(summary.args[1].label).toBe("amount");
    expect(summary.feeXlm).toBe("0.01");
    expect(summary.tokenTransfers).toHaveLength(1);
    expect(summary.tokenTransfers[0]).toMatchObject({
      symbol: "USDC",
      formattedAmount: "10",
      from: SOURCE_KEY,
      to: ARENA_CONTRACT_ID,
    });
  });

  it("decodes commit, reveal, claim, refund, stake, unstake, and create_pool fixtures", () => {
    const player = Address.fromString(SOURCE_KEY).toScVal();
    const commitment = nativeToScVal(Buffer.alloc(32, 7), { type: "bytes" });

    const cases: Array<[string, string, xdr.ScVal[]]> = [
      [ARENA_CONTRACT_ID, "commit", [player, commitment, nativeToScVal(1, { type: "u32" })]],
      [ARENA_CONTRACT_ID, "reveal", [player, nativeToScVal(0, { type: "u32" }), commitment, nativeToScVal(1, { type: "u32" })]],
      [ARENA_CONTRACT_ID, "claim", [player]],
      [ARENA_CONTRACT_ID, "refund", [player]],
      [STAKING_CONTRACT_ID, "stake", [player, nativeToScVal(50_000_000n, { type: "i128" })]],
      [STAKING_CONTRACT_ID, "unstake", [player, nativeToScVal(25_000_000n, { type: "i128" })]],
      [
        FACTORY_CONTRACT_ID,
        "create_pool",
        [
          player,
          nativeToScVal(10_000_000n, { type: "i128" }),
          Address.fromString(USDC_CONTRACT_ID).toScVal(),
          nativeToScVal(2, { type: "u32" }),
          nativeToScVal(100, { type: "u32" }),
        ],
      ],
    ];

    for (const [contractId, fn, args] of cases) {
      const xdrStr = buildGoldenInvokeXdr(contractId, fn, args);
      const summary = decodeInvocation(xdrStr, {
        networkPassphrase: Networks.TESTNET,
        knownContracts: TEST_MANIFEST,
      });
      expect(summary.isKnownContract).toBe(true);
      expect(summary.isBlocked).toBe(false);
      expect(summary.functionName).toBe(fn);
      expect(summary.args.length).toBe(args.length);
    }
  });

  it("blocks signing and raises warning when a tampered or unknown contract ID is present", () => {
    const player = Address.fromString(SOURCE_KEY).toScVal();
    const tamperedXdr = buildGoldenInvokeXdr(
      TAMPERED_CONTRACT_ID,
      "join",
      [player, nativeToScVal(500_000_000n, { type: "i128" })],
    );

    const summary = decodeInvocation(tamperedXdr, {
      networkPassphrase: Networks.TESTNET,
      knownContracts: TEST_MANIFEST,
    });

    expect(summary.isKnownContract).toBe(false);
    expect(summary.isBlocked).toBe(true);
    expect(summary.contractName).toBe("Unknown Contract");
    expect(summary.warnings[0]).toContain("Unknown target contract");
  });
});

import {
  Address,
  FeeBumpTransaction,
  Operation,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { stellarConfig, isStellarConfigured } from "@/shared/config/stellarConfig";

export interface DecodedArg {
  index: number;
  label: string;
  value: unknown;
  displayValue: string;
}

export interface DecodedAuthorizedInvocation {
  contractId: string;
  contractName: string;
  isKnownContract: boolean;
  functionName: string;
  args: unknown[];
  subInvocations: DecodedAuthorizedInvocation[];
}

export interface DecodedAuthEntry {
  signerAddress: string | null;
  nonce: string | null;
  rootInvocation: DecodedAuthorizedInvocation | null;
}

export interface DecodedTokenTransfer {
  tokenContractId: string;
  symbol: string;
  decimals: number;
  rawAmount: string;
  formattedAmount: string;
  from: string;
  to: string;
}

export interface DecodedResourceLimits {
  instructions?: number;
  readBytes?: number;
  writeBytes?: number;
  resourceFeeStroops?: string;
}

export interface DecodedInvocationSummary {
  contractId: string;
  contractName: string;
  isKnownContract: boolean;
  functionName: string;
  args: DecodedArg[];
  authEntries: DecodedAuthEntry[];
  tokenTransfers: DecodedTokenTransfer[];
  feeStroops: string;
  feeXlm: string;
  resourceLimits: DecodedResourceLimits;
  warnings: string[];
  isBlocked: boolean;
}

export interface ContractManifestEntry {
  id: string;
  name: string;
  symbol?: string;
  decimals?: number;
}

export interface DecodeInvocationOptions {
  networkPassphrase?: string;
  knownContracts?: ContractManifestEntry[];
  /** Additional dynamically-deployed arena IDs that are verified for this session. */
  knownArenaIds?: string[];
  /** Optional simulated auth/events from simulateTransaction for transfer derivation. */
  simulationEvents?: unknown[];
}

const KNOWN_FUNCTION_ARG_LABELS: Record<string, string[]> = {
  join: ["player", "amount"],
  join_arena: ["player", "choice_or_stake"],
  commit: ["player", "commitment", "round"],
  commit_choice: ["player", "commitment"],
  reveal: ["player", "choice", "salt", "round"],
  reveal_choice: ["player", "choice", "salt"],
  claim: ["player"],
  claim_prize: ["winner"],
  refund: ["player"],
  claim_refund: ["player"],
  stake: ["staker", "amount"],
  unstake: ["staker", "shares"],
  create_pool: ["creator", "entry_fee", "stake_token", "min_players", "max_players"],
};

export function formatTokenAmount(raw: bigint | string | number, decimals = 7): string {
  const value = typeof raw === "bigint" ? raw : BigInt(String(raw));
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  if (frac === 0n) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
}

function safeScValToNative(val: xdr.ScVal): unknown {
  try {
    const native = scValToNative(val);
    return normalizeNativeValue(native);
  } catch {
    return `[ScVal:${val.switch().name}]`;
  }
}

function normalizeNativeValue(val: unknown): unknown {
  if (typeof val === "bigint") {
    return val.toString();
  }
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    return `0x${Buffer.from(val).toString("hex")}`;
  }
  if (Array.isArray(val)) {
    return val.map(normalizeNativeValue);
  }
  if (val !== null && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = normalizeNativeValue(v);
    }
    return out;
  }
  return val;
}

function formatDisplayValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

export function buildDefaultManifest(knownArenaIds: string[] = []): ContractManifestEntry[] {
  const entries: ContractManifestEntry[] = [];
  if (isStellarConfigured) {
    entries.push({ id: stellarConfig.factoryContractId, name: "Arena Factory" });
    entries.push({
      id: stellarConfig.usdcContractId,
      name: "USDC Token",
      symbol: "USDC",
      decimals: 7,
    });
    entries.push({
      id: stellarConfig.xlmContractId,
      name: "XLM Token",
      symbol: "XLM",
      decimals: 7,
    });
    if (stellarConfig.stakingContractId) {
      entries.push({ id: stellarConfig.stakingContractId, name: "Staking Vault" });
    }
    if (stellarConfig.rwaVaultContractId) {
      entries.push({ id: stellarConfig.rwaVaultContractId, name: "RWA Yield Vault" });
    }
    if (stellarConfig.oracleContractId) {
      entries.push({ id: stellarConfig.oracleContractId, name: "Price / Yield Oracle" });
    }
  }
  for (const arenaId of knownArenaIds) {
    if (arenaId && !entries.some((e) => e.id === arenaId)) {
      entries.push({ id: arenaId, name: "Arena Contract" });
    }
  }
  return entries;
}

function lookupManifest(
  contractId: string,
  manifestMap: Map<string, ContractManifestEntry>,
): { name: string; isKnown: boolean; symbol?: string; decimals?: number } {
  const entry = manifestMap.get(contractId);
  if (entry) {
    return {
      name: entry.name,
      isKnown: true,
      symbol: entry.symbol,
      decimals: entry.decimals,
    };
  }
  return { name: "Unknown Contract", isKnown: false };
}

function decodeAuthorizedInvocation(
  inv: xdr.SorobanAuthorizedInvocation,
  manifestMap: Map<string, ContractManifestEntry>,
): DecodedAuthorizedInvocation | null {
  const fn = inv.function();
  if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") {
    return null;
  }
  const contractFn = fn.contractFn();
  const contractId = Address.fromScAddress(contractFn.contractAddress()).toString();
  const match = lookupManifest(contractId, manifestMap);
  const functionName = contractFn.functionName().toString();
  const args = contractFn.args().map(safeScValToNative);
  const subInvocations = inv
    .subInvocations()
    .map((sub) => decodeAuthorizedInvocation(sub, manifestMap))
    .filter((sub): sub is DecodedAuthorizedInvocation => sub !== null);

  return {
    contractId,
    contractName: match.name,
    isKnownContract: match.isKnown,
    functionName,
    args,
    subInvocations,
  };
}

function collectTokenTransfers(
  inv: DecodedAuthorizedInvocation,
  manifestMap: Map<string, ContractManifestEntry>,
  out: DecodedTokenTransfer[],
): void {
  if (
    (inv.functionName === "transfer" || inv.functionName === "transfer_from") &&
    inv.args.length >= 3
  ) {
    const tokenInfo = manifestMap.get(inv.contractId);
    const symbol = tokenInfo?.symbol ?? "TOKEN";
    const decimals = tokenInfo?.decimals ?? 7;
    const from = String(inv.args[inv.functionName === "transfer_from" ? 1 : 0] ?? "");
    const to = String(inv.args[inv.functionName === "transfer_from" ? 2 : 1] ?? "");
    const rawAmount = String(inv.args[inv.functionName === "transfer_from" ? 3 : 2] ?? "0");
    let formattedAmount = rawAmount;
    try {
      formattedAmount = formatTokenAmount(rawAmount, decimals);
    } catch {
      // Keep raw string if not an integer
    }

    out.push({
      tokenContractId: inv.contractId,
      symbol,
      decimals,
      rawAmount,
      formattedAmount,
      from,
      to,
    });
  }

  for (const sub of inv.subInvocations) {
    collectTokenTransfers(sub, manifestMap, out);
  }
}

/**
 * Decode an unsigned or signed Soroban transaction XDR into a human-readable,
 * manifest-verified invocation summary before prompting the user's wallet.
 */
export function decodeInvocation(
  xdrString: string,
  options: DecodeInvocationOptions = {},
): DecodedInvocationSummary {
  const passphrase =
    options.networkPassphrase ??
    (isStellarConfigured ? stellarConfig.passphrase : "Test SDF Network ; September 2015");

  const manifestEntries =
    options.knownContracts ?? buildDefaultManifest(options.knownArenaIds ?? []);
  const manifestMap = new Map(manifestEntries.map((e) => [e.id, e]));

  const parsed = TransactionBuilder.fromXDR(xdrString, passphrase);
  const tx: Transaction =
    parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;

  const feeStroops = tx.fee ?? "0";
  const feeXlm = formatTokenAmount(feeStroops, 7);

  const resourceLimits: DecodedResourceLimits = {};
  const sorobanData = (tx as unknown as { sorobanData?: xdr.SorobanTransactionData }).sorobanData;
  if (sorobanData) {
    const res = sorobanData.resources();
    resourceLimits.instructions = res.instructions();
    resourceLimits.readBytes =
      typeof (res as unknown as { diskReadBytes?: () => number }).diskReadBytes === "function"
        ? (res as unknown as { diskReadBytes: () => number }).diskReadBytes()
        : (res as unknown as { readBytes?: () => number }).readBytes?.();
    resourceLimits.writeBytes = res.writeBytes();
    resourceLimits.resourceFeeStroops = sorobanData.resourceFee().toString();
  }

  const invokeOp = tx.operations.find(
    (op): op is Operation.InvokeHostFunction => op.type === "invokeHostFunction",
  );

  if (!invokeOp) {
    return {
      contractId: "",
      contractName: "Non-Soroban Transaction",
      isKnownContract: false,
      functionName: tx.operations[0]?.type ?? "unknown",
      args: [],
      authEntries: [],
      tokenTransfers: [],
      feeStroops,
      feeXlm,
      resourceLimits,
      warnings: ["Transaction does not contain a Soroban invokeHostFunction operation."],
      isBlocked: true,
    };
  }

  const func = invokeOp.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    return {
      contractId: "",
      contractName: "Host Function",
      isKnownContract: false,
      functionName: func.switch().name,
      args: [],
      authEntries: [],
      tokenTransfers: [],
      feeStroops,
      feeXlm,
      resourceLimits,
      warnings: [`Unsupported host function type: ${func.switch().name}`],
      isBlocked: true,
    };
  }

  const invokeArgs = func.invokeContract();
  const contractId = Address.fromScAddress(invokeArgs.contractAddress()).toString();
  const manifestMatch = lookupManifest(contractId, manifestMap);
  const functionName = invokeArgs.functionName().toString();
  const argLabels = KNOWN_FUNCTION_ARG_LABELS[functionName] ?? [];

  const args: DecodedArg[] = invokeArgs.args().map((scVal, index) => {
    const value = safeScValToNative(scVal);
    return {
      index,
      label: argLabels[index] ?? `arg_${index}`,
      value,
      displayValue: formatDisplayValue(value),
    };
  });

  const rawAuths = invokeOp.auth ?? [];
  const authEntries: DecodedAuthEntry[] = rawAuths.map((entry) => {
    const creds = entry.credentials();
    let signerAddress: string | null = null;
    let nonce: string | null = null;
    if (creds.switch().name === "sorobanCredentialsAddress") {
      signerAddress = Address.fromScAddress(creds.address().address()).toString();
      nonce = creds.address().nonce().toString();
    }
    const rootInvocation = decodeAuthorizedInvocation(entry.rootInvocation(), manifestMap);
    return { signerAddress, nonce, rootInvocation };
  });

  const tokenTransfers: DecodedTokenTransfer[] = [];
  for (const auth of authEntries) {
    if (auth.rootInvocation) {
      collectTokenTransfers(auth.rootInvocation, manifestMap, tokenTransfers);
    }
  }

  // Also detect direct token contract transfer invocation
  if (
    (functionName === "transfer" || functionName === "transfer_from") &&
    args.length >= 3 &&
    tokenTransfers.length === 0
  ) {
    const tokenInfo = manifestMap.get(contractId);
    const symbol = tokenInfo?.symbol ?? "TOKEN";
    const decimals = tokenInfo?.decimals ?? 7;
    const rawAmount = String(args[functionName === "transfer_from" ? 3 : 2]?.value ?? "0");
    let formattedAmount = rawAmount;
    try {
      formattedAmount = formatTokenAmount(rawAmount, decimals);
    } catch {
      // Keep raw string
    }
    tokenTransfers.push({
      tokenContractId: contractId,
      symbol,
      decimals,
      rawAmount,
      formattedAmount,
      from: String(args[functionName === "transfer_from" ? 1 : 0]?.value ?? ""),
      to: String(args[functionName === "transfer_from" ? 2 : 1]?.value ?? ""),
    });
  }

  const warnings: string[] = [];
  let isBlocked = false;

  if (!manifestMatch.isKnown) {
    isBlocked = true;
    warnings.push(
      `Unknown target contract (${contractId}) is not in the configured deployment manifest. Signing is blocked for your protection.`,
    );
  }

  // Also check if any authorized sub-invocation targets an unknown contract
  const checkUnknownSub = (inv: DecodedAuthorizedInvocation) => {
    if (!inv.isKnownContract) {
      isBlocked = true;
      warnings.push(
        `Authorized sub-invocation targets unknown contract (${inv.contractId}) calling ${inv.functionName}.`,
      );
    }
    inv.subInvocations.forEach(checkUnknownSub);
  };
  for (const auth of authEntries) {
    if (auth.rootInvocation) {
      checkUnknownSub(auth.rootInvocation);
    }
  }

  return {
    contractId,
    contractName: manifestMatch.name,
    isKnownContract: manifestMatch.isKnown,
    functionName,
    args,
    authEntries,
    tokenTransfers,
    feeStroops,
    feeXlm,
    resourceLimits,
    warnings: [...new Set(warnings)],
    isBlocked,
  };
}

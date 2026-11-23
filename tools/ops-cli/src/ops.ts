/**
 * Contract calls through Soroban RPC. Reads are simulations. Mutations are
 * simulated (dry run) unless `submit` is set; then they are signed, sent and
 * awaited.
 *
 * Argument encoding, result decoding and error names all come from the
 * contract's own spec, read from its WASM: from the network by default, or
 * from a local build with --wasm-dir.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  contract,
  rpc,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import { encodeArgs, toJsonSafe } from "./encode.js";
import type { Deployment } from "./manifest.js";
import { confirmSubmit } from "./safety.js";
import type { Signer } from "./signer.js";

/** Simulation source for reads; any account works because nothing is signed. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export class ContractCallError extends Error {
  override name = "ContractCallError";
  constructor(
    message: string,
    readonly contractError?: { code: number; name: string },
  ) {
    super(message);
  }
}

/** Compiled WASM file name per contract kind, for --wasm-dir. */
export const WASM_FILES = {
  arena: "arena.wasm",
  factory: "factory.wasm",
  oracle: "oracle.wasm",
  vault: "rwa_adapter.wasm",
  staking: "staking.wasm",
  payout: "payout.wasm",
} as const;

export type WasmKind = keyof typeof WASM_FILES;

export interface OpsOptions {
  deployment: Deployment;
  server: rpc.Server;
  wasmDir?: string | undefined;
  signer?: Signer | undefined;
  submit: boolean;
  confirmMainnet: boolean;
  interactive: boolean;
  /** Progress messages; stderr so --json output stays parseable. */
  log?: (message: string) => void;
}

export interface MutationReport {
  mode: "dry-run" | "submitted";
  network: string;
  contract: string;
  method: string;
  source: string;
  /** Decoded return value. */
  result: unknown;
  /** From simulation: the fee floor for the resources used, in stroops. */
  minResourceFee: string;
  resources: { instructions: number; readBytes: number; writeBytes: number; readEntries: number; writeEntries: number };
  /** Addresses whose authorization the call needs. */
  authorizers: string[];
  txHash?: string;
  ledger?: number;
}

/** Map "Error(Contract, #N)" in a simulation error to the spec's error name. */
export function decodeContractError(spec: contract.Spec, message: string): { code: number; name: string } | undefined {
  const match = /Error\(Contract, #(\d+)\)/.exec(message);
  if (!match) return undefined;
  const code = Number(match[1]);
  const found = spec.errorCases().find((c) => c.value() === code);
  return { code, name: found ? found.name().toString() : `#${code}` };
}

function unwrapResult(value: unknown): unknown {
  // Spec returns Result<T, E> outputs as an Ok wrapper; errors already threw.
  if (value && typeof value === "object" && "unwrap" in value && typeof value.unwrap === "function") {
    return (value as { unwrap: () => unknown }).unwrap();
  }
  return value;
}

export class Ops {
  private readonly specs = new Map<string, Promise<contract.Spec>>();
  readonly deployment: Deployment;

  constructor(private readonly options: OpsOptions) {
    this.deployment = options.deployment;
  }

  get server(): rpc.Server {
    return this.options.server;
  }

  private log(message: string) {
    this.options.log?.(message);
  }

  spec(contractId: string, kind: WasmKind): Promise<contract.Spec> {
    const key = this.options.wasmDir ? `${kind}:${this.options.wasmDir}` : contractId;
    let spec = this.specs.get(key);
    if (!spec) {
      spec = (async () => {
        const wasm = this.options.wasmDir
          ? readFileSync(join(this.options.wasmDir, WASM_FILES[kind]))
          : await this.options.server.getContractWasmByContractId(contractId);
        return contract.Spec.fromWasm(wasm);
      })();
      this.specs.set(key, spec);
    }
    return spec;
  }

  private build(source: Account, contractId: string, method: string, args: xdr.ScVal[]): Transaction {
    return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: this.deployment.networkPassphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
  }

  private async simulate(spec: contract.Spec, tx: Transaction, method: string) {
    const sim = await this.options.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      const decoded = decodeContractError(spec, sim.error);
      const what = decoded ? `contract error ${decoded.name} (#${decoded.code})` : sim.error.split("\n")[0];
      throw new ContractCallError(`${method} failed in simulation: ${what}`, decoded);
    }
    return sim;
  }

  /** Simulate a read-only call and return its decoded result. */
  async read(contractId: string, kind: WasmKind, method: string, rawArgs: readonly string[] = []): Promise<unknown> {
    const spec = await this.spec(contractId, kind);
    const tx = this.build(new Account(NULL_ACCOUNT, "0"), contractId, method, encodeArgs(spec, method, rawArgs));
    const sim = await this.simulate(spec, tx, method);
    const retval = sim.result?.retval;
    return retval === undefined ? undefined : toJsonSafe(unwrapResult(spec.funcResToNative(method, retval)));
  }

  /**
   * Run a state-changing call. Simulates by default and reports what would
   * happen; with `submit`, confirms on mainnet, signs, sends and waits.
   */
  async mutate(contractId: string, kind: WasmKind, method: string, rawArgs: readonly string[] = []): Promise<MutationReport> {
    const spec = await this.spec(contractId, kind);
    const args = encodeArgs(spec, method, rawArgs);
    const { signer, submit } = this.options;
    if (submit && !signer) throw new ContractCallError("--submit needs a --signer");
    const source = signer ? await signer.publicKey() : NULL_ACCOUNT;

    const account = submit ? await this.options.server.getAccount(source) : new Account(source, "0");
    const tx = this.build(account, contractId, method, args);
    const sim = await this.simulate(spec, tx, method);

    const data = sim.transactionData.build();
    const resources = data.resources();
    const footprint = resources.footprint();
    const report: MutationReport = {
      mode: "dry-run",
      network: this.deployment.network,
      contract: contractId,
      method,
      source,
      result: sim.result?.retval ? toJsonSafe(unwrapResult(spec.funcResToNative(method, sim.result.retval))) : undefined,
      minResourceFee: sim.minResourceFee,
      resources: {
        instructions: resources.instructions(),
        readBytes: resources.diskReadBytes(),
        writeBytes: resources.writeBytes(),
        readEntries: footprint.readOnly().length,
        writeEntries: footprint.readWrite().length,
      },
      authorizers: (sim.result?.auth ?? []).map((entry) => {
        const credentials = entry.credentials();
        // Source-account credentials are satisfied by the envelope signature.
        return credentials.switch().name === "sorobanCredentialsAddress"
          ? Address.fromScAddress(credentials.address().address()).toString()
          : source;
      }),
    };
    if (!submit) return report;

    await confirmSubmit({
      network: this.deployment.network,
      action: `${method} on ${contractId}`,
      confirmFlag: this.options.confirmMainnet,
      interactive: this.options.interactive,
    });
    const assembled = rpc.assembleTransaction(tx, sim).build();
    await signer!.sign(assembled);
    this.log(`Submitting ${method} signed by ${signer!.description}…`);
    const sent = await this.options.server.sendTransaction(assembled);
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      throw new ContractCallError(`Submission rejected (${sent.status}) for ${sent.hash}`);
    }
    const final = await this.options.server.pollTransaction(sent.hash, { attempts: 30 });
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new ContractCallError(`Transaction ${sent.hash} finished with status ${final.status}`);
    }
    return {
      ...report,
      mode: "submitted",
      txHash: sent.hash,
      ledger: final.ledger,
      result: final.returnValue ? toJsonSafe(unwrapResult(spec.funcResToNative(method, final.returnValue))) : report.result,
    };
  }
}

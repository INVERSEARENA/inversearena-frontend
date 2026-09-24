import { Contract } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";

export type SorobanServerConstructor = new (serverUrl: string) => Server;

export type ContractClientFactoryDeps = {
  Server: SorobanServerConstructor;
};

export type DeploymentManifest = {
  network: string;
  rpcUrl: string;
  passphrase: string;
  contracts: Record<string, { address: string; version?: string }>;
};

/**
 * Creates Soroban RPC clients and {@link Contract} handles without embedding URLs in call sites.
 * Inject `deps.Server` in tests to avoid real RPC.
 *
 * Implements singleton pattern for Server and contract cache to reduce
 * re-initialization overhead on hot paths.
 */
export class ContractClientFactory {
  private _rpcServer: Server | null = null;
  private _contractCache = new Map<string, Contract>();
  private readonly manifest: DeploymentManifest;

  constructor(
    manifestOrRpcUrl: DeploymentManifest | string,
    private readonly deps: ContractClientFactoryDeps = { Server },
  ) {
    this.manifest = typeof manifestOrRpcUrl === "string"
      ? { network: "unknown", rpcUrl: manifestOrRpcUrl, passphrase: "", contracts: {} }
      : manifestOrRpcUrl;
  }

  get rpcUrl(): string {
    return this.manifest.rpcUrl;
  }

  get deployment(): DeploymentManifest {
    return this.manifest;
  }

  createRpcServer(): Server {
    if (!this._rpcServer) {
      this._rpcServer = new this.deps.Server(this.manifest.rpcUrl);
    }
    return this._rpcServer;
  }

  createContract(contractId: string): Contract {
    let contract = this._contractCache.get(contractId);
    if (!contract) {
      contract = new Contract(contractId);
      this._contractCache.set(contractId, contract);
    }
    return contract;
  }

  createNamedContract(name: string): Contract {
    const deployment = this.manifest.contracts[name];
    if (!deployment?.address) {
      throw new Error(`Contract "${name}" is not present in the ${this.manifest.network} deployment manifest`);
    }
    return this.createContract(deployment.address);
  }

  clearCache(): void {
    this._rpcServer = null;
    this._contractCache.clear();
  }
}

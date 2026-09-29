import { Contract } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import {
  parseSorobanContractId,
  type NetworkBoundContractId,
  type SorobanContractId,
  type ParseContractIdOptions,
} from "@/shared-d/utils/identity-value-objects";

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
 *
 * Contract ID validation (#1522): `createContract` and `createNamedContract`
 * now validate the contract ID via `parseSorobanContractId` before constructing
 * a `Contract` instance.  Pass `{ allowPlaceholder: true }` for test fixtures.
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

  /**
   * Create a {@link Contract} for the given contract ID string, validating it
   * via {@link parseSorobanContractId} before construction (#1522).
   *
   * @param contractId - Raw contract address string.
   * @param options    - Pass `{ allowPlaceholder: true }` for test/demo fixtures.
   */
  createContract(contractId: string, options: ParseContractIdOptions = {}): Contract {
    const validated: SorobanContractId = parseSorobanContractId(contractId, options);
    let contract = this._contractCache.get(validated);
    if (!contract) {
      contract = new Contract(validated);
      this._contractCache.set(validated, contract);
    }
    return contract;
  }

  /**
   * Create a {@link Contract} for a network-bound contract ID, validating that
   * the contract's network matches this factory's deployment manifest (#1522).
   *
   * @throws {Error} when the network identity of `bound` does not match
   *   the factory's deployment passphrase.
   */
  createNetworkBoundContract(bound: NetworkBoundContractId): Contract {
    // The factory's own passphrase-derived identity (lazy, for factories
    // constructed from a plain rpcUrl string that carry no passphrase).
    if (this.manifest.passphrase) {
      const { deriveNetworkIdentity, parseNetworkPassphrase } =
        require("@/shared-d/utils/identity-value-objects") as typeof import("@/shared-d/utils/identity-value-objects");
      const factoryNetwork = deriveNetworkIdentity(parseNetworkPassphrase(this.manifest.passphrase));
      if (bound.network !== factoryNetwork) {
        throw new Error(
          `Contract ${bound.contractId} is bound to network "${bound.network}" but this factory is on "${factoryNetwork}"`,
        );
      }
    }
    return this.createContract(bound.contractId);
  }

  createNamedContract(name: string, options: ParseContractIdOptions = {}): Contract {
    const deployment = this.manifest.contracts[name];
    if (!deployment?.address) {
      throw new Error(`Contract "${name}" is not present in the ${this.manifest.network} deployment manifest`);
    }
    return this.createContract(deployment.address, options);
  }

  clearCache(): void {
    this._rpcServer = null;
    this._contractCache.clear();
  }
}

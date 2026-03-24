import { Contract } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";

export type SorobanServerConstructor = new (serverUrl: string) => Server;

export type ContractClientFactoryDeps = {
  Server: SorobanServerConstructor;
};

/**
 * Creates Soroban RPC clients and {@link Contract} handles without embedding URLs in call sites.
 * Inject `deps.Server` in tests to avoid real RPC.
 */
export class ContractClientFactory {
  constructor(
    private readonly sorobanRpcUrl: string,
    private readonly deps: ContractClientFactoryDeps = { Server },
  ) {}

  get rpcUrl(): string {
    return this.sorobanRpcUrl;
  }

  createRpcServer(): Server {
    return new this.deps.Server(this.sorobanRpcUrl);
  }

  createContract(contractId: string): Contract {
    return new Contract(contractId);
  }
}

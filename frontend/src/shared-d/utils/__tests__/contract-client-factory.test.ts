import { describe, it, expect } from "@jest/globals";
import { Contract } from "@stellar/stellar-sdk";
import {
  ContractClientFactory,
  type ContractClientFactoryDeps,
} from "../contract-client-factory";

describe("ContractClientFactory", () => {
  it("constructs RPC server with injected Server implementation", () => {
    const rpcUrl = "https://soroban.test/rpc";

    class FakeServer {
      readonly passedUrl: string;
      constructor(url: string) {
        this.passedUrl = url;
      }
    }

    const factory = new ContractClientFactory(rpcUrl, {
      Server: FakeServer as unknown as ContractClientFactoryDeps["Server"],
    });

    const server = factory.createRpcServer() as unknown as FakeServer;
    expect(server.passedUrl).toBe(rpcUrl);
  });

  it("creates Contract instances for the given id", () => {
    const factory = new ContractClientFactory("https://x");
    const id = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const c = factory.createContract(id);
    expect(c).toBeInstanceOf(Contract);
  });

  it("exposes rpcUrl", () => {
    const u = "https://rpc.example";
    expect(new ContractClientFactory(u).rpcUrl).toBe(u);
  });
});

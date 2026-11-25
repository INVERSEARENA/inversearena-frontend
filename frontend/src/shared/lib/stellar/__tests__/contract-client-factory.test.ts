import { describe, it, expect } from "@jest/globals";
import { Contract, StrKey } from "@stellar/stellar-sdk";
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

  it("returns same Server instance on multiple createRpcServer calls", () => {
    const factory = new ContractClientFactory("https://x");
    const server1 = factory.createRpcServer();
    const server2 = factory.createRpcServer();
    expect(server1).toBe(server2);
  });

  it("returns same Contract instance for same contract ID", () => {
    const factory = new ContractClientFactory("https://x");
    const id = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const c1 = factory.createContract(id);
    const c2 = factory.createContract(id);
    expect(c1).toBe(c2);
  });

  it("returns different Contract instances for different IDs", () => {
    const factory = new ContractClientFactory("https://x");
    const id1 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const id2 = StrKey.encodeContract(Buffer.alloc(32, 7));
    const c1 = factory.createContract(id1);
    const c2 = factory.createContract(id2);
    expect(c1).not.toBe(c2);
  });

  it("clearCache resets server and contracts", () => {
    const factory = new ContractClientFactory("https://x");
    const server1 = factory.createRpcServer();
    const id = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const contract1 = factory.createContract(id);

    factory.clearCache();

    const server2 = factory.createRpcServer();
    const contract2 = factory.createContract(id);

    expect(server1).not.toBe(server2);
    expect(contract1).not.toBe(contract2);
  });
});

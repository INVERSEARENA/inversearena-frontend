import { rpc } from "@stellar/stellar-sdk";
import { StellarRpcGateway, type SorobanRpcTransaction } from "../stellarRpcGateway";
import { SimulationFailedError } from "@/shared/lib/stellar/contract-error";

describe("StellarRpcGateway.prepareTransaction (#1597)", () => {
  function gatewayWith(simulation: unknown) {
    const gateway = new StellarRpcGateway();
    jest.spyOn(gateway, "simulateTransaction").mockResolvedValue(
      simulation as Awaited<ReturnType<rpc.Server["simulateTransaction"]>>,
    );
    return gateway;
  }

  it("keeps the diagnostic events of a failed simulation", async () => {
    const failure = {
      id: "1",
      latestLedger: 10,
      error: "HostError: Error(Contract, #44)",
      events: ["AAAA"],
    };
    const gateway = gatewayWith(failure);

    const prepared = gateway.prepareTransaction({} as SorobanRpcTransaction);
    await expect(prepared).rejects.toBeInstanceOf(SimulationFailedError);
    await expect(prepared).rejects.toMatchObject({ simulation: failure });
  });
});

import {
  SorobanSimulationSingleFlight,
  setSorobanSimulationSingleFlightForTest,
} from "../src/utils/sorobanSimulationSingleFlight";
import { nativeToScVal } from "@stellar/stellar-sdk";

describe("SorobanSimulationSingleFlight (#1499)", () => {
  afterEach(() => {
    setSorobanSimulationSingleFlightForTest(null);
  });

  it("coalesces concurrent identical keys into one fetcher", async () => {
    const flight = new SorobanSimulationSingleFlight({ ttlMs: 10_000 });
    setSorobanSimulationSingleFlightForTest(flight);

    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true };
    };

    const key = SorobanSimulationSingleFlight.buildKey({
      network: "Test SDF Network ; September 2015",
      ledgerSequence: 100,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      functionName: "game_state",
      args: [],
    });

    const [a, b] = await Promise.all([
      flight.run(key, fetcher),
      flight.run(key, fetcher),
    ]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it("does not coalesce different ledger sequences", async () => {
    const flight = new SorobanSimulationSingleFlight({ ttlMs: 10_000 });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return calls;
    };

    const base = {
      network: "Test SDF Network ; September 2015",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      functionName: "game_state",
      args: [nativeToScVal(1)],
    };

    await Promise.all([
      flight.run(
        SorobanSimulationSingleFlight.buildKey({ ...base, ledgerSequence: 1 }),
        fetcher,
      ),
      flight.run(
        SorobanSimulationSingleFlight.buildKey({ ...base, ledgerSequence: 2 }),
        fetcher,
      ),
    ]);

    expect(calls).toBe(2);
  });
});

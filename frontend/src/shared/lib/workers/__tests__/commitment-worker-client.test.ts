import { computeCommitment } from "@/shared/lib/stellar/commit-reveal";
import { createCommitmentWorkerClient, type WorkerLike } from "@/shared/lib/workers/commitment-worker-client";

const context = {
  arenaId: "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V",
  round: 1,
  player: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
};
const salt = new Uint8Array(32).fill(7);

describe("commitment worker client", () => {
  it("falls back to the main thread when no worker factory is provided", async () => {
    const client = createCommitmentWorkerClient(null);
    expect(client.mode).toBe("main-thread");
    const digest = await client.computeCommitment({ choice: "Heads", salt, context });
    expect(digest).toEqual(await computeCommitment("Heads", salt, context));
  });

  it("falls back to the main thread when the worker factory throws", async () => {
    const client = createCommitmentWorkerClient(() => {
      throw new Error("no worker");
    });
    expect(client.mode).toBe("main-thread");
  });

  it("routes requests through the worker and resolves by correlation id", async () => {
    const expected = await computeCommitment("Tails", salt, context);
    let listener: WorkerLike | null = null;
    const fake: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        queueMicrotask(() =>
          fake.onmessage?.({
            data: { type: "result", id: message.id, digest: expected },
          } as MessageEvent),
        );
      },
      terminate: jest.fn(),
    };
    listener = fake;
    const client = createCommitmentWorkerClient(() => listener!);
    expect(client.mode).toBe("worker");
    await expect(client.computeCommitment({ choice: "Tails", salt, context })).resolves.toEqual(expected);
  });

  it("switches to the main thread after a worker error", async () => {
    const fake: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: jest.fn(),
      terminate: jest.fn(),
    };
    const client = createCommitmentWorkerClient(() => fake);
    const pendingCall = client.computeCommitment({ choice: "Heads", salt, context });
    fake.onerror?.({ message: "crashed" } as ErrorEvent);
    await expect(pendingCall).rejects.toThrow("crashed");
    expect(client.mode).toBe("main-thread");
    expect(fake.terminate).toHaveBeenCalled();
  });
});

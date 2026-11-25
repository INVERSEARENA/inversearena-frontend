import { createCommitmentWorkerClient, type CommitmentWorkerClient } from "@/shared/lib/workers/commitment-worker-client";

/**
 * Creates a commitment client backed by the bundled worker, or the main
 * thread when `Worker` is unavailable.
 */
export function createBrowserCommitmentWorkerClient(): CommitmentWorkerClient {
  const canUseWorker = typeof Worker !== "undefined";
  return createCommitmentWorkerClient(
    canUseWorker
      ? () =>
          new Worker(new URL("./commitment.worker.ts", import.meta.url), {
            type: "module",
          })
      : null,
  );
}

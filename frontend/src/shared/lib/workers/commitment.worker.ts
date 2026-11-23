/**
 * Web Worker entry for CPU-bound commitment hashing (#1771). Runs off the UI
 * thread so commit/reveal hashing does not block input during time-sensitive
 * windows. Loaded only through `commitment-worker-browser.ts`.
 */
import { computeCommitment } from "@/shared/lib/stellar/commit-reveal";
import type {
  CommitmentRequestMessage,
  CommitmentResponseMessage,
} from "@/shared/lib/workers/commitment-worker-protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<CommitmentRequestMessage>) => void) | null;
  postMessage(message: CommitmentResponseMessage, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = async (event) => {
  const request = event.data;
  if (request.type !== "computeCommitment") {
    return;
  }
  try {
    const digest = await computeCommitment(request.choice, request.salt, request.context);
    scope.postMessage({ type: "result", id: request.id, digest }, [digest.buffer]);
  } catch (error) {
    scope.postMessage({
      type: "error",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

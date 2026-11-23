import {
  computeCommitment,
  type CommitmentContext,
  type RoundChoice,
} from "@/shared/lib/stellar/commit-reveal";
import type {
  CommitmentRequestMessage,
  CommitmentResponseMessage,
} from "@/shared/lib/workers/commitment-worker-protocol";

export interface CommitmentRequest {
  choice: RoundChoice;
  salt: Uint8Array;
  context: CommitmentContext;
}

/** Minimal Worker surface the client depends on (eases testing). */
export interface WorkerLike {
  postMessage(message: CommitmentRequestMessage): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<CommitmentResponseMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface CommitmentWorkerClient {
  /** `"worker"` while requests go to a worker, `"main-thread"` after fallback. */
  readonly mode: "worker" | "main-thread";
  computeCommitment(request: CommitmentRequest): Promise<Uint8Array>;
  dispose(): void;
}

/**
 * Typed RPC client over a commitment worker. If the worker cannot be created,
 * or fails at runtime, all work falls back to the main thread so commit/reveal
 * keeps working on browsers without worker support.
 */
export function createCommitmentWorkerClient(
  createWorker: (() => WorkerLike) | null,
): CommitmentWorkerClient {
  let worker: WorkerLike | null = null;
  let mode: "worker" | "main-thread" = "main-thread";
  let nextId = 1;
  const pending = new Map<number, { resolve: (d: Uint8Array) => void; reject: (e: Error) => void }>();

  const fallBack = (reason: Error) => {
    for (const { reject } of pending.values()) {
      reject(reason);
    }
    pending.clear();
    worker?.terminate();
    worker = null;
    mode = "main-thread";
  };

  if (createWorker) {
    try {
      worker = createWorker();
      mode = "worker";
      worker.onmessage = (event) => {
        const message = event.data;
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.type === "result") {
          entry.resolve(message.digest);
        } else {
          entry.reject(new Error(message.message));
        }
      };
      worker.onerror = (event) => fallBack(new Error(event.message || "commitment worker failed"));
    } catch {
      worker = null;
      mode = "main-thread";
    }
  }

  return {
    get mode() {
      return mode;
    },
    computeCommitment(request) {
      if (!worker) {
        return computeCommitment(request.choice, request.salt, request.context);
      }
      const activeWorker = worker;
      const id = nextId++;
      return new Promise<Uint8Array>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        activeWorker.postMessage({ type: "computeCommitment", id, ...request });
      });
    },
    dispose() {
      fallBack(new Error("commitment worker disposed"));
    },
  };
}

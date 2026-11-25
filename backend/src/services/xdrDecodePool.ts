/**
 * Bounded worker_threads pool for CPU-heavy XDR decoding (#1834).
 *
 * Offloads compute-intensive `getLedgerEntries` XDR parsing and `scValToNative`
 * conversion from the main event-loop thread to worker threads, preventing event-loop
 * lag spikes and p99 latency degradation during high arena counts.
 */

import os from "node:os";
import { Worker } from "node:worker_threads";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import {
  xdrDecodeDurationSeconds,
  xdrDecodePoolTasksTotal,
  xdrDecodePoolQueueDepth,
} from "../metrics/domains/poller.metrics";
import { logger } from "../utils/logger";

export class PoolSaturationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolSaturationError";
  }
}

export class XdrDecodeError extends Error {
  constructor(message: string, readonly originalCause?: unknown) {
    super(message);
    this.name = "XdrDecodeError";
  }
}

export interface XdrDecodePoolOptions {
  /** Number of worker threads. Defaults to Math.max(1, availableParallelism() - 1), capped at 8. */
  threadCount?: number;
  /** Maximum queued tasks allowed before shedding load / throwing PoolSaturationError. Defaults to 1,000. */
  maxQueueSize?: number;
  /** Minimum batch size threshold to offload to worker threads vs decode inline. Defaults to 5. */
  batchThreshold?: number;
}

export interface LedgerEntryItem {
  name: string;
  xdr: string;
  liveUntil?: number;
}

interface WorkerTask {
  id: number;
  type: "LEDGER_ENTRIES" | "SCVALS" | "ARENA_EVENTS";
  payload: unknown;
  nowLedger?: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface WorkerHandle {
  worker: Worker;
  index: number;
  busy: boolean;
  currentTask: WorkerTask | null;
}

/**
 * Structured-clone serialization helpers.
 * Ensures `bigint` types (e.g. i128 / u128 / i256 ScVals) pass safely
 * across Node thread boundaries without precision loss or serialization errors.
 */
export function serializeBigIntForClone(value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __isBigInt: true, value: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map(serializeBigIntForClone);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeBigIntForClone(v);
    }
    return out;
  }
  return value;
}

export function deserializeBigIntFromClone(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    if ((value as Record<string, unknown>).__isBigInt && typeof (value as Record<string, unknown>).value === "string") {
      return BigInt((value as Record<string, unknown>).value as string);
    }
    if (Array.isArray(value)) {
      return value.map(deserializeBigIntFromClone);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deserializeBigIntFromClone(v);
    }
    return out;
  }
  return value;
}

/** Inline worker implementation script for universal TSX/Jest/Dist execution */
const WORKER_SCRIPT = `
const { parentPort } = require("node:worker_threads");
const { xdr, scValToNative } = require("@stellar/stellar-sdk");

function serializeBigIntForClone(value) {
  if (typeof value === "bigint") {
    return { __isBigInt: true, value: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map(serializeBigIntForClone);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeBigIntForClone(v);
    }
    return out;
  }
  return value;
}

function decodeLedgerEntry(entry, nowLedger) {
  if (entry.liveUntil !== undefined && nowLedger !== undefined && entry.liveUntil < nowLedger) {
    throw new Error("ledger entry is archived and needs a restore");
  }
  const data = xdr.LedgerEntryData.fromXDR(entry.xdr, "base64");
  return scValToNative(data.contractData().val());
}

parentPort.on("message", (msg) => {
  const { id, type, payload, nowLedger } = msg;
  try {
    if (type === "LEDGER_ENTRIES") {
      const results = {};
      for (const item of payload) {
        const decoded = decodeLedgerEntry(item, nowLedger);
        results[item.name] = serializeBigIntForClone(decoded);
      }
      parentPort.postMessage({ id, success: true, result: results });
    } else if (type === "SCVALS") {
      const results = payload.map((base64) => {
        const parsed = xdr.ScVal.fromXDR(base64, "base64");
        return serializeBigIntForClone(scValToNative(parsed));
      });
      parentPort.postMessage({ id, success: true, result: results });
    } else {
      throw new Error("Unknown XDR decode task type: " + type);
    }
  } catch (err) {
    parentPort.postMessage({
      id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : "Error",
    });
  }
});
`;

export class XdrDecodePool {
  readonly threadCount: number;
  readonly maxQueueSize: number;
  readonly batchThreshold: number;

  private workers: WorkerHandle[] = [];
  private taskQueue: WorkerTask[] = [];
  private nextTaskId = 1;
  private isDraining = false;
  private roundRobinIndex = 0;

  constructor(options: XdrDecodePoolOptions = {}) {
    const defaultCores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    this.threadCount = Math.max(1, Math.min(8, options.threadCount ?? Math.max(1, defaultCores - 1)));
    this.maxQueueSize = options.maxQueueSize ?? 1000;
    this.batchThreshold = options.batchThreshold ?? 5;

    this.spawnWorkers();
  }

  private spawnWorkers(): void {
    for (let i = 0; i < this.threadCount; i++) {
      this.spawnWorker(i);
    }
  }

  private spawnWorker(index: number): void {
    const worker = new Worker(WORKER_SCRIPT, { eval: true });
    const handle: WorkerHandle = {
      worker,
      index,
      busy: false,
      currentTask: null,
    };

    worker.on("message", (response: { id: number; success: boolean; result?: unknown; error?: string; name?: string }) => {
      const task = handle.currentTask;
      handle.busy = false;
      handle.currentTask = null;

      if (task && task.id === response.id) {
        if (response.success) {
          xdrDecodePoolTasksTotal.inc({ outcome: "ok" });
          task.resolve(response.result);
        } else {
          xdrDecodePoolTasksTotal.inc({ outcome: "error" });
          task.reject(new XdrDecodeError(response.error ?? "Unknown decode error"));
        }
      }

      this.processQueue();
    });

    worker.on("error", (err) => {
      logger.error({ err, workerIndex: index }, "XDR decode worker error");
      if (handle.currentTask) {
        xdrDecodePoolTasksTotal.inc({ outcome: "error" });
        handle.currentTask.reject(new XdrDecodeError(`Worker crashed: ${err.message}`, err));
        handle.currentTask = null;
        handle.busy = false;
      }
    });

    worker.on("exit", (code) => {
      if (code !== 0 && !this.isDraining) {
        logger.warn({ code, workerIndex: index }, "XDR decode worker exited unexpectedly; restarting");
        if (handle.currentTask) {
          xdrDecodePoolTasksTotal.inc({ outcome: "error" });
          handle.currentTask.reject(new XdrDecodeError(`Worker exited with exit code ${code}`));
          handle.currentTask = null;
          handle.busy = false;
        }
        // Respawn replacement worker
        this.spawnWorker(index);
      }
    });

    this.workers[index] = handle;
  }

  /**
   * Synchronous inline decoder for small batches below `batchThreshold`.
   */
  decodeLedgerEntriesInline(entries: LedgerEntryItem[], nowLedger?: number): Record<string, unknown> {
    const timer = xdrDecodeDurationSeconds.startTimer({ mode: "inline" });
    try {
      const results: Record<string, unknown> = {};
      for (const item of entries) {
        if (item.liveUntil !== undefined && nowLedger !== undefined && item.liveUntil < nowLedger) {
          throw new Error("ledger entry is archived and needs a restore");
        }
        const data = xdr.LedgerEntryData.fromXDR(item.xdr, "base64");
        results[item.name] = scValToNative(data.contractData().val());
      }
      return results;
    } finally {
      timer();
    }
  }

  /**
   * Decodes a batch of `getLedgerEntries` XDR payloads.
   * If entries count < `batchThreshold`, runs synchronously inline;
   * otherwise, schedules work onto the worker_threads pool.
   */
  async decodeLedgerEntries(
    entries: LedgerEntryItem[],
    nowLedger?: number,
  ): Promise<Record<string, unknown>> {
    if (entries.length === 0) {
      return {};
    }

    if (entries.length < this.batchThreshold) {
      return this.decodeLedgerEntriesInline(entries, nowLedger);
    }

    if (this.isDraining) {
      throw new Error("XdrDecodePool is draining and refusing new tasks");
    }

    const timer = xdrDecodeDurationSeconds.startTimer({ mode: "worker" });
    try {
      const rawResult = (await this.enqueueTask("LEDGER_ENTRIES", entries, nowLedger)) as Record<string, unknown>;
      return deserializeBigIntFromClone(rawResult) as Record<string, unknown>;
    } finally {
      timer();
    }
  }

  /**
   * Decodes an array of base64-encoded ScVal XDR strings.
   */
  async decodeScVals(xdrList: string[]): Promise<unknown[]> {
    if (xdrList.length === 0) {
      return [];
    }

    if (xdrList.length < this.batchThreshold) {
      const timer = xdrDecodeDurationSeconds.startTimer({ mode: "inline" });
      try {
        return xdrList.map((str) => scValToNative(xdr.ScVal.fromXDR(str, "base64")));
      } finally {
        timer();
      }
    }

    if (this.isDraining) {
      throw new Error("XdrDecodePool is draining and refusing new tasks");
    }

    const timer = xdrDecodeDurationSeconds.startTimer({ mode: "worker" });
    try {
      const rawResult = (await this.enqueueTask("SCVALS", xdrList)) as unknown[];
      return deserializeBigIntFromClone(rawResult) as unknown[];
    } finally {
      timer();
    }
  }

  private enqueueTask(type: WorkerTask["type"], payload: unknown, nowLedger?: number): Promise<unknown> {
    if (this.taskQueue.length >= this.maxQueueSize) {
      xdrDecodePoolTasksTotal.inc({ outcome: "timeout" });
      throw new PoolSaturationError(
        `XdrDecodePool queue saturation limit (${this.maxQueueSize}) exceeded`,
      );
    }

    return new Promise((resolve, reject) => {
      const task: WorkerTask = {
        id: this.nextTaskId++,
        type,
        payload,
        nowLedger,
        resolve,
        reject,
      };

      this.taskQueue.push(task);
      xdrDecodePoolQueueDepth.set(this.taskQueue.length);
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.taskQueue.length === 0) {
      return;
    }

    // Find first idle worker
    const startIdx = this.roundRobinIndex;
    let chosenWorker: WorkerHandle | null = null;

    for (let i = 0; i < this.threadCount; i++) {
      const idx = (startIdx + i) % this.threadCount;
      const handle = this.workers[idx];
      if (handle && !handle.busy) {
        chosenWorker = handle;
        this.roundRobinIndex = (idx + 1) % this.threadCount;
        break;
      }
    }

    if (!chosenWorker) {
      return; // All workers currently busy
    }

    const task = this.taskQueue.shift()!;
    xdrDecodePoolQueueDepth.set(this.taskQueue.length);

    chosenWorker.busy = true;
    chosenWorker.currentTask = task;

    chosenWorker.worker.postMessage({
      id: task.id,
      type: task.type,
      payload: task.payload,
      nowLedger: task.nowLedger,
    });
  }

  /**
   * Graceful shutdown: drains all pending tasks and terminates worker threads.
   */
  async drain(timeoutMs = 5000): Promise<void> {
    this.isDraining = true;

    // Wait until queue is empty and active workers are idle
    const startTime = Date.now();
    while (
      (this.taskQueue.length > 0 || this.workers.some((w) => w?.busy)) &&
      Date.now() - startTime < timeoutMs
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Reject any remaining queued tasks
    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift()!;
      task.reject(new Error("XdrDecodePool shutting down"));
    }
    xdrDecodePoolQueueDepth.set(0);

    // Terminate all workers
    await Promise.all(this.workers.map((w) => w?.worker.terminate()));
    this.workers = [];
  }
}

// Singleton shared instance
let sharedPool: XdrDecodePool | null = null;

export function getSharedXdrDecodePool(options?: XdrDecodePoolOptions): XdrDecodePool {
  if (!sharedPool) {
    sharedPool = new XdrDecodePool(options);
  }
  return sharedPool;
}

export function setSharedXdrDecodePoolForTest(pool: XdrDecodePool | null): void {
  sharedPool = pool;
}

export async function closeSharedXdrDecodePool(): Promise<void> {
  if (sharedPool) {
    const pool = sharedPool;
    sharedPool = null;
    await pool.drain();
  }
}

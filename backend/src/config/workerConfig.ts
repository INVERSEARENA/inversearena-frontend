export const DEFAULT_TX_WORKER_CONCURRENCY = 1;

export interface TxWorkerConfig {
  concurrency: number;
  capacity: number;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function getTxWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): TxWorkerConfig {
  const value =
    env.TX_WORKER_CONCURRENCY ??
    env.TX_RECONCILER_CONCURRENCY ??
    env.TX_WORKER_CAPACITY ??
    String(DEFAULT_TX_WORKER_CONCURRENCY);
  const concurrency = positiveInteger(value, "TX_WORKER_CONCURRENCY");
  return { concurrency, capacity: concurrency };
}

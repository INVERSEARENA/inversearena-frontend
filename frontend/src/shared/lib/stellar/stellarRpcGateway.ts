import { Account, Horizon, rpc } from "@stellar/stellar-sdk";
import { ContractClientFactory } from "./contract-client-factory";
import { stellarConfig } from "@/shared/config/stellarConfig";
import { HorizonAccountFetchError, loadAccountFromHorizon } from "./horizon-account-loader";
import {
  ContractError,
  ContractErrorCode,
  SimulationFailedError,
  isArchivedStateError,
  parseContractError,
} from "./contract-error";
import { SorobanRpcPool } from "./sorobanRpcPool";

export type SorobanRpcTransaction = Parameters<rpc.Server["simulateTransaction"]>[0];
type SimulateTransactionResponse = Awaited<ReturnType<rpc.Server["simulateTransaction"]>>;
type SendTransactionResponse = Awaited<ReturnType<rpc.Server["sendTransaction"]>>;
type GetTransactionResponse = Awaited<ReturnType<rpc.Server["getTransaction"]>>;

export class StellarRpcGateway {
  private rpcServer: rpc.Server;
  private horizonServer: Horizon.Server;
  private pool: SorobanRpcPool;

  constructor(poolOrUrls?: SorobanRpcPool | string[] | string) {
    if (poolOrUrls instanceof SorobanRpcPool) {
      this.pool = poolOrUrls;
    } else if (Array.isArray(poolOrUrls) && poolOrUrls.length > 0) {
      this.pool = new SorobanRpcPool({ urls: poolOrUrls });
    } else if (typeof poolOrUrls === "string") {
      this.pool = new SorobanRpcPool({ urls: [poolOrUrls] });
    } else {
      const urls: string[] =
        (stellarConfig as unknown as { sorobanRpcUrls?: string[] }).sorobanRpcUrls ??
        [stellarConfig.sorobanRpcUrl];
      const maxLedgerLag =
        (stellarConfig as unknown as { sorobanMaxLedgerLag?: number }).sorobanMaxLedgerLag ?? 5;
      this.pool = new SorobanRpcPool({ urls, maxLedgerLag });
    }
    this.rpcServer = new ContractClientFactory(stellarConfig.sorobanRpcUrl).createRpcServer();
    this.horizonServer = new Horizon.Server(stellarConfig.horizonUrl);
  }

  getPool(): SorobanRpcPool {
    return this.pool;
  }

  async simulateTransaction(
    transaction: SorobanRpcTransaction,
  ): Promise<SimulateTransactionResponse> {
    return this.pool.simulateTransaction(transaction);
  }

  async sendTransaction(
    transaction: SorobanRpcTransaction,
  ): Promise<SendTransactionResponse> {
    return this.pool.sendTransaction(transaction);
  }

  async getTransaction(hash: string): Promise<GetTransactionResponse> {
    return this.pool.getTransaction(hash);
  }

  /**
   * Batched persistent/instance reads (#1768). Callers fall back to
   * simulateTransaction when an entry is missing or does not decode.
   */
  async getLedgerEntries(keys: Parameters<rpc.Server["getLedgerEntries"]>[0][]) {
    return this.pool.getLedgerEntries(...keys);
  }

  /**
   * Simulate and assemble, as `rpc.Server.prepareTransaction` does, but throw
   * a `SimulationFailedError` that keeps the diagnostic events, so a contract
   * error can be attributed to the contract that raised it (#1597).
   */
  async prepareTransaction(transaction: SorobanRpcTransaction) {
    const simulation = await this.simulateTransaction(transaction);
    if (rpc.Api.isSimulationRestore(simulation) || isArchivedStateError(simulation)) {
      throw new ContractError({
        code: ContractErrorCode.ARCHIVED_STATE,
        fn: "prepareTransaction",
        cause: simulation,
      });
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw new SimulationFailedError(simulation);
    }
    return rpc.assembleTransaction(transaction, simulation).build();
  }

  async getAccount(publicKey: string, fn: string): Promise<Account> {
    try {
      return await loadAccountFromHorizon(stellarConfig.horizonUrl, publicKey);
    } catch (error) {
      if (error instanceof HorizonAccountFetchError) {
        throw new ContractError({
          code: ContractErrorCode.ACCOUNT_NOT_FOUND,
          fn,
        });
      }
      throw parseContractError(error, fn);
    }
  }

  async checkTransactionOnHorizon(
    hash: string,
    horizonBaseUrl: string,
    fetchFn: typeof fetch = fetch,
  ): Promise<{
    hash: string;
    status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  }> {
    const base = horizonBaseUrl.replace(/\/+$/, "");
    const res = await fetchFn(`${base}/transactions/${hash}`);

    if (res.status === 404) {
      return { hash, status: "NOT_FOUND" };
    }
    if (!res.ok) {
      throw new ContractError({
        code: ContractErrorCode.UNKNOWN,
        message: `Horizon transaction lookup failed: ${res.status}`,
        fn: "checkTransactionOnHorizon",
        hash,
      });
    }

    const data = (await res.json()) as { successful?: boolean };
    return { hash, status: data.successful ? "SUCCESS" : "FAILED" };
  }

  async getLatestLedger(): Promise<number> {
    return this.pool.getLatestLedger();
  }

  /**
   * Latest ledger sequence together with its hash (`id`). The hash is the
   * stable identity continuity checks compare across reads: the same
   * sequence with a different hash means the ledger is no longer canonical
   * (#1490).
   */
  async getLatestLedgerIdentity(): Promise<{ sequence: number; id: string }> {
    return this.pool.getLatestLedgerIdentity();
  }

  /**
   * Raw Soroban `getEvents` passthrough (#1382 — the projection replay
   * engine's paginated event fetch). Kept as a thin passthrough of the
   * SDK's own request/response shapes, same as `simulateTransaction`/
   * `sendTransaction`/`getTransaction` above, rather than reshaping the
   * response here — callers own their own decoding (see
   * `onChainReader.toArenaProjectionEvent`).
   */
  async getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    return this.pool.getEvents(request);
  }
}

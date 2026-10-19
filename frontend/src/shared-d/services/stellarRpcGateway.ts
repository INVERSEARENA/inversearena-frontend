import { Account, Horizon, rpc } from "@stellar/stellar-sdk";
import { ContractClientFactory } from "../utils/contract-client-factory";
import { stellarConfig } from "@/lib/stellarConfig";
import { HorizonAccountFetchError, loadAccountFromHorizon } from "../utils/horizon-account-loader";
import { ContractError, ContractErrorCode, parseContractError } from "../utils/contract-error";

export type SorobanRpcTransaction = Parameters<rpc.Server["simulateTransaction"]>[0];
type SimulateTransactionResponse = Awaited<ReturnType<rpc.Server["simulateTransaction"]>>;
type SendTransactionResponse = Awaited<ReturnType<rpc.Server["sendTransaction"]>>;
type GetTransactionResponse = Awaited<ReturnType<rpc.Server["getTransaction"]>>;

export class StellarRpcGateway {
  private rpcServer: rpc.Server;
  private horizonServer: Horizon.Server;

  constructor() {
    this.rpcServer = new ContractClientFactory(stellarConfig.sorobanRpcUrl).createRpcServer();
    this.horizonServer = new Horizon.Server(stellarConfig.horizonUrl);
  }

  async simulateTransaction(
    transaction: SorobanRpcTransaction,
  ): Promise<SimulateTransactionResponse> {
    return this.rpcServer.simulateTransaction(transaction);
  }

  async sendTransaction(
    transaction: SorobanRpcTransaction,
  ): Promise<SendTransactionResponse> {
    return this.rpcServer.sendTransaction(transaction);
  }

  async getTransaction(hash: string): Promise<GetTransactionResponse> {
    return this.rpcServer.getTransaction(hash);
  }

  prepareTransaction(transaction: SorobanRpcTransaction) {
    return this.rpcServer.prepareTransaction(transaction);
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
    const response = await this.rpcServer.getHealth();
    return response.latestLedger;
  }

  /**
   * Latest ledger sequence together with its hash (`id`). The hash is the
   * stable identity continuity checks compare across reads: the same
   * sequence with a different hash means the ledger is no longer canonical
   * (#1490).
   */
  async getLatestLedgerIdentity(): Promise<{ sequence: number; id: string }> {
    const response = await this.rpcServer.getLatestLedger();
    return { sequence: response.sequence, id: response.id };
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
    return this.rpcServer.getEvents(request);
  }
}

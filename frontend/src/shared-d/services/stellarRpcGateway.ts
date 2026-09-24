import { Account, Horizon, rpc, xdr } from "@stellar/stellar-sdk";
import { ContractClientFactory } from "../utils/contract-client-factory";
import { stellarConfig } from "@/lib/stellarConfig";
import { HorizonAccountFetchError, loadAccountFromHorizon } from "../utils/horizon-account-loader";
import { ContractError, ContractErrorCode, parseContractError } from "../utils/contract-error";

export class StellarRpcGateway {
  private rpcServer: rpc.Server;
  private horizonServer: Horizon.Server;

  constructor() {
    this.rpcServer = new ContractClientFactory(stellarConfig.sorobanRpcUrl).createRpcServer();
    this.horizonServer = new Horizon.Server(stellarConfig.horizonUrl);
  }

  async simulateTransaction(transaction: xdr.Transaction): Promise<rpc.SimulateTransactionResponse> {
    return this.rpcServer.simulateTransaction(transaction);
  }

  async sendTransaction(transaction: xdr.Transaction): Promise<rpc.SendTransactionResponse> {
    return this.rpcServer.sendTransaction(transaction);
  }

  async getTransaction(hash: string): Promise<rpc.GetTransactionResponse> {
    return this.rpcServer.getTransaction(hash);
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

  async checkTransactionOnHorizon(hash: string, fetchFn: typeof fetch = fetch): Promise<{
    hash: string;
    status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  }> {
    const base = stellarConfig.horizonUrl.replace(/\/+$/, "");
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
}

import { Account } from "@stellar/stellar-sdk";
import { HorizonAccountResponseSchema } from "@/shared-d/utils/security-validation";

export type HorizonFetchFn = typeof fetch;

export class HorizonAccountFetchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HorizonAccountFetchError";
    this.status = status;
  }
}

/**
 * Loads an {@link Account} from Horizon for transaction building.
 * Caller must validate `publicKey` before invoking (e.g. StellarPublicKeySchema).
 */
export async function loadAccountFromHorizon(
  horizonBaseUrl: string,
  publicKey: string,
  fetchFn: HorizonFetchFn = fetch,
): Promise<Account> {
  const base = horizonBaseUrl.replace(/\/+$/, "");
  const res = await fetchFn(`${base}/accounts/${publicKey}`);
  if (!res.ok) {
    throw new HorizonAccountFetchError(
      `Horizon account fetch failed: ${res.status}`,
      res.status,
    );
  }
  const rawData: unknown = await res.json();
  const data = HorizonAccountResponseSchema.parse(rawData);
  return new Account(publicKey, data.sequence);
}

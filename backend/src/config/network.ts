import { getStellarConfig } from "./stellarConfig";

export function getConfiguredNetwork(): string {
  return process.env.STELLAR_NETWORK_PASSPHRASE?.trim() || getStellarConfig().networkPassphrase;
}

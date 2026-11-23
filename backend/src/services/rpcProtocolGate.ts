import { rpc } from "@stellar/stellar-sdk";
import { getStellarConfig } from "../config/stellarConfig";
import logger from "../utils/logger";

export type RpcProtocolStatus = {
  ok: boolean;
  networkPassphrase?: string;
  protocolVersion?: number;
  supportedMin: number;
  supportedMax: number;
  error?: string;
};

export async function checkRpcProtocolSupport(): Promise<RpcProtocolStatus> {
  const cfg = getStellarConfig();
  const supportedMin = cfg.supportedProtocolMin;
  const supportedMax = cfg.supportedProtocolMax;
  try {
    const server = new rpc.Server(cfg.sorobanRpcUrl);
    const network = await server.getNetwork();
    const versionInfo = await (server as any).getVersionInfo?.();
    const protocolVersion = Number(
      versionInfo?.protocolVersion ?? versionInfo?.protocol_version,
    );
    const passphrase = network?.passphrase;
    const protocolOk =
      Number.isFinite(protocolVersion) &&
      protocolVersion >= supportedMin &&
      protocolVersion <= supportedMax;
    const passphraseOk = !cfg.networkPassphrase || passphrase === cfg.networkPassphrase;
    const ok = protocolOk && passphraseOk;
    if (!ok) {
      logger.error(
        { protocolVersion, passphrase, supportedMin, supportedMax },
        "RPC protocol/network gate failed",
      );
    }
    return {
      ok,
      networkPassphrase: passphrase,
      protocolVersion: Number.isFinite(protocolVersion) ? protocolVersion : undefined,
      supportedMin,
      supportedMax,
      ...(ok ? {} : { error: "unsupported_rpc_protocol_or_network" }),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ err, supportedMin, supportedMax }, "RPC protocol probe failed");
    return { ok: false, supportedMin, supportedMax, error };
  }
}

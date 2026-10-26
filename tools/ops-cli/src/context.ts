/**
 * Global options -> a ready Ops instance: manifest, RPC server, signer.
 */
import { rpc } from "@stellar/stellar-sdk";
import { type ContractKind, contractIdFor, findDefaultManifest, loadManifest, ManifestError } from "./manifest.js";
import { Ops } from "./ops.js";
import { log } from "./output.js";
import { parseSigner } from "./signer.js";

export interface GlobalOptions {
  manifest?: string;
  rpcUrl?: string;
  wasmDir?: string;
  json?: boolean;
  signer?: string;
  submit?: boolean;
  confirmMainnet?: boolean;
  factory?: string;
  oracle?: string;
  vault?: string;
  staking?: string;
  payout?: string;
}

export interface Context {
  ops: Ops;
  json: boolean;
  /** Contract id for a kind, honouring --factory/--oracle/... overrides. */
  contract(kind: ContractKind): string;
}

export function createContext(options: GlobalOptions, env: NodeJS.ProcessEnv = process.env): Context {
  const manifestPath = options.manifest ?? env.INVERSE_OPS_MANIFEST ?? findDefaultManifest();
  if (!manifestPath) {
    throw new ManifestError("No deployment manifest found. Pass --manifest <path> or set INVERSE_OPS_MANIFEST.");
  }
  const deployment = loadManifest(manifestPath);
  const rpcUrl = options.rpcUrl ?? env.INVERSE_OPS_RPC_URL ?? deployment.rpcUrl;
  const server = new rpc.Server(rpcUrl, { allowHttp: /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(rpcUrl) });

  const ops = new Ops({
    deployment: { ...deployment, rpcUrl },
    server,
    wasmDir: options.wasmDir,
    signer: options.signer ? parseSigner(options.signer, env) : undefined,
    submit: options.submit ?? false,
    confirmMainnet: options.confirmMainnet ?? false,
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    log,
  });

  return {
    ops,
    json: options.json ?? false,
    contract: (kind) => contractIdFor(deployment, kind, options[kind]),
  };
}

/**
 * Transaction simulation diagnostics (#1400). Re-simulates a stored
 * transaction's unsignedXdr against the current ledger state and reports
 * whether it would still succeed, without ever submitting or mutating the
 * transaction. See docs/design/transaction-diagnostics.md.
 *
 * Uses @stellar/stellar-sdk's rpc.Server directly rather than
 * frontend/src/shared-d/services/stellarRpcGateway: that class (and its
 * own dependency chain) lives outside backend/src, which this package's
 * tsconfig rootDir:"src" rejects for any import, confirmed by the
 * pre-existing, currently-broken cross-boundary import in
 * backend/src/services/onChainReader.ts (fails both `tsc --noEmit` and
 * ts-jest module loading).
 */

import { TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { getStellarConfig } from "../config/stellarConfig";
import { logger } from "../utils/logger";
import { diagnosticsRunsTotal, diagnosticsRunDuration } from "../utils/metrics";
import { CONTRACT_PANIC_USER_MESSAGES, formatContractPanicMessage } from "../utils/contractPanicCodes";

export type DiagnosticsOutcome = "would_succeed" | "would_fail" | "restore_required";

export interface TransactionDiagnostics {
  outcome: DiagnosticsOutcome;
  /** Numeric Soroban contract panic code, when the failure was a contract error. */
  contractCode: number | null;
  /** User-facing remediation text; never the raw RPC error string. */
  remediation: string | null;
  /** Coarse, non-sensitive summary of the simulated resource footprint. */
  footprint: {
    minResourceFeeStroops: string | null;
    readEntries: number | null;
    writeEntries: number | null;
  };
  latestLedger: number;
}

const GENERIC_REMEDIATION =
  "This transaction could not be simulated successfully. It may be stale or reference state that has since changed; try refreshing and creating a new one.";
const RESTORE_REMEDIATION =
  "Some on-chain state this transaction depends on has expired and must be restored before this can succeed. Try again — a restore is applied automatically on next submission.";

/**
 * Extracts a Soroban contract panic code from a raw RPC error string, e.g.
 * "HostError: Error(Contract, #4)". Mirrors the pattern in
 * frontend/src/shared-d/utils/contract-error.ts's parseHostError, kept as
 * a small local copy for the same rootDir reason documented above.
 */
function extractContractPanicCode(rawError: string): number | null {
  const match = rawError.match(/Error\(Contract,\s*#(\d+)\)/);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

function sanitizeRemediation(rawError: string): { contractCode: number | null; remediation: string } {
  const contractCode = extractContractPanicCode(rawError);
  if (contractCode !== null) {
    const knownMessage = CONTRACT_PANIC_USER_MESSAGES[contractCode];
    return { contractCode, remediation: formatContractPanicMessage(contractCode, knownMessage) };
  }
  return { contractCode: null, remediation: GENERIC_REMEDIATION };
}

export async function diagnoseTransaction(unsignedXdr: string): Promise<TransactionDiagnostics> {
  const startedAt = Date.now();

  let simulation: Awaited<ReturnType<rpc.Server["simulateTransaction"]>>;
  try {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, getStellarConfig().networkPassphrase);
    const server = new rpc.Server(getStellarConfig().sorobanRpcUrl);
    simulation = await server.simulateTransaction(tx);
  } catch (error) {
    diagnosticsRunsTotal.inc({ outcome: "malformed" });
    diagnosticsRunDuration.observe((Date.now() - startedAt) / 1000);
    logger.warn({ err: error }, "transaction diagnostics: could not parse or simulate xdr");
    return {
      outcome: "would_fail",
      contractCode: null,
      remediation: GENERIC_REMEDIATION,
      footprint: { minResourceFeeStroops: null, readEntries: null, writeEntries: null },
      latestLedger: 0,
    };
  }

  const durationSeconds = (Date.now() - startedAt) / 1000;
  diagnosticsRunDuration.observe(durationSeconds);

  if (rpc.Api.isSimulationError(simulation)) {
    const { contractCode, remediation } = sanitizeRemediation(simulation.error);
    diagnosticsRunsTotal.inc({ outcome: "would_fail" });
    logger.info(
      { event: "transaction_diagnostics", outcome: "would_fail", contractCode, latencyMs: durationSeconds * 1000 },
      "transaction diagnostics completed",
    );
    return {
      outcome: "would_fail",
      contractCode,
      remediation,
      footprint: { minResourceFeeStroops: null, readEntries: null, writeEntries: null },
      latestLedger: simulation.latestLedger,
    };
  }

  const isRestore = "restorePreamble" in simulation;
  const outcome: DiagnosticsOutcome = isRestore ? "restore_required" : "would_succeed";
  const sorobanData = simulation.transactionData.build();
  const resources = sorobanData.resources();
  const footprint = resources.footprint();

  diagnosticsRunsTotal.inc({ outcome });
  logger.info(
    { event: "transaction_diagnostics", outcome, latencyMs: durationSeconds * 1000 },
    "transaction diagnostics completed",
  );

  return {
    outcome,
    contractCode: null,
    remediation: isRestore ? RESTORE_REMEDIATION : null,
    footprint: {
      minResourceFeeStroops: simulation.minResourceFee,
      readEntries: footprint.readOnly().length,
      writeEntries: footprint.readWrite().length,
    },
    latestLedger: simulation.latestLedger,
  };
}

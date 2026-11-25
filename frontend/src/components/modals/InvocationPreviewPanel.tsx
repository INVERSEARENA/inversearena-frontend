"use client";

import { useState } from "react";
import type {
  DecodedInvocationSummary,
  DecodedAuthorizedInvocation,
} from "@/shared/lib/stellar/decodeInvocation";

interface InvocationPreviewPanelProps {
  preview: DecodedInvocationSummary;
}

function truncateMiddle(value: string, head = 6, tail = 6): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function AuthInvocationTree({
  invocation,
  depth = 0,
}: {
  invocation: DecodedAuthorizedInvocation;
  depth?: number;
}) {
  return (
    <div
      className={depth > 0 ? "ml-3 pl-3 border-l border-white/15 mt-2" : "mt-1"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-mono text-white break-all">
          <span className="text-primary font-bold">{invocation.functionName}</span>
          {" on "}
          <span title={invocation.contractId}>
            {invocation.contractName} ({truncateMiddle(invocation.contractId)})
          </span>
        </span>
        {!invocation.isKnownContract && (
          <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 border border-red-500/40 text-[10px] font-bold uppercase">
            Unverified
          </span>
        )}
      </div>
      {invocation.subInvocations.map((sub, idx) => (
        <AuthInvocationTree key={idx} invocation={sub} depth={depth + 1} />
      ))}
    </div>
  );
}

export function InvocationPreviewPanel({ preview }: InvocationPreviewPanelProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <section
      role="region"
      aria-label="Decoded transaction invocation preview"
      className="mb-6 border-2 border-white/15 bg-slate-900/70 p-4 text-left"
    >
      {/* Blocking Warning Banner for Unknown / Tampered Contracts */}
      {preview.isBlocked && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 p-3 bg-red-950/80 border-2 border-red-500 text-red-200"
        >
          <div className="flex items-center gap-2 font-black uppercase text-xs tracking-widest text-red-400 mb-1">
            <span className="material-symbols-outlined text-base" aria-hidden="true">
              gpp_bad
            </span>
            Signing Blocked — Unverified Contract
          </div>
          <ul className="list-disc list-inside text-xs space-y-1">
            {preview.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Target Contract & Function */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-white/10">
        <div>
          <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Target Contract
          </span>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="font-black text-sm text-white">
              {preview.contractName}
            </span>
            {preview.isKnownContract ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-500/20 border border-green-500/40 text-green-400 text-[10px] font-bold uppercase"
                aria-label="Contract verified against deployment manifest"
              >
                Verified
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-red-500/20 border border-red-500/40 text-red-400 text-[10px] font-bold uppercase"
                aria-label="Unknown contract not in deployment manifest"
              >
                Unknown
              </span>
            )}
          </div>
          {preview.contractId && (
            <span
              className="block font-mono text-[11px] text-slate-400 break-all mt-0.5"
              title={preview.contractId}
            >
              {truncateMiddle(preview.contractId, 10, 10)}
            </span>
          )}
        </div>

        <div className="sm:text-right">
          <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Function
          </span>
          <span className="inline-block mt-0.5 font-mono font-bold text-sm text-primary">
            {preview.functionName}()
          </span>
        </div>
      </div>

      {/* Expected Token Transfers */}
      {preview.tokenTransfers.length > 0 && (
        <div className="py-3 border-b border-white/10">
          <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">
            Expected Token Transfers
          </span>
          <ul className="space-y-2" aria-label="Token transfers">
            {preview.tokenTransfers.map((transfer, idx) => (
              <li
                key={idx}
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 bg-black/30 p-2 border border-white/10"
              >
                <span className="font-black text-sm text-primary">
                  {transfer.formattedAmount} {transfer.symbol}
                </span>
                <span className="font-mono text-[11px] text-slate-300 break-all">
                  {truncateMiddle(transfer.from, 5, 5)} → {truncateMiddle(transfer.to, 5, 5)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Decoded Arguments */}
      {preview.args.length > 0 && (
        <div className="py-3 border-b border-white/10">
          <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">
            Arguments
          </span>
          <dl className="space-y-1.5 text-xs">
            {preview.args.map((arg) => (
              <div
                key={arg.index}
                className="flex flex-col sm:flex-row sm:justify-between gap-1"
              >
                <dt className="font-mono text-slate-400">{arg.label}</dt>
                <dd className="font-mono text-white break-all sm:text-right">
                  {arg.displayValue.length > 48
                    ? truncateMiddle(arg.displayValue, 14, 10)
                    : arg.displayValue}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* Fee & Resource Limits */}
      <div className="pt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <span className="text-slate-400 font-bold uppercase tracking-wider mr-2">
            Max Fee:
          </span>
          <span className="font-mono text-white font-bold">
            {preview.feeXlm} XLM
          </span>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          aria-controls="invocation-advanced-details"
          className="text-xs font-bold uppercase tracking-wider text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary px-1"
        >
          {showAdvanced ? "Hide Auth & Limits" : "Show Auth & Limits"}
        </button>
      </div>

      {showAdvanced && (
        <div
          id="invocation-advanced-details"
          className="mt-3 pt-3 border-t border-white/10 space-y-3 text-xs"
        >
          {/* Resource Limits */}
          {(preview.resourceLimits.instructions !== undefined ||
            preview.resourceLimits.readBytes !== undefined ||
            preview.resourceLimits.writeBytes !== undefined) && (
            <div>
              <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">
                Resource Limits
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px] text-slate-300">
                {preview.resourceLimits.instructions !== undefined && (
                  <div className="bg-black/30 p-1.5 border border-white/10">
                    CPU: {preview.resourceLimits.instructions.toLocaleString()}
                  </div>
                )}
                {preview.resourceLimits.readBytes !== undefined && (
                  <div className="bg-black/30 p-1.5 border border-white/10">
                    Read: {preview.resourceLimits.readBytes.toLocaleString()} B
                  </div>
                )}
                {preview.resourceLimits.writeBytes !== undefined && (
                  <div className="bg-black/30 p-1.5 border border-white/10">
                    Write: {preview.resourceLimits.writeBytes.toLocaleString()} B
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Auth Entries */}
          <div>
            <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">
              Authorization Entries ({preview.authEntries.length})
            </span>
            {preview.authEntries.length === 0 ? (
              <span className="text-slate-400 italic">None</span>
            ) : (
              <div className="space-y-2">
                {preview.authEntries.map((entry, idx) => (
                  <div
                    key={idx}
                    className="bg-black/30 p-2 border border-white/10"
                  >
                    <div className="text-[11px] text-slate-400 font-mono break-all">
                      Signer: {entry.signerAddress ? truncateMiddle(entry.signerAddress, 8, 8) : "Invoking Account"}
                    </div>
                    {entry.rootInvocation && (
                      <AuthInvocationTree invocation={entry.rootInvocation} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

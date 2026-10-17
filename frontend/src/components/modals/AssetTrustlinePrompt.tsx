"use client";

/**
 * Guided `changeTrust` prompt (#1487).
 *
 * A `changeTrust` is the one transaction in this app that a user can walk
 * away from with a *worse* account: signing it consumes a signature, raises
 * the account's minimum balance, and can hand an issuer standing to revoke or
 * claw back. So the states that are not "ready" are stated explicitly, the
 * issuer is shown by name, and the limit being signed is quoted before the
 * wallet prompt appears.
 *
 * One component serves join, stake and claim: the copy differs, the sequence
 * does not.
 *
 * @module
 */

import React from 'react';
import { Modal } from '../ui/Modal';
import { maskAccountId, type TrustlineRemediation } from '@/shared-d/utils/asset-readiness';
import { stroopsToAmount } from '@/shared-d/utils/stellar-asset-reader';

export interface AssetTrustlinePromptProps {
  isOpen: boolean;
  onClose: () => void;
  /** Non-null only when there is a `changeTrust` the user can actually sign. */
  remediation: TrustlineRemediation | null;
  /** Safe to render: `describeAssetReadiness` never contains a full account id. */
  message: string;
  phase: 'remediation_offered' | 'remediating' | 'blocked';
  /** Runs build → firewall → sign → submit → re-read. */
  onConfirm: () => Promise<void>;
  onRetry?: () => void;
  /** What the user is trying to do, e.g. "join arena #12". */
  actionLabel: string;
}

export const AssetTrustlinePrompt: React.FC<AssetTrustlinePromptProps> = ({
  isOpen,
  onClose,
  remediation,
  message,
  phase,
  onConfirm,
  onRetry,
  actionLabel,
}) => {
  const busy = phase === 'remediating';

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <div className="bg-white border-4 border-black text-black">
        <div className="border-b-4 border-black px-6 md:px-8 py-6">
          <h1 className="text-2xl md:text-3xl font-black italic text-left tracking-tight">
            TRUSTLINE REQUIRED
          </h1>
        </div>

        <div className="px-6 md:px-8 py-6 space-y-4">
          <p className="text-sm text-left text-gray-700">
            To {actionLabel} you need a {remediation?.asset.code ?? 'asset'} trustline.
          </p>

          {/* The exact transaction, before the wallet prompt. A user who signs
              a `changeTrust` deserves to see its limit and issuer first. */}
          {remediation && (
            <dl className="border-2 border-black text-left text-sm">
              <Row label="Asset" value={remediation.asset.code} />
              <Row
                label="Issuer"
                value={remediation.issuerHomeDomain
                  ? `${remediation.issuerHomeDomain} (${maskAccountId(remediation.issuer)})`
                  : maskAccountId(remediation.issuer)}
              />
              <Row label="Limit" value={`${remediation.limit} ${remediation.asset.code}`} emphasis />
              {remediation.exact ? null : (
                <Row
                  label="Note"
                  value="This limit is larger than strictly required for this transaction."
                />
              )}
              {remediation.reserveImpactStroops > 0n && (
                <Row
                  label="Reserve impact"
                  value={`+${stroopsToAmount(remediation.reserveImpactStroops)} XLM minimum balance`}
                />
              )}
              {remediation.requiresIssuerAuthorization && (
                <p className="border-t-2 border-black bg-yellow-100 px-4 py-3 text-left text-xs">
                  This issuer requires authorization. Adding the trustline is necessary but not
                  sufficient — the issuer must also authorize it before you can receive {remediation.asset.code}.
                </p>
              )}
              {remediation.issuerCanRevoke && (
                <p className="px-4 py-2 text-left text-xs text-gray-700">
                  The issuer can revoke this trustline, and any balance it holds, at its discretion.
                </p>
              )}
              {remediation.issuerClawbackEnabled && (
                <p className="px-4 py-2 text-left text-xs text-gray-700">
                  This issuer has clawback enabled and can remove balances from this trustline.
                </p>
              )}
            </dl>
          )}

          <p className="text-sm text-left text-gray-700">{message}</p>

          <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="border-2 border-black px-4 py-2 text-sm font-bold disabled:opacity-50"
            >
              Cancel
            </button>
            {phase === 'blocked' && onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="border-2 border-black bg-black px-4 py-2 text-sm font-bold text-white"
              >
                Check again
              </button>
            ) : null}
            {remediation && (
              <button
                type="button"
                onClick={() => void onConfirm()}
                disabled={busy}
                className="border-2 border-black bg-black px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                {busy ? 'Submitting…' : `Add ${remediation.asset.code} trustline`}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
};

const Row: React.FC<{ label: string; value: string; emphasis?: boolean }> = ({
  label,
  value,
  emphasis,
}) => (
  <div className="flex items-start justify-between gap-4 border-b border-black/20 px-4 py-2 last:border-b-0">
    <dt className="font-bold uppercase tracking-widest text-gray-600">{label}</dt>
    <dd className={`text-right ${emphasis ? 'font-black' : ''}`}>{value}</dd>
  </div>
);

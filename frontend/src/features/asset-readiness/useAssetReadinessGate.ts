"use client";

/**
 * Asset-readiness gate for wallet actions (#1487).
 *
 * Join, stake and claim all need the same thing before they can build their
 * business transaction: an answer to "can this account actually receive the
 * asset?", plus, when the answer is no, a `changeTrust` the user can sign
 * without losing their place. This hook owns that sequence so the three call
 * sites differ only in which asset they ask about and what to do afterwards.
 *
 * ## Why a hook and not a component
 *
 * The gate has to *gate* — the caller needs a boolean to disable a button
 * before the flow is even open. A modal component cannot do that, and
 * duplicating the preflight in three places is how the three drift.
 *
 * ## The sequence
 *
 *   check → (blocked? offer remediation) → sign → submit → **re-read** → ready
 *
 * The re-read after submission is the whole point. Optimistically flipping to
 * `ready` on submit would re-enable the business transaction while the account
 * still has no trustline, and the user would watch a second transaction fail.
 * `state` only becomes `ready` once a fresh account read says so.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeAssetReadiness,
  hasTrustlineRemediation,
  isRetryableReadiness,
  preflightAssetReadiness,
  type AssetReadiness,
  type TrustlineRemediation,
} from "@/shared-d/utils/asset-readiness";
import type { AssetDescriptor } from "@/shared-d/utils/stellar-asset-reader";
import { stroopsToAmount } from "@/shared-d/utils/stellar-asset-reader";
import { resolveStakeAsset } from "@/shared-d/utils/stake-asset";
import {
  evaluateSigningRequest,
  SigningPolicyError,
} from "@/shared-d/security/policy";
import { buildChangeTrustTransaction, submitSignedTransaction } from "@/shared-d/utils/stellar-transactions";
import { useWallet } from "@/features/wallet/useWallet";
import { recordAssetReadinessOutcome } from "@/shared-d/telemetry/asset-readiness";

/** Where the gate is in its own sequence. */
export type AssetGatePhase =
  /** No check has run yet. Callers should treat this as "not known". */
  | "idle"
  /** A check is in flight. */
  | "checking"
  /** The account is ready; the business transaction may proceed. */
  | "ready"
  /** A trustline is missing or too small; a remediation is offered. */
  | "remediation_offered"
  /** The remediation is being built, signed and submitted. */
  | "remediating"
  /** Blocked with nothing the user can sign (fund, wait, or ask the issuer). */
  | "blocked";

export interface AssetGateState {
  phase: AssetGatePhase;
  /** `null` until the first check completes. */
  readiness: AssetReadiness | null;
  /** The `changeTrust` the user can act on; non-null iff remediable. */
  remediation: TrustlineRemediation | null;
  /** Safe to render: never contains a full wallet address. */
  message: string;
  /** True only when the business transaction may be built. */
  canProceed: boolean;
  /** True when re-running the check is the right thing to offer. */
  canRetry: boolean;
}

export interface AssetGate extends AssetGateState {
  /** Run the preflight now. Cheap and safe to call on every open. */
  check: () => Promise<void>;
  /** Build, inspect, sign and submit the `changeTrust`, then re-read. */
  remediate: () => Promise<void>;
}

export interface UseAssetReadinessGateOptions {
  /**
   * Domain asset code from the arena/pool record (`"XLM" | "USDC" | ...`).
   * A code with no configured issuer yields a blocking state rather than a
   * guess — see `resolveStakeAsset`.
   */
  assetCode: string | undefined;
  /**
   * Amount the action needs to receive, in stroops. `0n` asks only whether
   * the account can hold the asset at all.
   */
  amountStroops: bigint;
  /** Where this gate sits, for telemetry. A closed label set. */
  entryPoint: "join" | "stake" | "claim";
  /** Skip the network entirely; for tests and storybook. */
  enabled?: boolean;
  /** Injected issuer map; defaults to live config. */
  issuers?: Readonly<Record<string, string>>;
}

const IDLE: AssetGateState = {
  phase: "idle",
  readiness: null,
  remediation: null,
  message: "Checking your account…",
  canProceed: false,
  canRetry: false,
};

/**
 * Gate a wallet action on asset readiness.
 *
 * @param options.issuerOverrides not used; issuer source is `options.issuers`
 *   or live config. Kept explicit so tests never touch the throwing
 *   `stellarConfig` proxy.
 */
export function useAssetReadinessGate({
  assetCode,
  amountStroops,
  entryPoint,
  enabled = true,
  issuers,
}: UseAssetReadinessGateOptions): AssetGate {
  const { publicKey, address, isConnected, signTransaction, network } = useWallet();
  // `address` is a documented alias of `publicKey` on the wallet context.
  // Accepting either keeps the gate working against both names rather than
  // reporting "not connected" for an account that is plainly connected.
  const account: string | null = publicKey ?? address;
  const [state, setState] = useState<AssetGateState>(IDLE);
  const mounted = useRef(true);
  // Guards against a slow preflight resolving after the user has moved on, and
  // against a second check racing the first.
  const run = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback(
    (readiness: AssetReadiness) => {
      if (!mounted.current) return;

      const remediable = hasTrustlineRemediation(readiness);
      recordAssetReadinessOutcome({
        entryPoint,
        state: readiness.state,
        assetCode: readiness.assetCode,
        // Masked, never the full account id: this reaches analytics.
        account: account,
        canProceed: readiness.canProceed,
        reserveApproximate: readiness.snapshot?.baseReserveApproximate ?? null,
        network: network ?? null,
      });

      setState({
        phase: readiness.canProceed
          ? "ready"
          : remediable
            ? "remediation_offered"
            : "blocked",
        readiness,
        remediation: remediable ? readiness.remediation : null,
        message: describeAssetReadiness(readiness),
        canProceed: readiness.canProceed,
        canRetry: isRetryableReadiness(readiness),
      });
    },
    [entryPoint, account, network],
  );

  const check = useCallback(async () => {
    if (!enabled) return;
    const runId = ++run.current;

    setState((prev) => ({ ...prev, phase: "checking", message: "Checking your account…" }));

    // A wallet that changed under us invalidates the previous answer.
    if (!isConnected || !account || !assetCode) {
      if (mounted.current) {
        setState({
          ...IDLE,
          phase: "blocked",
          message: "Connect the wallet you want to use before checking assets.",
          canRetry: false,
        });
      }
      return;
    }

    const resolution = resolveStakeAsset(assetCode, issuers);

    if (resolution.kind === "unconfigured") {
      // Never guess an issuer: a wrong one produces a trustline to an asset
      // the user does not hold, and costs them a signature to find out.
      if (mounted.current) {
        setState({
          phase: "blocked",
          readiness: null,
          remediation: null,
          message: `No issuer is configured for ${resolution.code}, so this action cannot be checked safely. Set ${resolution.envVar} and reload.`,
          canProceed: false,
          canRetry: false,
        });
      }
      return;
    }

    // Native XLM has no trustline, so there is nothing to read: the classifier
    // would return an unconditional `ready` regardless of the account, and a
    // network round-trip to learn that would leave the button the gate guards
    // disabled for the duration — on a slow or failing Horizon, forever. The
    // fee and reserve question for native is the wallet balance's job, not this
    // hook's.
    if (resolution.asset.kind === "native") {
      const readiness: AssetReadiness = {
        state: "native",
        asset: resolution.asset,
        assetCode: "XLM",
        balanceStroops: 0n,
        canProceed: true,
        remediation: null,
        snapshot: null,
      };
      if (runId === run.current) apply(readiness);
      return;
    }

    const readiness = await preflightAssetReadiness({
      asset: resolution.asset as AssetDescriptor,
      amountStroops,
    }, {
      publicKey: account,
    });

    if (runId === run.current) apply(readiness);
  }, [enabled, isConnected, account, assetCode, amountStroops, issuers, apply]);

  const remediate = useCallback(async () => {
    const remediation = state.remediation;
    const owner = account;
    if (!remediation || !owner) return;

    const runId = ++run.current;
    setState((prev) => ({
      ...prev,
      phase: "remediating",
      message: "Submitting your trustline…",
    }));

    try {
      const tx = await buildChangeTrustTransaction(
        owner,
        { code: remediation.asset.code, issuer: remediation.issuer },
        remediation.limit,
      );

      // The same firewall every other sign request passes. A `changeTrust` is
      // only admissible as the sole operation of the envelope.
      evaluateSigningRequest(tx.toXDR(), "TRUSTLINE");

      const signed = await signTransaction(tx.toXDR());
      await submitSignedTransaction(signed);
    } catch (error) {
      if (!mounted.current) return;
      const message =
        error instanceof SigningPolicyError
          ? error.message
          : error instanceof Error
            ? error.message
            : "The trustline could not be submitted.";
      setState((prev) => ({ ...prev, phase: "remediation_offered", message }));
      return;
    }

    // Re-read rather than assume. Only a fresh account read can say the
    // trustline exists, and `state` must not report `ready` before then.
    if (!mounted.current || runId !== run.current) return;
    const resolution = resolveStakeAsset(remediation.asset.code, issuers);
    if (resolution.kind !== "resolved") return;
    const readiness = await preflightAssetReadiness(
      { asset: resolution.asset, amountStroops },
      { publicKey: owner },
    );
    if (runId === run.current) apply(readiness);
  }, [state.remediation, account, signTransaction, amountStroops, issuers, apply]);

  useEffect(() => {
    if (enabled) void check();
    // Re-checking on wallet/network change is the point: the previous answer
    // was about a different account or a different chain.
  }, [enabled, check, account, network]);

  return { ...state, check, remediate };
}

/** Display helper: stroops of XLM as a short decimal string. */
export function formatStroops(stroops: bigint): string {
  return stroopsToAmount(stroops);
}

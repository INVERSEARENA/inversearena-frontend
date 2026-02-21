"use client";

import React, { useState, useEffect } from "react";
import { TrendingUp, CheckSquare, Zap, Info, Loader2, TerminalSquare, ShieldCheck } from "lucide-react";
import { useWallet } from "@/shared-d/hooks/useWallet";
import {
  buildStakeProtocolTransaction,
  submitSignedTransaction,
} from "@/shared-d/utils/stellar-transactions";

type TransactionState = "idle" | "signing" | "submitting" | "success" | "error";

type StakeModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  apy?: number;
  connectionLabel?: string;
};

export default function StakeModal({
  isOpen,
  onClose,
  onSuccess,
  apy = 12.5,
  connectionLabel = "SOROBAN_MAINNET_NODE_04",
}: StakeModalProps) {
  const { address, isConnected, connect, signTransaction, balance, isLoadingBalance } =
    useWallet();

  const [amount, setAmount] = useState<string>("5000.00");
  const [txState, setTxState] = useState<TransactionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const isProcessing = txState === "signing" || txState === "submitting";
  const displayBalance = balance.xlm;
  const numAmount = parseFloat(amount) || 0;
  const isValidAmount = numAmount > 0 && numAmount <= displayBalance;
  const isButtonDisabled =
    isProcessing ||
    txState === "success" ||
    (isConnected && !isValidAmount);

  useEffect(() => {
    if (!isOpen) {
      setTxState("idle");
      setErrorMessage("");
    }
  }, [isOpen]);

  const handleInitiateStake = async () => {
    if (!isConnected) {
      await connect();
      return;
    }

    if (!address) {
      setErrorMessage("Wallet address not available");
      setTxState("error");
      return;
    }

    if (isNaN(numAmount) || numAmount <= 0) {
      setErrorMessage("Please enter a valid amount");
      setTxState("error");
      return;
    }
    if (numAmount > displayBalance) {
      setErrorMessage("Insufficient balance");
      setTxState("error");
      return;
    }

    try {
      setTxState("signing");
      const tx = await buildStakeProtocolTransaction(address, numAmount);
      const signedXdr = await signTransaction(tx.toXDR());

      setTxState("submitting");
      await submitSignedTransaction(signedXdr);

      setTxState("success");
      setTimeout(() => {
        onSuccess?.();
        onClose();
      }, 1500);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transaction failed. Please try again.";
      setErrorMessage(message);
      setTxState("error");
    }
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/[^0-9.]/g, "");
    setAmount(value);
    if (txState === "error") {
      setTxState("idle");
      setErrorMessage("");
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={!isProcessing ? onClose : undefined}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-sm border border-zinc-700 bg-white shadow-2xl shadow-lime-500/10">
        {/* Header */}
        <div className="relative border-b border-zinc-800 bg-black px-6 py-5">
          <div className="flex items-start justify-between">
            <h2 className="font-mono text-2xl font-bold italic tracking-wide text-lime-400 md:text-3xl">
              PROTOCOL AUTHENTICATION
            </h2>
            <TerminalSquare className="h-6 w-6 text-zinc-400" />
          </div>
          <p className="mt-2 font-mono text-xs uppercase tracking-wider text-zinc-400">
            STAKE XLM TO ACTIVATE HOST PRIVILEGES. STAKED FUNDS GENERATE
            CONTINUOUS RWA YIELD.
          </p>
        </div>

        {/* Body */}
        <div className="space-y-5 p-6">
          {/* Amount Input */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="font-mono text-sm font-medium uppercase tracking-wider text-zinc-800">
                XLM AMOUNT
              </label>
              <span className="border border-zinc-800 bg-lime-400 px-2.5 py-1 font-mono text-xs font-bold text-black">
                {isLoadingBalance ? (
                  "LOADING..."
                ) : (
                  <>BALANCE: {displayBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })}</>
                )}
              </span>
            </div>
            <div className="flex items-center rounded-sm border-2 border-zinc-300 bg-white px-4 py-3 transition-colors focus-within:border-zinc-400">
              <input
                type="text"
                value={amount}
                onChange={handleAmountChange}
                disabled={isProcessing || !isConnected}
                className="min-w-0 flex-1 bg-transparent font-mono text-3xl font-bold text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50 md:text-4xl"
                placeholder="0.00"
              />
              <span className="ml-4 shrink-0 font-mono text-lg font-bold text-zinc-800">XLM</span>
            </div>
          </div>

          {/* Status Cards */}
          <div className="grid grid-cols-2 gap-3">
            {/* APY Card */}
            <div className="rounded-sm border-2 border-lime-400 bg-black p-4">
              <div className="mb-2 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-lime-400" />
                <span className="font-mono text-xs font-medium uppercase tracking-wider text-zinc-400">
                  STAKING REWARD
                </span>
              </div>
              <p className="font-mono text-xl font-bold text-lime-400 md:text-2xl">
                {apy}% APY
              </p>
            </div>

            {/* Privilege Card */}
            <div className="border-2 border-zinc-800 bg-white p-4">
              <div className="mb-3 flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-zinc-800" />
                <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-800">
                  PRIVILEGE STATUS
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 border border-zinc-800 bg-lime-400" />
                <span className="font-mono text-xs font-bold uppercase tracking-wider text-lime-500">
                  ARENA CREATION ENABLED
                </span>
              </div>
            </div>
          </div>

          {/* System Notice */}
          <div className="flex gap-3 rounded-sm border-l-4 border-lime-400 bg-lime-200/50 p-4">
            <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-lime-600" />
            <p className="font-mono text-xs uppercase leading-relaxed tracking-wide text-zinc-800">
              SYSTEM NOTICE: STAKING IS SUBJECT TO A 48-HOUR COOL-DOWN PERIOD FOR
              UNSTAKING. YIELD IS DISTRIBUTED IN REAL-TIME TO YOUR CONNECTED STELLAR
              WALLET.
            </p>
          </div>

          {/* Success Message */}
          {txState === "success" && (
            <div className="rounded-sm border border-lime-400 bg-lime-400/20 p-4 text-center">
              <p className="font-mono text-sm font-bold uppercase text-lime-400">
                ✓ STAKE SUCCESSFUL
              </p>
            </div>
          )}

          {/* Error Message */}
          {txState === "error" && errorMessage && (
            <div className="rounded-sm border border-red-500 bg-red-500/20 p-4 text-center">
              <p className="font-mono text-sm font-bold uppercase text-red-400">
                {errorMessage}
              </p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="space-y-3">
            <button
              onClick={handleInitiateStake}
              disabled={isButtonDisabled}
              className="flex w-full items-center justify-center gap-2 border-2 border-zinc-800 bg-lime-400 py-4 font-mono text-base font-bold uppercase tracking-wider text-black transition-all hover:bg-lime-300 hover:shadow-lg hover:shadow-lime-400/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!isConnected && (
                <>
                  <Zap className="h-5 w-5" />
                  CONNECT WALLET
                </>
              )}
              {isConnected && txState === "signing" && (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  SIGNING...
                </>
              )}
              {isConnected && txState === "submitting" && (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  SUBMITTING...
                </>
              )}
              {isConnected && txState === "success" && (
                <>
                  <CheckSquare className="h-5 w-5" />
                  STAKED
                </>
              )}
              {isConnected && (txState === "idle" || txState === "error") && (
                <>
                  <Zap className="h-5 w-5" />
                  INITIATE STAKE
                </>
              )}
            </button>

            <button
              onClick={onClose}
              disabled={isProcessing}
              className="w-full border-2 border-zinc-800 bg-transparent py-4 font-mono text-base font-bold uppercase tracking-wider text-zinc-800 transition-colors hover:border-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              CANCEL
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 bg-black px-6 py-3">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-red-500" />
            <div className="h-2 w-2 rounded-full bg-yellow-500" />
            <div className="h-2 w-2 rounded-full bg-lime-500" />
          </div>
          <span className="font-mono text-xs uppercase tracking-wider text-zinc-500">
            CONNECTION: {connectionLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Modal } from "@/components/ui/Modal";
import { useWallet } from "@/shared-d/hooks/useWallet";
import { TransactionModal } from "@/components/modals/TransactionModal";
import { buildCreatePoolTransaction, submitSignedTransaction } from "@/shared-d/utils/stellar-transactions";
import {
  validateStakeAmount,
  formatCurrencyInput,
  sanitizeNumericInput,
  getDecimalPrecision,
  type Currency,
} from "@/shared-d/utils/form-validation";
import {
  estimateCreatePoolFee,
  formatFeeDisplay,
  formatTotalCostDisplay,
} from "@/shared-d/utils/stellar-fees";

type RoundSpeed = "30S" | "1M" | "5M";

interface PoolCreationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInitialize?: (data: PoolCreationData) => void;
}

interface PoolCreationData {
  stakeAmount: number;
  currency: Currency;
  roundSpeed: RoundSpeed;
  arenaCapacity: number;
}

const MIN_CAPACITY = 10;
const MAX_CAPACITY = 1000;
const MIN_STAKE = 10; // Minimum stake for both XLM and USDC

export function PoolCreationModal({
  isOpen,
  onClose,
  onInitialize,
}: PoolCreationModalProps) {
  // Form input state (using string for better control)
  const [stakeAmountInput, setStakeAmountInput] = useState("100");
  const [currency, setCurrency] = useState<Currency>("USDC");
  const [roundSpeed, setRoundSpeed] = useState<RoundSpeed>("1M");
  const [arenaCapacity, setArenaCapacity] = useState(50);

  // Validation state
  const [stakeError, setStakeError] = useState<string>("");
  const [isFormValid, setIsFormValid] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);

  // Refs for accessibility
  const stakeInputRef = useRef<HTMLInputElement>(null);
  const stakeErrorRef = useRef<HTMLDivElement>(null);

  // Fee estimation
  const [estimatedFee] = useState(estimateCreatePoolFee());

  const { isConnected, address, connect, signTransaction, balance, isLoadingBalance, refreshBalance } = useWallet();
  const [showTxModal, setShowTxModal] = useState(false);
  const [txDetails, setTxDetails] = useState<{ label: string; value: string | number }[]>([]);

  // Parse stake amount for calculations
  const stakeAmount = parseFloat(stakeAmountInput) || 0;
  const totalPotentialPool = stakeAmount * arenaCapacity;
  const dynamicYield = 8.42;
  const minorityWinCap = 14.5;

  // Get max stake based on currency and wallet balance
  const getMaxStake = useCallback(() => {
    if (!isConnected) return Infinity;
    return currency === "XLM" ? balance.xlm : balance.usdc;
  }, [isConnected, currency, balance]);

  // Validate stake amount
  const validateStake = useCallback(() => {
    const maxStake = getMaxStake();
    const result = validateStakeAmount({
      amount: stakeAmountInput,
      currency,
      minStake: MIN_STAKE,
      maxStake,
    });

    setStakeError(result.error || "");

    // Focus error if it exists (Accessibility)
    if (result.error && stakeErrorRef.current) {
      stakeErrorRef.current.focus();
    }

    return result.isValid;
  }, [stakeAmountInput, currency, getMaxStake]);

  // Validate form on stake or currency change
  useEffect(() => {
    const isStakeValid = validateStake();
    const isCapacityValid = arenaCapacity >= MIN_CAPACITY && arenaCapacity <= MAX_CAPACITY;
    const hasStake = stakeAmountInput.trim() !== "" && stakeAmount > 0;

    setIsFormValid(isStakeValid && isCapacityValid && hasStake);
  }, [stakeAmountInput, stakeAmount, currency, arenaCapacity, validateStake]);

  // Reset form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setStakeAmountInput("100");
      setStakeError("");
      setIsFormValid(false);
      setRoundSpeed("1M");
      setArenaCapacity(50);
      setIsDeploying(false);
    }
  }, [isOpen]);

  // Handle stake amount input change
  const handleStakeAmountChange = (value: string) => {
    const sanitized = sanitizeNumericInput(value);
    const formatted = formatCurrencyInput(sanitized, currency);
    setStakeAmountInput(formatted);
  };

  // Handle currency change
  const handleCurrencyChange = (newCurrency: Currency) => {
    setCurrency(newCurrency);
    // Reformat the input for the new currency's precision
    if (stakeAmountInput) {
      const formatted = formatCurrencyInput(stakeAmountInput, newCurrency);
      setStakeAmountInput(formatted);
    }
  };

  const handleDecreaseCapacity = () => {
    setArenaCapacity((prev) => Math.max(MIN_CAPACITY, prev - 10));
  };

  const handleIncreaseCapacity = () => {
    setArenaCapacity((prev) => Math.min(MAX_CAPACITY, prev + 10));
  };

  // Check if capacity buttons should be disabled
  const isDecreaseDisabled = arenaCapacity <= MIN_CAPACITY;
  const isIncreaseDisabled = arenaCapacity >= MAX_CAPACITY;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        position="center"
        ariaLabel="Pool Creation"
        className="max-w-250! bg-background-dark! rounded-none! border-3 border-black"
      >
        <div className="p-6 lg:p-8 font-display relative">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-6 right-6 lg:top-8 lg:right-8 size-10 flex items-center justify-center text-white hover:text-primary border-2 border-white/20 hover:border-primary transition-colors z-10"
            aria-label="Close modal"
          >
            <span className="material-symbols-outlined text-2xl">close</span>
          </button>

          <div className="mb-8">
            <h2 className="text-4xl lg:text-5xl font-black tracking-tighter uppercase leading-none mb-2 italic text-white">
              Pool Creation
            </h2>
            <div className="bg-primary h-2 w-40 mb-4 border-b-2 border-black" />
            <p className="text-base font-medium text-slate-400 uppercase tracking-widest">
              Deploy new arena instance to Soroban network
            </p>
          </div>

          <div className="grid grid-cols-12 gap-6">
            <div className="col-span-12 lg:col-span-5 flex flex-col gap-5">
              <section className="bg-[#1e293b] border-3 border-black p-5 shadow-[4px_4px_0px_0px_#000]">
                <div className="flex items-center gap-2 mb-5">
                  <span className="material-symbols-outlined text-primary">payments</span>
                  <h3 className="text-lg font-black uppercase tracking-tight text-white">
                    Stake Amount
                  </h3>
                </div>
                <div className="flex gap-0 border-3 border-black bg-background-dark">
                  <input
                    ref={stakeInputRef}
                    type="text"
                    value={stakeAmountInput}
                    onChange={(e) => handleStakeAmountChange(e.target.value)}
                    className="w-full bg-transparent border-none text-3xl font-black p-4 focus:ring-0 focus:outline-none text-primary placeholder:text-slate-700"
                    placeholder="0.00"
                    aria-label="Stake amount"
                    aria-invalid={!!stakeError}
                    aria-describedby={stakeError ? "stake-error" : undefined}
                  />
                  <select
                    value={currency}
                    onChange={(e) => handleCurrencyChange(e.target.value as Currency)}
                    className="bg-primary text-black border-l-3 border-black font-black text-lg px-4 appearance-none cursor-pointer focus:ring-0 focus:outline-none"
                    aria-label="Currency selection"
                  >
                    <option value="USDC">USDC</option>
                    <option value="XLM">XLM</option>
                  </select>
                </div>

                {/* Balance display */}
                {isConnected && (
                  <div className="mt-3 text-sm font-bold text-slate-400">
                    {isLoadingBalance ? (
                      <span className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-sm animate-spin">cached</span>
                        Loading balance...
                      </span>
                    ) : (
                      <span>
                        Balance: {currency === "XLM" ? balance.xlm.toFixed(7) : balance.usdc.toFixed(2)} {currency}
                      </span>
                    )}
                  </div>
                )}

                {/* Error message */}
                {stakeError && (
                  <div
                    ref={stakeErrorRef}
                    id="stake-error"
                    tabIndex={-1} // Make focusable for screen readers
                    className="mt-3 text-sm font-bold text-red-500 flex items-start gap-2 outline-none"
                    role="alert"
                    aria-live="polite"
                  >
                    <span className="material-symbols-outlined text-base">error</span>
                    <span>{stakeError}</span>
                  </div>
                )}
              </section>

              <section className="bg-[#1e293b] border-3 border-black p-5 shadow-[4px_4px_0px_0px_#000]">
                <div className="flex items-center gap-2 mb-5">
                  <span className="material-symbols-outlined text-primary">timer</span>
                  <h3 className="text-lg font-black uppercase tracking-tight text-white">
                    Round Speed
                  </h3>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {(["30S", "1M", "5M"] as RoundSpeed[]).map((speed) => (
                    <button
                      key={speed}
                      type="button"
                      onClick={() => setRoundSpeed(speed)}
                      className={`border-3 border-black py-3 font-black text-lg transition-all ${
                        roundSpeed === speed
                          ? "bg-primary text-black"
                          : "bg-background-dark text-white hover:bg-primary hover:text-black"
                      }`}
                    >
                      {speed}
                    </button>
                  ))}
                </div>
              </section>

              <section className="bg-[#1e293b] border-3 border-black p-5 shadow-[4px_4px_0px_0px_#000]">
                <div className="flex items-center gap-2 mb-5">
                  <span className="material-symbols-outlined text-primary">groups</span>
                  <h3 className="text-lg font-black uppercase tracking-tight text-white">
                    Arena Capacity
                  </h3>
                </div>
                <div className="flex items-center justify-between border-3 border-black bg-background-dark p-2">
                  <button
                    type="button"
                    onClick={handleDecreaseCapacity}
                    disabled={isDecreaseDisabled}
                    className="size-10 bg-slate-800 border-2 border-black flex items-center justify-center font-black text-xl text-white hover:bg-primary hover:text-black transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-800 disabled:hover:text-white"
                    aria-label="Decrease arena capacity"
                  >
                    -
                  </button>
                  <div className="text-3xl font-black text-white" aria-label="Arena capacity">{arenaCapacity}</div>
                  <button
                    type="button"
                    onClick={handleIncreaseCapacity}
                    disabled={isIncreaseDisabled}
                    className="size-10 bg-slate-800 border-2 border-black flex items-center justify-center font-black text-xl text-white hover:bg-primary hover:text-black transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-800 disabled:hover:text-white"
                    aria-label="Increase arena capacity"
                  >
                    +
                  </button>
                </div>
                <div className="mt-3 flex justify-between text-xs font-bold uppercase text-slate-500">
                  <span className={isDecreaseDisabled ? "text-primary" : ""}>Min: {MIN_CAPACITY}</span>
                  <span className={isIncreaseDisabled ? "text-primary" : ""}>Max: {MAX_CAPACITY}</span>
                </div>
              </section>
            </div>

            <div className="col-span-12 lg:col-span-7">
              <div className="h-full bg-primary border-3 border-black p-6 text-black shadow-[4px_4px_0px_0px_#000] relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4">
                  <span className="material-symbols-outlined text-7xl opacity-10 font-bold select-none">
                    security
                  </span>
                </div>

                <div className="relative z-10 h-full flex flex-col">
                  <div className="flex justify-between items-start mb-8">
                    <div>
                      <h3 className="text-3xl font-black uppercase italic leading-none">
                        Pool Specs
                      </h3>
                      <p className="font-bold text-xs tracking-widest mt-1 opacity-70">
                        LIVE PROJECTED DATA
                      </p>
                    </div>
                    <div className="bg-black text-primary px-3 py-1 font-black text-xs border-2 border-black">
                      ACTIVE_TERMINAL
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-6 grow">
                    <div>
                      <p className="text-xs font-black uppercase tracking-widest mb-2">
                        Dynamic RWA Yield (APY)
                      </p>
                      <div className="text-6xl font-black leading-none tracking-tighter">
                        {dynamicYield}
                        <span className="text-3xl italic">%</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="border-t-3 border-black pt-3">
                        <p className="text-xs font-black uppercase tracking-widest mb-1 opacity-70">
                          Total Potential Pool
                        </p>
                        <p className="text-2xl font-black">
                          ${totalPotentialPool.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                        </p>
                      </div>
                      <div className="border-t-3 border-black pt-3">
                        <p className="text-xs font-black uppercase tracking-widest mb-1 opacity-70">
                          Minority-Win Cap
                        </p>
                        <p className="text-2xl font-black">X {minorityWinCap}</p>
                      </div>
                    </div>

                    <div className="mt-auto pt-4">
                      <div className="bg-black/10 border-2 border-black/20 p-3 italic text-sm font-medium">
                        <span className="font-black">TACTICAL NOTE:</span> RWA yields are
                        generated via automated Soroban-anchored Treasury vaults. Rewards are
                        distributed to the final survivors of the arena.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="col-span-12 mt-4">
              {/* Fee and Total Cost Display */}
              {isConnected && isFormValid && (
                <div className="mb-4 bg-[#1e293b] border-3 border-black p-4 space-y-2">
                  <div className="flex justify-between items-center text-sm font-bold">
                    <span className="text-slate-400 uppercase tracking-wide">Estimated Network Fee:</span>
                    <span className="text-white">{formatFeeDisplay(estimatedFee)}</span>
                  </div>
                  <div className="flex justify-between items-center text-base font-black border-t-2 border-white/10 pt-2">
                    <span className="text-primary uppercase tracking-wide">Total Cost:</span>
                    <span className="text-primary">{formatTotalCostDisplay(stakeAmount, currency, estimatedFee)}</span>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={async () => {
                  if (!isConnected) {
                    await connect();
                  } else if (isFormValid) {
                    setTxDetails([
                      { label: "Operation", value: "Create Pool" },
                      { label: "Stake Amount", value: `${stakeAmount} ${currency}` },
                      { label: "Round Speed", value: roundSpeed },
                      { label: "Capacity", value: arenaCapacity },
                      { label: "Network Fee", value: formatFeeDisplay(estimatedFee) },
                      { label: "Network", value: "Soroban Testnet" },
                    ]);
                    setShowTxModal(true);
                  }
                }}
                disabled={isConnected && !isFormValid}
                className="w-full bg-primary text-black border-3 border-black py-6 text-2xl lg:text-3xl font-black uppercase italic tracking-tighter shadow-[4px_4px_0px_0px_#000] hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-[4px_4px_0px_0px_#000]"
                aria-label={isConnected ? "Initialize arena" : "Connect wallet"}
              >
                {isConnected ? (isDeploying ? "Deploying..." : "Initialize Arena") : "Connect Wallet"}
                <span className={`material-symbols-outlined text-3xl ${isDeploying ? "animate-spin" : ""}`}>
                  {isConnected ? (isDeploying ? "cached" : "rocket_launch") : "account_balance_wallet"}
                </span>
              </button>

              {/* Validation hint when form is invalid */}
              {isConnected && !isFormValid && (
                <div className="mt-3 text-sm font-bold text-slate-500 text-center">
                  Please correct the errors above to continue
                </div>
              )}

              <div className="mt-4 flex justify-center items-center gap-6 text-slate-500 font-bold text-xs uppercase tracking-widest flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="size-2 bg-primary" /> Soroban Network
                </div>
                <div className="flex items-center gap-2">
                  <span className="size-2 bg-primary" /> Smart Contract V2.4
                </div>
                <div className="flex items-center gap-2">
                  <span className="size-2 bg-primary" /> Yield Verified
                </div>
              </div>
            </div>
          </div>
        </div>
      </Modal>

      <TransactionModal
        isOpen={showTxModal}
        onClose={() => setShowTxModal(false)}
        title="Confirm Pool Creation"
        description="Review transaction details"
        details={txDetails}
        onConfirm={async () => {
          if (!address) return;
          const tx = await buildCreatePoolTransaction(address, {
            stakeAmount,
            currency,
            roundSpeed,
            arenaCapacity,
          });
          const signedXdr = await signTransaction(tx.toXDR());
          await submitSignedTransaction(signedXdr);
          onInitialize?.({
            stakeAmount,
            currency,
            roundSpeed,
            arenaCapacity,
          });
          setShowTxModal(false);
          onClose();
        }}
        confirmLabel="Sign & Deploy"
      />
    </>
  );
}
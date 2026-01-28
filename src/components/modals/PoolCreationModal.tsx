"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { useWallet } from "@/shared-d/hooks/useWallet";
import { TransactionModal } from "@/components/modals/TransactionModal";
import { buildCreatePoolTransaction, submitSignedTransaction } from "@/shared-d/utils/stellar-transactions";

type RoundSpeed = "30S" | "1M" | "5M";
type Currency = "USDC" | "XLM";

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

export function PoolCreationModal({
  isOpen,
  onClose,
  onInitialize,
}: PoolCreationModalProps) {
  const [stakeAmount, setStakeAmount] = useState(100);
  const [currency, setCurrency] = useState<Currency>("USDC");
  const [roundSpeed, setRoundSpeed] = useState<RoundSpeed>("1M");
  const [arenaCapacity, setArenaCapacity] = useState(50);

  const { isConnected, address, connect, signTransaction } = useWallet();
  const [showTxModal, setShowTxModal] = useState(false);
  const [txDetails, setTxDetails] = useState<{ label: string; value: string | number }[]>([]);

  const totalPotentialPool = stakeAmount * arenaCapacity;
  const dynamicYield = 8.42;
  const minorityWinCap = 14.5;

  const handleDecreaseCapacity = () => {
    setArenaCapacity((prev) => Math.max(MIN_CAPACITY, prev - 10));
  };

  const handleIncreaseCapacity = () => {
    setArenaCapacity((prev) => Math.min(MAX_CAPACITY, prev + 10));
  };

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
                    type="number"
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(Number(e.target.value))}
                    className="w-full bg-transparent border-none text-3xl font-black p-4 focus:ring-0 focus:outline-none text-primary placeholder:text-slate-700"
                    placeholder="0.00"
                  />
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value as Currency)}
                    className="bg-primary text-black border-l-3 border-black font-black text-lg px-4 appearance-none cursor-pointer focus:ring-0 focus:outline-none"
                  >
                    <option value="USDC">USDC</option>
                    <option value="XLM">XLM</option>
                  </select>
                </div>
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
                    className="size-10 bg-slate-800 border-2 border-black flex items-center justify-center font-black text-xl text-white hover:bg-primary hover:text-black transition-all"
                  >
                    -
                  </button>
                  <div className="text-3xl font-black text-white">{arenaCapacity}</div>
                  <button
                    type="button"
                    onClick={handleIncreaseCapacity}
                    className="size-10 bg-slate-800 border-2 border-black flex items-center justify-center font-black text-xl text-white hover:bg-primary hover:text-black transition-all"
                  >
                    +
                  </button>
                </div>
                <div className="mt-3 flex justify-between text-xs font-bold uppercase text-slate-500">
                  <span>Min: {MIN_CAPACITY}</span>
                  <span>Max: {MAX_CAPACITY}</span>
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
              <button
                type="button"
                onClick={async () => {
                  if (!isConnected) {
                    await connect();
                  } else {
                    setTxDetails([
                      { label: "Operation", value: "Create Pool" },
                      { label: "Stake Amount", value: `${stakeAmount} ${currency}` },
                      { label: "Round Speed", value: roundSpeed },
                      { label: "Capacity", value: arenaCapacity },
                      { label: "Network", value: "Soroban Testnet" },
                    ]);
                    setShowTxModal(true);
                  }
                }}
                className="w-full bg-primary text-black border-3 border-black py-6 text-2xl lg:text-3xl font-black uppercase italic tracking-tighter shadow-[4px_4px_0px_0px_#000] hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all flex items-center justify-center gap-3"
              >
                {isConnected ? "Initialize Arena" : "Connect Wallet"}
                <span className="material-symbols-outlined text-3xl">
                  {isConnected ? "rocket_launch" : "account_balance_wallet"}
                </span>
              </button>

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
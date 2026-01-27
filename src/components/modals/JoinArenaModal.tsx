'use client'
import React, { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';

interface JoinArenaModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  arenaId: number;
  requiredStake: number;
  currentPlayers: number;
  maxPlayers: number;
  yieldGeneration: number;
  arenaStatus: 'ACTIVE' | 'INACTIVE';
}

const JoinArenaModal: React.FC<JoinArenaModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  arenaId,
  requiredStake,
  currentPlayers,
  maxPlayers,
  yieldGeneration,
  arenaStatus,
}) => {
  const [isChecked, setIsChecked] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsChecked(false);
    }
  }, [isOpen]);

  const handleConfirm = async () => {
    if (!isChecked) return;
    setIsLoading(true);
    try {
      await onConfirm();
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <div className="bg-white border-4 border-black text-black">
        {/* Header */}
        <div className="border-b-4 border-black px-6 md:px-8 py-6">
          <h1 className="text-3xl md:text-4xl font-black italic text-left tracking-tight">
            JOIN ARENA #{arenaId}
          </h1>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 border-b-4 border-black">
          <div className="border-b-4 md:border-b-0 md:border-r-4 border-black px-6 md:px-8 py-6">
            <p className="text-xs font-bold tracking-widest text-left text-gray-600 mb-2">
              REQUIRED STAKE
            </p>
            <p className="text-2xl md:text-3xl text-left font-black">{requiredStake} USDC</p>
          </div>

          <div className="px-6 md:px-8 py-6">
            <p className="text-xs text-left font-bold tracking-widest text-gray-600 mb-2">
              CURRENT PLAYERS
            </p>
            <p className="text-2xl md:text-3xl text-left font-black text-lime-400">
              {currentPlayers} / {maxPlayers}
            </p>
          </div>
        </div>

        {/* Yield Section */}
        <div className="border-b-4 border-black px-6 md:px-8 py-6 flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-left tracking-widest text-gray-600 mb-2">
              YIELD GENERATION
            </p>
            <p className="text-2xl md:text-3xl font-black">{yieldGeneration}% APY</p>
          </div>
          <div className={`bg-black px-3 py-2 ${arenaStatus === 'ACTIVE' ? 'text-lime-400' : 'text-red-500'}`}>
            <span className="text-xs font-black tracking-widest">
              ■ {arenaStatus}
            </span>
          </div>
        </div>

        {/* Agreement Checkbox */}
        <div className="px-6 md:px-8 py-6">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isChecked}
              onChange={(e) => setIsChecked(e.target.checked)}
              className="mt-1 w-6 h-6 border-2 border-black cursor-pointer accent-black"
            />
            <span className="text-md md:text-lg italic font-bold leading-tight">
              I UNDERSTAND THAT MINORITY WINS.
            </span>
          </label>
        </div>

        {/* Buttons */}
        <div className="space-y-4 p-6">
          <button
            onClick={handleConfirm}
            disabled={!isChecked || isLoading}
            className={`w-full border-3 border-black py-4 px-6 font-black text-lg italic tracking-wide transition-all ${
              isChecked && !isLoading
                ? 'bg-lime-400 text-black hover:bg-lime-300 active:scale-95'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {isLoading ? 'CONFIRMING...' : 'CONFIRM ENTRY'}
          </button>

          <button
            onClick={onClose}
            className="w-full border-3 border-black bg-white py-4 px-6 font-black text-lg tracking-wide hover:bg-gray-50 active:scale-95 transition-all"
          >
            CANCEL
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default JoinArenaModal;

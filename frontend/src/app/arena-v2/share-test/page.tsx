'use client';

import { useState } from 'react';
import ShareModal from '@/components/arena-v2/modals/ShareModal';

export default function ShareTestPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-8">
          Share Modal Test
        </h1>
        <button
          onClick={() => setIsModalOpen(true)}
          className="bg-[#39FF14] text-black px-8 py-4 font-bold text-lg hover:bg-[#2de010] transition-colors"
        >
          OPEN SHARE MODAL
        </button>
      </div>

      <ShareModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        arenaId="A1B2C3D4"
        joinUrl="https://inversearena.xyz/join/A1B2C3D4"
      />
    </div>
  );
}

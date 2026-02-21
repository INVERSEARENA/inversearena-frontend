'use client';

import React, { useState, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Modal } from '../../ui/Modal';

interface QRCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  arenaUrl: string;
}

const QRCodeModal: React.FC<QRCodeModalProps> = ({ isOpen, onClose, arenaUrl }) => {
  const [copied, setCopied] = useState(false);

  const fullUrl = arenaUrl.startsWith('http') ? arenaUrl : `https://${arenaUrl}`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const el = document.createElement('textarea');
      el.value = fullUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [fullUrl]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      position="center"
      closeOnOverlayClick
      closeOnEscape
      ariaLabel="Scan to join arena"
      className="!rounded-none"
    >
      {/* White container */}
      <div className="bg-white text-black w-full relative" style={{ borderRadius: 0 }}>

        {/* Close button — top-right, square */}
        <button
          onClick={onClose}
          aria-label="Close modal"
          className="absolute top-3 right-3 z-10 w-7 h-7 border border-gray-400 flex items-center justify-center text-black hover:bg-gray-100 transition-colors text-xs font-bold"
          style={{ borderRadius: 0 }}
        >
          ✕
        </button>

        {/* Header */}
        <div className="pt-10 pb-6 px-8 text-center">
          <h1 className="text-xl font-black tracking-widest uppercase">
            SCAN TO JOIN ARENA
          </h1>
        </div>

        {/* QR Code */}
        <div className="flex items-center justify-center px-3 pb-3">
          <div className="relative p-3">
            {/* Neon green corner — top-left */}
            <span
              className="absolute top-0 left-0 border-t-4 border-l-4 border-[#39FF14]"
              style={{ width: 28, height: 28 }}
            />
            {/* Neon green corner — top-right */}
            <span
              className="absolute top-0 right-0 border-t-4 border-r-4 border-[#39FF14]"
              style={{ width: 28, height: 28 }}
            />
            {/* Neon green corner — bottom-left */}
            <span
              className="absolute bottom-0 left-0 border-b-4 border-l-4 border-[#39FF14]"
              style={{ width: 28, height: 28 }}
            />
            {/* Neon green corner — bottom-right */}
            <span
              className="absolute bottom-0 right-0 border-b-4 border-r-4 border-[#39FF14]"
              style={{ width: 28, height: 28 }}
            />

            {/* MIDDLE layer */}
            <div className="border-[3px] border-neutral-800 p-3" style={{ borderRadius: 0 }}>

              {/* INNER layer */}
              <div className="border-[6px] border-neutral-800 bg-white p-1" style={{ borderRadius: 0 }}>
                <QRCodeSVG
                  value={fullUrl}
                  size={200}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="H"
                  includeMargin={false}
                />
              </div>

            </div>
          </div>
        </div>

        {/* Arena URL copy section */}
        <div className="px-8 pb-4">
          <div
            className="border border-gray-300 bg-gray-100 flex items-stretch overflow-hidden"
            style={{ borderRadius: 0 }}
          >
            <div className="flex-1 px-3 py-3">
              <p className="text-[9px] font-bold tracking-widest text-gray-500 uppercase mb-1">
                ARENA_URL
              </p>
              <p className="text-[11px] font-mono font-bold text-black truncate uppercase">
                {arenaUrl}
              </p>
            </div>

            <button
              onClick={handleCopy}
              className="bg-[#39FF14] hover:bg-[#2de010] active:scale-95 transition-all px-5 font-black text-black text-xs tracking-widest uppercase"
              style={{ borderRadius: 0 }}
            >
              {copied ? 'COPIED!' : 'COPY'}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center pb-8 px-8">
          <p className="text-[10px] font-mono text-gray-500 tracking-widest uppercase">
            ■ COMPATIBLE WITH LOBSTER / FREIGHTER MOBILE
          </p>
        </div>
      </div>
    </Modal>
  );
};

export default QRCodeModal;
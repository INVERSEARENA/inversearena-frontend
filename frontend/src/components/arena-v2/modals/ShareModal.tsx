'use client';

import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Modal } from '../../ui/Modal';
import { SocialCard } from './SocialCard';

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  arenaId: string;
  joinUrl: string;
}

const ShareModal: React.FC<ShareModalProps> = ({
  isOpen,
  onClose,
  arenaId,
  joinUrl,
}) => {
  const [copied, setCopied] = useState(false);
  const [showQR, setShowQR] = useState(false);

  const fullUrl = joinUrl.startsWith('http') ? joinUrl : `https://${joinUrl}`;

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
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

  const handleShareTwitter = () => {
    const text = encodeURIComponent(
      `Join me in the Inverse Arena! Recruit the minority. Be the minority. Win the pot. 🎯`
    );
    const url = encodeURIComponent(fullUrl);
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  const handleShareTelegram = () => {
    const text = encodeURIComponent(
      `Join me in the Inverse Arena! ${fullUrl}`
    );
    window.open(
      `https://t.me/share/url?url=${fullUrl}&text=${text}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  const handleShareDiscord = () => {
    // Discord doesn't have a direct share URL, so we copy to clipboard with a message
    navigator.clipboard.writeText(
      `Join me in the Inverse Arena! ${fullUrl}`
    );
    alert('Link copied! Paste it in your Discord channel.');
  };

  const handleGenerateQR = () => {
    setShowQR(!showQR);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      position="center"
      closeOnOverlayClick
      closeOnEscape
      ariaLabel="Recruit Survivors"
      className="!rounded-none"
    >
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="bg-white text-black w-full relative shadow-[6px_6px_0px_0px_#000]"
            style={{ borderRadius: 0 }}
          >
            {/* Header - BLACK */}
            <div className="bg-black border-b-2 border-black px-6 py-4 flex items-center justify-between">
              <div>
                <h1 className="text-lg font-black tracking-widest uppercase text-white" style={{ fontFamily: 'monospace' }}>
                  RECRUIT SURVIVORS
                </h1>
                <p className="text-xs text-[#39FF14] font-mono mt-1">
                  ARENA_ID: {arenaId}
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close modal"
                className="w-8 h-8 border-2 border-white flex items-center justify-center text-white hover:bg-white/10 transition-colors font-bold"
                style={{ borderRadius: 0 }}
              >
                ✕
              </button>
            </div>

            {/* Join Link Section - WHITE */}
            <div className="px-6 py-6">
              <label className="block text-[10px] font-bold tracking-widest text-black/60 uppercase mb-2">
                JOIN LINK
              </label>
              <div
                className="border-2 border-black flex items-stretch overflow-hidden shadow-[6px_6px_0px_0px_#000]"
                style={{ borderRadius: 0 }}
              >
                <div className="flex-1 px-4 py-3 bg-white border-r-2 border-black">
                  <p className="text-xs font-mono text-black truncate uppercase">
                    {fullUrl}
                  </p>
                </div>
                <button
                  onClick={handleCopyLink}
                  className="bg-[#39FF14] hover:bg-[#2de010] active:scale-95 transition-all px-8 py-4 font-black text-black text-xs tracking-widest uppercase flex items-center gap-2"
                  style={{ borderRadius: 0 }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="square"
                    strokeLinejoin="miter"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="0" ry="0" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  {copied ? 'COPIED!' : 'COPY_LINK'}
                </button>
              </div>
            </div>

            {/* Social Sharing Grid - WHITE */}
            <div className="px-6 pb-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <SocialCard
                  label="POST TO X / TWITTER"
                  icon={
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                    </svg>
                  }
                  onClick={handleShareTwitter}
                  variant="outline"
                />
                <SocialCard
                  label="BROADCAST ON TELEGRAM"
                  icon={
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" fill="none" strokeWidth="2" />
                    </svg>
                  }
                  onClick={handleShareTelegram}
                  variant="outline"
                />
                <SocialCard
                  label="SYNC WITH DISCORD"
                  icon={
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                    </svg>
                  }
                  onClick={handleShareDiscord}
                  variant="outline"
                />
                <SocialCard
                  label="GENERATE QR_CODE"
                  icon={
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <rect x="3" y="3" width="7" height="7" />
                      <rect x="14" y="3" width="7" height="7" />
                      <rect x="14" y="14" width="7" height="7" />
                      <rect x="3" y="14" width="7" height="7" />
                    </svg>
                  }
                  onClick={handleGenerateQR}
                  variant="filled"
                />
              </div>
            </div>

            {/* Footer - WHITE */}
            <div className="bg-white border-t-2 border-black px-6 py-4">
              <p className="text-[10px] font-black tracking-widest text-center mb-2 text-black uppercase">
                RECRUIT THE MINORITY. BE THE MINORITY. WIN THE POT.
              </p>
              <p className="text-[8px] font-mono text-black/40 text-center tracking-wider uppercase">
                STELLAR・SOROBAN・PROTOCOL_v2.4.0
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
};

export default ShareModal;

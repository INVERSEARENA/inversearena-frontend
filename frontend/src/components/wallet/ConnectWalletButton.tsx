'use client';

import { useState } from 'react';
import { useWallet } from '@/features/wallet/useWallet';
import { usePasskeyWallet } from '@/features/wallet/usePasskeyWallet';
import { Button } from '@/components/ui/Button';

const shortAddress = (address: string) =>
  `${address.slice(0, 6)}...${address.slice(-4)}`;

export const ConnectWalletButton = ({ className }: { className?: string }) => {
  const { status, publicKey, error, connect, disconnect } = useWallet();
  const passkey = usePasskeyWallet();
  const [showPasskeyPrompt, setShowPasskeyPrompt] = useState(false);
  const [passkeyUsername, setPasskeyUsername] = useState('');
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  const buttonVariant = className ? 'none' : 'primary';

  // Passkey already registered and active
  if (passkey.isRegistered && passkey.address) {
    return (
      <div className="flex items-center gap-4">
        <span className="text-white" title="Passkey wallet">
          🔑 {shortAddress(passkey.address)}
        </span>
        <Button onClick={passkey.disconnect} variant={buttonVariant} className={className}>
          Disconnect
        </Button>
      </div>
    );
  }

  // Extension wallet connected
  if (status === 'connected') {
    return (
      <div className="flex items-center gap-4">
        <span className="text-white">{publicKey ? shortAddress(publicKey) : 'Connected'}</span>
        <Button onClick={() => disconnect()} variant={buttonVariant} className={className}>
          Disconnect
        </Button>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-3">
        {error && (
          <span className="hidden sm:inline text-red-400 text-xs max-w-[180px] truncate">
            {error}
          </span>
        )}
        <Button onClick={() => connect()} variant={buttonVariant} className={className}>
          Retry
        </Button>
      </div>
    );
  }

  // Passkey registration prompt
  if (showPasskeyPrompt) {
    return (
      <div className="flex flex-col gap-2">
        <input
          type="text"
          placeholder="Username for passkey"
          value={passkeyUsername}
          onChange={(e) => setPasskeyUsername(e.target.value)}
          className="border border-gray-600 bg-black text-white px-3 py-1 text-sm rounded"
          aria-label="Username for passkey registration"
        />
        {passkeyError && <p className="text-red-500 text-xs">{passkeyError}</p>}
        <div className="flex gap-2">
          <Button
            onClick={async () => {
              setPasskeyError(null);
              try {
                await passkey.register(passkeyUsername || 'player');
                setShowPasskeyPrompt(false);
              } catch (e) {
                setPasskeyError(e instanceof Error ? e.message : 'Passkey registration failed');
              }
            }}
            variant={buttonVariant}
            className={className}
          >
            Register Passkey
          </Button>
          <Button onClick={() => setShowPasskeyPrompt(false)} variant="none">
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Default: show both connect options
  return (
    <div className="flex flex-col gap-2">
      <Button
        onClick={() => connect()}
        disabled={status === 'connecting'}
        variant={buttonVariant}
        className={className}
      >
        {status === 'connecting' ? 'Connecting...' : 'Connect Extension Wallet'}
      </Button>
      {passkey.isAvailable && (
        <Button
          onClick={() => setShowPasskeyPrompt(true)}
          variant="none"
          className="text-xs text-gray-400 hover:text-white"
        >
          🔑 Use Passkey (FaceID / TouchID)
        </Button>
      )}
    </div>
  );
};

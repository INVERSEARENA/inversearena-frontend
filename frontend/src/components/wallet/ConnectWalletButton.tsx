'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useWallet } from '@/features/wallet/hooks/useWallet';
import { usePasskeyWallet } from '@/features/wallet/hooks/usePasskeyWallet';
import { Button } from '@/components/ui/Button';

const shortAddress = (address: string) =>
  `${address.slice(0, 6)}...${address.slice(-4)}`;

export const ConnectWalletButton = ({ className }: { className?: string }) => {
  const t = useTranslations('wallet');
  const tCommon = useTranslations('common');
  const { status, publicKey, error, connect, disconnect, walletNetworkName, recheckNetwork } =
    useWallet();
  const passkey = usePasskeyWallet();
  const [showPasskeyPrompt, setShowPasskeyPrompt] = useState(false);
  const [passkeyUsername, setPasskeyUsername] = useState('');
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [isCheckingNetwork, setIsCheckingNetwork] = useState(false);

  const buttonVariant = className ? 'none' : 'primary';

  // Passkey already registered and active. WalletProvider merges the
  // passkey session into the shared useWallet() context (see #1281), so
  // `status`/`publicKey` already reflect it here — disconnecting goes
  // through the same shared `disconnect()` rather than passkey.disconnect
  // directly, keeping this branch consistent with the extension-connected
  // one below.
  if (passkey.isRegistered && passkey.address) {
    return (
      <div className="flex items-center gap-4">
        <span className="text-white" title={t('passkeyTitle')}>
          🔑 {shortAddress(passkey.address)}
        </span>
        <Button onClick={() => disconnect()} variant={buttonVariant} className={className}>
          {tCommon('disconnect')}
        </Button>
      </div>
    );
  }

  // Extension wallet connected
  if (status === 'connected') {
    return (
      <div className="flex items-center gap-4">
        <span className="text-white">{publicKey ? shortAddress(publicKey) : tCommon('connected')}</span>
        <Button onClick={() => disconnect()} variant={buttonVariant} className={className}>
          {tCommon('disconnect')}
        </Button>
      </div>
    );
  }

  // Wallet extension is connected but active on a different network than
  // this app expects (#1404). Signing is blocked in this state (see
  // useStellarWallet.signTransaction), so surface a clear, recoverable path
  // instead of a confusing sign-time failure.
  if (status === 'network-mismatch') {
    return (
      <div className="flex flex-col items-end gap-1">
        <span
          role="alert"
          className="text-amber-400 text-xs max-w-[220px] text-right"
        >
          {t('networkMismatch')}
          {walletNetworkName ? ` (${walletNetworkName})` : ''}. {t('networkMismatchHint')}
        </span>
        <div className="flex items-center gap-3">
          <Button
            onClick={async () => {
              setIsCheckingNetwork(true);
              try {
                await recheckNetwork();
              } finally {
                setIsCheckingNetwork(false);
              }
            }}
            disabled={isCheckingNetwork}
            variant={buttonVariant}
            className={className}
          >
            {isCheckingNetwork ? tCommon('checking') : t('checkAgain')}
          </Button>
          <Button onClick={() => disconnect()} variant="none">
            {tCommon('disconnect')}
          </Button>
        </div>
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
          {tCommon('retry')}
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
          placeholder={t('passkeyPlaceholder')}
          value={passkeyUsername}
          onChange={(e) => setPasskeyUsername(e.target.value)}
          className="border border-gray-600 bg-black text-white px-3 py-1 text-sm rounded"
          aria-label={t('passkeyAriaLabel')}
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
                setPasskeyError(e instanceof Error ? e.message : t('passkeyRegistrationFailed'));
              }
            }}
            variant={buttonVariant}
            className={className}
          >
            {t('registerPasskey')}
          </Button>
          <Button onClick={() => setShowPasskeyPrompt(false)} variant="none">
            {tCommon('cancel')}
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
        {status === 'connecting' ? t('connecting') : t('connectExtension')}
      </Button>
      {passkey.isAvailable && (
        <Button
          onClick={() => setShowPasskeyPrompt(true)}
          variant="none"
          className="text-xs text-gray-400 hover:text-white"
        >
          {t('usePasskey')}
        </Button>
      )}
    </div>
  );
};

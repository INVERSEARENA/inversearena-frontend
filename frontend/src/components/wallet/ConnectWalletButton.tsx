'use client';

import { useWallet } from '@/features/wallet/useWallet';
import { Button } from '@/components/ui/Button';

const shortAddress = (address: string) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export const ConnectWalletButton = ({ className }: { className?: string }) => {
  const { status, publicKey, error, connect, disconnect } = useWallet();

  const buttonVariant = className ? 'none' : 'primary';

  if (status === 'connected') {
    return (
      <div className="flex items-center gap-4">
        <span className='text-white'>{publicKey ? shortAddress(publicKey) : 'Connected'}</span>
        <Button onClick={() => disconnect()} variant={buttonVariant} className={className}>Disconnect</Button>
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

  return (
    <Button onClick={() => connect()} disabled={status === 'connecting'} variant={buttonVariant} className={className}>
      {status === 'connecting' ? 'Connecting...' : 'Connect Wallet'}
    </Button>
  );
};
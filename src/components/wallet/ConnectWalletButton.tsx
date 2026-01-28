'use client';

import { useWallet } from '@/features/wallet/useWallet';
import { Button } from '@/components/ui/Button';
import { Loader2 } from 'lucide-react';

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
      <div className="flex flex-col items-end gap-2">
        <Button onClick={() => connect()} variant={buttonVariant} className={className}>Retry</Button>
        {error && (
          <p className="text-red-400 text-xs max-w-[200px] text-right animate-pulse">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <Button 
      onClick={() => connect()} 
      disabled={status === 'connecting'} 
      variant={buttonVariant} 
      className={className}
    >
      {status === 'connecting' ? (
        <span className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Connecting...
        </span>
      ) : (
        'Connect Wallet'
      )}
    </Button>
  );
};
// src/features/wallet/useWallet.ts
import { useContext } from 'react';
import { WalletContext } from './WalletProvider';
import { WalletContextType } from './types';

export const useWallet = (): WalletContextType => {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
};
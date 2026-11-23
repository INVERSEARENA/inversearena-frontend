// src/features/wallet/hooks/useWallet.ts
import { useContext } from 'react';
import { WalletContext } from '../components/WalletProvider';
import { WalletContextType } from '../model/types';

export const useWallet = (): WalletContextType => {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
};
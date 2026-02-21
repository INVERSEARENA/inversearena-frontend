"use client";

import React from 'react';
import { useNotification } from '../../shared-d/hooks/useNotification';
import { Button } from './Button';

export function NotificationDemo() {
  const notify = useNotification();

  const handleSuccess = () => {
    notify.success('Transaction completed successfully!', { duration: 4000 });
  };

  const handleError = () => {
    notify.error('Failed to connect to wallet. Please try again.', { duration: 6000 });
  };

  const handleInfo = () => {
    notify.info('Arena match starting in 30 seconds...', { duration: 3000 });
  };

  const handleWarning = () => {
    notify.warning('Low balance detected. Consider adding funds.', { 
      duration: 5000,
      action: {
        label: 'Add Funds',
        onClick: () => console.log('Navigate to add funds')
      }
    });
  };

  const handlePersistent = () => {
    notify({
      message: 'This notification will stay until manually dismissed',
      type: 'info',
      persistent: true
    });
  };

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-xl font-bold text-white mb-4">Notification System Demo</h2>
      <div className="flex flex-wrap gap-3">
        <Button onClick={handleSuccess} variant="primary">
          Success Notification
        </Button>
        <Button onClick={handleError} variant="secondary">
          Error Notification
        </Button>
        <Button onClick={handleInfo} variant="secondary">
          Info Notification
        </Button>
        <Button onClick={handleWarning} variant="secondary">
          Warning Notification
        </Button>
        <Button onClick={handlePersistent} variant="secondary">
          Persistent Notification
        </Button>
      </div>
    </div>
  );
}
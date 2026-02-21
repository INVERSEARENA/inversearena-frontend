import { useCallback } from 'react';
import { useNotificationContext } from '../../components/ui/NotificationProvider';
import type { NotificationConfig, NotificationType } from '../types/notification';

interface NotificationOptions {
  duration?: number;
  persistent?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface NotifyFunction {
  (config: NotificationConfig): string;
  (message: string, options?: NotificationOptions): string;
  success: (message: string, options?: NotificationOptions) => string;
  error: (message: string, options?: NotificationOptions) => string;
  info: (message: string, options?: NotificationOptions) => string;
  warning: (message: string, options?: NotificationOptions) => string;
}

export function useNotification() {
  const context = useNotificationContext();
  
  // Additional validation for context availability
  if (!context) {
    throw new Error(
      'useNotification must be used within a NotificationProvider. ' +
      'Make sure your component is wrapped with <NotificationProvider>.'
    );
  }
  
  const { addNotification } = context;

  const notify = useCallback((
    configOrMessage: NotificationConfig | string,
    options?: NotificationOptions
  ): string => {
    // Validate message content
    const message = typeof configOrMessage === 'string' 
      ? configOrMessage 
      : configOrMessage.message;
      
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      console.warn('useNotification: Empty or invalid message provided, skipping notification');
      return '';
    }

    if (typeof configOrMessage === 'string') {
      // Called with message string and options
      const config: NotificationConfig = {
        message: configOrMessage.trim(),
        type: 'info',
        ...options,
      };
      return addNotification(config);
    } else {
      // Called with full config object
      const config = {
        ...configOrMessage,
        message: configOrMessage.message.trim(),
        type: configOrMessage.type || 'info',
      };
      return addNotification(config);
    }
  }, [addNotification]);

  const createTypeSpecificNotify = useCallback((type: NotificationType) => {
    return (message: string, options?: NotificationOptions): string => {
      // Validate message for type-specific methods
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        console.warn(`useNotification.${type}: Empty or invalid message provided, skipping notification`);
        return '';
      }
      
      const config: NotificationConfig = {
        message: message.trim(),
        type,
        ...options,
      };
      return addNotification(config);
    };
  }, [addNotification]);

  // Create type-specific methods
  const notifyWithMethods = notify as NotifyFunction;
  notifyWithMethods.success = createTypeSpecificNotify('success');
  notifyWithMethods.error = createTypeSpecificNotify('error');
  notifyWithMethods.info = createTypeSpecificNotify('info');
  notifyWithMethods.warning = createTypeSpecificNotify('warning');

  return notifyWithMethods;
}
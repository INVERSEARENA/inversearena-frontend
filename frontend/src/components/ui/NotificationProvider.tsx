"use client";

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import type { 
  NotificationConfig, 
  InternalNotification, 
  NotificationContextValue 
} from '../../shared-d/types/notification';
import { NotificationCard } from './NotificationCard';

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotificationContext() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotificationContext must be used within a NotificationProvider');
  }
  return context;
}

interface NotificationProviderProps {
  children: React.ReactNode;
  maxNotifications?: number;
}

export function NotificationProvider({ 
  children, 
  maxNotifications = 5 
}: NotificationProviderProps) {
  const [notifications, setNotifications] = useState<InternalNotification[]>([]);
  const timeoutRefs = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const generateId = useCallback(() => {
    // Use crypto.randomUUID if available, fallback to timestamp + random
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  const removeNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(notification => notification.id !== id));
    
    // Clear timeout if it exists
    const timeoutId = timeoutRefs.current.get(id);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutRefs.current.delete(id);
    }
  }, []);

  const addNotification = useCallback((config: NotificationConfig): string => {
    const id = generateId();
    const defaultDuration = 5000; // 5 seconds
    const duration = config.persistent ? undefined : (config.duration ?? defaultDuration);

    const notification: InternalNotification = {
      ...config,
      id,
      createdAt: Date.now(),
      type: config.type ?? 'info',
    };

    setNotifications(prev => {
      const newNotifications = [notification, ...prev];
      // Limit the number of notifications
      return newNotifications.slice(0, maxNotifications);
    });

    // Set up auto-dismissal if not persistent
    if (duration && !config.persistent) {
      const timeoutId = setTimeout(() => {
        removeNotification(id);
      }, duration);
      
      timeoutRefs.current.set(id, timeoutId);
      notification.timeoutId = timeoutId;
    }

    return id;
  }, [generateId, removeNotification, maxNotifications]);

  const clearAllNotifications = useCallback(() => {
    // Clear all timeouts
    timeoutRefs.current.forEach(timeoutId => clearTimeout(timeoutId));
    timeoutRefs.current.clear();
    
    setNotifications([]);
  }, []);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      timeoutRefs.current.forEach(timeoutId => clearTimeout(timeoutId));
      timeoutRefs.current.clear();
    };
  }, []);

  const contextValue: NotificationContextValue = {
    notifications,
    addNotification,
    removeNotification,
    clearAllNotifications,
  };

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
      <NotificationContainer 
        notifications={notifications} 
        onRemove={removeNotification}
      />
    </NotificationContext.Provider>
  );
}

interface NotificationContainerProps {
  notifications: InternalNotification[];
  onRemove: (id: string) => void;
}

function NotificationContainer({ notifications, onRemove }: NotificationContainerProps) {
  if (typeof window === 'undefined') return null;

  return createPortal(
    <div 
      className="fixed top-4 right-4 z-50 flex flex-col gap-3 pointer-events-none"
      role="region"
      aria-label="Notifications"
    >
      <AnimatePresence mode="popLayout">
        {notifications.map((notification) => (
          <NotificationCard
            key={notification.id}
            notification={notification}
            onRemove={onRemove}
          />
        ))}
      </AnimatePresence>
    </div>,
    document.body
  );
}
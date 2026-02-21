"use client";

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import type { InternalNotification } from '../../shared-d/types/notification';

interface NotificationCardProps {
  notification: InternalNotification;
  onRemove: (id: string) => void;
}

const typeConfig = {
  success: {
    icon: CheckCircle,
    bgColor: 'bg-card-bg border-neon-green/30',
    iconColor: 'text-neon-green',
    progressColor: 'bg-neon-green',
    ariaRole: 'status' as const,
  },
  error: {
    icon: AlertCircle,
    bgColor: 'bg-card-bg border-neon-pink/30',
    iconColor: 'text-neon-pink',
    progressColor: 'bg-neon-pink',
    ariaRole: 'alert' as const,
  },
  warning: {
    icon: AlertTriangle,
    bgColor: 'bg-card-bg border-yellow-500/30',
    iconColor: 'text-yellow-500',
    progressColor: 'bg-yellow-500',
    ariaRole: 'alert' as const,
  },
  info: {
    icon: Info,
    bgColor: 'bg-card-bg border-blue-400/30',
    iconColor: 'text-blue-400',
    progressColor: 'bg-blue-400',
    ariaRole: 'status' as const,
  },
};

export function NotificationCard({ notification, onRemove }: NotificationCardProps) {
  const [progress, setProgress] = useState(100);
  const config = typeConfig[notification.type || 'info'];
  const Icon = config.icon;

  const handleClose = () => {
    onRemove(notification.id);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClose();
    }
  };

  // Progress bar animation for auto-dismissal
  useEffect(() => {
    if (notification.persistent || !notification.duration) return;

    const startTime = Date.now();
    const duration = notification.duration;
    
    const updateProgress = () => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, duration - elapsed);
      const progressPercent = (remaining / duration) * 100;
      
      setProgress(progressPercent);
      
      if (remaining > 0) {
        requestAnimationFrame(updateProgress);
      }
    };

    updateProgress();
  }, [notification.persistent, notification.duration]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -50, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -20, scale: 0.95 }}
      transition={{
        type: "spring",
        damping: 25,
        stiffness: 300,
      }}
      className={`
        relative w-80 max-w-sm p-4 rounded-lg border backdrop-blur-sm
        shadow-2xl pointer-events-auto
        ${config.bgColor}
      `}
      role={config.ariaRole}
      aria-live={config.ariaRole === 'alert' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      {/* Progress bar for auto-dismissal */}
      {!notification.persistent && notification.duration && (
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10 rounded-b-lg overflow-hidden">
          <motion.div
            className={`h-full ${config.progressColor}`}
            initial={{ width: '100%' }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.1, ease: 'linear' }}
          />
        </div>
      )}

      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`flex-shrink-0 ${config.iconColor}`}>
          <Icon size={20} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white font-medium leading-relaxed">
            {notification.message}
          </p>
          
          {/* Action button if provided */}
          {notification.action && (
            <button
              onClick={notification.action.onClick}
              className={`
                mt-2 text-xs font-medium underline hover:no-underline
                transition-colors ${config.iconColor}
              `}
            >
              {notification.action.label}
            </button>
          )}
        </div>

        {/* Close button */}
        <button
          onClick={handleClose}
          onKeyDown={handleKeyDown}
          className="
            flex-shrink-0 p-1 rounded-md text-white/60 hover:text-white 
            hover:bg-white/10 transition-colors focus:outline-none 
            focus:ring-2 focus:ring-white/20
          "
          aria-label={`Dismiss ${notification.type} notification`}
          tabIndex={0}
        >
          <X size={16} />
        </button>
      </div>
    </motion.div>
  );
}
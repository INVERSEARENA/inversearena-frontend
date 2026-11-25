export type NotificationType = 'success' | 'error' | 'info' | 'warning';

export interface NotificationConfig {
  message: string;
  type?: NotificationType;
  duration?: number;
  persistent?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface InternalNotification extends NotificationConfig {
  id: string;
  createdAt: number;
  timeoutId?: NodeJS.Timeout;
}

export interface NotificationContextValue {
  notifications: InternalNotification[];
  addNotification: (config: NotificationConfig) => string;
  removeNotification: (id: string) => void;
  clearAllNotifications: () => void;
}
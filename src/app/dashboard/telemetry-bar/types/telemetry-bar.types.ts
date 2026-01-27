/**
 * Type definitions for the Global Telemetry & Control Bar
 * @module telemetry-bar.types
 */

/**
 * System operational status
 * - operational: System is running normally (green)
 * - degraded: System is experiencing issues (amber)
 * - offline: System is not available (red)
 */
export type SystemStatus = 'operational' | 'degraded' | 'offline';

/**
 * Server telemetry data
 */
export interface ServerTelemetry {
  /** Server region identifier (e.g., US-EAST-1, EU-WEST-2, AP-SOUTHEAST-1) */
  region: string;
  
  /** Network latency in milliseconds */
  latency: number;
}

/**
 * Global pool value data
 */
export interface GlobalPoolData {
  /** Numeric value of the pool */
  value: number;
  
  /** Optional currency code (e.g., USD, ADA, BTC) */
  currency?: string;
  
  /** Display symbol for the currency (e.g., $, ₳, ₿) */
  symbol?: string;
}

/**
 * Props for the TelemetryBar component
 */
export interface TelemetryBarProps {
  /** Current system operational status */
  systemStatus: SystemStatus;
  
  /** Server telemetry information */
  serverTelemetry: ServerTelemetry;
  
  /** Global pool value and currency information */
  globalPool: GlobalPoolData;
  
  /** Callback when notification button is clicked */
  onNotificationClick?: () => void;
  
  /** Callback when settings button is clicked */
  onSettingsClick?: () => void;
  
  /** Additional CSS classes to apply to the root element */
  className?: string;
}

/**
 * Complete telemetry data structure (for full state management)
 */
export interface TelemetryData {
  systemStatus: SystemStatus;
  serverTelemetry: ServerTelemetry;
  globalPool: GlobalPoolData;
  timestamp?: Date;
}

/**
 * WebSocket message format for real-time updates
 */
export interface TelemetryWebSocketMessage {
  type: 'telemetry_update';
  data: Partial<TelemetryData>;
}

/**
 * API response format for polling endpoints
 */
export interface TelemetryAPIResponse {
  success: boolean;
  data: TelemetryData;
  timestamp: string;
}

/**
 * Status configuration for visual rendering
 */
export interface StatusConfig {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  dotColor: string;
  bgColor: string;
  borderColor: string;
  glowColor: string;
  label: string;
}

/**
 * Utility type for event handlers
 */
export type TelemetryEventHandler = () => void;

/**
 * Server region options (common regions, extend as needed)
 */
export type ServerRegion =
  | 'US-EAST-1'
  | 'US-EAST-2'
  | 'US-WEST-1'
  | 'US-WEST-2'
  | 'EU-WEST-1'
  | 'EU-WEST-2'
  | 'EU-CENTRAL-1'
  | 'AP-SOUTHEAST-1'
  | 'AP-SOUTHEAST-2'
  | 'AP-NORTHEAST-1'
  | string; // Allow custom regions

/**
 * Currency symbol options
 */
export type CurrencySymbol = '₳' | '$' | '€' | '£' | '¥' | '₿' | string;

/**
 * Latency thresholds for color coding
 */
export interface LatencyThresholds {
  excellent: number; // Below this is green
  moderate: number;  // Below this is amber, above is red
}

/**
 * Default latency thresholds
 */
export const DEFAULT_LATENCY_THRESHOLDS: LatencyThresholds = {
  excellent: 50,
  moderate: 100,
};
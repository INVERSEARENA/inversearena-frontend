/**
 * Database Connection Pool Monitor
 * 
 * Tracks connection pool metrics and alerts on saturation
 */

import { prisma } from '../db/prisma';
import { getDatabaseConfig } from '../config/database';
import {
  dbPoolConnectionsActive,
  dbPoolConnectionsIdle,
  dbPoolAcquireCount,
  dbPoolTimeoutCount,
} from './metrics';

export class PoolMonitor {
  private config = getDatabaseConfig();
  private intervalId?: NodeJS.Timeout;
  private readonly pollIntervalMs: number;

  constructor(pollIntervalMs = 10000) {
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Start monitoring connection pool metrics
   */
  start(): void {
    if (this.intervalId) {
      console.warn('[PoolMonitor] Already running');
      return;
    }

    console.log(`[PoolMonitor] Starting for role: ${this.config.role}`);
    console.log(`[PoolMonitor] Connection limit: ${this.config.connectionLimit}`);
    console.log(`[PoolMonitor] Poll interval: ${this.pollIntervalMs}ms`);

    this.intervalId = setInterval(() => {
      this.collect().catch((err) => {
        console.error('[PoolMonitor] Collection error:', err);
      });
    }, this.pollIntervalMs);

    // Initial collection
    this.collect().catch((err) => {
      console.error('[PoolMonitor] Initial collection error:', err);
    });
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log('[PoolMonitor] Stopped');
    }
  }

  /**
   * Collect pool metrics
   * 
   * Note: Prisma doesn't expose pool metrics directly, so we use
   * a lightweight query to estimate pool state
   */
  private async collect(): Promise<void> {
    try {
      const startTime = Date.now();
      
      // Execute lightweight query to test pool
      await prisma.$queryRaw`SELECT 1`;
      
      const duration = Date.now() - startTime;

      // Record successful acquisition
      dbPoolAcquireCount.inc({ role: this.config.role, status: 'success' });

      // If query took longer than pool timeout threshold, likely pool saturation
      const timeoutThreshold = this.config.poolTimeout * 1000 * 0.8; // 80% of timeout
      if (duration > timeoutThreshold) {
        console.warn(
          `[PoolMonitor] Slow pool acquisition detected: ${duration}ms (threshold: ${timeoutThreshold}ms)`
        );
        dbPoolTimeoutCount.inc({ role: this.config.role });
      }

      // Since Prisma doesn't expose pool metrics, we estimate based on query time
      // Fast queries (<10ms) suggest idle connections available
      // Slow queries (>100ms) suggest pool pressure
      if (duration < 10) {
        dbPoolConnectionsIdle.set({ role: this.config.role }, 
          Math.floor(this.config.connectionLimit * 0.7));
        dbPoolConnectionsActive.set({ role: this.config.role }, 
          Math.floor(this.config.connectionLimit * 0.3));
      } else if (duration > 100) {
        dbPoolConnectionsIdle.set({ role: this.config.role }, 1);
        dbPoolConnectionsActive.set({ role: this.config.role }, 
          this.config.connectionLimit - 1);
      } else {
        // Medium pressure - estimate 50/50
        const half = Math.floor(this.config.connectionLimit / 2);
        dbPoolConnectionsIdle.set({ role: this.config.role }, half);
        dbPoolConnectionsActive.set({ role: this.config.role }, half);
      }
    } catch (error) {
      console.error('[PoolMonitor] Collection failed:', error);
      dbPoolAcquireCount.inc({ role: this.config.role, status: 'error' });
    }
  }

  /**
   * Get current pool configuration
   */
  getConfig() {
    return { ...this.config };
  }
}

// Singleton instance
let monitor: PoolMonitor | null = null;

/**
 * Start global pool monitor
 */
export function startPoolMonitor(pollIntervalMs?: number): PoolMonitor {
  if (!monitor) {
    monitor = new PoolMonitor(pollIntervalMs);
    monitor.start();
  }
  return monitor;
}

/**
 * Stop global pool monitor
 */
export function stopPoolMonitor(): void {
  if (monitor) {
    monitor.stop();
    monitor = null;
  }
}

/**
 * Get global pool monitor instance
 */
export function getPoolMonitor(): PoolMonitor | null {
  return monitor;
}

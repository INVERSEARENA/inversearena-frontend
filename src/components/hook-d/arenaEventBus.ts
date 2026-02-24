/**
 * Arena Event Bus - Lightweight publish/subscribe event system
 * 
 * A framework-agnostic event bus for broadcasting arena domain events
 * across loosely coupled parts of the application.
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Game state enum representing the current phase of the arena
 */
export type GameState = 'JOINING' | 'ACTIVE' | 'RESOLVING' | 'ENDED';

/**
 * Event listener function type
 */
export type EventListener<T> = (payload: T) => void;

/**
 * Unsubscribe function returned by event subscriptions
 */
export type UnsubscribeFn = () => void;

// ============================================================================
// Event Payload Interfaces
// ============================================================================

/**
 * Payload for round:started event
 */
export interface RoundStartedPayload {
  roundNumber: number;
  timestamp: number;
  duration: number;
}

/**
 * Payload for round:ended event
 */
export interface RoundEndedPayload {
  roundNumber: number;
  timestamp: number;
  outcome: 'heads' | 'tails';
}

/**
 * Payload for round:resolved event
 */
export interface RoundResolvedPayload {
  roundNumber: number;
  timestamp: number;
  eliminatedCount: number;
  survivorCount: number;
}

/**
 * Payload for player:eliminated event
 */
export interface PlayerEliminatedPayload {
  playerId: string;
  roundNumber: number;
  timestamp: number;
  choice: 'heads' | 'tails';
}

/**
 * Payload for player:joined event
 */
export interface PlayerJoinedPayload {
  playerId: string;
  timestamp: number;
  stake: number;
}

/**
 * Payload for player:choice event
 */
export interface PlayerChoiceMadePayload {
  playerId: string;
  roundNumber: number;
  choice: 'heads' | 'tails';
  timestamp: number;
}

/**
 * Payload for timer:tick event
 */
export interface TimerTickPayload {
  remainingSeconds: number;
  roundNumber: number;
}

/**
 * Payload for timer:tension event
 */
export interface TimerTensionModePayload {
  remainingSeconds: number;
  roundNumber: number;
}

/**
 * Payload for timer:expired event
 */
export interface TimerExpiredPayload {
  roundNumber: number;
  timestamp: number;
}

/**
 * Payload for pot:changed event
 */
export interface PotChangedPayload {
  newAmount: number;
  previousAmount: number;
  timestamp: number;
}

/**
 * Payload for pot:distributed event
 */
export interface PotDistributedPayload {
  totalAmount: number;
  winnerCount: number;
  amountPerWinner: number;
  timestamp: number;
}

/**
 * Payload for game:stateChanged event
 */
export interface GameStateChangedPayload {
  previousState: GameState;
  newState: GameState;
  timestamp: number;
}

/**
 * Map of all arena events to their payload types
 * This provides type safety for event names and payloads
 */
export interface ArenaEventMap {
  'round:started': RoundStartedPayload;
  'round:ended': RoundEndedPayload;
  'round:resolved': RoundResolvedPayload;
  'player:eliminated': PlayerEliminatedPayload;
  'player:joined': PlayerJoinedPayload;
  'player:choice': PlayerChoiceMadePayload;
  'timer:tick': TimerTickPayload;
  'timer:tension': TimerTensionModePayload;
  'timer:expired': TimerExpiredPayload;
  'pot:changed': PotChangedPayload;
  'pot:distributed': PotDistributedPayload;
  'game:stateChanged': GameStateChangedPayload;
}


// ============================================================================
// EventBus Class
// ============================================================================

/**
 * Generic EventBus class for managing event subscriptions and emissions
 * 
 * @template EventMap - Map of event names to their payload types
 */
class EventBus<EventMap extends Record<string, any>> {
  /**
   * Internal storage for event listeners
   * Maps event names to Sets of listener functions
   */
  private listeners: Map<keyof EventMap, Set<EventListener<any>>>;

  /**
   * Maximum number of listeners per event before warning
   */
  private maxListeners: number;

  /**
   * Flag indicating if we're in development mode
   */
  private isDevelopment: boolean;

  /**
   * Creates a new EventBus instance
   * 
   * @param maxListeners - Maximum listeners per event (default: 20)
   */
  constructor(maxListeners: number = 20) {
    this.listeners = new Map();
    this.maxListeners = maxListeners;
    // Detect development environment
    this.isDevelopment = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
  }

  /**
   * Subscribe to an event
   * 
   * @param event - Event name to subscribe to
   * @param listener - Callback function to invoke when event is emitted
   * @returns Unsubscribe function to remove the listener
   * 
   * @example
   * const unsubscribe = arenaEventBus.on('round:started', (payload) => {
   *   console.log('Round started:', payload.roundNumber);
   * });
   * 
   * // Later, to unsubscribe:
   * unsubscribe();
   */
  on<K extends keyof EventMap>(
    event: K,
    listener: EventListener<EventMap[K]>
  ): UnsubscribeFn {
    // Create event entry if it doesn't exist
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    // Get the listener set for this event
    const eventListeners = this.listeners.get(event)!;

    // Add the listener to the set
    eventListeners.add(listener);

    // Check for potential memory leaks
    this.checkListenerCount(event);

    // Return unsubscribe function
    return () => {
      eventListeners.delete(listener);
      // Clean up empty event entries
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  /**
   * Check if listener count exceeds threshold and warn in development
   * 
   * @param event - Event name to check
   */
  private checkListenerCount(event: keyof EventMap): void {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners) return;

    const listenerCount = eventListeners.size;

    if (this.isDevelopment && listenerCount > this.maxListeners) {
      console.warn(
        `Possible memory leak detected: Event "${String(event)}" has ${listenerCount} listeners ` +
        `(max: ${this.maxListeners}). This may indicate listeners are not being cleaned up properly.`
      );
    }
  }

  /**
   * Emit an event to all registered listeners
   * 
   * @param event - Event name to emit
   * @param payload - Data to pass to all listeners
   * 
   * @example
   * arenaEventBus.emit('round:started', {
   *   roundNumber: 1,
   *   timestamp: Date.now(),
   *   duration: 60
   * });
   */
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const eventListeners = this.listeners.get(event);

    // No listeners registered - silent no-op
    if (!eventListeners || eventListeners.size === 0) {
      return;
    }

    // Invoke all listeners with error handling
    eventListeners.forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        // Log error but continue executing remaining listeners
        console.error(`Error in listener for event "${String(event)}":`, error);
      }
    });
  }

  /**
   * Manually remove a specific listener from an event
   * 
   * @param event - Event name
   * @param listener - Listener function to remove
   * 
   * @example
   * const myListener = (payload) => console.log(payload);
   * arenaEventBus.on('round:started', myListener);
   * 
   * // Later, remove it manually:
   * arenaEventBus.off('round:started', myListener);
   */
  off<K extends keyof EventMap>(
    event: K,
    listener: EventListener<EventMap[K]>
  ): void {
    const eventListeners = this.listeners.get(event);

    // Event or listener doesn't exist - silent no-op
    if (!eventListeners) {
      return;
    }

    // Remove the specific listener
    eventListeners.delete(listener);

    // Clean up empty event entries
    if (eventListeners.size === 0) {
      this.listeners.delete(event);
    }
  }

  /**
   * Remove all listeners for a specific event, or all listeners for all events
   * 
   * @param event - Optional event name. If omitted, clears all events.
   * 
   * @example
   * // Clear all listeners for a specific event:
   * arenaEventBus.clear('round:started');
   * 
   * // Clear all listeners for all events:
   * arenaEventBus.clear();
   */
  clear(event?: keyof EventMap): void {
    if (event !== undefined) {
      // Clear specific event
      this.listeners.delete(event);
    } else {
      // Clear all events
      this.listeners.clear();
    }
  }
}


// ============================================================================
// Singleton Instance
// ============================================================================

/**
 * Singleton instance of the arena event bus
 * 
 * This instance is shared across the entire application, ensuring
 * all components and services communicate through the same event bus.
 * 
 * @example
 * import { arenaEventBus } from './arenaEventBus';
 * 
 * // Subscribe to events
 * const unsubscribe = arenaEventBus.on('round:started', (payload) => {
 *   console.log('Round', payload.roundNumber, 'started!');
 * });
 * 
 * // Emit events
 * arenaEventBus.emit('round:started', {
 *   roundNumber: 1,
 *   timestamp: Date.now(),
 *   duration: 60
 * });
 * 
 * // Clean up
 * unsubscribe();
 */
export const arenaEventBus = new EventBus<ArenaEventMap>(20);


// ============================================================================
// React Hook
// ============================================================================

/**
 * React hook for subscribing to arena events with automatic cleanup
 * 
 * This hook automatically subscribes to an event on mount and unsubscribes
 * on unmount. It also handles updates to the listener function and event name.
 * 
 * @param event - Event name to subscribe to
 * @param listener - Callback function to invoke when event is emitted
 * 
 * @example
 * import { useArenaEvent } from './arenaEventBus';
 * 
 * function MyComponent() {
 *   useArenaEvent('round:started', (payload) => {
 *     console.log('Round started:', payload.roundNumber);
 *   });
 * 
 *   return <div>Listening for round events...</div>;
 * }
 */
export function useArenaEvent<K extends keyof ArenaEventMap>(
  event: K,
  listener: EventListener<ArenaEventMap[K]>
): void {
  // Import React types dynamically to avoid hard dependency
  // This allows the event bus to work in non-React environments
  let useEffect: any;
  let useRef: any;

  try {
    // Try to import React hooks if available
    const React = require('react');
    useEffect = React.useEffect;
    useRef = React.useRef;
  } catch (error) {
    // React not available - this is expected in non-React environments
    throw new Error(
      'useArenaEvent requires React to be installed. ' +
      'Use arenaEventBus.on() directly in non-React environments.'
    );
  }

  // Store listener in ref to maintain stable reference
  const listenerRef = useRef(listener);

  // Update ref when listener changes
  useEffect(() => {
    listenerRef.current = listener;
  }, [listener]);

  // Subscribe to event with stable listener wrapper
  useEffect(() => {
    // Create stable listener that calls the current ref value
    const stableListener = (payload: ArenaEventMap[K]) => {
      listenerRef.current(payload);
    };

    // Subscribe to the event
    const unsubscribe = arenaEventBus.on(event, stableListener);

    // Cleanup on unmount or when event changes
    return unsubscribe;
  }, [event]);
}

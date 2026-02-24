/**
 * Basic tests for Arena Event Bus
 */

import { arenaEventBus } from './arenaEventBus';

describe('Arena Event Bus', () => {
  beforeEach(() => {
    // Clear all listeners before each test
    arenaEventBus.clear();
  });

  describe('on() and emit()', () => {
    it('should register listener and receive emitted events', () => {
      const mockListener = jest.fn();
      const payload = {
        roundNumber: 1,
        timestamp: Date.now(),
        duration: 60,
      };

      arenaEventBus.on('round:started', mockListener);
      arenaEventBus.emit('round:started', payload);

      expect(mockListener).toHaveBeenCalledTimes(1);
      expect(mockListener).toHaveBeenCalledWith(payload);
    });

    it('should return unsubscribe function that removes listener', () => {
      const mockListener = jest.fn();
      const payload = {
        roundNumber: 1,
        timestamp: Date.now(),
        duration: 60,
      };

      const unsubscribe = arenaEventBus.on('round:started', mockListener);
      unsubscribe();
      arenaEventBus.emit('round:started', payload);

      expect(mockListener).not.toHaveBeenCalled();
    });

    it('should invoke multiple listeners in order', () => {
      const callOrder: number[] = [];
      const listener1 = () => callOrder.push(1);
      const listener2 = () => callOrder.push(2);
      const listener3 = () => callOrder.push(3);

      arenaEventBus.on('round:started', listener1);
      arenaEventBus.on('round:started', listener2);
      arenaEventBus.on('round:started', listener3);

      arenaEventBus.emit('round:started', {
        roundNumber: 1,
        timestamp: Date.now(),
        duration: 60,
      });

      expect(callOrder).toEqual([1, 2, 3]);
    });

    it('should handle emit with no listeners', () => {
      expect(() => {
        arenaEventBus.emit('round:started', {
          roundNumber: 1,
          timestamp: Date.now(),
          duration: 60,
        });
      }).not.toThrow();
    });

    it('should continue invoking listeners if one throws error', () => {
      const mockListener1 = jest.fn();
      const errorListener = jest.fn(() => {
        throw new Error('Test error');
      });
      const mockListener2 = jest.fn();

      arenaEventBus.on('round:started', mockListener1);
      arenaEventBus.on('round:started', errorListener);
      arenaEventBus.on('round:started', mockListener2);

      const payload = {
        roundNumber: 1,
        timestamp: Date.now(),
        duration: 60,
      };

      // Should not throw
      expect(() => {
        arenaEventBus.emit('round:started', payload);
      }).not.toThrow();

      // All listeners should have been called
      expect(mockListener1).toHaveBeenCalledWith(payload);
      expect(errorListener).toHaveBeenCalledWith(payload);
      expect(mockListener2).toHaveBeenCalledWith(payload);
    });
  });

  describe('off()', () => {
    it('should remove specific listener', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      arenaEventBus.on('round:started', listener1);
      arenaEventBus.on('round:started', listener2);

      arenaEventBus.off('round:started', listener1);

      arenaEventBus.emit('round:started', {
        roundNumber: 1,
        timestamp: Date.now(),
        duration: 60,
      });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('should handle removing non-existent listener', () => {
      const listener = jest.fn();

      expect(() => {
        arenaEventBus.off('round:started', listener);
      }).not.toThrow();
    });
  });

  describe('clear()', () => {
    it('should clear all listeners for specific event', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      arenaEventBus.on('round:started', listener1);
      arenaEventBus.on('player:joined', listener2);

      arenaEventBus.clear('round:started');

      arenaEventBus.emit('round:started', {
        roundNumber: 1,
        timestamp: Date.now(),
        duration: 60,
      });

      arenaEventBus.emit('player:joined', {
        playerId: 'player1',
        timestamp: Date.now(),
        stake: 100,
      });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('should clear all listeners for all events', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      arenaEventBus.on('round:started', listener1);
      arenaEventBus.on('player:joined', listener2);

      arenaEventBus.clear();

      arenaEventBus.emit('round:started', {
        roundNumber: 1,
        timestamp: Date.now(),
        duration: 60,
      });

      arenaEventBus.emit('player:joined', {
        playerId: 'player1',
        timestamp: Date.now(),
        stake: 100,
      });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });
  });

  describe('Singleton behavior', () => {
    it('should maintain state across imports', () => {
      const listener = jest.fn();

      // Simulate different module importing the same instance
      arenaEventBus.on('round:started', listener);

      // Emit from "another module"
      arenaEventBus.emit('round:started', {
        roundNumber: 1,
        timestamp: Date.now(),
        duration: 60,
      });

      expect(listener).toHaveBeenCalled();
    });
  });
});

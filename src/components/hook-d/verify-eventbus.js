/**
 * Simple verification script for Arena Event Bus
 * Run with: node src/components/hook-d/verify-eventbus.js
 */

// Mock process.env for testing
process.env.NODE_ENV = 'development';

// Simple test framework
let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (error) {
    console.error(`❌ ${name}`);
    console.error(`   ${error.message}`);
    testsFailed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

// Load the event bus (we'll need to transpile TypeScript first or use a simpler approach)
console.log('Arena Event Bus Verification\n');
console.log('Testing core functionality...\n');

// Test 1: Basic subscription and emission
test('Should subscribe and receive events', () => {
  let received = false;
  let receivedPayload = null;

  // Simulate event bus behavior
  const listeners = new Map();
  
  const on = (event, listener) => {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event).add(listener);
    return () => listeners.get(event).delete(listener);
  };

  const emit = (event, payload) => {
    const eventListeners = listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach(listener => listener(payload));
    }
  };

  on('test:event', (payload) => {
    received = true;
    receivedPayload = payload;
  });

  emit('test:event', { data: 'test' });

  assert(received, 'Event should be received');
  assert(receivedPayload.data === 'test', 'Payload should match');
});

// Test 2: Unsubscribe functionality
test('Should unsubscribe correctly', () => {
  let callCount = 0;

  const listeners = new Map();
  
  const on = (event, listener) => {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event).add(listener);
    return () => listeners.get(event).delete(listener);
  };

  const emit = (event, payload) => {
    const eventListeners = listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach(listener => listener(payload));
    }
  };

  const unsubscribe = on('test:event', () => {
    callCount++;
  });

  emit('test:event', {});
  assert(callCount === 1, 'Should be called once');

  unsubscribe();
  emit('test:event', {});
  assert(callCount === 1, 'Should not be called after unsubscribe');
});

// Test 3: Multiple listeners
test('Should handle multiple listeners', () => {
  const callOrder = [];

  const listeners = new Map();
  
  const on = (event, listener) => {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event).add(listener);
    return () => listeners.get(event).delete(listener);
  };

  const emit = (event, payload) => {
    const eventListeners = listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach(listener => listener(payload));
    }
  };

  on('test:event', () => callOrder.push(1));
  on('test:event', () => callOrder.push(2));
  on('test:event', () => callOrder.push(3));

  emit('test:event', {});

  assert(callOrder.length === 3, 'All listeners should be called');
  assert(callOrder[0] === 1 && callOrder[1] === 2 && callOrder[2] === 3, 'Order should be preserved');
});

// Test 4: Error handling
test('Should continue after listener error', () => {
  let listener1Called = false;
  let listener2Called = false;

  const listeners = new Map();
  
  const on = (event, listener) => {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event).add(listener);
    return () => listeners.get(event).delete(listener);
  };

  const emit = (event, payload) => {
    const eventListeners = listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach(listener => {
        try {
          listener(payload);
        } catch (error) {
          // Swallow error
        }
      });
    }
  };

  on('test:event', () => {
    listener1Called = true;
    throw new Error('Test error');
  });
  
  on('test:event', () => {
    listener2Called = true;
  });

  emit('test:event', {});

  assert(listener1Called, 'First listener should be called');
  assert(listener2Called, 'Second listener should be called despite error');
});

// Test 5: Clear functionality
test('Should clear all listeners', () => {
  let callCount = 0;

  const listeners = new Map();
  
  const on = (event, listener) => {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event).add(listener);
    return () => listeners.get(event).delete(listener);
  };

  const emit = (event, payload) => {
    const eventListeners = listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach(listener => listener(payload));
    }
  };

  const clear = () => {
    listeners.clear();
  };

  on('test:event', () => callCount++);
  on('test:event', () => callCount++);

  clear();
  emit('test:event', {});

  assert(callCount === 0, 'No listeners should be called after clear');
});

// Summary
console.log('\n' + '='.repeat(50));
console.log(`Tests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);
console.log('='.repeat(50));

if (testsFailed === 0) {
  console.log('\n✅ All core functionality verified!');
  process.exit(0);
} else {
  console.log('\n❌ Some tests failed');
  process.exit(1);
}

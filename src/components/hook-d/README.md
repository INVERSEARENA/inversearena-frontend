# Arena Event Bus

A lightweight, framework-agnostic publish/subscribe event bus for broadcasting arena domain events across loosely coupled parts of the application.

## Features

- ✅ **Type-safe**: Full TypeScript support with typed events and payloads
- ✅ **Framework-agnostic**: Works in any JavaScript environment (React, Node.js, etc.)
- ✅ **Memory-safe**: Built-in leak detection warns when listener count exceeds threshold
- ✅ **Error-resilient**: Listener errors don't prevent other listeners from executing
- ✅ **React integration**: Convenient `useArenaEvent` hook with automatic cleanup
- ✅ **Singleton pattern**: Single shared instance across the entire application

## Installation

The event bus is located at `src/components/hook-d/arenaEventBus.ts` and can be imported directly:

```typescript
import { arenaEventBus, useArenaEvent } from '@/components/hook-d/arenaEventBus';
```

## Basic Usage

### Subscribing to Events

```typescript
import { arenaEventBus } from '@/components/hook-d/arenaEventBus';

// Subscribe to an event
const unsubscribe = arenaEventBus.on('round:started', (payload) => {
  console.log('Round', payload.roundNumber, 'started!');
  console.log('Duration:', payload.duration, 'seconds');
});

// Later, unsubscribe
unsubscribe();
```

### Emitting Events

```typescript
import { arenaEventBus } from '@/components/hook-d/arenaEventBus';

// Emit an event with typed payload
arenaEventBus.emit('round:started', {
  roundNumber: 1,
  timestamp: Date.now(),
  duration: 60
});
```

### Manual Cleanup

```typescript
// Remove a specific listener
const myListener = (payload) => console.log(payload);
arenaEventBus.on('round:started', myListener);
arenaEventBus.off('round:started', myListener);

// Clear all listeners for an event
arenaEventBus.clear('round:started');

// Clear all listeners for all events
arenaEventBus.clear();
```

## React Integration

### Using the Hook

```typescript
import { useArenaEvent } from '@/components/hook-d/arenaEventBus';

function MyComponent() {
  useArenaEvent('round:started', (payload) => {
    console.log('Round started:', payload.roundNumber);
    // Update component state, trigger animations, etc.
  });

  return <div>Listening for round events...</div>;
}
```

The hook automatically:
- Subscribes on component mount
- Unsubscribes on component unmount
- Updates subscription when event name changes
- Handles listener function updates correctly

## Available Events

### Round Lifecycle Events

- `round:started` - A new round has begun
- `round:ended` - A round has concluded
- `round:resolved` - Round results have been processed

### Player Events

- `player:eliminated` - A player has been eliminated
- `player:joined` - A new player has joined the arena
- `player:choice` - A player has made their choice (heads/tails)

### Timer Events

- `timer:tick` - Timer countdown update
- `timer:tension` - Timer entered tension mode (< 30 seconds)
- `timer:expired` - Timer has reached zero

### Pot Events

- `pot:changed` - Prize pot amount has changed
- `pot:distributed` - Prize pot has been distributed to winners

### Game State Events

- `game:stateChanged` - Game state transition (JOINING → ACTIVE → RESOLVING → ENDED)

## Event Payloads

Each event has a strongly-typed payload. See `ArenaEventMap` interface in the source code for complete payload definitions.

Example payloads:

```typescript
// round:started
{
  roundNumber: number;
  timestamp: number;
  duration: number;
}

// player:eliminated
{
  playerId: string;
  roundNumber: number;
  timestamp: number;
  choice: 'heads' | 'tails';
}

// timer:tick
{
  remainingSeconds: number;
  roundNumber: number;
}
```

## Advanced Usage

### Multiple Listeners

```typescript
// Multiple listeners can subscribe to the same event
arenaEventBus.on('round:started', listener1);
arenaEventBus.on('round:started', listener2);
arenaEventBus.on('round:started', listener3);

// All listeners will be invoked in registration order
arenaEventBus.emit('round:started', payload);
```

### Error Handling

```typescript
// If a listener throws an error, other listeners still execute
arenaEventBus.on('round:started', () => {
  throw new Error('Oops!'); // Error is logged, but doesn't stop execution
});

arenaEventBus.on('round:started', () => {
  console.log('This still runs!'); // ✅ Still executes
});
```

### Memory Leak Detection

The event bus warns in development mode when a single event exceeds 20 listeners:

```
⚠️ Possible memory leak detected: Event "round:started" has 21 listeners 
(max: 20). This may indicate listeners are not being cleaned up properly.
```

This helps catch bugs where components forget to unsubscribe.

## Use Cases

### Coordinating UI Updates

```typescript
// Timer component emits tick events
arenaEventBus.emit('timer:tick', {
  remainingSeconds: 45,
  roundNumber: 3
});

// Multiple components react independently
// - Header shows countdown
// - Progress bar updates
// - Sound effects trigger at certain thresholds
```

### Decoupling Game Logic

```typescript
// Game service emits elimination event
arenaEventBus.emit('player:eliminated', {
  playerId: 'user123',
  roundNumber: 2,
  timestamp: Date.now(),
  choice: 'heads'
});

// Various parts of the app react:
// - UI removes player from list
// - Analytics tracks elimination
// - Sound effect plays
// - Toast notification appears
```

### Cross-Component Communication

```typescript
// Component A triggers an action
function ComponentA() {
  const handleAction = () => {
    arenaEventBus.emit('pot:changed', {
      newAmount: 1000,
      previousAmount: 800,
      timestamp: Date.now()
    });
  };
  
  return <button onClick={handleAction}>Update Pot</button>;
}

// Component B reacts (no direct connection needed)
function ComponentB() {
  useArenaEvent('pot:changed', (payload) => {
    console.log('Pot updated:', payload.newAmount);
  });
  
  return <div>Pot Display</div>;
}
```

## Best Practices

1. **Always clean up subscriptions** - Use the returned unsubscribe function or `useArenaEvent` hook
2. **Use TypeScript** - Leverage type safety to catch errors at compile time
3. **Keep payloads simple** - Don't include large objects or sensitive data
4. **Emit from services, not components** - Keep business logic separate from UI
5. **Use descriptive event names** - Follow the `category:action` naming pattern
6. **Don't overuse** - Event bus is for cross-cutting concerns, not all communication

## Testing

The event bus can be easily tested by subscribing to events and verifying emissions:

```typescript
import { arenaEventBus } from '@/components/hook-d/arenaEventBus';

describe('My Feature', () => {
  beforeEach(() => {
    arenaEventBus.clear(); // Clean slate for each test
  });

  it('should emit round started event', () => {
    const listener = jest.fn();
    arenaEventBus.on('round:started', listener);

    // Trigger your feature
    myFeature.startRound();

    // Verify event was emitted
    expect(listener).toHaveBeenCalledWith({
      roundNumber: 1,
      timestamp: expect.any(Number),
      duration: 60
    });
  });
});
```

## Performance

- **O(1)** subscription and unsubscription
- **O(N)** emission (scales with listener count)
- Uses `Set` internally to prevent duplicate listeners
- Synchronous execution maintains predictable order

## Browser Support

Works in all modern browsers and Node.js environments that support:
- ES6 Map and Set
- TypeScript (for type checking)

## License

Part of the Inverse Arena project.

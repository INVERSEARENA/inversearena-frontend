import { renderHook } from '@testing-library/react';
import { usePageVisibility } from '../usePageVisibility';

describe('usePageVisibility', () => {
  let originalDocument: typeof document | undefined;

  beforeEach(() => {
    originalDocument = global.document;
  });

  afterEach(() => {
    Object.defineProperty(global, 'document', {
      value: originalDocument,
      writable: true,
      configurable: true,
    });
  });

  it('returns true when document is visible', () => {
    // Ensure document exists and is not hidden
    Object.defineProperty(global, 'document', {
      value: {
        ...global.document,
        hidden: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => usePageVisibility());
    expect(result.current).toBe(true);
  });

  it('returns false when document is hidden', () => {
    Object.defineProperty(global, 'document', {
      value: {
        ...global.document,
        hidden: true,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => usePageVisibility());
    expect(result.current).toBe(false);
  });

  it('returns true when document is undefined (SSR environment)', () => {
    // Simulate SSR environment where document is undefined
    Object.defineProperty(global, 'document', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => usePageVisibility());
    expect(result.current).toBe(true);
  });

  it('does not crash when document is undefined during useEffect (SSR safety)', () => {
    Object.defineProperty(global, 'document', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    expect(() => {
      renderHook(() => usePageVisibility());
    }).not.toThrow();
  });

  it('attaches visibilitychange listener when document exists', () => {
    const addEventListenerMock = jest.fn();
    const removeEventListenerMock = jest.fn();

    Object.defineProperty(global, 'document', {
      value: {
        ...global.document,
        hidden: false,
        addEventListener: addEventListenerMock,
        removeEventListener: removeEventListenerMock,
      },
      writable: true,
      configurable: true,
    });

    const { unmount } = renderHook(() => usePageVisibility());

    expect(addEventListenerMock).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    );

    unmount();

    expect(removeEventListenerMock).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    );
  });

  it('does not attach listener when document is undefined', () => {
    const addEventListenerMock = jest.fn();

    Object.defineProperty(global, 'document', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    renderHook(() => usePageVisibility());

    expect(addEventListenerMock).not.toHaveBeenCalled();
  });
});

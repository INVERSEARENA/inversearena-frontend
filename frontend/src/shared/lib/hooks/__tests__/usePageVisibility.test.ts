import { renderHook } from '@testing-library/react';
import { usePageVisibility } from '../usePageVisibility';

// jest-environment-jsdom exposes `document` as a non-configurable accessor
// on the global object, so it cannot be reassigned via
// `Object.defineProperty(global, 'document', ...)` (throws "Cannot redefine
// property: document"). Spying on the existing document's members instead
// works within jsdom's real document. SSR (document === undefined) behavior
// is covered separately in usePageVisibility.ssr.test.ts, which runs under
// the node test environment where `document` genuinely does not exist.
describe('usePageVisibility', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns true when document is visible', () => {
    jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);

    const { result } = renderHook(() => usePageVisibility());
    expect(result.current).toBe(true);
  });

  it('returns false when document is hidden', () => {
    jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    const { result } = renderHook(() => usePageVisibility());
    expect(result.current).toBe(false);
  });

  it('attaches visibilitychange listener when document exists', () => {
    const addEventListenerSpy = jest.spyOn(document, 'addEventListener');
    const removeEventListenerSpy = jest.spyOn(document, 'removeEventListener');

    const { unmount } = renderHook(() => usePageVisibility());

    expect(addEventListenerSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    );

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    );
  });
});

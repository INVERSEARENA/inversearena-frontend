/**
 * @jest-environment node
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { usePageVisibility } from '../usePageVisibility';

// Runs under the node test environment, where `document` is genuinely
// undefined — unlike jsdom, where it is a non-configurable global accessor
// that cannot be reassigned (see usePageVisibility.test.ts). React effects
// never run during server rendering, so this only exercises the hook's
// initial (SSR) render path, which is exactly the path that must not throw
// or reference `document` when it doesn't exist.
describe('usePageVisibility (SSR)', () => {
  it('document is not defined in this environment', () => {
    expect(typeof document).toBe('undefined');
  });

  function Probe({ onResult }: { onResult: (value: boolean) => void }) {
    onResult(usePageVisibility());
    return null;
  }

  it('returns true when document is undefined', () => {
    let value: boolean | undefined;
    renderToStaticMarkup(<Probe onResult={(v) => (value = v)} />);
    expect(value).toBe(true);
  });

  it('does not crash when rendered with document undefined', () => {
    expect(() => {
      renderToStaticMarkup(<Probe onResult={() => {}} />);
    }).not.toThrow();
  });
});

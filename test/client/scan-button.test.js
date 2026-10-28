// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { mountScanButton } from '../../src/ui/scan-button.js';

function setup(claimLink = vi.fn(async () => ({ label: 'Tablet' }))) {
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  let scannerOptions;
  const options = {
    client: { claimLink },
    onLinked: vi.fn(),
    onError: vi.fn(),
    scanner: { text: { hint: 'Aim at the code' } },
    openScanner: vi.fn((o) => (scannerOptions = o)),
  };
  const button = mountScanButton(container, options);
  return { container, button, options, claimLink, scanned: () => scannerOptions };
}

describe('mountScanButton', () => {
  it('adds a labelled button that opens the scanner with the app’s options', () => {
    const { container, button, options, scanned } = setup();
    expect(container.contains(button)).toBe(true);
    expect(button.textContent).toBe('Scan to link a device');
    button.click();
    expect(options.openScanner).toHaveBeenCalledOnce();
    expect(scanned().text).toEqual({ hint: 'Aim at the code' });
  });

  it('claims the scanned code without asking, then reports who was linked', async () => {
    const { button, options, claimLink, scanned } = setup();
    button.click();
    scanned().onToken('tok');
    expect(claimLink).toHaveBeenCalledWith('tok');
    await vi.waitFor(() => expect(options.onLinked).toHaveBeenCalledWith({ label: 'Tablet' }));
  });

  it('reports the server’s message when the claim fails', async () => {
    const failure = Object.assign(new Error('This join code has expired.'), { status: 410 });
    const { button, options, scanned } = setup(vi.fn(async () => Promise.reject(failure)));
    button.click();
    scanned().onToken('tok');
    await vi.waitFor(() =>
      expect(options.onError).toHaveBeenCalledWith('This join code has expired.'),
    );
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { mountScanButton } from '../../src/ui/scan-button.js';

function setup(
  claimLink = vi.fn(async () => ({ label: 'Tablet' })),
  peekLink = vi.fn(async () => ({ label: 'Tablet', outcomes: ['new-member'] })),
) {
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  let scannerOptions;
  const options = {
    client: { claimLink, peekLink },
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

  it('opens the claim dialog on a scan and reports who was linked after confirm', async () => {
    const { button, options, claimLink, scanned } = setup();
    button.click();
    scanned().onToken('tok');
    await vi.waitFor(() => expect(document.querySelector('button[data-role=confirm]')).not.toBeNull());
    expect(claimLink).not.toHaveBeenCalled();
    document.querySelector('button[data-role=confirm]').click();
    await vi.waitFor(() => expect(options.onLinked).toHaveBeenCalledWith({ label: 'Tablet' }));
    expect(claimLink).toHaveBeenCalledWith('tok', { outcome: 'new-member' });
    expect(document.querySelector('button[data-role=confirm]')).toBeNull();
  });

  it('reports the server’s message when the preview is refused', async () => {
    const failure = Object.assign(new Error('This join code has expired.'), { status: 410 });
    const { button, options, scanned } = setup(
      undefined,
      vi.fn(async () => Promise.reject(failure)),
    );
    button.click();
    scanned().onToken('tok');
    await vi.waitFor(() => expect(options.onError).toHaveBeenCalledWith('This join code has expired.'));
  });
});

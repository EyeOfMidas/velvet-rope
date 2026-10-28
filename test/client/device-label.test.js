// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { labelFromUserAgent } from '../../src/client/device-label.js';

const UA = {
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  firefoxIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
};

describe('labelFromUserAgent', () => {
  it.each([
    ['firefoxWindows', 'Firefox on Windows'],
    ['firefoxAndroid', 'Firefox on Android'],
    ['chromeAndroid', 'Chrome on Android'],
    ['edgeWindows', 'Edge on Windows'],
    ['safariIphone', 'Safari on iPhone'],
    ['safariMac', 'Safari on Mac'],
    ['chromeLinux', 'Chrome on Linux'],
    ['firefoxIphone', 'Firefox on iPhone'],
  ])('names %s as "%s"', (key, label) => {
    expect(labelFromUserAgent(UA[key])).toBe(label);
  });

  it('falls back to a generic label for an unknown user agent', () => {
    expect(labelFromUserAgent('curl/8.0')).toBe('This device');
    expect(labelFromUserAgent('')).toBe('This device');
  });
});

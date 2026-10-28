// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';
import { linkUrl, parseLinkUrl } from '../../src/client/link-url.js';
import { decodeFrame } from '../../src/client/decode.js';

const ORIGIN = 'https://notes.example.com';
const TOKEN = 'Q3J5cHRvZ3JhcGhpY2FsbHktcmFuZG9tLXRva2VuLTEyMzQ';

describe('linkUrl', () => {
  it('puts the token in the fragment of /link', () => {
    expect(linkUrl(ORIGIN, TOKEN)).toBe(`${ORIGIN}/link#${TOKEN}`);
  });
});

describe('parseLinkUrl', () => {
  it('returns the token from a join link on this origin', () => {
    expect(parseLinkUrl(`${ORIGIN}/link#${TOKEN}`, ORIGIN)).toBe(TOKEN);
  });

  it('ignores whitespace around the scanned text', () => {
    expect(parseLinkUrl(`  ${ORIGIN}/link#${TOKEN}\n`, ORIGIN)).toBe(TOKEN);
  });

  it('rejects a link to another origin', () => {
    expect(parseLinkUrl(`https://evil.example/link#${TOKEN}`, ORIGIN)).toBeNull();
    expect(parseLinkUrl(`http://notes.example.com/link#${TOKEN}`, ORIGIN)).toBeNull();
  });

  it('rejects other paths', () => {
    expect(parseLinkUrl(`${ORIGIN}/files/link#${TOKEN}`, ORIGIN)).toBeNull();
    expect(parseLinkUrl(`${ORIGIN}/link/#${TOKEN}`, ORIGIN)).toBeNull();
    expect(parseLinkUrl(`${ORIGIN}/link?x=1#${TOKEN}`, ORIGIN)).toBeNull();
  });

  it('rejects a missing or garbage fragment', () => {
    expect(parseLinkUrl(`${ORIGIN}/link`, ORIGIN)).toBeNull();
    expect(parseLinkUrl(`${ORIGIN}/link#`, ORIGIN)).toBeNull();
    expect(parseLinkUrl(`${ORIGIN}/link#abc`, ORIGIN)).toBeNull();
    expect(parseLinkUrl(`${ORIGIN}/link#${TOKEN}<script>`, ORIGIN)).toBeNull();
  });

  it('rejects text that is not a URL', () => {
    expect(parseLinkUrl('hello world', ORIGIN)).toBeNull();
    expect(parseLinkUrl('', ORIGIN)).toBeNull();
    expect(parseLinkUrl(null, ORIGIN)).toBeNull();
  });
});

// Rasterizes a QR code to RGBA pixels, like a camera frame drawn to a canvas: black modules on
// white, `scale` pixels per module, with a 4-module quiet zone.
function qrImageData(text, scale = 4) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const quiet = 4;
  const width = (modules.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const row = Math.floor(y / scale) - quiet;
      const col = Math.floor(x / scale) - quiet;
      const inside = row >= 0 && col >= 0 && row < modules.size && col < modules.size;
      if (inside && modules.get(row, col)) {
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return { data, width, height: width };
}

describe('decodeFrame', () => {
  it('reads the link out of a frame showing the join QR code', () => {
    const frame = qrImageData(linkUrl(ORIGIN, TOKEN));
    expect(parseLinkUrl(decodeFrame(frame), ORIGIN)).toBe(TOKEN);
  });

  it('returns null for a frame with no QR code', () => {
    const blank = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
    expect(decodeFrame(blank)).toBeNull();
  });
});

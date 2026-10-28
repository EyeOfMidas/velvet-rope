// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openScanner } from '../../src/ui/scanner.js';

const ORIGIN = 'https://app.test';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

function fakeTrack({ torch = false } = {}) {
  return {
    stop: vi.fn(),
    getCapabilities: () => (torch ? { torch: true } : {}),
    applyConstraints: vi.fn(async () => {}),
  };
}

function fakeCamera(track = fakeTrack()) {
  // A real MediaStream, because <video>.srcObject accepts nothing else, with fake tracks.
  const stream = Object.assign(new MediaStream(), {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  });
  return { track, stream, mediaDevices: { getUserMedia: vi.fn(async () => stream) } };
}

function setup({ camera = fakeCamera(), frames = [] } = {}) {
  const onToken = vi.fn();
  const onClose = vi.fn();
  const queue = [...frames];
  const scanner = openScanner({
    origin: ORIGIN,
    onToken,
    onClose,
    mediaDevices: camera.mediaDevices,
    grabFrame: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    decode: () => (queue.length ? queue.shift() : null),
  });
  return { ...camera, scanner, onToken, onClose };
}

const dialog = () => document.querySelector('[role=dialog]');
const button = (name) => [...document.querySelectorAll('button')].find((b) => b.textContent === name && !b.hidden);

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('in-app scanner', () => {
  it('opens the back camera in a labelled dialog with Cancel', async () => {
    const { mediaDevices } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'environment' },
      audio: false,
    });
    expect(dialog().getAttribute('aria-label')).toBe('Scan a join QR code');
    expect(dialog().querySelector('video').srcObject).toBeTruthy();
    expect(button('Cancel')).toBeTruthy();
  });

  it('stops the camera and closes on Cancel', async () => {
    const { track, onClose, onToken } = setup();
    await vi.advanceTimersByTimeAsync(0);
    button('Cancel').click();
    expect(track.stop).toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(onClose).toHaveBeenCalled();
    expect(onToken).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const { track } = setup();
    await vi.advanceTimersByTimeAsync(0);
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(track.stop).toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('hands over the token and stops the camera as soon as it sees a join code', async () => {
    const { track, onToken } = setup({ frames: [null, null, `${ORIGIN}/link#${TOKEN}`] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith(TOKEN);
    expect(track.stop).toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('says so and keeps scanning when a QR code is not a join code', async () => {
    const { onToken, track } = setup({
      frames: ['https://example.com/', `${ORIGIN}/link#${TOKEN}`],
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(dialog().textContent).toContain('That QR code isn’t a join code for this site.');
    expect(track.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onToken).toHaveBeenCalledWith(TOKEN);
  });

  it('offers a torch toggle only where the camera supports it', async () => {
    setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(button('Torch on')).toBeUndefined();
    document.body.replaceChildren();

    const { track } = setup({ camera: fakeCamera(fakeTrack({ torch: true })) });
    await vi.advanceTimersByTimeAsync(0);
    button('Torch on').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
    expect(button('Torch off').getAttribute('aria-pressed')).toBe('true');
  });

  it('explains when the camera can’t be opened', async () => {
    const camera = fakeCamera();
    camera.mediaDevices.getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    });
    setup({ camera });
    await vi.advanceTimersByTimeAsync(0);
    expect(dialog().querySelector('[role=alert]').textContent).toBe(
      'Camera access was blocked. Allow the camera for this site, or open the link with your camera app.',
    );
    expect(button('Cancel')).toBeTruthy();
  });

  it('stops a camera that arrives after the scanner was closed', async () => {
    let resolve;
    const camera = fakeCamera();
    camera.mediaDevices.getUserMedia = vi.fn(() => new Promise((r) => (resolve = r)));
    const { scanner } = setup({ camera });
    scanner.close();
    resolve(camera.stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(camera.track.stop).toHaveBeenCalled();
  });
});

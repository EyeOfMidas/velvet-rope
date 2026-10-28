// The camera half of the QR scanner, with no UI: back camera → <video> → canvas frames → jsQR.
// The app supplies the <video>; the first QR text seen goes to onText, which returns true to
// stop scanning (it was a join link) or false to keep looking.
import { decodeFrame } from './decode.js';

const SCAN_EVERY_MS = 200;
const MAX_FRAME_WIDTH = 640; // jsQR is plenty accurate at this size and much cheaper on phones.

/** Draws the current video frame to a canvas and returns its pixels, or null before the first frame. */
export function grabVideoFrame(video, canvas = document.createElement('canvas')) {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** 'blocked' (permission), 'no-camera', or 'failed'. */
export function cameraErrorCode(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'blocked';
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return 'no-camera';
  return 'failed';
}

/**
 * Starts the camera into `video` and scans it. onError(code) if the camera can't start;
 * onTorch(track) when the camera has a torch the app may offer. Returns stop(), which also
 * releases the camera.
 */
export function startScanner({
  video,
  onText,
  onError = () => {},
  onTorch = () => {},
  mediaDevices = navigator.mediaDevices,
  grabFrame = grabVideoFrame,
  decode = decodeFrame,
}) {
  let stream = null;
  let timer = null;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
  }

  function scan() {
    if (stopped) return;
    const frame = grabFrame(video);
    const text = frame && decode(frame);
    if (text && onText(text)) return stop();
    timer = setTimeout(scan, SCAN_EVERY_MS);
  }

  async function start() {
    try {
      if (!mediaDevices?.getUserMedia) throw new Error('No camera API');
      const media = await mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      if (stopped) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = media;
      video.srcObject = media;
      video.play?.()?.catch?.(() => {});
      const track = media.getVideoTracks()[0];
      if (track?.getCapabilities?.().torch) onTorch(track);
      scan();
    } catch (e) {
      if (!stopped) onError(cameraErrorCode(e));
    }
  }

  start();
  return stop;
}

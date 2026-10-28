// Decodes one camera frame (RGBA pixels, as from canvas getImageData) with jsQR.
import jsQR from 'jsqr';

/** The QR code's text, or null when the frame has none. */
export function decodeFrame({ data, width, height }) {
  const code = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
  return code?.data || null;
}

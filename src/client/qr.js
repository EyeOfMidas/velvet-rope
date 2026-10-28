// The join QR as SVG: black on white with a quiet zone, whatever the page theme.
import QRCode from 'qrcode';

/** The QR code for `text` as an SVG string. */
export const renderQrSvg = (text) =>
  QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 4,
    color: { dark: '#000000', light: '#ffffff' },
  });

/**
 * The QR code as an <svg> element, ready to insert. Inline rather than an <img> with a data:
 * URL, which a CSP of `img-src 'self'` blocks. The SVG is qrcode's own output, not user content.
 */
export async function renderQr(text, { label = 'QR code to join', render = renderQrSvg } = {}) {
  const template = document.createElement('template');
  template.innerHTML = await render(text);
  const svg = template.content.firstElementChild;
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  return svg;
}

// The join QR carries `<origin>/link#<token>`. The token sits in the fragment so it never reaches
// server logs. `path` is where the app answers join links; '/link' unless the app says otherwise.
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export const linkUrl = (origin, token, path = '/link') => `${origin}${path}#${token}`;

/** The token from a scanned or pasted join link on `origin`, or null for anything else. */
export function parseLinkUrl(text, origin, path = '/link') {
  if (typeof text !== 'string') return null;
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname !== path || url.search) return null;
  const token = url.hash.slice(1);
  return TOKEN.test(token) ? token : null;
}

/**
 * A join link opened from the camera app or pasted into the address bar: returns its token and
 * takes it out of the address bar at once (the page carries on at `/`). Null on any other page.
 */
export function takeLinkFromLocation(win = window, path = '/link') {
  if (win.location.pathname !== path) return null;
  const token = parseLinkUrl(win.location.href, win.location.origin, path);
  win.history.replaceState(null, '', '/');
  return token;
}

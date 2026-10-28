// CSRF: on top of SameSite=Strict, every mutating request must be JSON and carry the app's CSRF
// header set to 1 (e.g. `X-Velvet-Rope: 1`). A cross-site form can't set either without a CORS
// preflight the app never allows. The plugin installs this for the whole app.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** An onRequest hook that refuses mutating requests without JSON and `header: 1`. */
export function csrfGuard({ csrfHeader, refuse }) {
  const header = csrfHeader.toLowerCase();
  return async function requireCsrfHeaders(request, reply) {
    if (SAFE_METHODS.has(request.method)) return;
    const type = request.headers['content-type'] ?? '';
    if (!type.toLowerCase().startsWith('application/json') || request.headers[header] !== '1') {
      return refuse(reply, 403, 'csrf');
    }
  };
}

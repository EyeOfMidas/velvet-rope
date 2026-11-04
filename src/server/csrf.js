// CSRF: on top of SameSite=Strict, every mutating request must carry the app's CSRF header set to 1
// (e.g. `X-Velvet-Rope: 1`), and a request that has a body must make it JSON. A cross-site form
// can't set either without a CORS preflight the app never allows. A body-less request needs only
// the header: JSON adds nothing there, because the custom header alone already forces the
// preflight. The plugin installs this for the whole app.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hasBody(headers) {
  return headers['transfer-encoding'] !== undefined || Number(headers['content-length'] ?? 0) > 0;
}

/** An onRequest hook that refuses mutating requests without `header: 1`, or with a non-JSON body. */
export function csrfGuard({ csrfHeader, refuse }) {
  const header = csrfHeader.toLowerCase();
  return async function requireCsrfHeaders(request, reply) {
    if (SAFE_METHODS.has(request.method)) return;
    const type = (request.headers['content-type'] ?? '').toLowerCase();
    const jsonOk = !hasBody(request.headers) || type.startsWith('application/json');
    if (!jsonOk || request.headers[header] !== '1') {
      return refuse(reply, 403, 'csrf');
    }
  };
}

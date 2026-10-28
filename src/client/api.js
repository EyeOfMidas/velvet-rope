// Thin fetch wrappers for apps that don't bring their own. Mutating requests send JSON plus the
// CSRF header the server plugin requires; GETs need neither. Failures throw VelvetRopeError with
// the server's { error: code, message }.
export class VelvetRopeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'VelvetRopeError';
    this.status = status;
    this.code = code;
  }
}

async function handle(res, path) {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new VelvetRopeError(res.status, body?.error ?? null, body?.message ?? body?.error ?? `${res.status} ${path}`);
  }
  return body;
}

/** Returns { getJson, postJson, patchJson, deleteJson }. */
export function createApi({ csrfHeader = 'X-Velvet-Rope', fetch = globalThis.fetch } = {}) {
  const send = async (method, path, body) =>
    handle(
      await fetch(path, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          [csrfHeader]: '1',
        },
        body: JSON.stringify(body),
      }),
      path,
    );
  return {
    getJson: async (path) => handle(await fetch(path, { headers: { Accept: 'application/json' } }), path),
    postJson: (path, body) => send('POST', path, body),
    patchJson: (path, body) => send('PATCH', path, body),
    deleteJson: (path, body = {}) => send('DELETE', path, body),
  };
}

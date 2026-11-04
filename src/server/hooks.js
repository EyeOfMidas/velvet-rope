// How an app's hooks take part in a change. A hook runs inside the route's database transaction
// and vetoes the change by throwing a Refusal: the transaction rolls back and the client gets
// { error: code, message }. Any other error also rolls back, but the client only hears a generic
// 500, because an error's text can hold internals (or a WebAuthn challenge).

export class Refusal extends Error {
  /** `message` is optional; without it the reply uses the app's wording for `code`. */
  constructor(status, code, message) {
    super(message);
    this.name = 'Refusal';
    this.status = status;
    this.code = code;
  }
}

export function createHookTools({ db, hooks, messages }) {
  /**
   * Calls the app's hook `name` with (db, ...args). Call it inside a `transact` callback. A SQLite
   * transaction is synchronous, so a hook that returns a promise would do its work after the
   * commit; that is refused (and so rolled back) instead of half-committing.
   */
  function runHook(name, ...args) {
    const result = hooks[name](db, ...args);
    if (typeof result?.then === 'function') {
      result.then(undefined, () => {}); // already refused; don't also leave an unhandled rejection
      throw new Error(`velvet-rope: hook ${name} returned a promise; hooks must be synchronous`);
    }
    return result;
  }

  /** Replies with a Refusal's status, code and message, or a plain 500 for any other error. */
  function replyToError(request, reply, error) {
    if (error instanceof Refusal) {
      const message = error.message || messages[error.code] || error.code;
      reply.code(error.status).send({ error: error.code, message });
    } else {
      // The way Fastify logs a 500 itself; the client never sees the text.
      request.log.error({ req: request, res: reply, err: error }, error.message);
      reply.code(500).send({ error: 'server_error', message: messages.server_error });
    }
  }

  /** Runs `fn` in a transaction. Returns { value }, or null after replying with the refusal or error. */
  function transact(request, reply, fn) {
    try {
      return { value: db.transaction(fn)() };
    } catch (error) {
      replyToError(request, reply, error);
      return null;
    }
  }

  /** Like transact, for work outside a transaction that may be async (an app hook that vets input). */
  async function attempt(request, reply, fn) {
    try {
      return { value: await fn() };
    } catch (error) {
      replyToError(request, reply, error);
      return null;
    }
  }

  return { runHook, transact, attempt };
}

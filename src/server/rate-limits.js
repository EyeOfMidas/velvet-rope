// Rate limits with @fastify/rate-limit's in-memory store. Each limit group is one shared counter
// across its routes. By default a group counts per client IP (behind a proxy, set Fastify's
// trustProxy so that's the real client); `keys` can count a group by something else, e.g. per
// velvet-rope group for writes, as long as that hook runs after the session is resolved.
//
// velvet-rope's routes use three groups: groupCreation, ceremony and linkRequest. An app may add
// its own groups to the same limiter.
import rateLimit from '@fastify/rate-limit';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const DEFAULT_RATE_LIMITS = Object.freeze({
  // POST /groups/options: every new group starts here.
  groupCreation: { max: 5, timeWindow: HOUR },
  // Passkey ceremonies: sign-in options and verify, group and link registration verify.
  ceremony: { max: 30, timeWindow: MINUTE },
  // Join requests and claims.
  linkRequest: { max: 30, timeWindow: HOUR },
});

const noLimit = async () => {};

class TooManyRequests extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Registers the plugin and returns `limiter(group)`, an onRequest hook for that group (memoized,
 * so routes in different plugins share a counter). `limits`: groups to enforce; a group that's
 * missing, or `limits` null, isn't limited. `keys`: { group: (request) => key } overrides.
 * Pass the limiter to velvet-rope as its `rateLimit` option.
 */
export function createRateLimiter(app, limits, { keys = {} } = {}) {
  if (limits) {
    app.register(rateLimit, {
      global: false,
      errorResponseBuilder: (request, context) =>
        new TooManyRequests(context.statusCode, `Too many requests. Try again in ${context.after}.`),
    });
    // The same { error, message } shape as every other refusal.
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof TooManyRequests) {
        return reply.code(error.statusCode).send({ error: 'too_many_requests', message: error.message });
      }
      return reply.send(error);
    });
  }
  const hooks = new Map();
  return (group) => {
    const options = limits?.[group];
    if (!options) return noLimit;
    if (!hooks.has(group)) {
      const keyGenerator = keys[group];
      hooks.set(group, app.rateLimit(keyGenerator ? { ...options, keyGenerator } : options));
    }
    return hooks.get(group);
  };
}

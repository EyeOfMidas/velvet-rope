// The Fastify plugin. One register() call adds the auth, group, link and member routes under
// `prefix`, a CSRF guard for the whole app, and the guards the app's own routes use:
//
//   app.requireSession            onRequest/preHandler hook: 401 without a live session
//   app.requireCapability('x')    the same, plus 403 when the session's role can't do 'x'
//   request.session               { token, passkey: { id, label, role }, group: { id, name } }
//   request.can('x')              whether the session's role can do 'x'
//   app.velvetRope                { roles, events, resolveSession(request) }
//
// It isn't encapsulated (like fastify-plugin), so the decorators and the CSRF hook reach every
// route in the app.
import { csrfGuard } from './csrf.js';
import { resolveOptions } from './options.js';
import authRoutes from './routes/auth.js';
import eventRoutes from './routes/events.js';
import currentGroupRoutes from './routes/group.js';
import groupRoutes from './routes/groups.js';
import linkRequestRoutes from './routes/link-requests.js';
import meRoutes from './routes/me.js';
import memberRoutes from './routes/members.js';

const ROUTES = [groupRoutes, currentGroupRoutes, authRoutes, meRoutes, memberRoutes, linkRequestRoutes, eventRoutes];

export default async function velvetRope(app, options) {
  const ctx = resolveOptions(options);
  const { now, roles, sessions, refuse } = ctx;

  app.addHook('onRequest', csrfGuard(ctx));

  app.decorateRequest('session', null);
  app.decorateRequest('can', function can(capability) {
    return Boolean(this.session) && roles.can(this.session.passkey.role, capability);
  });

  async function requireSession(request, reply) {
    request.session ??= sessions.resolve(request, now());
    if (!request.session) return refuse(reply, 401, 'not_signed_in');
  }
  app.decorate('requireSession', requireSession);
  app.decorate('requireCapability', (capability) => async (request, reply) => {
    request.session ??= sessions.resolve(request, now());
    if (!request.session) return refuse(reply, 401, 'not_signed_in');
    if (!roles.can(request.session.passkey.role, capability)) {
      return refuse(reply, 403, 'forbidden');
    }
  });
  app.decorate('velvetRope', {
    roles,
    events: ctx.events,
    resolveSession: (request) => sessions.resolve(request, now()),
  });

  // ctx carries `prefix`, so Fastify mounts each route module under it.
  for (const routes of ROUTES) app.register(routes, ctx);
}

// Same as wrapping with fastify-plugin: don't encapsulate, so decorators reach the app.
velvetRope[Symbol.for('skip-override')] = true;
velvetRope[Symbol.for('fastify.display-name')] = 'velvet-rope';

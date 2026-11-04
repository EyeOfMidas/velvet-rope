// GET /events: a Server-Sent Events stream of the session's group. velvet-rope publishes
// members-changed, member-ended, role-changed, session-revoked and group-deleted here; the app publishes its own
// events on the same hub (app.velvetRope.events). Event data is never logged.
import { eventStreams } from '../stream.js';

export default async function eventRoutes(app, { events, heartbeatMs }) {
  const stream = eventStreams(app, heartbeatMs);

  app.get('/events', { onRequest: app.requireSession }, async (request, reply) => {
    const { session } = request;
    // Tagged with the device so session-revoked / role-changed reach only its own streams.
    stream(request, reply, (send, end) =>
      events.subscribe(session.group.id, send, { deviceId: session.device.id, end }),
    );
  });
}

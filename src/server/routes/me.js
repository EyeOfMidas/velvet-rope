// GET /me: who this session is. Also slides the cookie's Max-Age with the session.
export default async function meRoutes(app, { sessions }) {
  app.get('/me', { onRequest: app.requireSession }, async (request, reply) => {
    const { session } = request;
    sessions.setCookie(reply, session.token, session.device.kind);
    const { member, device, group, passkey } = session;
    return { member, device, group, passkey };
  });
}

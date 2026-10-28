// Server-Sent Events plumbing shared by the event routes (group events, link-request status).
// Event data is never logged.
export const HEARTBEAT_MS = 25_000;

/**
 * Returns stream(request, reply, subscribe) for one route plugin. `subscribe(send, end)` must
 * return an unsubscribe function; `end()` closes the stream from the server side. Open streams
 * are ended on app.close().
 */
export function eventStreams(app, heartbeatMs = HEARTBEAT_MS) {
  const open = new Set();
  // Long-lived streams would otherwise keep app.close() waiting.
  app.addHook('preClose', async () => {
    for (const end of open) end();
  });

  return function stream(request, reply, subscribe) {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let unsubscribe = () => {};
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs);
    const end = () => {
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(end);
      if (!res.writableEnded) res.end();
    };
    unsubscribe = subscribe(send, end);
    open.add(end);
    request.raw.on('close', end);
    res.on('error', end);
    res.write(': connected\n\n');
    return send;
  };
}

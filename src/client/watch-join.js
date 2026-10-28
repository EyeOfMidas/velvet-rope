// Watches this device's join request until someone scans it: Server-Sent Events first, polling
// as the fallback. onStatus gets { status, expiresAt, groupName? }; status is pending, claimed,
// completed or expired. Returns stop().
export const POLL_EVERY_MS = 2000;

const parse = (event) => {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
};

export function watchJoin({
  client,
  onStatus,
  EventSource = globalThis.EventSource,
  pollEveryMs = POLL_EVERY_MS,
}) {
  let source = null;
  let timer = null;
  let stopped = false;

  const report = (data) => {
    if (!stopped && data) onStatus(data);
  };

  async function poll() {
    try {
      report(await client.joinStatus());
    } catch (e) {
      // 404: the request was pruned, which only happens once it expired.
      if (e?.status === 404) report({ status: 'expired' });
    }
    if (!stopped) timer = setTimeout(poll, pollEveryMs);
  }

  if (EventSource) {
    source = new EventSource(client.joinEventsUrl);
    source.addEventListener('status', (event) => report(parse(event)));
    // EventSource would retry on its own; polling is simpler to reason about after a failure.
    source.addEventListener('error', () => {
      source?.close();
      source = null;
      if (!stopped) timer = setTimeout(poll, pollEveryMs);
    });
  } else {
    poll();
  }

  return function stop() {
    stopped = true;
    source?.close();
    source = null;
    clearTimeout(timer);
  };
}

// In-process pub/sub for Server-Sent Events. Subscribers are kept per group,
// so an event can only reach connections signed in to the group it was published for.
// A subscriber may also name its passkey, so events meant for one device (session-revoked,
// role-changed) reach only that passkey's connections, and disconnect() can end them.
export function createHub() {
  const byGroup = new Map();
  const byPasskey = new Map();

  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    const set = map.get(key);
    set.add(value);
    return () => {
      set.delete(value);
      if (set.size === 0 && map.get(key) === set) map.delete(key);
    };
  };

  const deliver = (subscribers, event, data) => {
    for (const { send } of subscribers ?? []) {
      try {
        send(event, data);
      } catch {
        // One broken connection mustn't stop the others.
      }
    }
  };

  return {
    /** `passkeyId` targets publishTo/disconnect; `end` closes the connection on disconnect. */
    subscribe(groupId, send, { passkeyId, end } = {}) {
      const subscriber = { send, end };
      const removeFromGroup = add(byGroup, groupId, subscriber);
      const removeFromPasskey = passkeyId ? add(byPasskey, passkeyId, subscriber) : () => {};
      return () => {
        removeFromGroup();
        removeFromPasskey();
      };
    },
    publish(groupId, event, data) {
      deliver(byGroup.get(groupId), event, data);
    },
    publishTo(passkeyId, event, data) {
      deliver(byPasskey.get(passkeyId), event, data);
    },
    /** Ends every connection of the passkey (each end() is expected to unsubscribe). */
    disconnect(passkeyId) {
      for (const { end } of [...(byPasskey.get(passkeyId) ?? [])]) {
        try {
          end?.();
        } catch {
          // Keep ending the rest.
        }
      }
    },
    subscriberCount(groupId) {
      return byGroup.get(groupId)?.size ?? 0;
    },
  };
}

// In-process pub/sub for Server-Sent Events. Subscribers are kept per group,
// so an event can only reach connections signed in to the group it was published for.
// A subscriber may also name its device, so events meant for one device (session-revoked,
// role-changed) reach only that device's connections, and disconnect() can end them.
// An app with its own stream passes its own hub as `events` (with eventsRoute: false). It needs:
//   subscribe(groupId, send(event, data), { deviceId, end }) -> unsubscribe function
//   publish(groupId, event, data)      to every connection of the group
//   publishTo(deviceId, event, data)   to every connection of one device
//   disconnect(deviceId)               ends that device's connections
export function createHub() {
  const byGroup = new Map();
  const byDevice = new Map();

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
    /** `deviceId` targets publishTo/disconnect; `end` closes the connection on disconnect. */
    subscribe(groupId, send, { deviceId, end } = {}) {
      const subscriber = { send, end };
      const removeFromGroup = add(byGroup, groupId, subscriber);
      const removeFromDevice = deviceId ? add(byDevice, deviceId, subscriber) : () => {};
      return () => {
        removeFromGroup();
        removeFromDevice();
      };
    },
    publish(groupId, event, data) {
      deliver(byGroup.get(groupId), event, data);
    },
    publishTo(deviceId, event, data) {
      deliver(byDevice.get(deviceId), event, data);
    },
    /** Ends every connection of the device (each end() is expected to unsubscribe). */
    disconnect(deviceId) {
      for (const { end } of [...(byDevice.get(deviceId) ?? [])]) {
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

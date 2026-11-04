// The headless client: one function per thing a person does, over the plugin's routes. Bring
// your own transport ({ getJson, postJson, patchJson, deleteJson }, e.g. the app's existing fetch
// wrappers) or let it make one with createApi().
import {
  startAuthentication as browserStartAuthentication,
  startRegistration as browserStartRegistration,
} from '@simplewebauthn/browser';
import { createApi } from './api.js';

export function createClient({
  prefix = '/api',
  csrfHeader,
  getJson,
  postJson,
  patchJson,
  deleteJson,
  startRegistration = browserStartRegistration,
  startAuthentication = browserStartAuthentication,
} = {}) {
  // Any transport function the app doesn't pass comes from createApi().
  const fallback = createApi({ csrfHeader });
  const api = {
    getJson: getJson ?? fallback.getJson,
    postJson: postJson ?? fallback.postJson,
    patchJson: patchJson ?? fallback.patchJson,
    deleteJson: deleteJson ?? fallback.deleteJson,
  };
  const url = (path) => `${prefix}${path}`;
  const member = (id) => url(`/members/${encodeURIComponent(id)}`);
  const device = (id) => url(`/devices/${encodeURIComponent(id)}`);

  return {
    /** Where the group's event stream is, for an EventSource. */
    eventsUrl: url('/events'),
    /** Where the new device's join status stream is. */
    joinEventsUrl: url('/link-requests/current/events'),

    /** { member, device, group } for this session, or null when signed out. */
    async getMe() {
      try {
        return await api.getJson(url('/me'));
      } catch (error) {
        if (error?.status === 401) return null;
        throw error;
      }
    },

    /** Discoverable sign-in: the passkey the person picks decides the group. */
    async signIn() {
      const optionsJSON = await api.postJson(url('/auth/options'), {});
      const response = await startAuthentication({ optionsJSON });
      try {
        return await api.postJson(url('/auth'), { response });
      } catch (error) {
        // The browser can drop a passkey the server no longer knows; best effort, never changes the error.
        if (error?.code === 'removed') {
          try {
            await globalThis.PublicKeyCredential?.signalUnknownCredential?.({
              rpId: optionsJSON?.rpId ?? globalThis.location?.hostname,
              credentialId: response.id,
            });
          } catch {
            // ignored
          }
        }
        throw error;
      }
    },

    /** Resolves { forgotDevice }: true when a device key was removed, so this device needs a new scan. */
    signOut: async () => ({ forgotDevice: !!(await api.postJson(url('/auth/sign-out'), {}))?.forgotDevice }),

    /** Creates a group with this device's passkey as its first admin. */
    async createGroup({ groupName, label, invite }) {
      const optionsJSON = await api.postJson(url('/groups/options'), {
        groupName,
        label,
        ...(invite ? { invite } : {}),
      });
      const response = await startRegistration({ optionsJSON });
      return api.postJson(url('/groups'), { response });
    },

    /** Creates a group from a device that can't make a passkey, signing in with a device key. Same result as createGroup. */
    createGroupWithKey: ({ groupName, label, name, profile, invite }) =>
      api.postJson(url('/groups/key'), {
        groupName,
        label,
        ...(name ? { name } : {}),
        ...(profile ? { profile } : {}),
        ...(invite ? { invite } : {}),
      }),

    // Joining, the new device's side: request → (someone scans) → completeJoin.
    /** Takes a label, or { label, name?, profile? }. Resolves { id, token, expiresAt }; the token goes in the QR (see linkUrl). */
    requestJoin: (join) => api.postJson(url('/link-requests'), typeof join === 'string' ? { label: join } : join),
    /** { status, expiresAt, groupName? } of this device's request. */
    joinStatus: () => api.getJson(url('/link-requests/current')),
    /** Keeps this device's join code alive; resolves { expiresAt }. */
    renewJoin: () => api.postJson(url('/link-requests/current/renew'), {}),
    /** After the request is claimed: creates this device's passkey and signs in. */
    async completeJoin() {
      const optionsJSON = await api.postJson(url('/link-requests/current/options'), {});
      const response = await startRegistration({ optionsJSON });
      return api.postJson(url('/link-requests/current/complete'), { response });
    },
    /** After the request is claimed, on a device that can't make a passkey: joins with a device key (a long-lived cookie). Resolves like completeJoin. */
    completeJoinWithKey: () => api.postJson(url('/link-requests/current/complete-key'), {}),
    /** On a device-key device: adds a passkey to this same device (no scan). Resolves the session, now with kind passkey. */
    async upgradeToPasskey() {
      const optionsJSON = await api.postJson(url('/devices/current/passkey/options'), {});
      const response = await startRegistration({ optionsJSON });
      return api.postJson(url('/devices/current/passkey'), { response });
    },
    /** Previews a scanned code: { label, name, profile, expiresAt, outcomes } (what this member may choose). */
    peekLink: (token) => api.postJson(url('/link-requests/peek'), { token }),

    /**
     * The scanning device's side: the scan is the approval. `options`: { outcome, memberId?,
     * signOut? }, where outcome is 'new-member', 'own-device' or 'member' (then memberId is
     * the member to relink) and signOut is 'none' (the default), 'scanner' or 'others'.
     * Returns { label }.
     */
    claimLink: (token, { outcome, memberId, signOut } = {}) =>
      api.postJson(url('/link-requests/claim'), { token, outcome, memberId, signOut }),

    // Members of the signed-in group, each with their live devices.
    listMembers: () => api.getJson(url('/members')),
    /** `changes`: { name?, role? }. `label` still works as a deprecated alias of `name`. */
    updateMember: (id, changes) => api.patchJson(member(id), changes),
    removeMember: (id) => api.deleteJson(member(id)),
    /** Renames a device: your own, or anyone's with manageMembers. */
    updateDevice: (id, changes) => api.patchJson(device(id), changes),
    /** Revokes one device (a lost phone); its member stays. */
    removeDevice: (id) => api.deleteJson(device(id)),
    leaveGroup: () => api.postJson(url('/members/leave'), {}),
    /** `name` must be the group's name, typed by the person as a confirmation. */
    deleteGroup: (name) => api.deleteJson(url('/group'), { name }),
  };
}

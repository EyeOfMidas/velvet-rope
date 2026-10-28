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

  return {
    /** Where the group's event stream is, for an EventSource. */
    eventsUrl: url('/events'),
    /** Where the new device's join status stream is. */
    joinEventsUrl: url('/link-requests/current/events'),

    /** { passkey, group } for this session, or null when signed out. */
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
      return api.postJson(url('/auth'), { response });
    },

    signOut: () => api.postJson(url('/auth/sign-out'), {}),

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

    // Joining, the new device's side: request → (someone scans) → completeJoin.
    /** { id, token, expiresAt }; the token goes in the QR (see linkUrl). */
    requestJoin: (label) => api.postJson(url('/link-requests'), { label }),
    /** { status, expiresAt, groupName? } of this device's request. */
    joinStatus: () => api.getJson(url('/link-requests/current')),
    /** After the request is claimed: creates this device's passkey and signs in. */
    async completeJoin() {
      const optionsJSON = await api.postJson(url('/link-requests/current/options'), {});
      const response = await startRegistration({ optionsJSON });
      return api.postJson(url('/link-requests/current/complete'), { response });
    },

    /** The scanning device's side: the scan is the approval. Returns { label }. */
    claimLink: (token) => api.postJson(url('/link-requests/claim'), { token }),

    // Members of the signed-in group.
    listMembers: () => api.getJson(url('/members')),
    /** `changes`: { label?, role? }. */
    updateMember: (id, changes) => api.patchJson(member(id), changes),
    removeMember: (id) => api.deleteJson(member(id)),
    leaveGroup: () => api.postJson(url('/members/leave'), {}),
    /** `name` must be the group's name, typed by the person as a confirmation. */
    deleteGroup: (name) => api.deleteJson(url('/group'), { name }),
  };
}

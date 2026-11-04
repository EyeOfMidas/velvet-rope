// The example's page: sign in, create or join a group, and a shared list of notes where what you
// can do depends on your role. Plain DOM; everything velvet-rope does comes from its client and ui.
import {
  connectSessionEvents,
  createClient,
  labelFromUserAgent,
  takeLinkFromLocation,
} from '../../src/client/index.js';
import { JOIN_TEXT, mountJoin, mountScanButton } from '../../src/ui/index.js';
import '../../src/ui/style.css';
import { canEditNote, roles } from '../roles.js';

// The example says "device" because a device can hold a passkey or, with KEYS=1, a device key.
const JOIN_OVERRIDES = { labelField: 'Name this device' };

const root = document.querySelector('#app');
const client = createClient({ csrfHeader: 'X-Notes' });
const api = (method, path, body) =>
  fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Notes': '1' },
    // The CSRF guard wants JSON on every write, DELETE included, so writes always carry a body.
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  }).then(async (res) => {
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
    return data;
  });

function createElement(tag, { dataset = {}, ...props } = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  Object.assign(el.dataset, dataset);
  el.append(...children);
  return el;
}

const button = (text, onClick) => {
  const b = createElement('button', { type: 'button' }, text);
  b.addEventListener('click', onClick);
  return b;
};

// A join link opened from the phone's camera app: claimed once someone here is signed in.
let pendingToken = takeLinkFromLocation();
let events = null;

function showWelcome(message = '') {
  events?.close();
  const error = createElement('p', { className: 'error' });
  const showErrors = (fn) => async () => {
    error.textContent = '';
    try {
      await fn();
    } catch (e) {
      error.textContent = e.message;
    }
  };
  root.replaceChildren(
    message ? createElement('p', {}, message) : '',
    pendingToken ? createElement('p', {}, 'Sign in first, then the other device will be linked.') : '',
    createElement(
      'div',
      { className: 'row' },
      button(
        'Sign in',
        showErrors(async () => showHome(await client.signIn())),
      ),
      button('Create a group', showCreateGroup),
      button('Join a group', () =>
        mountJoin(root, {
          client,
          askName: true,
          draftKey: 'example-join',
          text: { ...JOIN_TEXT, ...JOIN_OVERRIDES },
          onJoined: showHome,
          onCancel: () => showWelcome(),
        }),
      ),
    ),
    error,
  );
}

function showCreateGroup() {
  const name = createElement('input', { id: 'group-name', required: true });
  const label = createElement('input', {
    id: 'label',
    required: true,
    value: labelFromUserAgent(navigator.userAgent),
  });
  const error = createElement('p', { className: 'error' });
  // Offered only after the passkey fails; the server refuses unless it runs with KEYS=1.
  const keyOption = createElement('div', { className: 'row' });
  const form = createElement(
    'form',
    {},
    createElement('p', {}, createElement('label', { htmlFor: 'group-name' }, 'Group name '), name),
    createElement('p', {}, createElement('label', { htmlFor: 'label' }, 'Name this device '), label),
    createElement(
      'div',
      { className: 'row' },
      createElement('button', { type: 'submit' }, 'Create passkey'),
      button('Back', () => showWelcome()),
    ),
    error,
    keyOption,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      showHome(await client.createGroup({ groupName: name.value, label: label.value }));
    } catch (e) {
      error.textContent = e.message;
      keyOption.replaceChildren(
        button('Use a device key instead', async () => {
          try {
            showHome(await client.createGroupWithKey({ groupName: name.value, label: label.value }));
          } catch (err) {
            error.textContent = err.message;
          }
        }),
      );
    }
  });
  root.replaceChildren(createElement('h2', {}, 'Create a group'), form);
  name.focus();
}

async function showHome(me) {
  const status = createElement('p', { role: 'status' });
  const notes = createElement('ul', { ariaLabel: 'Notes' });
  const members = createElement('section');
  const toolbar = createElement('div', { className: 'row' });
  const setStatus = (text) => (status.textContent = text);

  async function refresh() {
    const list = await api('GET', '/api/notes');
    notes.replaceChildren(...list.map((note) => noteItem(note)));
    members.replaceChildren(...(await memberList()));
  }

  function noteItem(note) {
    const li = createElement(
      'li',
      {},
      createElement('span', {}, note.text),
      ' ',
      createElement('span', { className: 'muted' }, `— ${note.author ?? 'gone'}`),
    );
    const actions = createElement('div', { className: 'row' });
    // Hiding a control only spares people a button that wouldn't work; the server decides.
    if (canEditNote(me, note)) {
      actions.append(
        button('Edit', () => {
          const input = createElement('input', { value: note.text, ariaLabel: 'Note text' });
          const save = button('Save', async () => {
            await api('PUT', `/api/notes/${note.id}`, { text: input.value }).catch((e) => setStatus(e.message));
            refresh();
          });
          li.replaceChildren(input, save);
          input.focus();
        }),
      );
    }
    if (roles.can(me.member.role, 'delete')) {
      actions.append(
        button('Delete', () => api('DELETE', `/api/notes/${note.id}`).then(refresh, (e) => setStatus(e.message))),
      );
    }
    li.append(actions);
    return li;
  }

  async function memberList() {
    const list = await client.listMembers();
    return [
      createElement('h2', {}, 'Members'),
      createElement(
        'ul',
        {},
        ...list.map((member) => {
          const isAdmin = roles.can(me.member.role, 'manageMembers');
          const head = createElement('div', { className: 'row' }, createElement('span', {}, member.name));
          if (isAdmin) {
            const select = createElement('select', { ariaLabel: `Role for ${member.name}` });
            select.append(
              ...roles.names.map((role) =>
                createElement('option', { value: role, selected: role === member.role }, role),
              ),
            );
            select.addEventListener('change', () =>
              client.updateMember(member.id, { role: select.value }).then(refresh, (e) => setStatus(e.message)),
            );
            head.append(select);
          } else {
            head.append(createElement('span', { className: 'muted' }, member.role));
          }
          const devices = createElement(
            'ul',
            { ariaLabel: `Devices of ${member.name}` },
            ...member.devices.map((device) => {
              const row = createElement(
                'li',
                { className: 'row' },
                createElement('span', {}, device.label),
                createElement('span', { className: 'muted' }, device.kind === 'key' ? 'device key' : 'passkey'),
                device.current ? createElement('strong', {}, 'this device') : '',
              );
              // Anyone may remove their own devices, an admin anyone's; the server decides.
              if (member.current || isAdmin) {
                row.append(
                  button('Remove', () => client.removeDevice(device.id).then(refresh, (e) => setStatus(e.message))),
                );
              }
              return row;
            }),
          );
          return createElement('li', {}, head, devices);
        }),
      ),
    ];
  }

  function render() {
    const { member, group } = me;
    const onKey = me.device?.kind === 'key';
    toolbar.replaceChildren(
      button('Sign out', async () => {
        // A device key is the cookie itself, so signing out forgets this device (it needs a new scan).
        if (
          onKey &&
          !confirm('Signing out removes this device from the group. You will need a new scan to get back in.')
        ) {
          return;
        }
        await client.signOut();
        showWelcome();
      }),
    );
    if (onKey) {
      toolbar.append(
        button('Add a passkey to this device', async () => {
          try {
            Object.assign(me, await client.upgradeToPasskey());
            render();
            setStatus('This device now has a passkey.');
          } catch (e) {
            setStatus(e.message);
          }
        }),
      );
    }
    if (roles.can(member.role, 'link')) {
      mountScanButton(toolbar, {
        client,
        onLinked: ({ label }) => setStatus(`Linked ${label}. They start as a viewer.`),
        onError: setStatus,
      });
    }
    const add = createElement('form', { className: 'row' });
    if (roles.can(member.role, 'write')) {
      const text = createElement('input', { ariaLabel: 'New note', placeholder: 'New note' });
      add.append(text, createElement('button', { type: 'submit' }, 'Add'));
      add.addEventListener('submit', async (event) => {
        event.preventDefault();
        await api('POST', '/api/notes', { text: text.value }).then(
          () => (text.value = ''),
          (e) => setStatus(e.message),
        );
        refresh();
      });
    }
    root.replaceChildren(
      createElement('p', { dataset: { testid: 'signed-in' } }, `${member.name} in ${group.name} · ${member.role}`),
      toolbar,
      status,
      createElement('h2', {}, 'Notes'),
      add,
      notes,
      members,
    );
    refresh();
  }

  events?.close();
  events = new EventSource(client.eventsUrl);
  events.addEventListener('notes-changed', () => refresh());
  connectSessionEvents(events, {
    onMembersChanged: () => refresh(),
    onMemberEnded: () => refresh(),
    onRoleChanged: (role) => {
      me.member.role = role;
      render();
    },
    onRevoked: () => showWelcome('This device was removed from the group.'),
    onGroupDeleted: ({ name }) => showWelcome(`${name} was deleted.`),
  });
  render();

  if (pendingToken) {
    const token = pendingToken;
    pendingToken = null;
    client.claimLink(token, { outcome: 'new-member' }).then(
      ({ label }) => setStatus(`Linked ${label}.`),
      (e) => setStatus(e.message),
    );
  }
}

const me = await client.getMe();
if (me) showHome(me);
else showWelcome();

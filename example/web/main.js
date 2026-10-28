// The example's page: sign in, create or join a group, and a shared list of notes where what you
// can do depends on your role. Plain DOM; everything velvet-rope does comes from its client and ui.
import {
  connectSessionEvents,
  createClient,
  labelFromUserAgent,
  takeLinkFromLocation,
} from '../../src/client/index.js';
import { mountJoin, mountScanButton } from '../../src/ui/index.js';
import '../../src/ui/style.css';
import { canEditNote, roles } from '../roles.js';

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

function welcome(message = '') {
  events?.close();
  const error = createElement('p', { className: 'error' });
  const run = (fn) => async () => {
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
        run(async () => home(await client.signIn())),
      ),
      button('Create a group', createForm),
      button('Join a group', () => mountJoin(root, { client, onJoined: home, onCancel: () => welcome() })),
    ),
    error,
  );
}

function createForm() {
  const name = createElement('input', { id: 'group-name', required: true });
  const label = createElement('input', {
    id: 'label',
    required: true,
    value: labelFromUserAgent(navigator.userAgent),
  });
  const error = createElement('p', { className: 'error' });
  const form = createElement(
    'form',
    {},
    createElement('p', {}, createElement('label', { htmlFor: 'group-name' }, 'Group name '), name),
    createElement('p', {}, createElement('label', { htmlFor: 'label' }, 'Name this passkey '), label),
    createElement(
      'div',
      { className: 'row' },
      createElement('button', { type: 'submit' }, 'Create passkey'),
      button('Back', () => welcome()),
    ),
    error,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      home(await client.createGroup({ groupName: name.value, label: label.value }));
    } catch (e) {
      error.textContent = e.message;
    }
  });
  root.replaceChildren(createElement('h2', {}, 'Create a group'), form);
  name.focus();
}

async function home(me) {
  const status = createElement('p', { role: 'status' });
  const notes = createElement('ul', { ariaLabel: 'Notes' });
  const members = createElement('section');
  const toolbar = createElement('div', { className: 'row' });
  const say = (text) => (status.textContent = text);

  async function refresh() {
    const list = await api('GET', '/api/notes');
    notes.replaceChildren(...list.map((note) => noteItem(note)));
    if (roles.can(me.passkey.role, 'manageMembers')) members.replaceChildren(...(await memberList()));
    else members.replaceChildren();
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
            await api('PUT', `/api/notes/${note.id}`, { text: input.value }).catch((e) => say(e.message));
            refresh();
          });
          li.replaceChildren(input, save);
          input.focus();
        }),
      );
    }
    if (roles.can(me.passkey.role, 'delete')) {
      actions.append(
        button('Delete', () => api('DELETE', `/api/notes/${note.id}`).then(refresh, (e) => say(e.message))),
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
          const select = createElement('select', { ariaLabel: `Role for ${member.label}` });
          select.append(
            ...roles.names.map((role) =>
              createElement('option', { value: role, selected: role === member.role }, role),
            ),
          );
          select.addEventListener('change', () =>
            client.updateMember(member.id, { role: select.value }).then(refresh, (e) => say(e.message)),
          );
          return createElement('li', { className: 'row' }, createElement('span', {}, member.label), select);
        }),
      ),
    ];
  }

  function render() {
    const { passkey, group } = me;
    toolbar.replaceChildren(button('Sign out', async () => (await client.signOut(), welcome())));
    if (roles.can(passkey.role, 'link')) {
      mountScanButton(toolbar, {
        client,
        onLinked: ({ label }) => say(`Linked ${label}. They start as a viewer.`),
        onError: say,
      });
    }
    const add = createElement('form', { className: 'row' });
    if (roles.can(passkey.role, 'write')) {
      const text = createElement('input', { ariaLabel: 'New note', placeholder: 'New note' });
      add.append(text, createElement('button', { type: 'submit' }, 'Add'));
      add.addEventListener('submit', async (event) => {
        event.preventDefault();
        await api('POST', '/api/notes', { text: text.value }).then(
          () => (text.value = ''),
          (e) => say(e.message),
        );
        refresh();
      });
    }
    root.replaceChildren(
      createElement('p', { dataset: { testid: 'signed-in' } }, `${passkey.label} in ${group.name} · ${passkey.role}`),
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
    onRoleChanged: (role) => {
      me.passkey.role = role;
      render();
    },
    onRevoked: () => welcome('This device was removed from the group.'),
    onGroupDeleted: ({ name }) => welcome(`${name} was deleted.`),
  });
  render();

  if (pendingToken) {
    const token = pendingToken;
    pendingToken = null;
    client.claimLink(token).then(
      ({ label }) => say(`Linked ${label}.`),
      (e) => say(e.message),
    );
  }
}

const me = await client.getMe();
if (me) home(me);
else welcome();

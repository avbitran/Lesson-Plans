import { api, h, clear } from './common.js';

const app = document.getElementById('app');

function go(user) {
  location.href = user.role === 'teacher' ? '/teacher' : '/student';
}

function field(label, input) {
  return h('label', {}, label, input);
}

function loginForm() {
  const username = h('input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none' });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'card form narrow',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          const { user } = await api('POST', '/api/login', { username: username.value, password: password.value });
          go(user);
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    h('h1', { text: 'Online Tests' }),
    field('Username', username),
    field('Password', password),
    error,
    h('button', { class: 'btn btn-primary btn-big', type: 'submit' }, 'Log in'),
    h('p', { class: 'muted small', text: 'Forgot your password? Ask your teacher to reset it.' }),
  );
  clear(app, h('main', { class: 'center' }, form));
  username.focus();
}

function setupForm() {
  const code = h('input', { inputmode: 'numeric', required: true });
  const name = h('input', { required: true, placeholder: 'e.g. Ms. Cohen' });
  const username = h('input', { required: true, autocapitalize: 'none', pattern: '[a-zA-Z0-9._\\-]{3,40}' });
  const password = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
  const error = h('p', { class: 'error', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'card form narrow',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          const { user } = await api('POST', '/api/setup', {
            code: code.value,
            name: name.value,
            username: username.value,
            password: password.value,
          });
          go(user);
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    h('h1', { text: 'Create the teacher account' }),
    h('p', { class: 'muted', text: 'This only happens once. The setup code is printed in the server log when it starts.' }),
    field('Setup code', code),
    field('Your name (students see this)', name),
    field('Username', username),
    field('Password (8+ characters)', password),
    error,
    h('button', { class: 'btn btn-primary btn-big', type: 'submit' }, 'Create account'),
  );
  clear(app, h('main', { class: 'center' }, form));
}

(async () => {
  const { user } = await api('GET', '/api/me');
  if (user) return go(user);
  const { needed } = await api('GET', '/api/setup');
  needed ? setupForm() : loginForm();
})();

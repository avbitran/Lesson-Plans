// Hash router: #tests, #edit/ID, #results/ID, #grade/ID, #people, #preview/ID
// for teachers; #my, #take/ID, #result/ID for students.

(function () {
  const app = document.getElementById('app');
  let currentHash = location.hash;

  function notOnList() {
    const email = BOOT.user.email;
    clear(
      app,
      h(
        'main',
        { class: 'center' },
        h(
          'div',
          { class: 'card narrow' },
          h('h1', { text: 'Online Tests' }),
          email
            ? h('p', {}, 'You are signed in as ', h('strong', { text: email }), ', which is not on the class list yet. Ask your teacher to add this email.')
            : h('p', { text: 'Sign in with your school Google account to use this page.' }),
        ),
      ),
    );
  }

  App.route = function () {
    const [name, arg, ...rest] = location.hash.slice(1).split('/');
    const role = BOOT.user.role;
    if (role === 'teacher') App.teacherRoute(name || 'tests', arg && decodeURIComponent(arg), rest.join('/'));
    else if (role === 'student') App.studentRoute(name || 'my', arg && decodeURIComponent(arg));
    else notOnList();
  };

  window.addEventListener('hashchange', () => {
    const t = App.activeTake;
    if (t && !t.finished) {
      // A running test can only be left by submitting it.
      if (!t.preview && t.attempt) {
        history.replaceState(null, '', currentHash);
        return toast('Submit the test before leaving it.', 'warn');
      }
      t.dispose();
    }
    if (BOOT.user.role === 'teacher' && App.teacherHasUnsaved() && !confirm('You have unsaved changes. Leave anyway?')) {
      history.replaceState(null, '', currentHash);
      return;
    }
    currentHash = location.hash;
    App.route();
  });

  window.addEventListener('beforeunload', (e) => {
    if (BOOT.user.role === 'teacher' && App.teacherHasUnsaved()) e.preventDefault();
  });

  App.route();
})();

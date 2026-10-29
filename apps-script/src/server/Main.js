// Apps Script entry points: the web page (doGet) and the one function the
// page calls for everything else (rpc).

// The pop-up voice recorder. Apps Script pages may not use the microphone,
// so recording happens on this separate page (GitHub Pages) and the audio is
// sent back to the test. Teachers can change it on the Students page.
const DEFAULT_RECORDER_URL = 'https://avbitran.github.io/Lesson-Plans/apps-script/recorder.html';

function doGet() {
  // INDEX_HTML (the pages) is appended to Code.gs by build.js, so the whole
  // app is a single file to paste.
  const t = HtmlService.createTemplate(INDEX_HTML);
  // Escaped so a name like "</script>" can't break out of the page's script.
  t.boot = JSON.stringify(bootInfo()).replace(/</g, '\\u003c');
  return t
    .evaluate()
    .setTitle('Online Tests')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function spreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('Online Tests – data');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

// Settings are stored per spreadsheet, so a copy of this Sheet (with its
// script) never writes into the original's recordings folder.
function propKey_(name) {
  return name + ':' + spreadsheet_().getId();
}

function recordingsFolder_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(propKey_('RECORDINGS_FOLDER_ID'));
  // Upgrade from the version that stored one folder per script.
  const legacy = props.getProperty('RECORDINGS_FOLDER_ID');
  if (!id && legacy) {
    id = legacy;
    props.setProperty(propKey_('RECORDINGS_FOLDER_ID'), legacy);
    props.deleteProperty('RECORDINGS_FOLDER_ID');
  }
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      // Folder was deleted; make a new one below.
    }
  }
  let folder;
  try {
    folder = DriveApp.createFolder('Online Tests – voice answers');
  } catch (e) {
    if (/permission/i.test(String(e && e.message))) throw new HttpError(503, DRIVE_PERMISSION_HELP);
    throw e;
  }
  props.setProperty(propKey_('RECORDINGS_FOLDER_ID'), folder.getId());
  return folder;
}

// Google's consent screen lets people untick Drive; voice answers need it.
const DRIVE_PERMISSION_HELP =
  'Voice answers are not set up yet: the app needs permission to use Google Drive. ' +
  'Teacher: open the Apps Script editor, choose "authorize" in the function list at the top, click Run, ' +
  'and tick every box on the permission screen (including Google Drive).';

// Run this once from the Apps Script editor (choose "authorize", then Run)
// to grant every permission the app needs.
function authorize() {
  // With Google's per-permission consent, a permission that was unticked is
  // only offered again when the script asks for it explicitly.
  if (typeof ScriptApp.requireAllScopes === 'function') ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  const ss = spreadsheet_();
  const folder = recordingsFolder_();
  console.log('All set. Data: ' + ss.getUrl() + '  Voice answers: ' + folder.getUrl());
}

let lockHeld_ = false;
function withLock_(fn) {
  if (lockHeld_) return fn();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new HttpError(503, 'The system is busy. Try again in a moment.');
  lockHeld_ = true;
  try {
    return fn();
  } finally {
    lockHeld_ = false;
    lock.releaseLock();
  }
}

// Google Classroom, when its service is on (the manifest turns it on). Runs as
// the person who set up the app, so it sees their Classroom classes.
function classroom_() {
  if (typeof Classroom === 'undefined') return undefined;
  const call = (fn) => {
    try {
      return fn();
    } catch (e) {
      throw new HttpError(502, 'Google Classroom said: ' + (e && e.message) + ' ' + CLASSROOM_SETUP_HELP);
    }
  };
  return {
    courses() {
      return call(() => {
        const out = [];
        let pageToken;
        do {
          const r = Classroom.Courses.list({ teacherId: 'me', courseStates: ['ACTIVE'], pageSize: 100, pageToken });
          (r.courses || []).forEach((c) => out.push({ id: c.id, name: c.name, section: c.section || '' }));
          pageToken = r.nextPageToken;
        } while (pageToken);
        return out;
      });
    },
    students(courseId) {
      return call(() => {
        const out = [];
        let pageToken;
        do {
          const r = Classroom.Courses.Students.list(courseId, { pageSize: 100, pageToken });
          (r.students || []).forEach((st) =>
            out.push({ email: (st.profile && st.profile.emailAddress) || '', name: (st.profile && st.profile.name && st.profile.name.fullName) || '' }),
          );
          pageToken = r.nextPageToken;
        } while (pageToken);
        return out;
      });
    },
  };
}

const CLASSROOM_SETUP_HELP =
  'To use Classroom import, the app’s manifest (appsscript.json) must be the one from the update instructions, then run "authorize" once and allow every permission.';

// Teachers at another school can't use this copy (Google only shares emails
// within a school), so they get their own: a copy of this Sheet without the
// data, which carries the app's code with it.
const DATA_TABS = Object.keys(SCHEMAS);
function makeInstallCopy_() {
  recordingsFolder_(); // settle this copy's own settings before copying
  const ss = spreadsheet_();
  const file = DriveApp.getFileById(ss.getId()).makeCopy('Online Tests (installable copy)');
  const copy = SpreadsheetApp.openById(file.getId());
  const start = copy.insertSheet('Start here', 0);
  start.getRange(1, 1, INSTALL_STEPS.length, 1).setValues(INSTALL_STEPS.map((x) => [x]));
  start.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  start.setColumnWidth(1, 900);
  for (const sh of copy.getSheets()) {
    const name = sh.getName();
    if (DATA_TABS.includes(name) || name.indexOf('Results: ') === 0) copy.deleteSheet(sh);
  }
  let sharing = 'anyone';
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    try {
      file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
      sharing = 'school';
    } catch (e2) {
      sharing = 'none';
    }
  }
  return { copyLink: 'https://docs.google.com/spreadsheets/d/' + file.getId() + '/copy', fileUrl: file.getUrl(), sharing };
}

const INSTALL_STEPS = [
  'Online Tests: set up your own copy (about 5 minutes)',
  '',
  'You made a copy of this Sheet, so the app is already inside it. Do this once, signed in with your school Google account:',
  '',
  '1. In the menu above, click Extensions → Apps Script. A code editor opens.',
  '2. At the top, choose "authorize" in the list next to ▷ Run, then click ▷ Run. Allow everything Google asks for (tick every box).',
  '3. Click the blue Deploy button → New deployment. Click the gear ⚙ next to "Select type" and choose Web app.',
  '4. Set "Execute as" to Me, and "Who has access" to Anyone within your school. Click Deploy.',
  '5. Copy the Web app URL. That is the link to your app: open it to start, and give it to your students.',
  '',
  'Your students, tests and results will be stored in this Sheet (new tabs appear by themselves). Keep this file.',
  'Help and updates: https://github.com/avbitran/Lesson-Plans',
];

function env_(db) {
  return {
    db,
    ownerEmail: Session.getEffectiveUser().getEmail().toLowerCase(),
    classroom: classroom_(),
    makeInstallCopy: makeInstallCopy_,
    withLock: withLock_,
    files: {
      save(name, mime, base64) {
        const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, name);
        return recordingsFolder_().createFile(blob).getId();
      },
      read(id) {
        return Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes());
      },
      remove(id) {
        try {
          DriveApp.getFileById(id).setTrashed(true);
        } catch (e) {
          // Already gone.
        }
      },
    },
    formatTime: (ms) => Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    exportResults(title, rows) {
      const ss = spreadsheet_();
      const name = ('Results: ' + title).replace(/[\[\]*?:\\/]/g, ' ').slice(0, 90);
      const sh = ss.getSheetByName(name) || ss.insertSheet(name);
      sh.clear();
      sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
      sh.setFrozenRows(1);
      return ss.getUrl() + '#gid=' + sh.getSheetId();
    },
    settings: {
      get() {
        const p = PropertiesService.getScriptProperties();
        return {
          recorderUrl: p.getProperty('RECORDER_URL') || DEFAULT_RECORDER_URL,
          spreadsheetUrl: spreadsheet_().getUrl(),
          classroomEnabled: typeof Classroom !== 'undefined',
          recordingsUrl: (() => {
            try {
              return recordingsFolder_().getUrl();
            } catch (e) {
              return null; // shown on the Students page as "not set up"
            }
          })(),
        };
      },
      set(s) {
        const p = PropertiesService.getScriptProperties();
        if (s.recorderUrl) p.setProperty('RECORDER_URL', s.recorderUrl);
        else p.deleteProperty('RECORDER_URL');
      },
    },
  };
}

// Who is visiting. Works because the app runs as the teacher and is shared
// with "anyone in the school": Google then tells us the visitor's email.
// Anyone not yet on a list is a guest, who can join a class with its code.
function currentUser_(db, ownerEmail) {
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) return { role: null, email: '' };
  if (email === ownerEmail) return { id: email, email, role: 'teacher', admin: true, name: email.split('@')[0] };
  const t = db.get('teachers', email);
  if (t) return { id: email, email, role: 'teacher', admin: false, name: t.name || email.split('@')[0] };
  const s = db.get('students', email);
  if (!s) return { id: email, email, role: 'guest' };
  return {
    id: email,
    email,
    role: 'student',
    name: s.name,
    readAloud: !!s.readAloud,
    voiceAnswers: !!s.voiceAnswers,
    extraTimePct: s.extraTimePct || 0,
  };
}

// The one-time upgrade from the single-teacher version (see Api.migrate).
const SCHEMA_VERSION = '2';
function migrateOnce_(db, env) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(propKey_('SCHEMA_VERSION')) === SCHEMA_VERSION) return;
  withLock_(() => {
    if (props.getProperty(propKey_('SCHEMA_VERSION')) === SCHEMA_VERSION) return;
    createApi(env).migrate();
    props.setProperty(propKey_('SCHEMA_VERSION'), SCHEMA_VERSION);
  });
}

function bootInfo() {
  const db = new SheetStore(spreadsheet_());
  const env = env_(db);
  migrateOnce_(db, env);
  const user = currentUser_(db, env.ownerEmail);
  return {
    user,
    recorderUrl: PropertiesService.getScriptProperties().getProperty('RECORDER_URL') || DEFAULT_RECORDER_URL,
  };
}

// Returns a JSON string: google.script.run mangles some values (undefined,
// nested nulls), and a string arrives exactly as sent.
function rpc(method, path, body) {
  try {
    const db = new SheetStore(spreadsheet_());
    const env = env_(db);
    migrateOnce_(db, env);
    const user = currentUser_(db, env.ownerEmail);
    const api = createApi(env);
    // Teacher edits are rare; serialising them avoids row shifts mid-write.
    const run = () => api.handle(method, path, body, user);
    const data = user.role === 'teacher' && method !== 'GET' ? withLock_(run) : run();
    return JSON.stringify({ ok: true, data: data === undefined ? null : data });
  } catch (e) {
    const status = e instanceof ValidationError ? 400 : e.status || 500;
    if (status === 500) console.error(e && e.stack ? e.stack : e);
    return JSON.stringify({ ok: false, status, error: status === 500 ? 'Something went wrong: ' + (e && e.message) : e.message });
  }
}

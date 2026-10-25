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

function recordingsFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('RECORDINGS_FOLDER_ID');
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
  props.setProperty('RECORDINGS_FOLDER_ID', folder.getId());
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

function env_(db) {
  return {
    db,
    ownerEmail: Session.getEffectiveUser().getEmail().toLowerCase(),
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
function currentUser_(db, ownerEmail) {
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) return { role: null, email: '' };
  if (email === ownerEmail || db.get('teachers', email)) return { id: email, email, role: 'teacher', name: email.split('@')[0] };
  const s = db.get('students', email);
  if (!s) return { role: null, email };
  return {
    id: email,
    email,
    role: 'student',
    name: s.name,
    className: s.className,
    readAloud: !!s.readAloud,
    voiceAnswers: !!s.voiceAnswers,
    extraTimePct: s.extraTimePct || 0,
  };
}

function bootInfo() {
  const db = new SheetStore(spreadsheet_());
  const env = env_(db);
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

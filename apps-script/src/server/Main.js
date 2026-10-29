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
  return folder_('RECORDINGS_FOLDER_ID', 'Online Tests – voice answers');
}

function audioFolder_() {
  return folder_('AUDIO_FOLDER_ID', 'Online Tests – read-aloud audio');
}

function folder_(prop, title) {
  const props = PropertiesService.getScriptProperties();
  // Stored per spreadsheet, so a copy of this Sheet never uses the
  // original's folders. Older versions stored one id per script: adopt it.
  let id = props.getProperty(propKey_(prop));
  const legacy = props.getProperty(prop);
  if (!id && legacy) {
    id = legacy;
    props.setProperty(propKey_(prop), legacy);
    props.deleteProperty(prop);
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
    folder = DriveApp.createFolder(title);
  } catch (e) {
    if (/permission/i.test(String(e && e.message))) throw new HttpError(503, DRIVE_PERMISSION_HELP);
    throw e;
  }
  props.setProperty(propKey_(prop), folder.getId());
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
  audioFolder_();
  // Natural voices call Google's or Chatterbox's speech service from here.
  UrlFetchApp.getRequest('https://texttospeech.googleapis.com/');
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
    backups: backupsEnv_(),
    withLock: withLock_,
    hash: (text) =>
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
        .map((b) => ((b + 256) % 256).toString(16).padStart(2, '0'))
        .join(''),
    tts: { synthesize: ttsSynthesize_ },
    files: {
      save(name, mime, base64, kind) {
        const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, name);
        return (kind === 'audio' ? audioFolder_() : recordingsFolder_()).createFile(blob).getId();
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
          voices: {
            googleKeySet: !!p.getProperty('GOOGLE_TTS_KEY'),
            chatterboxUrl: p.getProperty('CHATTERBOX_URL') || '',
            chatterboxKeySet: !!p.getProperty('CHATTERBOX_KEY'),
          },
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
      // undefined = leave as it is, '' = remove.
      setVoices(v) {
        const p = PropertiesService.getScriptProperties();
        const put = (key, val) => {
          if (val === undefined) return;
          if (val) p.setProperty(key, val);
          else p.deleteProperty(key);
        };
        put('GOOGLE_TTS_KEY', v.googleKey);
        put('CHATTERBOX_URL', v.chatterboxUrl);
        put('CHATTERBOX_KEY', v.chatterboxKey);
      },
    },
  };
}

// ------------------------------------------------------- natural voices
// Each returns a list of { mime, data (base64) } pieces, played in order.

function ttsSynthesize_(o) {
  const p = PropertiesService.getScriptProperties();
  if (o.provider === 'google') return googleTts_(p.getProperty('GOOGLE_TTS_KEY'), o);
  if (o.provider === 'chatterbox') return chatterboxTts_(p.getProperty('CHATTERBOX_URL'), p.getProperty('CHATTERBOX_KEY'), o);
  throw new HttpError(400, 'Unknown voice.');
}

// Google Cloud Text-to-Speech. A voice name like "en-US-Neural2-F" also
// says its language; stretches in another language (Hebrew inside an English
// test) use Google's default voice for that language.
function googleTts_(key, o) {
  if (!key) throw new HttpError(400, 'Add your Google Cloud key first: Students → Settings → Read-aloud voices.');
  const nameLang = o.voice ? o.voice.split('-').slice(0, 2).join('-') : '';
  return ttsPieces(o.text, nameLang || o.language, 1500).map((piece) => {
    const own = o.voice && piece.lang.slice(0, 2) === nameLang.slice(0, 2);
    const body = {
      input: { text: piece.text },
      voice: own ? { languageCode: nameLang, name: o.voice } : { languageCode: piece.lang },
      audioConfig: { audioEncoding: 'MP3' },
    };
    const res = UrlFetchApp.fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(key), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new HttpError(502, googleTtsError_(res));
    return { mime: 'audio/mpeg', data: JSON.parse(res.getContentText()).audioContent };
  });
}

function googleTtsError_(res) {
  let msg = '';
  try {
    msg = JSON.parse(res.getContentText()).error.message || '';
  } catch (e) {
    msg = res.getContentText().slice(0, 200);
  }
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg))
    return 'Google says the Text-to-Speech API is not turned on for your Cloud project. Turn it on (see the instructions) and try again in a few minutes.';
  if (/billing/i.test(msg)) return 'Google says your Cloud project needs a billing account before it can make voices.';
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Google says the key is not valid. Copy it again from the Google Cloud console.';
  if (/voice/i.test(msg) && /not exist|invalid|unsupported/i.test(msg)) return 'Google does not have a voice with that name. Check the spelling, e.g. en-US-Neural2-F.';
  return 'Google could not make the audio: ' + msg;
}

// Chatterbox (or any server with the OpenAI-style /v1/audio/speech address).
// Sentences go in short pieces, which Chatterbox handles best.
function chatterboxTts_(url, key, o) {
  if (!url) throw new HttpError(400, 'Add your Chatterbox address first: Students → Settings → Read-aloud voices.');
  const endpoint = /\/v1\/audio\/speech$/.test(url) ? url : url.replace(/\/+$/, '') + '/v1/audio/speech';
  return ttsPieces(o.text, o.language, 300).map((piece) => {
    const body = { model: 'chatterbox', input: piece.text, response_format: 'mp3' };
    if (o.voice) body.voice = o.voice;
    if (piece.lang.slice(0, 2) !== 'en') body.language = piece.lang.slice(0, 2);
    let res;
    try {
      res = UrlFetchApp.fetch(endpoint, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        headers: key ? { Authorization: 'Bearer ' + key } : {},
        muteHttpExceptions: true,
      });
    } catch (e) {
      throw new HttpError(502, 'Could not reach your Chatterbox server at ' + url + '. Is the computer on and the tunnel running?');
    }
    const code = res.getResponseCode();
    const mime = String(res.getHeaders()['Content-Type'] || res.getHeaders()['content-type'] || '').split(';')[0].trim();
    if (code !== 200 || !/^audio\//.test(mime))
      throw new HttpError(502, 'Your Chatterbox server answered with an error (' + code + '): ' + res.getContentText().slice(0, 200));
    return { mime, data: Utilities.base64Encode(res.getContent()) };
  });
}

// Who is visiting. Works because the app runs as the teacher and is shared
// with "anyone in the school": Google then tells us the visitor's email.
// Anyone not yet on a list is a guest, who can join a class with its code.
function currentUser_(db, ownerEmail) {
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) return { role: null, email: '' };
  const t = db.get('teachers', email);
  if (email === ownerEmail) return { id: email, email, role: 'teacher', admin: true, name: (t && t.name) || email.split('@')[0] };
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

// The first visit after new code is pasted backs everything up before any
// upgrade touches the data. BUILD_ID is set by build.js.
function migrateOnce_(db, env) {
  const props = PropertiesService.getScriptProperties();
  const build = typeof BUILD_ID === 'undefined' ? 'dev' : BUILD_ID;
  if (props.getProperty(propKey_('SCHEMA_VERSION')) === SCHEMA_VERSION && props.getProperty(propKey_('BUILD_ID')) === build) return;
  withLock_(() => {
    if (props.getProperty(propKey_('BUILD_ID')) !== build) {
      const hasData = db.all('students', true).length || db.all('tests', true).length;
      if (hasData) {
        try {
          backupNow_('before update');
        } catch (e) {
          // Don't block the app; the error is visible in Settings → Backups.
          props.setProperty(propKey_('BACKUP_ERROR'), String((e && e.message) || e).slice(0, 300));
        }
      }
      props.setProperty(propKey_('BUILD_ID'), build);
    }
    if (props.getProperty(propKey_('SCHEMA_VERSION')) !== SCHEMA_VERSION) {
      createApi(env).migrate();
      props.setProperty(propKey_('SCHEMA_VERSION'), SCHEMA_VERSION);
    }
  });
}

// ------------------------------------------------------------------ backups
// A backup is a new, separate Google Sheet with copies of the data tabs (no
// app code inside), in the "Online Tests – backups" folder. Daily backups are
// kept for BACKUP_KEEP days; manual and before-update backups are kept until
// you delete them. Voice answers and read-aloud audio are files in Drive and
// are never deleted by an update.
const BACKUP_KEEP = 30;

function backupsFolder_() {
  return folder_('BACKUPS_FOLDER_ID', 'Online Tests – backups');
}

function backupNow_(reason) {
  const ss = spreadsheet_();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  const name = `Online Tests backup ${stamp} (${reason})`;
  const dest = SpreadsheetApp.create(name);
  const blank = dest.getSheets()[0];
  let tabs = 0;
  for (const sh of ss.getSheets()) {
    if (!DATA_TABS.includes(sh.getName())) continue;
    sh.copyTo(dest).setName(sh.getName());
    tabs++;
  }
  if (tabs) dest.deleteSheet(blank);
  const file = DriveApp.getFileById(dest.getId());
  file.moveTo(backupsFolder_());
  const props = PropertiesService.getScriptProperties();
  props.setProperty(propKey_('LAST_BACKUP'), String(Date.now()));
  props.deleteProperty(propKey_('BACKUP_ERROR'));
  pruneBackups_();
  return { name, url: dest.getUrl() };
}

function pruneBackups_() {
  const cutoff = Date.now() - BACKUP_KEEP * 24 * 3600e3;
  const it = backupsFolder_().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('(daily)') >= 0 && f.getDateCreated().getTime() < cutoff) f.setTrashed(true);
  }
}

function listBackups_() {
  const out = [];
  const it = backupsFolder_().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    out.push({ name: f.getName(), url: f.getUrl(), createdAt: f.getDateCreated().getTime() });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
}

// Runs every night (the trigger below calls it).
function dailyBackup() {
  backupNow_('daily');
}

function backupTrigger_() {
  return ScriptApp.getProjectTriggers().find((t) => t.getHandlerFunction() === 'dailyBackup') || null;
}

function setDailyBackups_(on) {
  const props = PropertiesService.getScriptProperties();
  const t = backupTrigger_();
  if (on && !t) ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(2).create();
  if (!on && t) ScriptApp.deleteTrigger(t);
  props.setProperty(propKey_('DAILY_BACKUPS'), on ? 'on' : 'off');
}

// Daily backups are on unless the admin turned them off. Checked once per
// spreadsheet (and again if it failed, e.g. before the permission existed).
function ensureDailyBackups_() {
  const props = PropertiesService.getScriptProperties();
  const state = props.getProperty(propKey_('DAILY_BACKUPS'));
  if (state === 'on' || state === 'off') return;
  try {
    setDailyBackups_(true);
  } catch (e) {
    props.setProperty(propKey_('BACKUP_ERROR'), 'Daily backups could not be turned on: ' + String((e && e.message) || e).slice(0, 250));
  }
}

function backupsEnv_() {
  return {
    status() {
      const props = PropertiesService.getScriptProperties();
      let daily = props.getProperty(propKey_('DAILY_BACKUPS')) === 'on';
      try {
        daily = !!backupTrigger_();
      } catch (e) {
        // No permission to look at triggers yet.
      }
      const last = Number(props.getProperty(propKey_('LAST_BACKUP'))) || null;
      return { daily, lastBackup: last, error: props.getProperty(propKey_('BACKUP_ERROR')) || '', folderUrl: backupsFolder_().getUrl(), backups: listBackups_(), keepDays: BACKUP_KEEP };
    },
    now: () => backupNow_('manual'),
    setDaily: setDailyBackups_,
  };
}

// Header rows remembered between requests (6 hours, the most the cache keeps),
// per spreadsheet and code version.
function headerCache_() {
  const cache = CacheService.getScriptCache();
  const prefix = 'hdr:' + spreadsheet_().getId() + ':' + (typeof BUILD_ID === 'undefined' ? 'dev' : BUILD_ID) + ':';
  return {
    getAll(tables) {
      const got = cache.getAll(tables.map((t) => prefix + t));
      const out = {};
      tables.forEach((t) => {
        if (got[prefix + t]) out[t] = got[prefix + t];
      });
      return out;
    },
    put: (table, value) => cache.put(prefix + table, value, 21600),
  };
}

function store_() {
  return new SheetStore(spreadsheet_(), headerCache_());
}

function bootInfo() {
  const db = store_();
  const env = env_(db);
  migrateOnce_(db, env);
  const user = currentUser_(db, env.ownerEmail);
  if (user.admin) ensureDailyBackups_();
  // The first screen's data comes with the page, saving one round trip.
  const prefetch = {};
  try {
    const api = createApi(env);
    if (user.role === 'teacher') prefetch['GET /api/tests'] = api.handle('GET', '/api/tests', null, user);
    else if (user.role === 'student') prefetch['GET /api/my/tests'] = api.handle('GET', '/api/my/tests', null, user);
  } catch (e) {
    // The page will ask for it normally.
  }
  return {
    user,
    recorderUrl: PropertiesService.getScriptProperties().getProperty('RECORDER_URL') || DEFAULT_RECORDER_URL,
    prefetch,
  };
}

// Returns a JSON string: google.script.run mangles some values (undefined,
// nested nulls), and a string arrives exactly as sent.
function rpc(method, path, body) {
  try {
    const db = store_();
    const env = env_(db);
    migrateOnce_(db, env);
    const user = currentUser_(db, env.ownerEmail);
    if (user.admin) ensureDailyBackups_();
    const api = createApi(env);
    // Teacher edits are rare; serialising them avoids row shifts mid-write.
    // Making audio and trying voices take long and only add rows, so they
    // don't hold the lock (students starting a test need it).
    const run = () => api.handle(method, path, body, user);
    const slow = /\/audio$|^\/api\/voices\/try$/.test(path);
    const data = user.role === 'teacher' && method !== 'GET' && !slow ? withLock_(run) : run();
    return JSON.stringify({ ok: true, data: data === undefined ? null : data });
  } catch (e) {
    const status = e instanceof ValidationError ? 400 : e.status || 500;
    if (status === 500) console.error(e && e.stack ? e.stack : e);
    return JSON.stringify({ ok: false, status, error: status === 500 ? 'Something went wrong: ' + (e && e.message) : e.message });
  }
}

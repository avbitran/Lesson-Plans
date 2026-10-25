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
  return folder_('RECORDINGS_FOLDER_ID', 'Online Tests – voice answers');
}

function audioFolder_() {
  return folder_('AUDIO_FOLDER_ID', 'Online Tests – read-aloud audio');
}

function folder_(prop, title) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(prop);
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
  props.setProperty(prop, folder.getId());
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

function env_(db) {
  return {
    db,
    ownerEmail: Session.getEffectiveUser().getEmail().toLowerCase(),
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

// Read-aloud (browser text-to-speech) and voice-answer recording.

export const ttsSupported = 'speechSynthesis' in window;

let voices = [];
function loadVoices() {
  voices = ttsSupported ? speechSynthesis.getVoices() : [];
}
if (ttsSupported) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

function pickVoice(lang) {
  const exact = voices.filter((v) => v.lang.replace('_', '-') === lang);
  const family = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  const pool = exact.length ? exact : family;
  // Prefer the higher-quality network voices Chrome ships ("Google ...").
  return pool.find((v) => /google|natural|enhanced|premium/i.test(v.name)) || pool[0] || null;
}

// Chrome stops long utterances after ~15 seconds, so speak sentence by sentence.
function chunks(text) {
  return String(text)
    .replace(/_{2,}/g, ' blank ')
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => (s.length > 220 ? s.match(/.{1,200}(\s|$)/g) : [s]));
}

export class Reader {
  constructor({ lang = 'en-US', rate = 1 } = {}) {
    this.lang = lang;
    this.rate = rate;
    this.active = null; // { onEnd }
  }

  speak(text, { onStart, onEnd } = {}) {
    this.stop();
    if (!ttsSupported) return;
    const parts = chunks(text);
    if (!parts.length) return;
    const voice = pickVoice(this.lang);
    const token = {};
    this.active = { token, onEnd };
    onStart?.();
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      u.lang = this.lang;
      if (voice) u.voice = voice;
      u.rate = this.rate;
      if (i === parts.length - 1) {
        u.onend = u.onerror = () => {
          if (this.active?.token === token) {
            this.active = null;
            onEnd?.();
          }
        };
      }
      speechSynthesis.speak(u);
    });
  }

  stop() {
    if (!ttsSupported) return;
    const prev = this.active;
    this.active = null;
    speechSynthesis.cancel();
    prev?.onEnd?.();
  }

  get speaking() {
    return !!this.active;
  }
}

// ------------------------------------------------------------- recording

export const recordingSupported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

let sharedStream = null;

// Ask for the microphone once, before the test goes fullscreen, so the
// permission prompt never interrupts the test itself.
export async function getMicrophone() {
  if (sharedStream && sharedStream.getAudioTracks().some((t) => t.readyState === 'live')) return sharedStream;
  sharedStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  return sharedStream;
}

export class Recorder {
  constructor({ maxSeconds = 300, onTick, onStop } = {}) {
    this.maxSeconds = maxSeconds;
    this.onTick = onTick;
    this.onStop = onStop;
    this.rec = null;
  }

  async start() {
    const stream = await getMicrophone();
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const parts = [];
    this.startedAt = performance.now();
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = () => {
      clearInterval(this.timer);
      const seconds = (performance.now() - this.startedAt) / 1000;
      const type = (rec.mimeType || mimeType || 'audio/webm').split(';')[0];
      this.rec = null;
      this.onStop?.(new Blob(parts, { type }), seconds);
    };
    rec.start(1000);
    this.rec = rec;
    this.timer = setInterval(() => {
      const s = (performance.now() - this.startedAt) / 1000;
      this.onTick?.(s);
      if (s >= this.maxSeconds) this.stop();
    }, 250);
  }

  stop() {
    if (this.rec?.state === 'recording') this.rec.stop();
  }

  get recording() {
    return this.rec?.state === 'recording';
  }
}

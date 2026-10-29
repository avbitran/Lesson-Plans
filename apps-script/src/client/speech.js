// Read-aloud. Two ways to speak:
//  - prepared natural-voice audio (Google or Chatterbox), made by the teacher
//    and fetched piece by piece from Drive;
//  - the device's own text-to-speech, used when a test has no prepared audio
//    (or it fails to load).

const ttsSupported = 'speechSynthesis' in window;

let voices = [];
function loadVoices() {
  voices = ttsSupported ? speechSynthesis.getVoices() : [];
}
if (ttsSupported) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

// The most natural-sounding voice the device has for a language. Network
// voices ("Google US English", Edge's "… Online (Natural)", Apple's enhanced
// voices) sound far better than the small offline ones.
function voiceScore(v) {
  const n = v.name;
  let s = 0;
  if (/natural|neural/i.test(n)) s += 50;
  if (/online/i.test(n)) s += 20;
  if (/premium|enhanced/i.test(n)) s += 30;
  if (/^google/i.test(n)) s += 25;
  if (v.localService === false) s += 10;
  if (/espeak|robot|compact|novelty|whisper|bad news|bells|boing|bubbles|cellos|zarvox|trinoids|albert|jester|organ|superstar|wobble/i.test(n)) s -= 100;
  return s;
}

function pickVoice(lang) {
  const norm = (l) => String(l || '').replace('_', '-').toLowerCase();
  const want = norm(lang);
  const exact = voices.filter((v) => norm(v.lang) === want);
  const family = voices.filter((v) => norm(v.lang).startsWith(want.slice(0, 2)));
  const pool = exact.length ? exact : family;
  return pool.slice().sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
}

// Hebrew or Arabic stretches inside an English test get a voice for that language.
const scriptLang = (s, fallback) => (/[֐-׿]/.test(s) ? 'he-IL' : /[؀-ۿ]/.test(s) ? 'ar-SA' : fallback);

// Chrome stops a single utterance after ~15 seconds, so text is spoken in
// pieces. Pieces are whole sentences joined up to ~180 characters: fewer,
// longer pieces sound much less choppy than one sentence at a time.
function chunks(text, lang) {
  const sentences = String(text)
    .replace(/_{2,}/g, ' … blank … ')
    .split(/(?<=[.!?;:…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => (s.length > 220 ? s.match(/.{1,200}(\s|$)/g).map((x) => x.trim()) : [s]));
  const out = [];
  for (const s of sentences) {
    const l = scriptLang(s, lang);
    const last = out[out.length - 1];
    if (last && last.lang === l && last.text.length + s.length < 180) last.text += ` ${s}`;
    else out.push({ text: s, lang: l });
  }
  return out;
}

class Reader {
  constructor({ lang = 'en-US', rate = 1 } = {}) {
    this.lang = lang;
    this._rate = rate;
    this.active = null; // { token, onEnd, audio? }
  }

  get rate() {
    return this._rate;
  }

  set rate(r) {
    this._rate = r;
    if (this.active?.audio) this.active.audio.playbackRate = r;
  }

  // audioId: prepared natural-voice audio for this text, if any.
  speak(text, { audioId, onStart, onEnd } = {}) {
    this.stop();
    const token = {};
    this.active = { token, onEnd };
    onStart?.();
    if (audioId) this.playClip(token, audioId, text);
    else this.speakDevice(token, text);
  }

  finish(token) {
    if (this.active?.token !== token) return;
    const { onEnd } = this.active;
    this.active = null;
    onEnd?.();
  }

  speakDevice(token, text) {
    if (!ttsSupported) return this.finish(token);
    const parts = chunks(text, this.lang);
    if (!parts.length) return this.finish(token);
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part.text);
      u.lang = part.lang;
      const voice = pickVoice(part.lang);
      if (voice) u.voice = voice;
      u.rate = this._rate;
      if (i === parts.length - 1) u.onend = u.onerror = () => this.finish(token);
      speechSynthesis.speak(u);
    });
  }

  // Plays the clip's pieces one after another, loading the next while the
  // current one plays. If anything fails, the device voice reads instead.
  async playClip(token, id, text) {
    const load = (n) =>
      api('GET', `/api/audio/${id}/${n}`).then((r) => ({ ...r, url: URL.createObjectURL(base64ToBlob(r.data, r.mime)) }));
    try {
      let next = load(0);
      for (let n = 0; ; n++) {
        const piece = await next;
        if (this.active?.token !== token) return;
        if (n + 1 < piece.count) next = load(n + 1);
        await new Promise((resolve, reject) => {
          const audio = new Audio();
          audio.playbackRate = this._rate;
          audio.preservesPitch = true;
          this.active.audio = audio;
          audio.onended = resolve;
          audio.onerror = () => {
            // Some browsers refuse blob: media inside the Apps Script frame.
            if (audio.src.startsWith('blob:')) {
              audio.src = `data:${piece.mime};base64,${piece.data}`;
              audio.play().catch(reject);
            } else reject(new Error('audio'));
          };
          audio.src = piece.url;
          // A refused blob: lands in onerror; a blocked autoplay falls back.
          audio.play().catch((e) => e && e.name === 'NotAllowedError' && reject(e));
        });
        URL.revokeObjectURL(piece.url);
        if (this.active?.token !== token) return;
        if (n + 1 >= piece.count) return this.finish(token);
      }
    } catch (e) {
      if (this.active?.token !== token) return;
      this.active.audio = null;
      this.speakDevice(token, text);
    }
  }

  stop() {
    const prev = this.active;
    this.active = null;
    if (prev?.audio) prev.audio.pause();
    if (ttsSupported) speechSynthesis.cancel();
    prev?.onEnd?.();
  }

  get speaking() {
    return !!this.active;
  }
}

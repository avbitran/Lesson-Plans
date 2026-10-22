// Read-aloud with the browser's built-in text-to-speech.

const ttsSupported = 'speechSynthesis' in window;

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

class Reader {
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

// Synthesized sound effects (Web Audio), so there are no audio files to load.
const KEY = 'the-table-sound';
let ctx, master, noise;
let enabled = localStorage.getItem(KEY) !== 'off';
let lastClack = 0;

const rand = (a, b) => a + Math.random() * (b - a);

function ac() {
  if (!ctx) {
    ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(comp).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

const envelope = (g, now, peak, attack, dur) => {
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
};

function hiss({ t = 0, dur = 0.06, freq = 3000, to, q = 2, type = 'bandpass', gain = 0.5, attack = 0.002 }) {
  const c = ac(), now = c.currentTime + t;
  const src = c.createBufferSource();
  src.buffer = noise;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, now);
  if (to) f.frequency.exponentialRampToValueAtTime(to, now + dur);
  f.Q.value = q;
  const g = c.createGain();
  envelope(g, now, gain, attack, dur);
  src.connect(f).connect(g).connect(master);
  src.start(now, Math.random() * 0.5);
  src.stop(now + dur + 0.05);
}

function tone({ t = 0, freq, to, dur = 0.2, type = 'sine', gain = 0.3, attack = 0.005 }) {
  const c = ac(), now = c.currentTime + t;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, now);
  if (to) o.frequency.exponentialRampToValueAtTime(to, now + dur);
  const g = c.createGain();
  envelope(g, now, gain, attack, dur);
  o.connect(g).connect(master);
  o.start(now);
  o.stop(now + dur + 0.05);
}

const on = () => enabled && ctx;

export const sfx = {
  get enabled() { return enabled; },
  set enabled(v) {
    enabled = v;
    localStorage.setItem(KEY, v ? 'on' : 'off');
  },
  /** Must be called from a user gesture before anything can play. */
  unlock() { if (enabled) ac(); },

  clack(speed, kind) {
    if (!on()) return;
    const now = ctx.currentTime;
    if (now - lastClack < 0.012) return;
    lastClack = now;
    const k = Math.min(1, speed / 22);
    const gain = 0.05 + 0.65 * k ** 1.3;
    if (kind === 'dice') {
      hiss({ freq: rand(2800, 4200), q: 4, dur: 0.05, gain });
      tone({ freq: rand(1800, 2600), dur: 0.035, type: 'triangle', gain: gain * 0.3 });
    } else if (kind === 'floor') {
      hiss({ freq: rand(1100, 1700), q: 1.2, dur: 0.07, gain: gain * 0.9 });
      tone({ freq: rand(140, 190), to: 70, dur: 0.09, gain: gain * 0.6 });
    } else {
      hiss({ freq: rand(600, 900), q: 1, dur: 0.09, gain });
      tone({ freq: 110, to: 60, dur: 0.12, gain: gain * 0.7 });
    }
  },

  whoosh(strength = 0.6) {
    if (!on()) return;
    hiss({ freq: 350, to: 2200, q: 1.5, dur: 0.18, gain: 0.08 + 0.2 * strength, attack: 0.08 });
    hiss({ t: 0.15, freq: 2200, to: 500, q: 1.5, dur: 0.2, gain: 0.05 + 0.12 * strength, attack: 0.01 });
  },

  crit() {
    if (!on()) return;
    tone({ freq: 90, to: 40, dur: 0.6, gain: 0.5 });
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const last = i === 3;
      tone({ t: i * 0.085, freq: f, dur: last ? 1.1 : 0.3, type: 'triangle', gain: 0.22 });
      tone({ t: i * 0.085, freq: f * 2, dur: last ? 0.9 : 0.2, type: 'square', gain: 0.04 });
    });
    [1318.5, 1568].forEach((f) => tone({ t: 0.34, freq: f, dur: 1.1, type: 'triangle', gain: 0.1 }));
    hiss({ t: 0.3, freq: 7000, q: 0.7, type: 'highpass', dur: 0.9, gain: 0.08, attack: 0.05 });
  },

  fumble() {
    if (!on()) return;
    tone({ freq: 311, to: 294, dur: 0.28, type: 'sawtooth', gain: 0.11 });
    tone({ t: 0.3, freq: 294, to: 277, dur: 0.28, type: 'sawtooth', gain: 0.11 });
    tone({ t: 0.6, freq: 277, to: 185, dur: 0.8, type: 'sawtooth', gain: 0.12 });
    tone({ freq: 70, to: 35, dur: 0.5, gain: 0.5 });
    hiss({ freq: 500, q: 0.8, dur: 0.15, gain: 0.35 });
  },

  hit(k = 1) {
    if (!on()) return;
    tone({ freq: 180, to: 45, dur: 0.3, gain: 0.6 * k });
    hiss({ freq: 900, to: 200, q: 0.9, type: 'lowpass', dur: 0.14, gain: 0.5 * k });
  },

  down() {
    if (!on()) return;
    this.hit(1);
    tone({ t: 0.05, freq: 70, to: 30, dur: 1, gain: 0.5 });
    tone({ t: 0.1, freq: 220, to: 110, dur: 0.9, type: 'sawtooth', gain: 0.08 });
  },

  heal() {
    if (!on()) return;
    tone({ freq: 660, to: 990, dur: 0.25, type: 'triangle', gain: 0.14 });
    tone({ t: 0.08, freq: 990, to: 1320, dur: 0.3, type: 'triangle', gain: 0.1 });
  },
};

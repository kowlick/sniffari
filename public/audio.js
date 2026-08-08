// Sound effects and music, synthesised with Web Audio.
//
// Nothing is loaded from a file. That keeps the game asset-free and instant to start on a
// LAN, and it means the music can react to the game — the walk theme is the same tune as
// the placing theme, just faster and busier, so the transition feels like a gear change
// rather than a track swap.
//
// Browsers block audio until a gesture, so nothing here works until unlock() is called
// from a click.

let ctx = null;
let master = null;
let muted = false;

export function unlock() {
  try {
    ctx ??= new (window.AudioContext ?? window.webkitAudioContext)();
    if (!master) {
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
  return Boolean(ctx);
}

export function setMuted(next) {
  muted = next;
  if (master) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.02);
  return muted;
}

export const isMuted = () => muted;

// --- small synth ------------------------------------------------------------------------

/** One oscillator note with an envelope. */
function tone(at, { freq, dur = 0.15, type = 'sine', gain = 0.2, to = null, dest = null }) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const vol = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + dur);
  vol.gain.setValueAtTime(0.0001, at);
  vol.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.02, dur * 0.2));
  vol.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(vol).connect(dest ?? master);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/** A burst of filtered noise — the basis of barks, sniffs, splashes and thuds. */
function noise(at, { dur = 0.2, gain = 0.2, type = 'bandpass', freq = 1200, to = null, q = 1 }) {
  if (!ctx) return;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, at);
  filter.Q.value = q;
  if (to) filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), at + dur);
  const vol = ctx.createGain();
  vol.gain.setValueAtTime(gain, at);
  vol.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter).connect(vol).connect(master);
  src.start(at);
  src.stop(at + dur + 0.02);
}

// --- sound effects -----------------------------------------------------------------------

const SFX = {
  /** Two dogs meet: a proper double bark. */
  greet(t) {
    noise(t, { dur: 0.12, gain: 0.28, freq: 900, to: 320, q: 1.2 });
    tone(t, { freq: 420, to: 190, dur: 0.13, type: 'sawtooth', gain: 0.12 });
    noise(t + 0.17, { dur: 0.1, gain: 0.22, freq: 800, to: 300, q: 1.2 });
    tone(t + 0.17, { freq: 380, to: 170, dur: 0.11, type: 'sawtooth', gain: 0.1 });
  },
  /** Snuffling: short bursts of breathy noise. */
  sniff(t) {
    for (let i = 0; i < 3; i++) {
      noise(t + i * 0.06, { dur: 0.05, gain: 0.1, type: 'highpass', freq: 1800, q: 0.7 });
    }
    tone(t + 0.18, { freq: 880, dur: 0.09, type: 'triangle', gain: 0.07 });
  },
  /** Treat: a happy little rise. */
  treat(t) {
    [0, 4, 7, 12].forEach((semi, i) =>
      tone(t + i * 0.055, { freq: 523.25 * 2 ** (semi / 12), dur: 0.14, type: 'triangle', gain: 0.14 }),
    );
  },
  /** Walking into a wall. */
  bump(t) {
    noise(t, { dur: 0.09, gain: 0.16, type: 'lowpass', freq: 400, to: 120 });
    tone(t, { freq: 150, to: 70, dur: 0.1, type: 'sine', gain: 0.14 });
  },
  jump(t) {
    tone(t, { freq: 300, to: 720, dur: 0.16, type: 'triangle', gain: 0.13 });
  },
  /** A tile firing and vanishing. */
  consume(t) {
    tone(t, { freq: 1200, to: 1900, dur: 0.09, type: 'square', gain: 0.05 });
  },
  reveal(t) {
    [0, 5, 9].forEach((s, i) =>
      tone(t + i * 0.05, { freq: 660 * 2 ** (s / 12), dur: 0.18, type: 'sine', gain: 0.1 }),
    );
  },
  /** Chased it up the tree — the jackpot. */
  squirrel(t) {
    [0, 7, 12, 16, 19].forEach((s, i) =>
      tone(t + i * 0.06, { freq: 523.25 * 2 ** (s / 12), dur: 0.2, type: 'square', gain: 0.1 }),
    );
    noise(t, { dur: 0.3, gain: 0.06, type: 'highpass', freq: 2600 });
  },
  lake(t) {
    noise(t, { dur: 0.45, gain: 0.24, type: 'lowpass', freq: 2400, to: 200 });
    tone(t + 0.05, { freq: 500, to: 140, dur: 0.3, type: 'sine', gain: 0.08 });
  },
  drain(t) {
    tone(t, { freq: 260, to: 130, dur: 0.3, type: 'sine', gain: 0.1 });
  },
  /** Out of puff. */
  tuckered(t) {
    [0, -2, -5].forEach((s, i) =>
      tone(t + i * 0.13, { freq: 440 * 2 ** (s / 12), dur: 0.3, type: 'triangle', gain: 0.1 }),
    );
  },
  tail(t) {
    tone(t, { freq: 700, to: 300, dur: 0.35, type: 'sawtooth', gain: 0.07 });
  },
  stuck(t) {
    tone(t, { freq: 300, dur: 0.1, type: 'square', gain: 0.07 });
    tone(t + 0.12, { freq: 240, dur: 0.14, type: 'square', gain: 0.07 });
  },
};

/** Fire a one-shot. Unknown names are ignored so new sim events cannot throw. */
export function sfx(name, delay = 0) {
  if (!ctx || muted) return;
  SFX[name]?.(ctx.currentTime + delay);
}

// --- music --------------------------------------------------------------------------------
//
// A tiny step sequencer. Both themes share one chord progression so the walk theme reads as
// the placing theme getting excited rather than as a different piece of music.

const ROOT = 130.81; // C3
const noteHz = (semi) => ROOT * 2 ** (semi / 12);
const R = null; // rest

/**
 * Two tunes, written out note by note rather than generated from a scale. The walk theme
 * used to be the placing theme at a higher tempo, which is exactly what it sounded like.
 * They now differ in key, mode, chord progression, rhythm and instrumentation.
 *
 * Patterns are 16 eighth-notes long — 4 bars — and loop.
 */
const THEMES = {
  /**
   * Placing: A minor, slow, sparse. Long held notes with space between them, so it sits
   * under people thinking without demanding attention.
   */
  place: {
    bpm: 76,
    swing: 0.5,
    bass: { wave: 'sine', gain: 0.15, dur: 0.7 },
    lead: { wave: 'sine', gain: 0.075, dur: 0.55, octave: 12 },
    // Am – F – C – G
    roots: [9, 5, 0, 7],
    melody: [
      9, R, R, 12, R, R, 11, R,
      7, R, R, 9, R, R, R, R,
    ],
    drums: false,
  },

  /**
   * Walking: C major pentatonic over I–V–vi–IV, with a hook that rises, answers itself and
   * falls back. Square-wave lead, walking bass on every eighth, kick/snare/hat underneath.
   */
  walk: {
    bpm: 138,
    swing: 0.57,
    bass: { wave: 'triangle', gain: 0.15, dur: 0.14 },
    lead: { wave: 'square', gain: 0.055, dur: 0.13, octave: 24 },
    // C – G – Am – F
    roots: [0, 7, 9, 5],
    melody: [
      4, 7, 9, 7, 2, 4, 7, R,
      9, 12, 9, 7, 4, 2, 0, R,
    ],
    /** Counter-melody a third below, entering on the second half — the "catchy" bit. */
    harmony: [
      R, R, R, R, R, R, R, R,
      4, 7, 4, 2, 0, R, R, R,
    ],
    drums: true,
  },
};

let music = null; // { name, theme, step, nextTime, timer }

function kick(at) {
  tone(at, { freq: 150, to: 45, dur: 0.16, type: 'sine', gain: 0.3 });
}
function snare(at) {
  noise(at, { dur: 0.13, gain: 0.12, type: 'highpass', freq: 1400 });
}
function hat(at) {
  noise(at, { dur: 0.035, gain: 0.045, type: 'highpass', freq: 7000 });
}

function scheduleStep(theme, step, at) {
  const i = step % 16;
  const bar = Math.floor(i / 4) % theme.roots.length;
  const root = theme.roots[bar];

  // Bass: every eighth in the walk theme (that is the "walking" feel), on the bar in place.
  if (theme.drums || i % 4 === 0) {
    const wobble = theme.drums && i % 2 === 1 ? 7 : 0; // root then fifth
    tone(at, { freq: noteHz(root - 12 + wobble), ...theme.bass });
  }

  const note = theme.melody[i];
  if (note !== null && note !== undefined) {
    tone(at, { freq: noteHz(note + theme.lead.octave), ...theme.lead });
  }
  const harm = theme.harmony?.[i];
  if (harm !== null && harm !== undefined) {
    tone(at, { freq: noteHz(harm + theme.lead.octave - 12), ...theme.lead, gain: theme.lead.gain * 0.7 });
  }

  if (theme.drums) {
    if (i % 8 === 0 || i % 8 === 6) kick(at);
    if (i % 8 === 4) snare(at);
    if (i % 2 === 1) hat(at);
  }
}

function pump() {
  if (!music || !ctx) return;
  const { theme } = music;
  const stepDur = 60 / theme.bpm / 2;
  // Schedule a little ahead of the clock; setInterval alone is far too jittery for music.
  while (music.nextTime < ctx.currentTime + 0.25) {
    const swung = music.step % 2 === 1 ? stepDur * (theme.swing - 0.5) : 0;
    scheduleStep(theme, music.step, music.nextTime + swung);
    music.nextTime += stepDur;
    music.step++;
  }
}

/** Start (or switch to) a theme. Each starts at the top of its own phrase. */
export function playMusic(name) {
  if (!unlock()) return;
  const theme = THEMES[name];
  if (!theme) return stopMusic();
  if (music?.name === name) return;
  stopMusic();
  music = { name, theme, step: 0, nextTime: ctx.currentTime + 0.06, timer: null };
  music.timer = setInterval(pump, 40);
  pump();
}

export function stopMusic() {
  if (music?.timer) clearInterval(music.timer);
  music = null;
}

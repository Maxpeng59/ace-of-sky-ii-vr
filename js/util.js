// ============================================================================
//  Ace of Sky II — util.js
//  Math / RNG / DOM / audio helpers shared by every module.
//  (RNG + sfx adapted from the sibling project "Gravity Front".)
// ============================================================================

export const G = 9.80665;          // gravity m/s^2
export const RHO = 1.225;          // air density at sea level kg/m^3

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp  = (a, b, t) => a + (b - a) * t;
export const inv   = (t, a, b) => (b - a < 1e-9 ? 0 : clamp((t - a) / (b - a), 0, 1));
export const dampF = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
export const TAU = Math.PI * 2;

export function hashStr(s){
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export class RNG {
  constructor(seed){ this.f = mulberry32(typeof seed === 'string' ? hashStr(seed) : (seed >>> 0) || 1); }
  next(){ return this.f(); }
  range(a, b){ return a + (b - a) * this.f(); }
  int(a, b){ return Math.floor(this.range(a, b + 1)); }
  pick(arr){ return arr[Math.floor(this.f() * arr.length)]; }
  chance(p){ return this.f() < p; }
}

// ---------- DOM helpers ----------
export const $  = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export function el(tag, cls, text){
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
export function clear(node){ while (node && node.firstChild) node.removeChild(node.firstChild); }
export function show(node){ if (node) node.classList.remove('hidden'); }
export function hide(node){ if (node) node.classList.add('hidden'); }

export function fmtCr(n){ return Math.round(n).toLocaleString() + ' ☼'; }   // credits
export function fmtMass(kg){ return kg >= 1000 ? (kg / 1000).toFixed(2) + ' t' : Math.round(kg) + ' kg'; }
export function fmtNum(n, d = 0){ return Number(n).toLocaleString(undefined, { maximumFractionDigits: d }); }
export function fmtTime(s){ const m = Math.floor(s / 60), ss = Math.floor(s % 60); return m + ':' + String(ss).padStart(2, '0'); }

// ---------- tiny synth audio ----------
let actx = null;
export function audio(){
  if (!actx){ try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e){ return null; } }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
export function sfx(kind, vol = 0.2){
  const ctx = audio(); if (!ctx) return;
  const t = ctx.currentTime;
  const g = ctx.createGain(); g.connect(ctx.destination);
  const tone = (type, f0, f1, dur, v) => {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); o.start(t); o.stop(t + dur + 0.02);
  };
  if (kind === 'mg')            tone('square',   240, 60,  0.06, vol * 0.7);
  else if (kind === 'cannon')   tone('triangle', 180, 40,  0.18, vol);
  else if (kind === 'gatling')  tone('sawtooth', 320, 90,  0.05, vol * 0.6);
  else if (kind === 'missile')  tone('sawtooth', 600, 120, 0.4,  vol * 0.7);
  else if (kind === 'hit')      tone('square',   500, 120, 0.09, vol * 0.5);
  else if (kind === 'ui')       tone('sine',     880, 880, 0.08, vol * 0.4);
  else if (kind === 'lock')     tone('sine',     1200, 1200, 0.05, vol * 0.5);
  else if (kind === 'lockfull') tone('sine',     1600, 2000, 0.18, vol * 0.5);
  else if (kind === 'click')    tone('sine',     660, 660, 0.04, vol * 0.3);
  else if (kind === 'thrust')   tone('sawtooth', 90,  70,  0.2,  vol * 0.3);
  else if (kind === 'boom'){
    const len = 0.5, buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 2.2);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320;
    g.gain.setValueAtTime(vol * 1.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f); f.connect(g); src.start(t);
  }
}

// short-lived on-screen toast
export function toast(msg, kind = ''){
  let root = $('toast-root');
  if (!root){ root = el('div'); root.id = 'toast-root'; document.body.appendChild(root); }
  const t = el('div', 'toast ' + kind, msg);
  root.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, 2600);
}

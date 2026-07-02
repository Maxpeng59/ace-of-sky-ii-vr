// ============================================================================
//  Ace of Sky II — core.js
//  Global game state, persistence, the credit economy, the design library
//  (duplicate / save / delete) and shareable design codes (import / export).
//  Also ships the stock aircraft used as opponents and starter blueprints.
// ============================================================================
import { computeStats } from './physics.js';

const SAVE_KEY = 'aceofsky2.save.v1';

// ---- tiny event bus so modules talk without importing each other ----------
const listeners = {};
export const bus = {
  on(ev, fn){ (listeners[ev] ||= []).push(fn); return () => bus.off(ev, fn); },
  off(ev, fn){ if (listeners[ev]) listeners[ev] = listeners[ev].filter(f => f !== fn); },
  emit(ev, data){ (listeners[ev] || []).forEach(f => { try { f(data); } catch (e){ console.error(e); } }); },
};

export function uid(){ return 'd' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

// ---- design model ----------------------------------------------------------
//  AircraftDesign = { id, name, author, role, parts:[ {key,gx,gy,gz,rot} ], color }
export function newDesign(name = 'New Aircraft'){
  return { id: uid(), name, author: 'You', role: 'fighter', color: '#cfd8e3', parts: [] };
}
export function cloneDesign(d, suffix = ' Copy'){
  return { ...JSON.parse(JSON.stringify(d)), id: uid(), name: (d.name || 'Aircraft') + suffix };
}
export function statsOf(d){ return computeStats(d); }

// shareable code:  ASK2.<base64(json)>   (round-trips through clipboard/text)
export function exportCode(d){
  // [key, gx, gy, gz, rot(yaw), rx(pitch), rz(roll)] — rx/rz optional, back-compatible
  const lean = { n: d.name, a: d.author, r: d.role, c: d.color, p: d.parts.map(p => [p.key, p.gx, p.gy, p.gz, p.rot || 0, p.rx || 0, p.rz || 0]) };
  try { return 'ASK2.' + btoa(unescape(encodeURIComponent(JSON.stringify(lean)))); }
  catch (e){ return 'ASK2.' + btoa(JSON.stringify(lean)); }
}
export function importCode(str){
  if (!str) return null;
  str = String(str).trim();
  if (!str.startsWith('ASK2.')) return null;
  try {
    const json = decodeURIComponent(escape(atob(str.slice(5))));
    const lean = JSON.parse(json);
    return {
      id: uid(), name: lean.n || 'Imported', author: lean.a || 'Unknown', role: lean.r || 'fighter', color: lean.c || '#cfd8e3',
      parts: (lean.p || []).map(a => ({ key: a[0], gx: a[1], gy: a[2], gz: a[3], rot: a[4] || 0, rx: a[5] || 0, rz: a[6] || 0 })),
    };
  } catch (e){ console.warn('bad design code', e); return null; }
}

// ---- persistent game state -------------------------------------------------
export const State = {
  money: 18000,                 // campaign credits
  library: [],                  // AircraftDesign[]  (player's saved designs)
  settings: { sfx: true, invertY: false, masterVol: 0.8 },
  campaign: {
    started: false,
    onboard: 'intro',           // first-run flow: 'intro'→'tutorial'→'carrier'→'plane'→'done'
    day: 1,
    rank: 'Cadet',
    completed: [],              // mission ids done
    hangar: [],                 // owned design ids deployable in missions
    wingmen: [],                // [{designId, name, skill}]
    carrierId: null,            // owned carrier design id
    active: null,               // current sortie loadout
  },
  pvp: { lastFleet: [], budget: 60000, designSeconds: 300 },
};

export function save(){
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({
    money: State.money, library: State.library, settings: State.settings, campaign: State.campaign, pvp: State.pvp,
  })); bus.emit('saved'); } catch (e){ console.warn('save failed', e); }
}
export function load(){
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw){ const s = JSON.parse(raw); Object.assign(State, s); }
  } catch (e){ console.warn('load failed', e); }
  if (!State.library || State.library.length === 0) State.library = STOCK_DESIGNS.map(d => cloneDesign(d, ''));
  bus.emit('loaded');
}
export function resetSave(){ localStorage.removeItem(SAVE_KEY); }

// ---- economy ---------------------------------------------------------------
export function canAfford(n){ return State.money >= n; }
export function spend(n){ if (State.money < n) return false; State.money -= n; bus.emit('money', State.money); save(); return true; }
export function earn(n){ State.money += n; bus.emit('money', State.money); save(); }

// ---- library ops -----------------------------------------------------------
export function libGet(id){ return State.library.find(d => d.id === id); }
export function libSave(d){
  const i = State.library.findIndex(x => x.id === d.id);
  if (i >= 0) State.library[i] = d; else State.library.push(d);
  save(); bus.emit('library');
}
export function libDelete(id){ State.library = State.library.filter(d => d.id !== id); save(); bus.emit('library'); }
export function libDuplicate(id){ const d = libGet(id); if (!d) return null; const c = cloneDesign(d); State.library.push(c); save(); bus.emit('library'); return c; }

// ============================================================================
//  STOCK AIRCRAFT  — valid part layouts that actually fly (opponents + starters)
//  forward = +Z; gz increases toward the nose.
// ============================================================================
const mk = (key, gx, gy, gz, rot = 0) => ({ key, gx, gy, gz, rot });

// Player-supplied finished designs — shareable codes carry the full layout incl. pitch/roll (rx/rz).
const CODE_FALCON16 = 'ASK2.eyJuIjoiTmV3IEFpcmNyYWZ0IiwiYSI6IllvdSIsInIiOiJmaWdodGVyIiwiYyI6IiNjZmQ4ZTMiLCJwIjpbWyJjbWRhcm13cG5fY21kX2Nhbm9weV9hcm1vcmVkX2EzIiwwLDAsLTEsMCwwLDBdLFsiZnVzZWxhZ2VfcyIsMCwwLDEsMCwwLDBdLFsic3RydWN0dXJlX25vc2VfYzEiLDAsMCwzLDAsMCwwXSxbImZ1ZWxfZmxhdF9zMiIsMCwwLC00LDAsMCwwXSxbImpldF9iYXNpYyIsLTEsMCwtMiwwLDAsMF0sWyJqZXRfYmFzaWMiLDEsMCwtMiwwLDAsMF0sWyJrc3Bfc3dlcHRfd2luZ3MiLDAsMCwtNCwwLDAsMF0sWyJrc3Bfc3dlcHRfd2luZ3MiLC0zLDAsLTQsMCwwLDBdLFsia3NwX3RhaWxfZmluIiwxLDAsLTQsMCwwLDBdLFsia3NwX3RhaWxfZmluIiwtMSwwLC00LDAsMCwwXSxbImtzcF9lbGV2b25fMSIsLTIsMCwtNCwyLDAsMF0sWyJrc3BfZWxldm9uXzEiLC0zLDAsLTQsMiwwLDBdLFsia3NwX2VsZXZvbl8xIiwyLDAsLTQsMiwwLDBdLFsia3NwX2VsZXZvbl8xIiwxLDAsLTQsMiwwLDBdLFsia3NwX3N0YW5kYXJkX2NhbmFyZCIsLTMsMCwtNCwyLDAsMF0sWyJrc3Bfc3RhbmRhcmRfY2FuYXJkIiwxLDAsLTQsMiwwLDBdLFsiZmxhcmUiLDAsMSwtNCwwLDAsMl0sWyJjbWRhcm13cG5fYXJtX21lZGl1bV9iMyIsMCwwLC00LDAsMCwwXSxbImd1bl9tZyIsLTEsMCwtMiwwLDAsMF0sWyJndW5fbWciLDEsMCwtMiwwLDAsMF0sWyJtaXNzaWxlX3JhZGFyIiwtMywwLC00LDAsMCwwXSxbIm1pc3NpbGVfcmFkYXIiLDMsMCwtNCwwLDAsMF0sWyJtaXNzaWxlX2xyYWFtIiwtMiwwLC00LDAsMCwwXSxbIm1pc3NpbGVfbHJhYW0iLDIsMCwtNCwwLDAsMF1dfQ==';
const CODE_CARRIER = 'ASK2.eyJuIjoiTmV3IEFpcmNyYWZ0IiwiYSI6IllvdSIsInIiOiJmaWdodGVyIiwiYyI6IiNjOWQzZGUiLCJwIjpbWyJmdWVsX2ZsYXRfbTIiLC0xLDAsLTMsMCwwLDBdLFsiZnVlbF9mbGF0X20yIiwtMSwwLC0xLDAsMCwwXSxbImZ1ZWxfZmxhdF9tMiIsLTEsMCwxLDAsMCwwXSxbImZ1ZWxfZmxhdF9tMiIsLTEsMCwzLDAsMCwwXSxbImZ1ZWxfZmxhdF9tMiIsLTMsMCwtMywwLDAsMF0sWyJmdWVsX2ZsYXRfbTIiLC0zLDAsLTEsMCwwLDBdLFsiZnVlbF9mbGF0X20yIiwtMywwLDEsMCwwLDBdLFsiZnVlbF9mbGF0X20yIiwtMywwLDMsMCwwLDBdLFsiZnVlbF9mbGF0X20yIiwtMywwLC01LDAsMCwwXSxbImZ1ZWxfZmxhdF9tMiIsLTEsMCwtNSwwLDAsMF0sWyJmdWVsX2ZsYXRfbDEiLC0yLDAsNSwwLDAsMF0sWyJmdWVsX2ZsYXRfbTIiLC0xLDAsNywwLDAsMF0sWyJmdWVsX2ZsYXRfbTIiLC0xLDAsOSwwLDAsMF0sWyJmdWVsX2ZsYXRfczIiLDAsMCwxMSwwLDAsMF0sWyJmdWVsX2ZsYXRfczIiLDAsMSwtNSwwLDAsMF0sWyJmdWVsX2ZsYXRfczIiLDAsMSwtMywwLDAsMF0sWyJmdWVsX2ZsYXRfczIiLDAsMSwtMSwwLDAsMF0sWyJmdWVsX2ZsYXRfczEiLC0xLDEsLTUsMCwwLDBdLFsiZnVlbF9mbGF0X3MxIiwtMSwxLC00LDAsMCwwXSxbImZ1ZWxfZmxhdF9zMSIsLTEsMSwtMywwLDAsMF0sWyJmdWVsX2ZsYXRfczEiLDAsMiwtNSwwLDAsMF0sWyJjbWRhcm13cG5fY21kX3Byb2JlX2E3IiwwLDIsLTMsMCwwLDBdLFsiZW5naW5lX2pldF9zdXBlciIsMSwwLC01LDAsMCwwXSxbImVuZ2luZV9qZXRfc3VwZXIiLC00LDAsLTUsMCwwLDBdLFsiZW5naW5lX2Zhbl9nZWFyZWQiLDEsMCwtMywwLDAsMF0sWyJlbmdpbmVfZmFuX2dlYXJlZCIsLTQsMCwtMywwLDAsMF0sWyJ3aW5nbGV0IiwwLDMsLTUsMCwwLDBdLFsid2luZ19kZWx0YSIsMCwwLC0yLDAsMCwwXSxbIndpbmdfZGVsdGEiLC02LDAsLTIsMCwwLDBdLFsicmFkaWF0b3IiLC0xLDIsLTUsMSwwLDBdLFsic2Vuc29yX3JhZGFyIiwwLDMsLTQsMCwxLDBdLFsiY21kYXJtd3BuX2FybV9iZWxseV9iMTAiLC0xLDEsLTEsMCwwLDBdLFsiZ3VuX2ZsYWsiLDAsMiwtMSwwLDAsMF0sWyJndW5fZmxhayIsLTEsMiwtMSwwLDAsMF0sWyJjbWRhcm13cG5fZ3VuX3R1cnJldF9jOCIsLTQsMSwtNCwxLDEsMF0sWyJjbWRhcm13cG5fZ3VuX3R1cnJldF9jOCIsLTQsMSwtMiwxLDEsMF0sWyJjbWRhcm13cG5fZ3VuX3R1cnJldF9jOCIsMCwyLC0yLDEsMSwwXSxbImNtZGFybXdwbl9ndW5fdHVycmV0X2Nhbm5vbl9jOSIsLTEsMCwyLDAsMCwwXSxbImNtZGFybXdwbl9ndW5fdHVycmV0X2Nhbm5vbl9jOSIsLTEsMCw0LDAsMCwwXSxbImNtZGFybXdwbl9ndW5fdHVycmV0X2Nhbm5vbl9jOSIsLTIsMSwtMywwLDAsMF0sWyJrc3BfZWxldm9uXzEiLC0xLDIsLTUsMiwwLDBdLFsia3NwX2VsZXZvbl8xIiwtMSwxLC01LDIsMCwwXV19';
function fromCode(id, name, role, code){
  const d = importCode(code) || { parts: [] };
  return { id, name, author: 'Factory', role, color: d.color || '#cfd8e3', parts: d.parts || [] };
}

export const STOCK_DESIGNS = [
  // Falcon — the player's finished "Falcon 16" (armoured canopy, swept wings, canards, twin MG + radar/LRAAM).
  fromCode('stock_falcon', 'Falcon', 'interceptor', CODE_FALCON16),
  // Fortress — heavy 4-engine strategic bomber. Deep wet-barrel body (fuel is INTERNAL, no
  // top bulge), long high-aspect wings spanning far past the hull, four podded engines, a
  // tall fin + wide tailplane, and a dorsal defensive turret. Span ≫ length = "it's big".
  { id: 'stock_fortress', name: 'Fortress', author: 'Factory', role: 'bomber', color: '#8a95a1', parts: [
    mk('cmdarmwpn_cmd_cabin_a11', -1, 0, 5), mk('structure_fus_b3', -1, 0, 2), mk('structure_fus_b3', -1, 0, -1), mk('structure_fus_b3', -1, 0, -4),
    mk('wing_long', 1, 1, 0), mk('wing_long', 5, 1, 0), mk('wing_long', -5, 1, 0), mk('wing_long', -9, 1, 0),
    mk('jet_basic', 2, 0, 2), mk('jet_basic', 6, 0, 2), mk('jet_basic', -3, 0, 2), mk('jet_basic', -7, 0, 2),
    mk('tail_v', 0, 2, -4), mk('tail_v', 0, 4, -4), mk('tail_h', -2, 1, -4), mk('tail_h', 0, 1, -4),
    mk('cmdarmwpn_gun_turret_c8', 0, 2, 3),
    mk('bomb_heavy', 0, -1, -1), mk('bomb', 0, -1, -3), mk('bomb', -1, -1, -3),
  ] },
  // Goliath — A-10-style heavy gunship. Armoured 2.5m cockpit, big belly cannon, STRAIGHT
  // shoulder wings, two engines podded HIGH and AFT (the A-10 signature), twin splayed tails,
  // and a heavy load of bombs slung under the wings. Built fat and slab-sided.
  { id: 'stock_goliath', name: 'Goliath', author: 'Factory', role: 'heavy', color: '#6f7a86', parts: [
    mk('cmdarmwpn_cmd_canopy_heavy_a13', -1, 0, 4), mk('gun_gatling', 0, -1, 5),
    mk('structure_fus_b3', -1, 0, 1), mk('structure_fus_b3', -1, 0, -2),
    mk('wing_long', 1, 0, 0), mk('wing_long', -5, 0, 0),
    mk('jet_basic', 1, 2, -2), mk('jet_basic', -2, 2, -2),
    mk('tail_h', -2, 1, -3), mk('tail_h', 0, 1, -3), mk('tail_v', 1, 2, -3), mk('tail_v', -2, 2, -3),
    mk('bomb', 1, -1, 0), mk('bomb', 3, -1, 0), mk('bomb', -2, -1, 0), mk('bomb', -4, -1, 0),
    mk('sensor_radar', 0, 2, 1),
  ] },
  // Aegis Destroyer — a surface SHIP (role 'ship'): it steams across the water toward the
  // nearest enemy vessel and shells it with naval guns. Long steel hull + sharp bow, a twin
  // main turret forward, a windowed bridge with radar mast + CIWS amidships, an aft gun.
  { id: 'stock_destroyer', name: 'Aegis Destroyer', author: 'Factory', role: 'ship', color: '#566069', parts: [
    mk('nose_cone', 0, 0, 6),
    mk('structure_fus_a4', -1, 0, 3), mk('structure_fus_a4', -1, 0, 0), mk('structure_fus_a4', -1, 0, -3), mk('structure_fus_a4', -1, 0, -6),
    mk('cmdarmwpn_gun_naval_d3', -1, 2, 2),
    mk('cmdarmwpn_cmd_inline_a5', -1, 2, -1),
    mk('cmdarmwpn_gun_ciws_d1', 0, 4, 0),
    mk('sensor_radar', 0, 4, -2),
    mk('cmdarmwpn_gun_naval_d2', -1, 2, -6, 2),
  ] },
];

// The player's commissioned flat-deck carrier — the default carrier in missions/PvP when none chosen.
export const STOCK_CARRIER = fromCode('stock_carrier', 'Aegis Carrier', 'carrier', CODE_CARRIER);

export function stockGet(id){
  const d = id === 'stock_carrier' ? STOCK_CARRIER : STOCK_DESIGNS.find(s => s.id === id);
  return d ? cloneDesign(d, '') : null;
}

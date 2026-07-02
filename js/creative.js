// ============================================================================
//  Ace of Sky II — creative.js
//  The CREATIVE-mode battle-setup screen (#screen-creative).
//
//  A "skirmish builder": pick YOUR aircraft (from the library, or jump into the
//  Hangar to design/edit one), assemble an ENEMY FORCE (multiple rows of
//  design + count + skill), optional ALLIED WINGMEN, choose the BATTLEFIELD
//  (environment + objective) and toggle a generous pile of options, then LAUNCH
//  straight into Battle.start(...). When the fight ends we toast the result and
//  come right back here with the selection intact.
//
//  Composes:  Hangar (design/edit), Battle (the dogfight), Menu (back), core/State.
//  Owns the whole DOM inside #screen-creative; no 3D of its own (no engine use).
// ============================================================================
import {
  State, STOCK_DESIGNS, stockGet, libGet, libSave, cloneDesign, statsOf, newDesign,
} from './core.js';
import { statLine } from './physics.js';
import { $, el, clear, show, hide, toast, sfx, clamp, fmtTime } from './util.js';
import { Hangar } from './hangar.js';
import { Battle } from './battle.js';
import { Menu } from './menu.js';

// ----------------------------------------------------------------------------
//  Persistent setup model — survives leaving/returning to the screen so a player
//  can tweak, jump into the hangar, come back, and not lose their work.
// ----------------------------------------------------------------------------
const setup = {
  playerId: null,            // design id from State.library, or null
  playerDesign: null,        // resolved design object (clone) used for launch
  enemies: [],               // [{ designRef, count, skill }]   designRef = {kind:'stock'|'lib', id}
  allies: [],                // [{ designRef, count, skill }]
  env: 'day',                // 'day' | 'dusk' | 'night' | 'sea'
  objective: 'deathmatch',   // see OBJECTIVES
  surviveMin: 4,             // for the "survive" objective
  // toggles / options
  timeLimitOn: false,
  timeLimitMin: 8,
  friendlyCarrier: false,
  enemyCarrier: false,
  infiniteAmmo: false,
  lowFuel: false,
  noBoost: false,
  aceMode: false,            // every enemy at max skill
  startAirborne: true,
  showcaseLog: false,
};

const ENVS = [
  { key: 'day',   label: 'Clear Day',  glyph: '☀' },
  { key: 'dusk',  label: 'Dusk',       glyph: '🌆' },
  { key: 'night', label: 'Night',      glyph: '🌙' },
  { key: 'sea',   label: 'Open Sea',   glyph: '🌊' },
];

const OBJECTIVES = [
  { key: 'deathmatch',  label: 'Deathmatch',     desc: 'Destroy every enemy aircraft. Last one flying wins.' },
  { key: 'survive',     label: 'Survive',        desc: 'Stay alive for the set time while waves press the attack.' },
  { key: 'escort',      label: 'Escort Carrier', desc: 'Keep your friendly carrier afloat until the enemy is gone.' },
  { key: 'sink',        label: 'Sink Carrier',   desc: 'Send the enemy carrier to the bottom. Defenders will resist.' },
];

const CARRIER_NAME = 'Carrier';

// ----------------------------------------------------------------------------
//  DOM lifecycle
// ----------------------------------------------------------------------------
let root = null;       // #screen-creative
let keyHandler = null;

function hideOtherScreens(){
  for (const id of ['screen-menu', 'screen-campaign', 'screen-pvp', 'screen-hangar']){
    const n = $(id); if (n) hide(n);
  }
  const hud = $('hud'); if (hud) hide(hud);
}

export const Creative = {
  show(){
    root = $('screen-creative');
    if (!root){ console.warn('creative: #screen-creative missing'); return; }
    hideOtherScreens();
    show(root);
    ensureDefaults();
    render();
    // a couple of global shortcuts while on this screen
    keyHandler = (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'Escape') back();
      else if (e.key === 'Enter') launch();
    };
    addEventListener('keydown', keyHandler);
  },
  close(){
    if (keyHandler){ removeEventListener('keydown', keyHandler); keyHandler = null; }
    if (root){ hide(root); clear(root); }
  },
};

// On first ever entry: pick a sensible player aircraft + a starter enemy row.
function ensureDefaults(){
  if (!setup.playerId && State.library.length){
    setup.playerId = State.library[0].id;
  }
  if (setup.enemies.length === 0){
    setup.enemies.push(makeRow(stockRef('stock_falcon') || firstStockRef(), 3, 0.45));
  }
}

// ----------------------------------------------------------------------------
//  Design reference helpers — a row stores {kind,id}; we resolve to a real
//  design (and a fresh clone) only at launch / for stat display.
// ----------------------------------------------------------------------------
function stockRef(id){ return STOCK_DESIGNS.some(d => d.id === id) ? { kind: 'stock', id } : null; }
function firstStockRef(){ return { kind: 'stock', id: STOCK_DESIGNS[0].id }; }
function libRef(id){ return { kind: 'lib', id }; }

function makeRow(designRef, count, skill){
  return { designRef: designRef || firstStockRef(), count: clamp(count | 0, 1, 12), skill: clamp(skill, 0, 1) };
}

function resolveDesign(ref){
  if (!ref) return null;
  if (ref.kind === 'stock') return stockGet(ref.id) || (STOCK_DESIGNS[0] ? stockGet(STOCK_DESIGNS[0].id) : null);
  const d = libGet(ref.id);
  return d ? cloneDesign(d, '') : null;
}
function refName(ref){
  if (!ref) return '—';
  if (ref.kind === 'stock'){ const d = STOCK_DESIGNS.find(s => s.id === ref.id); return d ? d.name : '?'; }
  const d = libGet(ref.id); return d ? d.name : '(deleted)';
}
function refKey(ref){ return ref ? ref.kind + ':' + ref.id : ''; }

// flat list of pickable designs for the <select> dropdowns
function allPickable(){
  const out = [];
  for (const d of STOCK_DESIGNS) out.push({ ref: { kind: 'stock', id: d.id }, name: d.name + ' (stock)' });
  for (const d of State.library) out.push({ ref: { kind: 'lib', id: d.id }, name: d.name });
  return out;
}

// ----------------------------------------------------------------------------
//  Render — the whole screen, rebuilt from `setup` each time something changes.
// ----------------------------------------------------------------------------
function render(){
  clear(root);

  // ---- header / topbar ----
  const head = el('div', 'topbar');
  head.style.marginBottom = '18px';
  const back0 = el('button', 'btn small', '◂ BACK');
  back0.onclick = back;
  head.appendChild(back0);
  const ttl = el('div');
  ttl.innerHTML = '<span class="eyebrow">Skirmish Builder</span>';
  const h = el('div'); h.style.cssText = 'font-size:22px;font-weight:800;letter-spacing:.04em;';
  h.textContent = 'CREATIVE BATTLE';
  ttl.appendChild(h);
  head.appendChild(ttl);
  head.appendChild(el('div', 'spacer'));

  // live force-balance readout
  const balance = el('div', 'pill mono');
  const sumE = setup.enemies.reduce((a, r) => a + r.count, 0);
  const sumA = setup.allies.reduce((a, r) => a + r.count, 0) + (setup.playerId || setup.playerDesign ? 1 : 0);
  balance.textContent = `Friendly ${sumA}  vs  Enemy ${sumE}`;
  balance.style.color = sumE > sumA ? 'var(--bad)' : 'var(--good)';
  head.appendChild(balance);

  const launchBtn = el('button', 'btn accent big', '▶ LAUNCH');
  launchBtn.onclick = launch;
  head.appendChild(launchBtn);
  root.appendChild(head);

  // ---- body: 2-column responsive grid ----
  const body = el('div');
  body.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start;max-width:1300px;width:100%;margin:0 auto;';
  body.appendChild(buildPlayerPanel());
  body.appendChild(buildEnemyPanel());
  body.appendChild(buildAlliesPanel());
  body.appendChild(buildBattlefieldPanel());
  root.appendChild(body);

  // a tiny footer hint
  const hint = el('div', 'faint small mono');
  hint.style.cssText = 'text-align:center;margin:16px auto 6px;';
  hint.innerHTML = 'Press <span class="kbd">Enter</span> to launch · <span class="kbd">Esc</span> to go back';
  root.appendChild(hint);
}

// ---- 1) YOUR AIRCRAFT --------------------------------------------------------
function buildPlayerPanel(){
  const p = el('div', 'panel');
  p.appendChild(headingRow('Your Aircraft', '01'));

  const playerDesign = currentPlayerDesign();
  if (!State.library.length && !playerDesign){
    const empty = el('div', 'muted small');
    empty.textContent = 'No saved designs yet — design one to fly.';
    p.appendChild(empty);
  }

  // card grid of library designs (single-select)
  const grid = el('div', 'grid');
  grid.style.cssText = 'grid-template-columns:repeat(auto-fill,minmax(180px,1fr));margin-bottom:12px;';
  for (const d of State.library){
    const card = el('div', 'card' + (d.id === setup.playerId ? ' sel' : ''));
    card.style.cursor = 'pointer';
    const nm = el('div'); nm.style.cssText = 'font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:8px;';
    const sw = el('span'); sw.style.cssText = `width:12px;height:12px;border-radius:3px;background:${d.color || '#cfd8e3'};border:1px solid rgba(255,255,255,.2);`;
    nm.appendChild(sw); nm.appendChild(document.createTextNode(d.name));
    card.appendChild(nm);
    const sl = el('div', 'mono faint small'); sl.textContent = safeStatLine(d);
    card.appendChild(sl);
    card.onclick = () => { setup.playerId = d.id; setup.playerDesign = null; sfx('ui'); render(); };
    grid.appendChild(card);
  }
  p.appendChild(grid);

  // action row: design new / edit selected
  const acts = el('div', 'row');
  const editBtn = el('button', 'btn', '✎ EDIT IN HANGAR');
  editBtn.disabled = !playerDesign;
  editBtn.onclick = () => openHangarForPlayer(false);
  const newBtn = el('button', 'btn accent', '＋ DESIGN NEW');
  newBtn.onclick = () => openHangarForPlayer(true);
  acts.appendChild(editBtn);
  acts.appendChild(newBtn);
  p.appendChild(acts);

  // selected aircraft full stats
  if (playerDesign){
    const st = statsOf(playerDesign);
    const box = el('div', 'panel tight');
    box.style.marginTop = '12px';
    const t = el('div'); t.style.cssText = 'font-weight:700;margin-bottom:6px;';
    t.textContent = 'Flying: ' + playerDesign.name;
    box.appendChild(t);
    box.appendChild(statsGrid(st));
    if (!st.ok){
      const w = el('div', 'warns'); w.innerHTML = '<span class="err">⚠ This design has errors and may not fly well.</span>';
      box.appendChild(w);
    }
    p.appendChild(box);
  }
  return p;
}

function currentPlayerDesign(){
  if (setup.playerDesign) return setup.playerDesign;
  if (setup.playerId){ const d = libGet(setup.playerId); return d || null; }
  return null;
}

// ---- 2) ENEMY FORCE ----------------------------------------------------------
function buildEnemyPanel(){
  const p = el('div', 'panel');
  const hr = headingRow('Enemy Force', '02');
  p.appendChild(hr);

  const list = el('div', 'list');
  if (!setup.enemies.length){
    list.appendChild(mutedRow('No enemies — add at least one squadron.'));
  }
  setup.enemies.forEach((row, i) => list.appendChild(forceRow(row, i, setup.enemies, true)));
  p.appendChild(list);

  const acts = el('div', 'row'); acts.style.marginTop = '10px';
  const add = el('button', 'btn', '＋ ADD SQUADRON');
  add.onclick = () => { setup.enemies.push(makeRow(firstStockRef(), 2, 0.5)); sfx('ui'); render(); };
  acts.appendChild(add);

  const preset = el('button', 'btn ghost', '⚑ STANDARD SQUADRON');
  preset.title = 'Quick-fill a balanced enemy wing';
  preset.onclick = () => {
    setup.enemies = [
      makeRow(stockRef('stock_falcon') || firstStockRef(), 4, 0.45),
      makeRow(stockRef('stock_falcon') || firstStockRef(), 2, 0.6),
    ];
    sfx('ui'); toast('Standard squadron loaded', 'good'); render();
  };
  acts.appendChild(preset);

  const clr = el('button', 'btn ghost small', 'clear');
  clr.onclick = () => { setup.enemies = []; sfx('click'); render(); };
  acts.appendChild(clr);
  p.appendChild(acts);
  return p;
}

// ---- 3) ALLIED WINGMEN -------------------------------------------------------
function buildAlliesPanel(){
  const p = el('div', 'panel');
  p.appendChild(headingRow('Allied Wingmen', '03'));
  const sub = el('div', 'muted small'); sub.style.marginBottom = '8px';
  sub.textContent = 'Optional friendly AI flying alongside you.';
  p.appendChild(sub);

  const list = el('div', 'list');
  if (!setup.allies.length) list.appendChild(mutedRow('Flying solo — add wingmen if you like.'));
  setup.allies.forEach((row, i) => list.appendChild(forceRow(row, i, setup.allies, false)));
  p.appendChild(list);

  const acts = el('div', 'row'); acts.style.marginTop = '10px';
  const add = el('button', 'btn', '＋ ADD WINGMEN');
  add.onclick = () => { setup.allies.push(makeRow(stockRef('stock_falcon') || firstStockRef(), 1, 0.7)); sfx('ui'); render(); };
  acts.appendChild(add);
  if (setup.allies.length){
    const clr = el('button', 'btn ghost small', 'clear');
    clr.onclick = () => { setup.allies = []; sfx('click'); render(); };
    acts.appendChild(clr);
  }
  p.appendChild(acts);
  return p;
}

// shared row used by both enemy & ally lists
function forceRow(row, i, arr, isEnemy){
  const r = el('div', 'list-row');
  r.style.cssText = 'flex-wrap:wrap;gap:10px;align-items:flex-end;';

  // design picker
  const dl = el('label', 'field'); dl.textContent = 'Aircraft';
  dl.style.flex = '1 1 160px';
  const sel = el('select');
  const opts = allPickable();
  for (const o of opts){
    const opt = el('option'); opt.value = refKey(o.ref); opt.textContent = o.name;
    if (refKey(o.ref) === refKey(row.designRef)) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.onchange = () => {
    const found = opts.find(o => refKey(o.ref) === sel.value);
    if (found) row.designRef = found.ref;
    render();
  };
  dl.appendChild(sel);
  r.appendChild(dl);

  // count stepper
  const cl = el('label', 'field'); cl.textContent = 'Count';
  cl.style.flex = '0 0 92px';
  const cnt = el('input'); cnt.type = 'number'; cnt.min = '1'; cnt.max = '12'; cnt.value = String(row.count);
  cnt.oninput = () => { row.count = clamp(parseInt(cnt.value, 10) || 1, 1, 12); };
  cnt.onchange = () => { cnt.value = String(row.count); updateBalanceOnly(); };
  cl.appendChild(cnt);
  r.appendChild(cl);

  // skill slider — label carries a live text node we update on input
  const sk = el('label', 'field');
  sk.style.flex = '1 1 140px';
  const skTxt = document.createTextNode('Skill ' + skillName(row.skill));
  const slider = el('input', 'range'); slider.type = 'range'; slider.min = '0'; slider.max = '1'; slider.step = '0.05';
  slider.value = String(row.skill);
  slider.oninput = () => { row.skill = parseFloat(slider.value); skTxt.textContent = 'Skill ' + skillName(row.skill); };
  sk.appendChild(skTxt); sk.appendChild(slider);
  r.appendChild(sk);

  // stat line for the picked design
  const stat = el('div', 'mono faint small');
  stat.style.cssText = 'flex:1 1 100%;';
  const d = resolveDesign(row.designRef);
  stat.textContent = d ? safeStatLine(d) : 'invalid design';
  r.appendChild(stat);

  // remove
  const del = el('button', 'btn danger small', '✕');
  del.title = 'Remove row';
  del.onclick = () => { arr.splice(i, 1); sfx('click'); render(); };
  r.appendChild(del);

  return r;
}

// only refresh the header balance pill without a full re-render (cheap on count change)
function updateBalanceOnly(){ render(); }

// ---- 4) BATTLEFIELD ----------------------------------------------------------
function buildBattlefieldPanel(){
  const p = el('div', 'panel');
  p.appendChild(headingRow('Battlefield', '04'));

  // environment pills
  p.appendChild(subhead('Environment'));
  const envRow = el('div', 'pill-row');
  for (const e of ENVS){
    const pill = el('div', 'pill' + (setup.env === e.key ? ' sel' : ''), e.glyph + ' ' + e.label);
    pill.onclick = () => { setup.env = e.key; sfx('ui'); render(); };
    envRow.appendChild(pill);
  }
  p.appendChild(envRow);

  // objective pills + description
  p.appendChild(subhead('Objective'));
  const objRow = el('div', 'pill-row');
  for (const o of OBJECTIVES){
    const pill = el('div', 'pill' + (setup.objective === o.key ? ' sel' : ''), o.label);
    pill.onclick = () => {
      setup.objective = o.key;
      // auto-enable the relevant carrier toggle for convenience
      if (o.key === 'escort') setup.friendlyCarrier = true;
      if (o.key === 'sink') setup.enemyCarrier = true;
      sfx('ui'); render();
    };
    objRow.appendChild(pill);
  }
  p.appendChild(objRow);
  const objDesc = el('div', 'muted small'); objDesc.style.margin = '6px 0 4px';
  objDesc.textContent = (OBJECTIVES.find(o => o.key === setup.objective) || {}).desc || '';
  p.appendChild(objDesc);

  // survive-minutes (only relevant to "survive")
  if (setup.objective === 'survive'){
    const sl = el('label', 'field'); sl.style.maxWidth = '220px';
    const txt = document.createTextNode('Survive for ' + setup.surviveMin + ' min');
    sl.appendChild(txt);
    const rng = el('input', 'range'); rng.type = 'range'; rng.min = '1'; rng.max = '15'; rng.step = '1'; rng.value = String(setup.surviveMin);
    rng.oninput = () => { setup.surviveMin = parseInt(rng.value, 10); txt.textContent = 'Survive for ' + setup.surviveMin + ' min'; };
    sl.appendChild(rng);
    p.appendChild(sl);
  }

  // ---- the big toggle grid -------------------------------------------------
  p.appendChild(subhead('Options'));
  const tg = el('div');
  tg.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;';

  tg.appendChild(toggle('friendlyCarrier', 'Friendly carrier', 'Spawn an allied carrier in the battlespace.'));
  tg.appendChild(toggle('enemyCarrier', 'Enemy carrier', 'Spawn a hostile carrier to attack/defend.'));
  tg.appendChild(toggle('infiniteAmmo', 'Infinite ammo', 'Never run dry — blaze away forever.'));
  tg.appendChild(toggle('lowFuel', 'Low-fuel challenge', 'Start with a quarter tank. Manage it.'));
  tg.appendChild(toggle('noBoost', 'No afterburner', 'Disable boost for everyone.'));
  tg.appendChild(toggle('aceMode', 'Ace enemies', 'Force every hostile to maximum skill.'));
  tg.appendChild(toggle('startAirborne', 'Start airborne', 'Begin already in the air at altitude.'));
  tg.appendChild(toggle('showcaseLog', 'Verbose kill log', 'Print combat events to the console.'));
  p.appendChild(tg);

  // time-limit row (separate because it carries a value)
  const tlRow = el('div', 'row'); tlRow.style.marginTop = '10px';
  const tlTog = toggle('timeLimitOn', 'Time limit', 'End the battle after a fixed duration.');
  tlTog.style.flex = '1 1 auto';
  tlRow.appendChild(tlTog);
  if (setup.timeLimitOn){
    const tlLab = el('label', 'field'); tlLab.style.flex = '0 0 130px';
    const t = document.createTextNode(setup.timeLimitMin + ' min');
    tlLab.appendChild(t);
    const rng = el('input', 'range'); rng.type = 'range'; rng.min = '2'; rng.max = '30'; rng.step = '1'; rng.value = String(setup.timeLimitMin);
    rng.oninput = () => { setup.timeLimitMin = parseInt(rng.value, 10); t.textContent = setup.timeLimitMin + ' min'; };
    tlLab.appendChild(rng);
    tlRow.appendChild(tlLab);
  }
  p.appendChild(tlRow);

  // summary line
  const sum = el('div', 'panel tight mono small');
  sum.style.cssText = 'margin-top:12px;color:var(--ink-dim);line-height:1.7;';
  sum.appendChild(summaryLine());
  p.appendChild(sum);

  return p;
}

// a checkbox-style toggle bound to a boolean key of `setup`
function toggle(key, label, tip){
  const t = el('div');
  t.className = 'card';
  t.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;padding:9px 11px;' +
    (setup[key] ? 'border-color:var(--accent);box-shadow:inset 0 0 24px rgba(57,208,255,.08);' : '');
  const box = el('span');
  box.style.cssText = `width:18px;height:18px;border-radius:4px;flex:none;border:1px solid var(--edge2);display:flex;align-items:center;justify-content:center;font-size:12px;color:#04121c;` +
    (setup[key] ? 'background:var(--accent);border-color:transparent;' : 'background:#0a121e;');
  box.textContent = setup[key] ? '✓' : '';
  const lab = el('div');
  const lt = el('div', '', label); lt.style.cssText = 'font-size:13px;font-weight:600;';
  const ld = el('div', 'faint small', tip); ld.style.cssText = 'font-size:11px;margin-top:1px;';
  lab.appendChild(lt); lab.appendChild(ld);
  t.appendChild(box); t.appendChild(lab);
  t.title = tip;
  t.onclick = () => { setup[key] = !setup[key]; sfx('click'); render(); };
  return t;
}

// ----------------------------------------------------------------------------
//  Small UI helpers
// ----------------------------------------------------------------------------
function headingRow(title, num){
  const r = el('div');
  r.style.cssText = 'display:flex;align-items:baseline;gap:10px;margin-bottom:10px;';
  const n = el('span', 'mono'); n.style.cssText = 'color:var(--accent);font-size:12px;letter-spacing:.2em;';
  n.textContent = num;
  const h = el('h2'); h.style.margin = '0'; h.textContent = title;
  r.appendChild(n); r.appendChild(h);
  return r;
}
function subhead(text){ const h = el('h3', '', text); return h; }
function mutedRow(text){ const r = el('div', 'muted small'); r.style.padding = '6px 2px'; r.textContent = text; return r; }

function skillName(s){
  if (s < 0.2) return '· Rookie';
  if (s < 0.4) return '· Trained';
  if (s < 0.6) return '· Veteran';
  if (s < 0.8) return '· Elite';
  return '· Ace';
}

function safeStatLine(d){
  try { return statLine(statsOf(d)); }
  catch (e){ return 'unflyable'; }
}

// a compact stats grid using the .stats design-system class
function statsGrid(s){
  const g = el('div', 'stats');
  const add = (k, v, cls) => {
    const kk = el('div', 'k', k); const vv = el('div', 'v' + (cls ? ' ' + cls : ''), v);
    g.appendChild(kk); g.appendChild(vv);
  };
  const kmh = (mps) => Math.round(mps * 3.6) + ' km/h';
  add('Mass', (s.mass / 1000).toFixed(2) + ' t');
  add('TWR', s.twr.toFixed(2), s.twr < 0.8 ? 'warn' : 'good');
  add('Top speed', kmh(s.vMaxBoost || s.vMax));
  add('Stall', kmh(s.vStall), 'warn');
  add('Durability', Math.round(s.durability) + ' HP');
  add('Agility', Math.round((s.agility.pitch + s.agility.roll + s.agility.yaw) / 3) + '°/s');
  add('Endurance', fmtTime(s.endurance));
  add('Weapons', String((s.weapons || []).length));
  return g;
}

function summaryLine(){
  const frag = document.createDocumentFragment();
  const env = (ENVS.find(e => e.key === setup.env) || {}).label || setup.env;
  const obj = (OBJECTIVES.find(o => o.key === setup.objective) || {}).label || setup.objective;
  const sumE = setup.enemies.reduce((a, r) => a + r.count, 0);
  const sumA = setup.allies.reduce((a, r) => a + r.count, 0);
  const lines = [
    `Theatre: ${env}`,
    `Objective: ${obj}` + (setup.objective === 'survive' ? ` (${setup.surviveMin} min)` : ''),
    `Hostiles: ${sumE}  ·  Wingmen: ${sumA}`,
  ];
  const opts = [];
  if (setup.timeLimitOn) opts.push(`time limit ${setup.timeLimitMin}m`);
  if (setup.friendlyCarrier) opts.push('friendly carrier');
  if (setup.enemyCarrier) opts.push('enemy carrier');
  if (setup.infiniteAmmo) opts.push('∞ ammo');
  if (setup.lowFuel) opts.push('low fuel');
  if (setup.noBoost) opts.push('no boost');
  if (setup.aceMode) opts.push('ace enemies');
  if (setup.startAirborne) opts.push('airborne start');
  if (opts.length) lines.push('Options: ' + opts.join(', '));
  lines.forEach((ln, i) => {
    if (i) frag.appendChild(el('br'));
    frag.appendChild(document.createTextNode(ln));
  });
  return frag;
}

// ----------------------------------------------------------------------------
//  Hangar integration — design new / edit current player aircraft
// ----------------------------------------------------------------------------
function openHangarForPlayer(isNew){
  // hide ourselves while the hangar takes over the screen
  hide(root);

  let working;
  if (isNew){
    working = newDesign('My Aircraft');
  } else {
    const cur = currentPlayerDesign();
    working = cur ? cloneDesign(cur, '') : newDesign('My Aircraft');
    if (cur) working.id = cur.id;  // keep id so save overwrites the same library entry
  }

  const done = (design) => {
    // persist into library and select it
    libSave(design);
    setup.playerId = design.id;
    setup.playerDesign = null;
    sfx('ui');
    toast('Saved "' + design.name + '" to your library', 'good');
    returnFromHangar();
  };

  Hangar.open({
    design: working,
    title: isNew ? 'Design New Aircraft' : 'Edit ' + working.name,
    actions: [
      { label: '◂ DONE', kind: 'accent', fn: (design) => done(design) },
    ],
    onExit: (design) => {
      // EXIT without saving: keep prior selection, just come back
      returnFromHangar();
    },
  });
}

function returnFromHangar(){
  const hangarRoot = $('screen-hangar');
  if (hangarRoot) hide(hangarRoot);
  show(root);
  render();
}

// ----------------------------------------------------------------------------
//  Build the Battle config and launch
// ----------------------------------------------------------------------------
function buildConfig(){
  const player = currentPlayerDesign();
  if (!player) return { error: 'Choose or design your aircraft first.' };
  const playerClone = cloneDesign(player, '');

  // enemies: expand rows into the {design,count,skill} shape Battle expects
  const enemies = [];
  for (const row of setup.enemies){
    const d = resolveDesign(row.designRef);
    if (!d) continue;
    const skill = setup.aceMode ? 1 : clamp(row.skill, 0, 1);
    enemies.push({ design: d, count: clamp(row.count | 0, 1, 12), skill });
  }

  // allies: Battle.config.allies is a flat array of design objects (one per craft)
  const allies = [];
  for (const row of setup.allies){
    const base = resolveDesign(row.designRef);
    if (!base) continue;
    const n = clamp(row.count | 0, 1, 12);
    for (let i = 0; i < n; i++){
      const c = cloneDesign(base, '');
      c._skill = clamp(row.skill, 0, 1);   // hint for friendly AI (ignored if unused)
      allies.push(c);
    }
  }

  // objective
  let objective;
  switch (setup.objective){
    case 'survive':
      objective = { type: 'survive', minutes: setup.surviveMin, seconds: setup.surviveMin * 60, label: `Survive ${setup.surviveMin} min` };
      break;
    case 'escort':
      objective = { type: 'escort', label: 'Protect the carrier' };
      break;
    case 'sink':
      objective = { type: 'sink', label: 'Sink the enemy carrier' };
      break;
    default:
      objective = { type: 'deathmatch', label: 'Destroy all enemies' };
  }

  // carriers — explicit toggles win; objectives force the relevant one on.
  const wantFriendlyCarrier = setup.friendlyCarrier || setup.objective === 'escort';
  const wantEnemyCarrier = setup.enemyCarrier || setup.objective === 'sink';
  const carrier = wantFriendlyCarrier ? makeCarrierDesign('Friendly ' + CARRIER_NAME, '#7fb6e6') : null;
  const enemyCarrier = wantEnemyCarrier ? makeCarrierDesign('Enemy ' + CARRIER_NAME, '#c98a8a') : null;

  const timeLimit = setup.timeLimitOn ? setup.timeLimitMin * 60
    : (setup.objective === 'survive' ? setup.surviveMin * 60 : null);

  return {
    player: playerClone,
    allies,
    enemies,
    env: setup.env,
    objective,
    timeLimit,
    carrier,
    enemyCarrier,
    // pass-through customization flags Battle can honor
    options: {
      infiniteAmmo: setup.infiniteAmmo,
      lowFuel: setup.lowFuel,
      noBoost: setup.noBoost,
      startAirborne: setup.startAirborne,
      verboseLog: setup.showcaseLog,
    },
    // also flatten common toggles to top level for convenience/back-compat
    infiniteAmmo: setup.infiniteAmmo,
    lowFuel: setup.lowFuel,
    noBoost: setup.noBoost,
    startAirborne: setup.startAirborne,
    net: null,
    onEnd: (result) => onBattleEnd(result),
  };
}

// A carrier is just an aircraft design Battle can render/treat as a ship.
// We synthesize a long, heavy, wide flat-deck shape from stock parts.
function makeCarrierDesign(name, color){
  const parts = [];
  // long armored hull along +Z, a flat deck of fuselage segments + armor plate
  for (let z = -4; z <= 4; z++){
    parts.push({ key: 'fuselage_l', gx: 0, gy: 0, gz: z, rot: 0 });
    parts.push({ key: 'armor_plate', gx: 0, gy: 1, gz: z, rot: 0 });
  }
  for (let x = -2; x <= 2; x += 2){
    for (let z = -3; z <= 3; z += 2){
      parts.push({ key: 'armor_light', gx: x, gy: 0, gz: z, rot: 0 });
    }
  }
  // a defensive gun nest or two
  parts.push({ key: 'gun_gatling', gx: 2, gy: 1, gz: 3, rot: 0 });
  parts.push({ key: 'gun_gatling', gx: -2, gy: 1, gz: -3, rot: 0 });
  parts.push({ key: 'cockpit_heavy', gx: 2, gy: 2, gz: 0, rot: 0 });   // island/superstructure
  parts.push({ key: 'sensor_radar', gx: 2, gy: 3, gz: 0, rot: 0 });
  return { id: 'carrier_' + Math.random().toString(36).slice(2, 8), name, author: 'Fleet', role: 'carrier', color, parts, isCarrier: true };
}

function launch(){
  const cfg = buildConfig();
  if (cfg.error){ toast(cfg.error, 'bad'); sfx('lock'); return; }
  if (!cfg.enemies.length && !cfg.enemyCarrier){
    toast('Add at least one enemy or an enemy carrier.', 'warn'); sfx('lock'); return;
  }
  sfx('ui');
  // tear down our screen so Battle owns the view
  if (keyHandler){ removeEventListener('keydown', keyHandler); keyHandler = null; }
  hide(root);
  try {
    Battle.start(cfg);
  } catch (e){
    console.error('Battle.start failed', e);
    toast('Could not start battle: ' + (e && e.message ? e.message : 'error'), 'bad');
    // restore our screen
    show(root);
    keyHandler = (ev) => { if (ev.target && /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return; if (ev.key === 'Escape') back(); else if (ev.key === 'Enter') launch(); };
    addEventListener('keydown', keyHandler);
  }
}

function onBattleEnd(result){
  result = result || {};
  // toast the outcome and come back to the setup screen, selection intact
  const win = !!result.win;
  const bits = [];
  if (typeof result.kills === 'number') bits.push(result.kills + ' kills');
  if (typeof result.deaths === 'number') bits.push(result.deaths + ' losses');
  if (typeof result.time === 'number') bits.push(fmtTime(result.time));
  if (typeof result.score === 'number') bits.push('score ' + Math.round(result.score));
  const detail = bits.length ? '  (' + bits.join(' · ') + ')' : '';
  const reason = result.reason ? ' — ' + result.reason : '';
  toast((win ? '✔ VICTORY' : '✖ DEFEAT') + detail + reason, win ? 'good' : 'bad');
  sfx(win ? 'lockfull' : 'boom');

  // re-show our screen
  Creative.show();
}

// ----------------------------------------------------------------------------
//  Navigation
// ----------------------------------------------------------------------------
function back(){
  sfx('click');
  Creative.close();
  Menu.show();
}

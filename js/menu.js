// ============================================================================
//  Ace of Sky II — menu.js
//  The MAIN MENU (#screen-menu). Title block, the three mode entries
//  (Creative / Campaign / PvP), the Hangar/Library browser and the Settings
//  panel. Every other screen's BACK returns here via Menu.show().
//
//  Owns its own DOM completely: it rebuilds #screen-menu on every show() so
//  the library list and credit totals always reflect the latest State.
// ============================================================================
import * as THREE from 'three';
import {
  State, load, save, libGet, libSave, libDelete, libDuplicate,
  newDesign, STOCK_DESIGNS, resetSave, statsOf, bus,
} from './core.js';
import * as core from './core.js';
import { statLine } from './physics.js';
import {
  $, el, clear, show, hide, fmtCr, sfx, toast, clamp,
} from './util.js';
import { addEnterVRButton } from './vr.js';
import { Creative } from './creative.js';
import { Campaign } from './campaign.js';
import { Pvp } from './pvp.js';
import { Hangar } from './hangar.js';

// ---------------------------------------------------------------------------
//  Screen plumbing
// ---------------------------------------------------------------------------
const SCREEN_IDS = ['screen-menu', 'screen-creative', 'screen-campaign', 'screen-pvp', 'screen-hangar'];

// Hide every screen root, and the in-flight HUD, then reveal one.
function hideAllScreens(){
  for (const id of SCREEN_IDS){ const n = $(id); if (n) hide(n); }
  const hud = $('hud'); if (hud) hide(hud);
}
function revealScreen(id){
  hideAllScreens();
  const n = $(id); if (n) show(n);
  return n;
}

// little click helper so every button feels alive
function clickable(btn, fn){
  btn.addEventListener('click', (e) => {
    if (State.settings.sfx) sfx('click', 0.3);
    fn(e);
  });
  return btn;
}

// build a labelled <button class="btn …">
function mkBtn(label, cls, fn){
  const b = el('button', 'btn ' + (cls || ''), label);
  return clickable(b, fn);
}

// ---------------------------------------------------------------------------
//  Modal helper (uses #modal-root + .modal-bg/.modal from style.css)
// ---------------------------------------------------------------------------
function modal(buildInner){
  let root = $('modal-root');
  if (!root){ root = el('div'); root.id = 'modal-root'; document.body.appendChild(root); }
  const bg = el('div', 'modal-bg');
  const box = el('div', 'modal');
  bg.appendChild(box);
  const close = () => { bg.remove(); };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  buildInner(box, close);
  root.appendChild(bg);
  return close;
}

// confirm( {title, body, okLabel, danger}, onOk )
function confirmDialog({ title, body, okLabel = 'Confirm', danger = false }, onOk){
  modal((box, close) => {
    box.appendChild(el('h2', '', title));
    if (body){ const p = el('p', 'muted', body); p.style.lineHeight = '1.6'; box.appendChild(p); }
    const row = el('div', 'row'); row.style.marginTop = '18px'; row.style.justifyContent = 'flex-end';
    row.appendChild(mkBtn('Cancel', 'ghost', close));
    row.appendChild(mkBtn(okLabel, danger ? 'danger' : 'accent', () => { close(); onOk(); }));
    box.appendChild(row);
  });
}

// prompt-style textarea modal (used for Import code)
function importDialog(onCode){
  modal((box, close) => {
    box.appendChild(el('h2', '', 'Import design code'));
    const hint = el('p', 'muted small', 'Paste an ASK2.… share code below. It will be added to your library.');
    hint.style.lineHeight = '1.6';
    box.appendChild(hint);
    const ta = el('textarea');
    ta.style.width = '100%'; ta.style.minHeight = '110px'; ta.style.fontFamily = 'var(--mono)';
    ta.style.marginTop = '8px'; ta.placeholder = 'ASK2.eyJ…';
    box.appendChild(ta);
    const row = el('div', 'row'); row.style.marginTop = '16px'; row.style.justifyContent = 'flex-end';
    row.appendChild(mkBtn('Cancel', 'ghost', close));
    row.appendChild(mkBtn('Import', 'accent', () => { const v = ta.value; close(); onCode(v); }));
    box.appendChild(row);
    setTimeout(() => ta.focus(), 30);
  });
}

// ---------------------------------------------------------------------------
//  Decorative title background — a slow-drifting starfield on a 2D canvas.
//  Pure 2D context (NOT the shared WebGL renderer), runs only while the menu
//  is visible; torn down on hide so it never leaks frames into other screens.
// ---------------------------------------------------------------------------
let bgCanvas = null, bgRAF = 0, bgStars = null, bgT = 0;
function startBackdrop(host){
  stopBackdrop();
  const cv = el('canvas');
  cv.style.position = 'absolute'; cv.style.inset = '0'; cv.style.width = '100%'; cv.style.height = '100%';
  cv.style.zIndex = '0'; cv.style.pointerEvents = 'none'; cv.style.opacity = '0.55';
  host.appendChild(cv);
  bgCanvas = cv;
  const ctx = cv.getContext('2d');
  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.floor(cv.clientWidth * dpr));
    cv.height = Math.max(1, Math.floor(cv.clientHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  cv._resize = resize;
  window.addEventListener('resize', resize);
  // spawn stars in normalised [0,1] coordinates
  bgStars = [];
  for (let i = 0; i < 130; i++){
    bgStars.push({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7, s: Math.random() * 1.6 + 0.4 });
  }
  bgT = 0;
  const loop = () => {
    bgRAF = requestAnimationFrame(loop);
    bgT += 0.0025;
    const w = cv.clientWidth, h = cv.clientHeight;
    ctx.clearRect(0, 0, w, h);
    for (const st of bgStars){
      const px = ((st.x + bgT * st.z * 0.4) % 1) * w;
      const py = ((st.y + bgT * st.z * 0.12) % 1) * h;
      const a = 0.25 + st.z * 0.55;
      ctx.fillStyle = `rgba(150,200,255,${a.toFixed(3)})`;
      ctx.fillRect(px, py, st.s, st.s);
    }
  };
  loop();
}
function stopBackdrop(){
  if (bgRAF){ cancelAnimationFrame(bgRAF); bgRAF = 0; }
  if (bgCanvas){
    if (bgCanvas._resize) window.removeEventListener('resize', bgCanvas._resize);
    bgCanvas.remove(); bgCanvas = null;
  }
  bgStars = null;
}

// ---------------------------------------------------------------------------
//  Library card rendering
// ---------------------------------------------------------------------------
function roleLabel(d){ return (d.role || 'fighter'); }

function buildLibraryCard(d, rerender){
  const card = el('div', 'card');
  card.style.display = 'flex'; card.style.flexDirection = 'column'; card.style.gap = '8px';

  // header row: colour swatch + name + role tag
  const head = el('div', 'row');
  head.style.alignItems = 'center';
  const sw = el('div', 'part-swatch');
  sw.style.background = d.color || '#cfd8e3';
  head.appendChild(sw);
  const nameWrap = el('div', 'col');
  nameWrap.style.gap = '2px'; nameWrap.style.flex = '1';
  const nm = el('div', '', d.name || 'Aircraft');
  nm.style.fontWeight = '700'; nm.style.fontSize = '15px';
  nameWrap.appendChild(nm);
  const sub = el('div', 'faint small mono', (d.author || 'You') + ' · ' + (d.parts ? d.parts.length : 0) + ' parts');
  nameWrap.appendChild(sub);
  head.appendChild(nameWrap);
  const tag = el('span', 'tag', roleLabel(d));
  head.appendChild(tag);
  card.appendChild(head);

  // stat line + cost (computed; guard against malformed designs)
  let s = null;
  try { s = statsOf(d); } catch (e){ s = null; }
  const line = el('div', 'mono small muted', s ? statLine(s) : 'invalid design');
  card.appendChild(line);

  const cost = el('div', 'mono small');
  cost.style.color = 'var(--gold)';
  cost.textContent = s ? fmtCr(s.cost) : '—';
  card.appendChild(cost);

  if (s && (!s.ok || (s.errors && s.errors.length))){
    const warn = el('div', 'warns');
    warn.appendChild(el('div', 'err', '⚠ ' + ((s.errors && s.errors[0]) || 'will not fly')));
    card.appendChild(warn);
  }

  // actions
  const acts = el('div', 'row');
  acts.style.marginTop = '4px';
  acts.appendChild(mkBtn('Edit', 'small accent', () => editDesign(d.id, rerender)));
  acts.appendChild(mkBtn('Duplicate', 'small', () => {
    const c = libDuplicate(d.id);
    if (c) toast('Duplicated “' + c.name + '”', 'good');
    rerender();
  }));
  acts.appendChild(mkBtn('Export', 'small ghost', () => exportDesign(d)));
  acts.appendChild(mkBtn('Delete', 'small danger', () => {
    confirmDialog({
      title: 'Delete “' + (d.name || 'Aircraft') + '”?',
      body: 'This permanently removes the design from your library. This cannot be undone.',
      okLabel: 'Delete', danger: true,
    }, () => { libDelete(d.id); toast('Design deleted', 'warn'); rerender(); });
  }));
  card.appendChild(acts);

  return card;
}

// Open a library design in the hangar to edit; persist on exit.
function editDesign(id, rerender){
  const d = libGet(id);
  if (!d){ toast('Design not found', 'bad'); return; }
  // hangar edits the live object; libSave on done keeps it in the library.
  Hangar.open({
    design: d,
    title: 'EDIT · ' + (d.name || 'Aircraft'),
    onExit: (edited) => {
      if (edited){ libSave(edited); }
      Menu.show();
      if (rerender) { /* menu rebuilt by show(); nothing else needed */ }
    },
  });
}

// New aircraft → straight into the hangar; save into library on exit.
function newAircraft(){
  const d = newDesign();
  Hangar.open({
    design: d,
    title: 'NEW AIRCRAFT',
    onExit: (edited) => {
      // only persist if the player actually placed parts (avoid empty clutter)
      if (edited && edited.parts && edited.parts.length){ libSave(edited); toast('Saved “' + edited.name + '”', 'good'); }
      Menu.show();
    },
  });
}

// Export → show the share code in a copyable textarea.
function exportDesign(d){
  const code = core.exportCode(d);
  modal((box, close) => {
    box.appendChild(el('h2', '', 'Share code · ' + (d.name || 'Aircraft')));
    const hint = el('p', 'muted small', 'Copy this code and send it to a friend. They can Import it into their library.');
    hint.style.lineHeight = '1.6';
    box.appendChild(hint);
    const ta = el('textarea');
    ta.style.width = '100%'; ta.style.minHeight = '110px'; ta.style.fontFamily = 'var(--mono)';
    ta.style.marginTop = '8px'; ta.value = code; ta.readOnly = true;
    box.appendChild(ta);
    const row = el('div', 'row'); row.style.marginTop = '16px'; row.style.justifyContent = 'flex-end';
    row.appendChild(mkBtn('Copy', 'accent', () => {
      ta.select();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(code); }
        else { document.execCommand('copy'); }
        toast('Copied to clipboard', 'good');
      } catch (e){ toast('Select & copy manually', 'warn'); }
    }));
    row.appendChild(mkBtn('Close', 'ghost', close));
    box.appendChild(row);
    setTimeout(() => { ta.focus(); ta.select(); }, 30);
  });
}

// Import → parse code via core, push to library.
function importAircraft(rerender){
  importDialog((code) => {
    if (!code || !code.trim()){ return; }
    const d = core.importCode(code);
    if (!d){ toast('Invalid design code', 'bad'); return; }
    libSave(d);
    toast('Imported “' + d.name + '”', 'good');
    if (rerender) rerender();
  });
}

// ---------------------------------------------------------------------------
//  Settings panel
// ---------------------------------------------------------------------------
function buildSettings(){
  const panel = el('div', 'panel');
  panel.style.minWidth = '320px';
  panel.appendChild(el('h3', '', 'Settings'));

  const set = State.settings;

  // a reusable toggle row built from a .pill that flips .sel
  const toggleRow = (label, get, setFn, desc) => {
    const wrap = el('div', 'col');
    wrap.style.gap = '4px'; wrap.style.marginBottom = '12px';
    const row = el('div', 'row');
    row.style.justifyContent = 'space-between'; row.style.alignItems = 'center';
    const lab = el('div', '', label); lab.style.fontSize = '14px';
    row.appendChild(lab);
    const pill = el('button', 'pill' + (get() ? ' sel' : ''), get() ? 'ON' : 'OFF');
    clickable(pill, () => {
      const nv = !get();
      setFn(nv);
      pill.textContent = nv ? 'ON' : 'OFF';
      pill.classList.toggle('sel', nv);
      save();
    });
    row.appendChild(pill);
    wrap.appendChild(row);
    if (desc){ const d = el('div', 'faint small', desc); wrap.appendChild(d); }
    return wrap;
  };

  panel.appendChild(toggleRow(
    'Sound effects', () => !!set.sfx, (v) => { set.sfx = v; if (v) sfx('ui', 0.4); },
    'Gunfire, locks, UI clicks and explosions.',
  ));
  panel.appendChild(toggleRow(
    'Invert Y axis', () => !!set.invertY, (v) => { set.invertY = v; },
    'Pull mouse down to climb (flight-sim style).',
  ));

  // master volume slider
  const volWrap = el('div', 'col');
  volWrap.style.gap = '6px'; volWrap.style.marginBottom = '14px';
  const volRow = el('div', 'row');
  volRow.style.justifyContent = 'space-between';
  volRow.appendChild(el('div', '', 'Master volume'));
  const volVal = el('div', 'mono small muted', Math.round((set.masterVol ?? 0.8) * 100) + '%');
  volRow.appendChild(volVal);
  volWrap.appendChild(volRow);
  const slider = el('input', 'range');
  slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
  slider.value = String(Math.round((set.masterVol ?? 0.8) * 100));
  slider.addEventListener('input', () => {
    const v = clamp(Number(slider.value) / 100, 0, 1);
    set.masterVol = v;
    volVal.textContent = Math.round(v * 100) + '%';
  });
  slider.addEventListener('change', () => {
    save();
    if (set.sfx) sfx('ui', 0.4 * (set.masterVol ?? 0.8));
  });
  volWrap.appendChild(slider);
  panel.appendChild(volWrap);

  // VR — only shows on a WebXR headset/runtime; enters immersive mode (hangar + cockpit)
  const vrWrap = el('div', 'col');
  vrWrap.style.gap = '4px'; vrWrap.style.marginBottom = '12px';
  addEnterVRButton(vrWrap);
  vrWrap.appendChild(el('div', 'faint small', 'Immersive VR: grab parts in the hangar, fly from the cockpit. Needs a WebXR headset.'));
  panel.appendChild(vrWrap);

  // divider
  const hr = el('div'); hr.style.height = '1px'; hr.style.background = 'var(--edge)'; hr.style.margin = '8px 0 14px';
  panel.appendChild(hr);

  // credits readout (campaign economy at a glance)
  const econ = el('div', 'row');
  econ.style.justifyContent = 'space-between'; econ.style.marginBottom = '14px';
  econ.appendChild(el('div', 'muted small', 'Credits'));
  const cr = el('div', 'credits mono', fmtCr(State.money));
  econ.appendChild(cr);
  panel.appendChild(econ);
  // keep credits live if the economy emits while menu is open
  const offMoney = bus.on('money', () => { cr.textContent = fmtCr(State.money); });
  panel._cleanup = offMoney;

  // Reset save
  panel.appendChild(mkBtn('Reset save', 'danger small', () => {
    confirmDialog({
      title: 'Reset all progress?',
      body: 'This erases your library, campaign progress and credits, then reloads the game from scratch. This cannot be undone.',
      okLabel: 'Reset everything', danger: true,
    }, () => {
      resetSave();
      // reload so every module re-inits from a clean save (load() reseeds STOCK_DESIGNS)
      try { location.reload(); } catch (e){ load(); Menu.show(); }
    });
  }));

  return panel;
}

// ---------------------------------------------------------------------------
//  Library section (cards + toolbar). Self-rerendering.
// ---------------------------------------------------------------------------
function buildLibrarySection(){
  const panel = el('div', 'panel');
  panel.style.flex = '1';

  const head = el('div', 'row');
  head.style.justifyContent = 'space-between'; head.style.alignItems = 'baseline';
  head.appendChild(el('h3', '', 'Hangar / Library'));
  const count = el('div', 'faint small mono', '');
  head.appendChild(count);
  panel.appendChild(head);

  const toolbar = el('div', 'row');
  toolbar.style.marginBottom = '12px';
  const grid = el('div', 'grid');
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(260px, 1fr))';

  const rerender = () => {
    clear(grid);
    const lib = State.library || [];
    count.textContent = lib.length + (lib.length === 1 ? ' design' : ' designs');
    if (!lib.length){
      const empty = el('div', 'muted');
      empty.style.gridColumn = '1 / -1'; empty.style.padding = '24px'; empty.style.textAlign = 'center';
      empty.textContent = 'Your library is empty. Build a new aircraft or import a code to get started.';
      grid.appendChild(empty);
    } else {
      for (const d of lib) grid.appendChild(buildLibraryCard(d, rerender));
    }
  };

  toolbar.appendChild(mkBtn('+ New aircraft', 'accent', () => newAircraft()));
  toolbar.appendChild(mkBtn('Import code', '', () => importAircraft(rerender)));
  // restore the factory blueprints into the library
  toolbar.appendChild(mkBtn('Restore stock', 'ghost small', () => {
    confirmDialog({
      title: 'Restore stock blueprints?',
      body: 'Adds any missing factory designs (Falcon, Vanguard, Fortress, Wasp, Goliath) to your library. Your own designs are kept.',
      okLabel: 'Restore',
    }, () => {
      let added = 0;
      const names = new Set((State.library || []).map(d => d.name));
      for (const s of STOCK_DESIGNS){
        if (!names.has(s.name)){
          const c = core.cloneDesign(s, '');
          libSave(c); added++;
        }
      }
      toast(added ? ('Restored ' + added + ' blueprint' + (added === 1 ? '' : 's')) : 'Nothing to restore', added ? 'good' : '');
      rerender();
    });
  }));

  panel.appendChild(toolbar);
  panel.appendChild(grid);
  rerender();

  // re-render if the library changes externally while menu visible
  const offLib = bus.on('library', rerender);
  panel._cleanup = offLib;

  return panel;
}

// ---------------------------------------------------------------------------
//  Mode buttons (the three big entries)
// ---------------------------------------------------------------------------
function buildModeButtons(){
  const wrap = el('div', 'col');
  wrap.style.gap = '12px'; wrap.style.minWidth = '380px';

  const modeBtn = (title, desc, cls, fn) => {
    const b = el('button', 'btn big ' + cls);
    b.style.flexDirection = 'column'; b.style.alignItems = 'flex-start';
    b.style.gap = '4px'; b.style.padding = '18px 22px'; b.style.textAlign = 'left';
    const t = el('div', '', title); t.style.fontWeight = '800'; t.style.fontSize = '19px'; t.style.letterSpacing = '.04em';
    b.appendChild(t);
    const d = el('div', 'small', desc); d.style.opacity = '.85'; d.style.fontWeight = '400';
    b.appendChild(d);
    return clickable(b, fn);
  };

  wrap.appendChild(modeBtn(
    'CREATIVE', 'Free-form skirmish. Pick your jet, set the enemies, launch instantly.',
    'accent', () => { exitMenu(); Creative.show(); },
  ));
  wrap.appendChild(modeBtn(
    'CAMPAIGN', 'Earn credits, buy aircraft & wingmen, fly missions, climb the ranks.',
    'gold', () => { exitMenu(); Campaign.show(); },
  ));
  wrap.appendChild(modeBtn(
    'PVP', 'Budget-build a fleet and dogfight another human over the relay.',
    '', () => { exitMenu(); Pvp.show(); },
  ));

  return wrap;
}

// ---------------------------------------------------------------------------
//  Cleanup of any live listeners/RAF the menu registered
// ---------------------------------------------------------------------------
const cleanups = [];
function registerCleanup(fn){ if (typeof fn === 'function') cleanups.push(fn); }
function runCleanups(){
  while (cleanups.length){ try { cleanups.pop()(); } catch (e){ /* ignore */ } }
}
function exitMenu(){
  runCleanups();
  stopBackdrop();
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------
export const Menu = {
  show(){
    // tear down anything from a previous show
    runCleanups();
    stopBackdrop();

    const root = revealScreen('screen-menu');
    if (!root){ console.warn('menu: #screen-menu missing'); return; }
    clear(root);
    root.classList.add('screen');
    // override the centred default — menu uses a top-aligned column layout
    root.classList.remove('center');
    root.style.position = 'relative';

    // decorative drifting starfield behind everything (2D canvas)
    startBackdrop(root);

    // ---- foreground content wrapper (sits above the backdrop) ----
    const content = el('div', 'col');
    content.style.position = 'relative'; content.style.zIndex = '1';
    content.style.gap = '22px'; content.style.maxWidth = '1180px';
    content.style.margin = '0 auto'; content.style.width = '100%';
    root.appendChild(content);

    // ---- title block ----
    const titleBlock = el('div', 'col');
    titleBlock.style.gap = '2px'; titleBlock.style.marginTop = '6px';
    titleBlock.appendChild(el('div', 'eyebrow', 'Sky superiority · est. MMXXVI'));
    titleBlock.appendChild(el('h1', 'title', 'ACE OF SKY II'));
    titleBlock.appendChild(el('div', 'subtitle', 'BUILD · ARM · DOGFIGHT — THE BROWSER COMBAT FLIGHT SIM'));
    content.appendChild(titleBlock);

    // ---- top: mode buttons (left) + settings (right) ----
    const top = el('div', 'row');
    top.style.alignItems = 'stretch'; top.style.gap = '22px'; top.style.flexWrap = 'wrap';
    const modes = buildModeButtons();
    modes.style.flex = '1 1 380px';
    top.appendChild(modes);
    const settings = buildSettings();
    settings.style.flex = '0 0 320px';
    registerCleanup(settings._cleanup);
    top.appendChild(settings);
    content.appendChild(top);

    // ---- library section (full width below) ----
    const lib = buildLibrarySection();
    registerCleanup(lib._cleanup);
    content.appendChild(lib);

    // ---- footer credit / quit hint ----
    const foot = el('div', 'row');
    foot.style.justifyContent = 'space-between'; foot.style.marginTop = '6px'; foot.style.opacity = '.7';
    foot.appendChild(el('div', 'faint small mono', 'forward = +Z · WASD throttle/roll · mouse aim · Shift boost · Space fire'));
    foot.appendChild(el('div', 'faint small mono', 'Ace of Sky II'));
    content.appendChild(foot);

    if (State.settings.sfx) sfx('ui', 0.3);
  },
};

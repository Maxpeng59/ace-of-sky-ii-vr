// ============================================================================
//  Ace of Sky II — hangar.js
//  The KSP-style aircraft EDITOR. A scrollable categorized part palette (left),
//  a live Three.js build stage with orbit/pan/zoom + ghost placement (centre),
//  and a computeStats() readout with CoM/CoL gizmos, budget bar and import/
//  export tools (right). Renders entirely inside #screen-hangar, owns its own
//  Scene + camera via engine.setScene/onFrame, and tears itself down on close.
//
//  Forward (nose) = +Z, up = +Y. Parts are placed on an integer grid; a part's
//  footprint after a quarter-turn rotation comes from effSize(); two parts may
//  not occupy the same cell (occupancy set). gz increases toward the nose.
// ============================================================================
import * as THREE from 'three';
import { clamp, el, clear, $, fmtCr, fmtMass, fmtNum, fmtTime, sfx, toast } from './util.js';
import { computeStats, effSize, partCenter, navalCruise, OVERHEAT_TEMP, AMBIENT_TEMP } from './physics.js';
import { PARTS, CATEGORIES, partsByCategory, CAT_COLORS } from './parts.js';
import * as core from './core.js';
import * as engine from './engine.js';
import { setVRMode } from './vr.js';

// ----------------------------------------------------------------------------
//  Module-level live state (singleton editor — one open at a time)
// ----------------------------------------------------------------------------
let S = null;   // the active session object, or null when closed

// quarter-turn helpers ------------------------------------------------------
const QTURN = Math.PI / 2;

// Build the world-space position (metres) for a placed part. Mirrors physics.partCenter.
function placePos(p){
  const def = PARTS[p.key];
  if (!def) return new THREE.Vector3();
  const c = partCenter(p, def);
  return new THREE.Vector3(c.x, c.y, c.z);
}

// The set of grid cells a placed part occupies (string keys "gx,gy,gz").
function cellsOf(p){
  const def = PARTS[p.key];
  const es = effSize(def, p.rot || 0);
  const w = Math.max(1, Math.round(es[0])), h = Math.max(1, Math.round(es[1])), l = Math.max(1, Math.round(es[2]));
  const out = [];
  for (let dx = 0; dx < w; dx++)
    for (let dy = 0; dy < h; dy++)
      for (let dz = 0; dz < l; dz++)
        out.push((p.gx + dx) + ',' + (p.gy + dy) + ',' + (p.gz + dz));
  return out;
}

// ----------------------------------------------------------------------------
//  Public API
// ----------------------------------------------------------------------------
export const Hangar = {
  /**
   * Open the editor.
   * @param {object} opts
   *  - design   : AircraftDesign to edit (caller passes a clone)
   *  - title?   : header string
   *  - actions? : [{label, kind, fn(design,stats)}] extra header buttons
   *  - onChange?: (design,stats) fired after every edit
   *  - onExit   : (design) called by the default "◂ EXIT" button
   *  - budget?  : number → show a cost-vs-budget bar
   */
  open(opts = {}){
    if (S) Hangar.close();                       // never stack two editors
    const design = opts.design || core.newDesign();
    if (!design.parts) design.parts = [];

    S = {
      opts,
      design,
      // selection / tooling
      pendingKey: null,        // a palette part chosen for placement
      pendingRot: 0,           // rotation of the pending ghost
      selected: null,          // index into design.parts of a placed part
      // 3d
      scene: null, camera: null, root3d: null, gridMesh: null,
      ghost: null, ghostValid: false, ghostCell: null,
      placedGroup: null, partMeshes: [],         // partMeshes[i] = Object3D for design.parts[i]
      comMarker: null, colMarker: null, showGizmo: false,
      // camera control
      camTarget: new THREE.Vector3(0, 1.5, 0),
      camYaw: -0.7, camPitch: 0.5, camDist: 22,
      dragMode: null, lastMx: 0, lastMy: 0,
      mouseNDC: new THREE.Vector2(0, 0), haveMouse: false,
      raycaster: new THREE.Raycaster(),
      planeY: 0,               // build plane height for ghost (snaps to part footprint)
      freePlace: true,         // default: place/move parts anywhere, overlap allowed
      mirror: false,           // mirror placement: also place a twin across the X centreline
      // dom
      els: {},
      catOpen: {},             // category collapse state
      // history
      undoStack: [],
      // engine handles
      unsub: null,
      // misc
      stats: null,
      destroyed: false,
    };
    for (const c of CATEGORIES) S.catOpen[c.key] = true;

    buildDOM();
    buildScene();
    rebuildAircraft();
    refreshStats();
    installInput();
    sfx('ui', 0.25);
    // VR: assemble by reaching out — grab a part off the shelf and drop it on the grid.
    if (engine.isPresenting && engine.isPresenting()) setVRMode('hangar', { scene: S.scene, place: (k, w) => Hangar.vrPlace(k, w) });
  },

  // VR drop: map a world position to the nearest build cell and add the part.
  vrPlace(key, world){
    if (!S || !PARTS[key]) return;
    const local = (S.placedGroup ? S.placedGroup.worldToLocal(world.clone()) : world.clone());
    const p = { key, gx: Math.round(local.x), gy: Math.max(0, Math.round(local.y)), gz: Math.round(local.z), rot: 0, rx: 0, rz: 0 };
    S.design.parts.push(p);
    addPartMesh(p, S.design.parts.length - 1);
    refreshStats(); emitChange(); sfx('ui', 0.18);
  },

  close(){
    if (!S) return;
    S.destroyed = true;
    setVRMode('menu');           // detach the VR parts shelf
    removeInput();
    if (S.unsub) try { S.unsub(); } catch (e){}
    engine.resetView();
    // dispose three resources
    disposeGroup(S.placedGroup);
    disposeGroup(S.ghost);
    disposeGroup(S.ghostMirror);
    if (S.gridMesh){ S.gridMesh.geometry?.dispose?.(); S.gridMesh.material?.dispose?.(); }
    // sweep the rest of the scene (floor, lights' shadow maps, axis arrow, CoM/CoL
    // markers) — three.js never frees GPU memory just because the Scene is dropped,
    // so without this every open/close cycle leaks geometry + a shadow-map target.
    if (S.scene){
      S.scene.traverse(o => {
        if (o.isMesh || o.isLine || o.isPoints){
          o.geometry?.dispose?.();
          // material.dispose() leaves its textures alive — the 2048² concrete-apron
          // CanvasTexture would leak on every open/close without freeing .map et al.
          const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
          mats.forEach(m => { if (!m) return; for (const k in m){ const v = m[k]; if (v && v.isTexture) v.dispose(); } m.dispose?.(); });
        }
        if (o.isLight && o.shadow && o.shadow.map){ o.shadow.map.dispose(); }
      });
    }
    // tear down DOM
    const rootEl = $('screen-hangar') || S.els.rootCreated;
    if (rootEl){
      clear(rootEl);
      rootEl.classList.remove('hangar-root');
      rootEl.classList.add('hidden');
    }
    S = null;
  },
};

// ----------------------------------------------------------------------------
//  DOM construction
// ----------------------------------------------------------------------------
function ensureScreenRoot(){
  let root = $('screen-hangar');
  if (!root){
    // index.html should provide it, but be defensive so the editor is runnable.
    root = el('div'); root.id = 'screen-hangar'; root.className = 'screen hidden';
    document.body.appendChild(root);
    S.els.rootCreated = root;
  }
  return root;
}

function buildDOM(){
  const root = ensureScreenRoot();
  // Switch to the hangar grid layout. Hide every OTHER screen so only we show.
  for (const id of ['screen-menu', 'screen-creative', 'screen-campaign', 'screen-pvp']){
    const o = $(id); if (o) o.classList.add('hidden');
  }
  const hud = $('hud'); if (hud) hud.classList.add('hidden');
  clear(root);
  root.classList.remove('hidden', 'screen');
  root.classList.add('hangar-root');
  S.els.root = root;

  // ---- HEAD --------------------------------------------------------------
  const head = el('div', 'hangar-head');
  const title = el('div', '', S.opts.title || 'AIRCRAFT HANGAR');
  title.style.cssText = 'font-family:var(--mono);letter-spacing:.18em;font-size:14px;color:var(--accent);font-weight:700;';
  head.appendChild(title);

  const exitBtn = el('button', 'btn small', '◂ EXIT');
  exitBtn.onclick = () => { sfx('click'); const d = S.design; const fn = S.opts.onExit; Hangar.close(); if (fn) fn(d); };
  head.appendChild(exitBtn);

  const spacer = el('div', 'spacer'); head.appendChild(spacer);

  // file/library actions
  const mkBtn = (label, kind, fn) => { const b = el('button', 'btn small' + (kind ? ' ' + kind : ''), label); b.onclick = fn; head.appendChild(b); return b; };
  mkBtn('Save', '', () => doSave());
  mkBtn('Duplicate', '', () => doDuplicate());
  mkBtn('Export', '', () => doExport());
  mkBtn('Import', '', () => doImport());
  mkBtn('Clear', 'danger', () => doClear());

  // custom actions (e.g. LAUNCH / DONE)
  for (const a of (S.opts.actions || [])){
    const b = el('button', 'btn small' + (a.kind ? ' ' + a.kind : ''), a.label);
    b.onclick = () => { sfx('click'); if (a.fn) a.fn(S.design, S.stats); };
    head.appendChild(b);
  }
  root.appendChild(head);

  // ---- PALETTE -----------------------------------------------------------
  const palette = el('div', 'hangar-palette');
  S.els.palette = palette;
  buildPalette(palette);
  root.appendChild(palette);

  // ---- STAGE -------------------------------------------------------------
  const stage = el('div', 'hangar-stage');
  S.els.stage = stage;

  const toolbar = el('div', 'hangar-toolbar');
  const giz = el('button', 'btn small', 'CoM / CoL');
  giz.onclick = () => { S.showGizmo = !S.showGizmo; giz.classList.toggle('accent', S.showGizmo); updateGizmo(); sfx('click'); };
  toolbar.appendChild(giz);
  const fit = el('button', 'btn small', 'Center View');
  fit.onclick = () => { frameCamera(); sfx('click'); };
  toolbar.appendChild(fit);
  // rotate in 90° steps about any axis (R yaw · T pitch · Y roll)
  const rotY = el('button', 'btn small', '⟳ Yaw (R)');
  rotY.onclick = () => { rotateActive('y'); sfx('click'); };
  toolbar.appendChild(rotY);
  const rotX = el('button', 'btn small', '⟲ Pitch (T)');
  rotX.onclick = () => { rotateActive('x'); sfx('click'); };
  toolbar.appendChild(rotX);
  const rotZ = el('button', 'btn small', '⭮ Roll (Y)');
  rotZ.onclick = () => { rotateActive('z'); sfx('click'); };
  toolbar.appendChild(rotZ);
  const freeBtn = el('button', 'btn small accent', 'Free Place');
  freeBtn.onclick = () => { S.freePlace = !S.freePlace; freeBtn.classList.toggle('accent', S.freePlace); toast(S.freePlace ? 'Free placement — overlap allowed' : 'Grid placement — no overlap', ''); sfx('click'); };
  toolbar.appendChild(freeBtn);
  const mirBtn = el('button', 'btn small', '⇋ Mirror');
  mirBtn.onclick = () => { S.mirror = !S.mirror; mirBtn.classList.toggle('accent', S.mirror); toast(S.mirror ? 'Mirror ON — twin mirrors across the airframe centreline' : 'Mirror OFF', ''); sfx('click'); };
  toolbar.appendChild(mirBtn);
  const delBtn = el('button', 'btn small danger', 'Delete (Del)');
  delBtn.onclick = () => { deleteSelected(); sfx('click'); };
  toolbar.appendChild(delBtn);
  stage.appendChild(toolbar);

  // budget bar (optional)
  if (typeof S.opts.budget === 'number'){
    const bb = el('div', 'budgetbar panel tight');
    bb.style.cssText += 'width:200px;';
    const lbl = el('div', 'small'); lbl.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:5px;';
    const bar = el('div', 'statbar'); bar.style.height = '8px';
    const fill = el('i');
    bar.appendChild(fill);
    bb.appendChild(lbl); bb.appendChild(bar);
    stage.appendChild(bb);
    S.els.budgetLbl = lbl; S.els.budgetFill = fill; S.els.budgetBox = bb;
  }

  // hint line
  const hint = el('div', 'hangar-hint');
  hint.innerHTML = 'Drag = orbit · Right/Middle drag = pan · Wheel = zoom · ' +
    '<b>R</b> rotate · <b>Del</b>/right-click remove · <b>Ctrl+Z</b> undo · click a part then <b>drag the X/Y/Z arrows</b> to move it';
  stage.appendChild(hint);
  S.els.hint = hint;

  root.appendChild(stage);

  // ---- INFO --------------------------------------------------------------
  const info = el('div', 'hangar-info');
  buildInfo(info);
  root.appendChild(info);
  S.els.info = info;
}

// ---- left palette ----------------------------------------------------------
// ---------------------------------------------------------------------------
//  Palette thumbnails — render a small 3/4-view image of each part's model into
//  the swatch so you can see what it is. Uses the shared engine renderer drawing
//  to an offscreen render target (no second WebGL context), cached by part key,
//  and rendered lazily as items scroll into view.
// ---------------------------------------------------------------------------
const THUMB_CACHE = new Map();
let _thScene = null, _thCam = null, _thRT = null, _th2d = null, _thQueue = [], _thRunning = false;

// queue swatches and render their thumbnails in small setTimeout batches (so it
// never blocks the UI, and unlike rAF/IntersectionObserver it also runs offscreen).
function queueThumbs(swatches){
  for (const sw of swatches) _thQueue.push(sw);
  if (_thRunning) return;
  _thRunning = true;
  const step = () => {
    if (!S || S.destroyed){ _thRunning = false; _thQueue.length = 0; return; }
    let n = 0;
    while (n < 6 && _thQueue.length){
      const sw = _thQueue.shift();
      if (!sw.isConnected) continue;
      const url = renderPartThumb(PARTS[sw.dataset.thumbKey]);
      if (url){ sw.style.backgroundImage = 'url(' + url + ')'; sw.style.backgroundSize = 'cover'; sw.style.backgroundPosition = 'center'; }
      n++;
    }
    if (_thQueue.length) setTimeout(step, 0); else _thRunning = false;
  };
  setTimeout(step, 0);
}

function disposeThumbMesh(m){ m.traverse(o => { if (o.isMesh){ o.geometry?.dispose?.(); if (Array.isArray(o.material)) o.material.forEach(x => x.dispose?.()); else o.material?.dispose?.(); } }); }

function renderPartThumb(def){
  if (!def) return null;
  if (THUMB_CACHE.has(def.key)) return THUMB_CACHE.get(def.key);
  const renderer = engine.getRenderer && engine.getRenderer();
  if (!renderer) return null;
  if (!_thScene){
    _thScene = new THREE.Scene();
    // white "catalogue" backdrop like the KSP wiki part renders
    _thScene.add(new THREE.HemisphereLight(0xffffff, 0xc4ced9, 1.15));
    const k = new THREE.DirectionalLight(0xffffff, 1.45); k.position.set(4, 6, 5); _thScene.add(k);
    const f = new THREE.DirectionalLight(0xacc4e6, 0.55); f.position.set(-5, 2, -4); _thScene.add(f);
    _thCam = new THREE.PerspectiveCamera(32, 1, 0.05, 400);
    _thRT = new THREE.WebGLRenderTarget(128, 128, { samples: 4 });
  }
  let mesh; try { mesh = def.build(THREE, def); } catch (e){ return null; }
  _thScene.add(mesh);
  const bb = new THREE.Box3().setFromObject(mesh), sz = new THREE.Vector3(), ctr = new THREE.Vector3();
  bb.getSize(sz); bb.getCenter(ctr);
  const radius = Math.max(0.4, Math.max(sz.x, sz.y, sz.z) * 0.5);
  const dist = radius / Math.tan(32 * Math.PI / 360) * 1.4;
  const dir = new THREE.Vector3(0.85, 0.55, 1).normalize();
  _thCam.position.copy(ctr).addScaledVector(dir, dist); _thCam.lookAt(ctr); _thCam.updateProjectionMatrix();
  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color(); renderer.getClearColor(prevClear); const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(_thRT);
  renderer.setClearColor(0xf4f6f9, 1);
  renderer.render(_thScene, _thCam);
  const W = 128, H = 128, buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(_thRT, 0, 0, W, H, buf);
  renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha);
  _thScene.remove(mesh); disposeThumbMesh(mesh);
  if (!_th2d){ _th2d = document.createElement('canvas'); _th2d.width = W; _th2d.height = H; }
  const ctx = _th2d.getContext('2d'), imgD = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++){ const sy = H - 1 - y; for (let x = 0; x < W; x++){ const di = (y * W + x) * 4, si = (sy * W + x) * 4; imgD.data[di] = buf[si]; imgD.data[di + 1] = buf[si + 1]; imgD.data[di + 2] = buf[si + 2]; imgD.data[di + 3] = buf[si + 3]; } }
  ctx.putImageData(imgD, 0, 0);
  const url = _th2d.toDataURL('image/png');
  THUMB_CACHE.set(def.key, url);
  return url;
}

function buildPalette(palette){
  clear(palette);
  const swatches = [];
  for (const cat of CATEGORIES){
    const items = partsByCategory(cat.key);
    if (!items.length) continue;
    const head = el('div', 'cat-head');
    const open = S.catOpen[cat.key];
    head.appendChild(el('span', '', cat.name));
    const chev = el('span', '', open ? '▾' : '▸'); head.appendChild(chev);
    head.onclick = () => { S.catOpen[cat.key] = !S.catOpen[cat.key]; buildPalette(palette); sfx('click'); };
    palette.appendChild(head);

    if (!open) continue;
    for (const def of items){
      const item = el('div', 'part-item');
      item.dataset.key = def.key;
      if (S.pendingKey === def.key) item.classList.add('sel');

      const sw = el('div', 'part-swatch');
      sw.style.cssText = 'width:42px;height:42px;border-radius:6px;background:#0c121c center/cover no-repeat;' +
        'box-shadow:inset 0 0 0 1px rgba(255,255,255,.06), inset 0 0 0 2px ' + (CAT_COLORS[cat.key] || '#888') + '33;';
      sw.dataset.thumbKey = def.key;
      swatches.push(sw);               // batch-render the part image (queueThumbs below)
      item.appendChild(sw);

      const txt = el('div'); txt.style.cssText = 'flex:1;min-width:0;';
      const nm = el('div', 'part-name', def.name);
      const meta = el('div', 'part-meta', metaLine(def));
      txt.appendChild(nm); txt.appendChild(meta);
      item.appendChild(txt);

      item.title = (def.desc || '') + '\n' + metaLine(def);
      item.onclick = () => { selectPalette(def.key); sfx('click'); };
      palette.appendChild(item);
    }
  }
  queueThumbs(swatches);
}

function metaLine(def){
  const bits = [];
  bits.push(fmtMass(def.mass + (def.fuel || 0)));
  bits.push(fmtCr(def.cost));
  if (def.thrust) bits.push((def.thrust / 1000).toFixed(0) + 'kN');
  else if (def.fuel) bits.push(def.fuel + ' fuel');
  else if (def.lift) bits.push('lift ' + def.lift);
  else if (def.armor) bits.push('+' + def.armor + ' armor');
  else if (def.weapon) bits.push(def.weapon);
  return bits.join(' · ');
}

// ---- right info panel ------------------------------------------------------
function buildInfo(info){
  clear(info);

  // name + color + role
  const nameLbl = el('label', 'field', 'Aircraft name');
  const nameIn = el('input'); nameIn.type = 'text'; nameIn.value = S.design.name || '';
  nameIn.oninput = () => { S.design.name = nameIn.value; emitChange(); };
  nameLbl.appendChild(nameIn);
  info.appendChild(nameLbl);

  const rowCC = el('div', 'row'); rowCC.style.marginTop = '8px';
  const colLbl = el('label', 'field', 'Livery');
  const colIn = el('input'); colIn.type = 'color'; colIn.value = normHex(S.design.color);
  colIn.style.cssText = 'width:48px;height:34px;padding:2px;cursor:pointer;';
  colIn.oninput = () => { S.design.color = colIn.value; applyLivery(); emitChange(); };
  colLbl.appendChild(colIn);
  rowCC.appendChild(colLbl);

  const roleLbl = el('label', 'field', 'Role');
  const roleSel = el('select');
  for (const r of ['fighter', 'interceptor', 'strike', 'bomber', 'heavy', 'drone', 'carrier', 'ship']){
    const o = el('option', '', r); o.value = r; if (S.design.role === r) o.selected = true; roleSel.appendChild(o);
  }
  roleSel.onchange = () => { S.design.role = roleSel.value; emitChange(); };
  roleLbl.appendChild(roleSel);
  rowCC.appendChild(roleLbl);
  info.appendChild(rowCC);

  // selected-part inspector
  const sel = el('div', 'panel tight'); sel.style.marginTop = '12px';
  S.els.selBox = sel;
  info.appendChild(sel);

  // stats readout
  const h = el('h3', '', 'Flight Profile'); info.appendChild(h);
  const statsEl = el('div', 'stats'); S.els.stats = statsEl; info.appendChild(statsEl);

  // warnings/errors
  const warns = el('div', 'warns'); S.els.warns = warns; info.appendChild(warns);

  renderSelInspector();
}

// ----------------------------------------------------------------------------
//  Three.js scene
// ----------------------------------------------------------------------------
function buildScene(){
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0f18);
  scene.fog = new THREE.Fog(0x0a0f18, 60, 160);

  // lighting — a hangar-ish 3-point setup
  const hemi = new THREE.HemisphereLight(0x8fb8ff, 0x1a2230, 0.65); scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.05); key.position.set(14, 24, 10);
  key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1; key.shadow.camera.far = 90;
  key.shadow.camera.left = -30; key.shadow.camera.right = 30; key.shadow.camera.top = 30; key.shadow.camera.bottom = -30;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x3aa0ff, 0.4); fill.position.set(-16, 8, -12); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffce5a, 0.3); rim.position.set(0, 6, -20); scene.add(rim);

  // floor — procedural concrete hangar apron: slab joints + painted lane markings -----
  const fc = document.createElement('canvas'); fc.width = fc.height = 2048;
  const fx = fc.getContext('2d');
  fx.fillStyle = '#3a4046'; fx.fillRect(0, 0, 2048, 2048);                                  // concrete base
  for (let i = 0; i < 9000; i++){ const x = Math.random() * 2048, y = Math.random() * 2048, r = Math.random() * 2.6 + 0.4, v = (Math.random() * 30 - 15) | 0;
    fx.fillStyle = 'rgba(' + (58 + v) + ',' + (64 + v) + ',' + (70 + v) + ',0.5)'; fx.beginPath(); fx.arc(x, y, r, 0, 7); fx.fill(); }   // mottled wear
  fx.strokeStyle = '#2a2f34'; fx.lineWidth = 5;                                             // slab joints (~7.5 m)
  for (let i = 0; i <= 2048; i += 128){ fx.beginPath(); fx.moveTo(i, 0); fx.lineTo(i, 2048); fx.moveTo(0, i); fx.lineTo(2048, i); fx.stroke(); }
  const C = 1024;
  fx.strokeStyle = '#c9ced3'; fx.lineWidth = 13; fx.beginPath(); fx.arc(C, C, 300, 0, 7); fx.stroke();   // central turn circle
  fx.lineWidth = 5; fx.beginPath(); fx.arc(C, C, 278, 0, 7); fx.stroke();
  fx.strokeStyle = '#b7bcc1'; fx.lineWidth = 9; fx.setLineDash([44, 32]);                   // dashed centre cross guides
  fx.beginPath(); fx.moveTo(C, 130); fx.lineTo(C, 2048 - 130); fx.moveTo(130, C); fx.lineTo(2048 - 130, C); fx.stroke(); fx.setLineDash([]);
  fx.strokeStyle = '#aeb4b9'; fx.lineWidth = 8;                                             // hold lines
  for (const off of [-560, 560]){ fx.beginPath(); fx.moveTo(240, C + off); fx.lineTo(2048 - 240, C + off); fx.stroke(); }
  fx.strokeStyle = '#d8b13a'; fx.lineWidth = 20; fx.setLineDash([64, 56]);                  // yellow hazard border
  fx.strokeRect(70, 70, 2048 - 140, 2048 - 140); fx.setLineDash([]);
  const ftex = new THREE.CanvasTexture(fc); ftex.anisotropy = 4;
  if ('SRGBColorSpace' in THREE) ftex.colorSpace = THREE.SRGBColorSpace; else if ('sRGBEncoding' in THREE) ftex.encoding = THREE.sRGBEncoding;
  const floorGeo = new THREE.PlaneGeometry(120, 120);
  const floorMat = new THREE.MeshStandardMaterial({ map: ftex, metalness: 0.0, roughness: 0.92 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01; floor.receiveShadow = true;
  scene.add(floor);

  // subtle 1 m build grid kept for part alignment (painted-line look over the concrete)
  const grid = new THREE.GridHelper(80, 80, 0x8a96a4, 0x515a66);
  grid.material.opacity = 0.32; grid.material.transparent = true;
  grid.position.y = 0.006; scene.add(grid);
  S.gridMesh = grid;

  // axis hint: nose direction (+Z) marker
  const axis = new THREE.Group();
  const noseArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.02, 0), 6, 0x39d0ff, 1.2, 0.7);
  axis.add(noseArrow);
  scene.add(axis);

  // groups for placed parts + ghost
  const placedGroup = new THREE.Group(); scene.add(placedGroup);
  S.placedGroup = placedGroup;

  // CoM / CoL markers
  S.comMarker = makeMarker(0xff4d6d);
  S.colMarker = makeMarker(0x39d0ff);
  S.comMarker.visible = false; S.colMarker.visible = false;
  scene.add(S.comMarker); scene.add(S.colMarker);

  // 3-axis translate gizmo for the selected part (X red / Y green / Z blue)
  S.moveGizmo = buildMoveGizmo();
  S.moveGizmo.visible = false;
  scene.add(S.moveGizmo);

  // camera
  const cam = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 600);
  S.scene = scene; S.camera = cam;
  updateCamera();

  engine.setScene(scene, cam);
  S.unsub = engine.onFrame(frame);

  frameCamera();   // initial framing
}

function makeMarker(color){
  const g = new THREE.Group();
  const sph = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12),
    new THREE.MeshBasicMaterial({ color }));
  g.add(sph);
  // a small upright pin so it reads against the airframe
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 }));
  pin.position.y = 1.5; g.add(pin);
  return g;
}

// ----------------------------------------------------------------------------
//  Move gizmo — three draggable axis arrows that translate the selected part
//  one grid cell at a time along X (red) / Y (green) / Z (blue).
// ----------------------------------------------------------------------------
function buildMoveGizmo(){
  const g = new THREE.Group();
  S.gizmoHandles = { x: [], y: [], z: [] };
  const axes = [
    { k: 'x', dir: new THREE.Vector3(1, 0, 0), color: 0xff4d6d },
    { k: 'y', dir: new THREE.Vector3(0, 1, 0), color: 0x39ff88 },
    { k: 'z', dir: new THREE.Vector3(0, 0, 1), color: 0x5fd0ff },
  ];
  const L = 3.0, R = 0.07;
  for (const a of axes){
    const sub = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L, 10),
      new THREE.MeshBasicMaterial({ color: a.color, depthTest: false, transparent: true, opacity: 0.95 }));
    shaft.position.y = L / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(R * 3, L * 0.3, 12),
      new THREE.MeshBasicMaterial({ color: a.color, depthTest: false, transparent: true, opacity: 0.95 }));
    tip.position.y = L + L * 0.15;
    // fat invisible (opacity 0, still raycastable) cylinder so the axis is easy to grab
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(R * 5, R * 5, L * 1.35, 6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false }));
    hit.position.y = L * 0.62;
    for (const m of [shaft, tip, hit]){ m.userData.gizmoAxis = a.k; m.renderOrder = 999; }
    sub.add(shaft); sub.add(tip); sub.add(hit);
    sub.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a.dir);   // aim local +Y along the axis
    g.add(sub);
    S.gizmoHandles[a.k] = [shaft, tip, hit];
  }
  return g;
}

function updateMoveGizmo(){
  if (!S.moveGizmo) return;
  const show = S.selected != null && S.design.parts[S.selected] && !S.pendingKey;
  S.moveGizmo.visible = !!show;
  if (show){
    S.moveGizmo.position.copy(placePos(S.design.parts[S.selected]));
    S.moveGizmo.scale.setScalar(clamp(S.camDist * 0.045, 0.55, 2.4));   // stay grabbable at any zoom
  }
}

// ----------------------------------------------------------------------------
//  Per-frame: update ghost + camera + gizmo
// ----------------------------------------------------------------------------
function frame(dt){
  if (!S || S.destroyed) return;
  updateGhost();
  updateMoveGizmo();
}

// ---- camera ----------------------------------------------------------------
function updateCamera(){
  const cam = S.camera;
  S.camPitch = clamp(S.camPitch, -1.35, 1.45);
  S.camDist = clamp(S.camDist, 4, 120);
  const cp = Math.cos(S.camPitch), sp = Math.sin(S.camPitch);
  const cy = Math.cos(S.camYaw), sy = Math.sin(S.camYaw);
  const off = new THREE.Vector3(cp * sy, sp, cp * cy).multiplyScalar(S.camDist);
  cam.position.copy(S.camTarget).add(off);
  cam.lookAt(S.camTarget);
}

function frameCamera(){
  // centre the orbit target on the airframe bbox
  const st = S.stats || computeStats(S.design);
  if (st && st.partCount > 0 && isFinite(st.bbox.min.x)){
    const b = st.bbox;
    S.camTarget.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    const span = Math.max(b.size.x, b.size.y, b.size.z, 4);
    S.camDist = clamp(span * 2.2, 8, 90);
  } else {
    S.camTarget.set(0, 1.5, 0);
    S.camDist = 22;
  }
  S.camYaw = -0.7; S.camPitch = 0.5;
  updateCamera();
}

// ----------------------------------------------------------------------------
//  Ghost preview (the part-to-place following the cursor on the grid)
// ----------------------------------------------------------------------------
function rebuildGhost(){
  if (S.ghost){ disposeGroup(S.ghost); S.scene.remove(S.ghost); }
  if (S.ghostMirror){ disposeGroup(S.ghostMirror); S.scene.remove(S.ghostMirror); }
  S.ghost = null; S.ghostMirror = null;
  if (!S.pendingKey) return;
  const def = PARTS[S.pendingKey];
  if (!def) return;
  const mesh = def.build(THREE, def);
  applyMeshLivery(mesh, true);
  // wrap so we can rotate independently
  const g = new THREE.Group();
  g.add(mesh);
  g.rotation.set(-(S.pendingRx || 0) * QTURN, -(S.pendingRot || 0) * QTURN, -(S.pendingRz || 0) * QTURN, 'YXZ');
  S.scene.add(g);
  S.ghost = g;
  // a second, dimmer ghost previews where the mirror twin will land
  const mmesh = def.build(THREE, def);
  applyMeshLivery(mmesh, true);
  const gm = new THREE.Group();
  gm.add(mmesh);
  gm.visible = false;
  S.scene.add(gm);
  S.ghostMirror = gm;
}

function updateGhost(){
  if (S.ghostMirror) S.ghostMirror.visible = false;        // shown below only when mirror is on
  if (!S.ghost || !S.pendingKey){ if (S.ghost) S.ghost.visible = false; return; }
  if (!S.haveMouse){ S.ghost.visible = false; return; }

  const def = PARTS[S.pendingKey];
  const es = effSize(def, S.pendingRot || 0);
  // Pick a target cell. Raycast against existing part meshes first (so you can
  // stack on top / beside neighbours), else against the build plane (y=0..N).
  S.raycaster.setFromCamera(S.mouseNDC, S.camera);

  let hitPoint = null, hitNormal = null;
  const hits = S.raycaster.intersectObjects(S.partMeshes.filter(Boolean), true);
  if (hits.length){
    hitPoint = hits[0].point.clone();
    hitNormal = hits[0].face ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : new THREE.Vector3(0, 1, 0);
  } else {
    // intersect build plane at current planeY
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -S.planeY);
    const pt = new THREE.Vector3();
    if (S.raycaster.ray.intersectPlane(plane, pt)) hitPoint = pt;
    hitNormal = new THREE.Vector3(0, 1, 0);
  }
  if (!hitPoint){ S.ghost.visible = false; return; }

  // Resolve the target cell so the footprint tracks the cursor predictably.
  let gx, gy, gz;
  if (hits.length){
    // Stacking on an existing part: nudge exactly one cell along the DOMINANT axis
    // of the face normal (quantised so curved/rotated faces don't pick diagonals).
    const n = hitNormal.clone(), ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    n.set(ax >= ay && ax >= az ? Math.sign(n.x) : 0, ay > ax && ay >= az ? Math.sign(n.y) : 0, az > ax && az > ay ? Math.sign(n.z) : 0);
    const probe = hitPoint.clone().add(n.multiplyScalar(0.5));
    gx = Math.round(probe.x - es[0] / 2);
    gy = Math.max(0, Math.round(probe.y - es[1] / 2));
    gz = Math.round(probe.z - es[2] / 2);
  } else {
    // Flat build plane: no normal nudge — drop straight under the cursor at the
    // current build height (raise/lower with [ and ]).
    gx = Math.round(hitPoint.x - es[0] / 2);
    gy = Math.max(0, Math.round(S.planeY));
    gz = Math.round(hitPoint.z - es[2] / 2);
  }

  const cand = { key: S.pendingKey, gx, gy, gz, rot: S.pendingRot || 0, rx: S.pendingRx || 0, rz: S.pendingRz || 0 };
  const valid = !collides(cand, -1);
  S.ghostCell = cand;
  S.ghostValid = valid;

  const pos = placePos(cand);
  S.ghost.position.copy(pos);
  S.ghost.rotation.set(-(S.pendingRx || 0) * QTURN, -(S.pendingRot || 0) * QTURN, -(S.pendingRz || 0) * QTURN, 'YXZ');
  S.ghost.visible = true;
  tintGhost(S.ghost, valid);

  // preview the mirror twin (skip when the part straddles the symmetry plane and
  // would mirror onto itself)
  if (S.mirror && S.ghostMirror){
    const m = mirrorPart(cand);
    if (m && !(m.gx === cand.gx && m.rot === (cand.rot || 0) && m.rz === (cand.rz || 0))){
      S.ghostMirror.position.copy(placePos(m));
      S.ghostMirror.rotation.set(-(m.rx || 0) * QTURN, -(m.rot || 0) * QTURN, -(m.rz || 0) * QTURN, 'YXZ');
      S.ghostMirror.visible = true;
      tintGhost(S.ghostMirror, valid && !collides(m, -1));
    }
  }
}

function tintGhost(group, valid){
  const col = valid ? 0x39ff88 : 0xff4d6d;
  group.traverse(o => {
    if (o.isMesh){
      o.material.transparent = true;
      o.material.opacity = 0.45;
      o.material.emissive = new THREE.Color(col);
      o.material.emissiveIntensity = 0.6;
      o.material.depthWrite = false;
    }
  });
}

// occupancy test: does `cand` overlap any existing placed part (excluding index `skip`)?
function collides(cand, skip){
  if (S.freePlace) return false;          // free-placement mode: parts may overlap/clip freely
  const occ = new Set();
  S.design.parts.forEach((p, i) => { if (i !== skip) for (const c of cellsOf(p)) occ.add(c); });
  for (const c of cellsOf(cand)) if (occ.has(c)) return true;
  return false;
}

// ----------------------------------------------------------------------------
//  Placement / selection / editing operations
// ----------------------------------------------------------------------------
function selectPalette(key){
  S.pendingKey = key;
  S.pendingRot = 0; S.pendingRx = 0; S.pendingRz = 0;
  S.selected = null;
  // keep the current build height ([ / ] adjust it) so layered building persists
  // across part selections instead of snapping back to the floor each time.
  rebuildGhost();
  highlightPalette();
  renderSelInspector();
}

function highlightPalette(){
  for (const item of S.els.palette.querySelectorAll('.part-item')){
    item.classList.toggle('sel', item.dataset.key === S.pendingKey);
  }
}

function pushUndo(){
  // snapshot the parts array (deep) for Ctrl+Z. Cap history depth.
  S.undoStack.push(JSON.stringify(S.design.parts));
  if (S.undoStack.length > 60) S.undoStack.shift();
}

function undo(){
  if (!S.undoStack.length){ toast('Nothing to undo', 'warn'); return; }
  const prev = S.undoStack.pop();
  try { S.design.parts = JSON.parse(prev); } catch (e){ return; }
  S.selected = null;
  rebuildAircraft();
  refreshStats();
  emitChange(false);
  sfx('click');
}

// X grid-coordinate of the craft's symmetry plane: the centre of the ROOT part
// (the cockpit/spine the airframe is built around). Parts mirror across THIS, not
// world x=0 — so the twin lands symmetric to the subject it's built on, even when
// the craft is offset from the origin or anchored on an odd-width root.
function symPlaneX(){
  const root = S.design.parts[0];
  if (!root) return 0;
  const def = PARTS[root.key];
  const es = def ? effSize(def, root.rot || 0) : [1, 1, 1];
  return root.gx + es[0] / 2;
}

// reflect a placed part across the craft symmetry plane (gx, yaw and roll mirror)
function mirrorPart(p){
  const def = PARTS[p.key]; if (!def) return null;
  const es = effSize(def, p.rot || 0);
  const gx = Math.round(2 * symPlaneX() - p.gx - es[0]);
  return { key: p.key, gx, gy: p.gy, gz: p.gz,
    rot: (4 - (p.rot || 0)) & 3, rx: p.rx || 0, rz: (4 - (p.rz || 0)) & 3 };
}

function placeGhost(){
  if (!S.pendingKey || !S.ghostCell) return;
  if (!S.ghostValid){ toast('Cells occupied', 'bad'); sfx('hit', 0.2); return; }
  pushUndo();
  const p = { key: S.ghostCell.key, gx: S.ghostCell.gx, gy: S.ghostCell.gy, gz: S.ghostCell.gz, rot: S.ghostCell.rot, rx: S.ghostCell.rx || 0, rz: S.ghostCell.rz || 0 };
  S.design.parts.push(p);
  addPartMesh(p, S.design.parts.length - 1);
  if (S.mirror){
    const m = mirrorPart(p);
    if (m && !(m.gx === p.gx && m.rot === (p.rot || 0) && m.rz === (p.rz || 0))){   // skip a centred part that mirrors to itself
      S.design.parts.push(m);
      addPartMesh(m, S.design.parts.length - 1);
    }
  }
  refreshStats();
  emitChange();
  sfx('ui', 0.18);
}

function selectPlaced(idx){
  S.selected = idx;
  S.pendingKey = null;
  rebuildGhost();
  highlightPalette();
  highlightSelected();
  renderSelInspector();
}

function highlightSelected(){
  S.partMeshes.forEach((m, i) => {
    if (!m) return;
    const on = i === S.selected;
    m.traverse(o => {
      if (o.isMesh && o.userData.baseEmissive !== undefined){
        o.material.emissive = new THREE.Color(on ? 0x39d0ff : o.userData.baseEmissive);
        o.material.emissiveIntensity = on ? 0.5 : (o.userData.baseEI || 1);
      }
    });
  });
}

function deleteSelected(){
  if (S.selected == null) return;
  pushUndo();
  const idx = S.selected;
  S.design.parts.splice(idx, 1);
  S.selected = null;
  rebuildAircraft();
  refreshStats();
  emitChange();
  sfx('hit', 0.2);
}

// rotate the pending ghost OR the selected placed part 90° about an axis
// ('y' yaw / 'x' pitch / 'z' roll) — full 24-orientation freedom.
function rotateActive(axis = 'y'){
  const fld = axis === 'x' ? 'Rx' : axis === 'z' ? 'Rz' : 'Rot';   // pending field suffix
  const pfld = axis === 'x' ? 'rx' : axis === 'z' ? 'rz' : 'rot';  // part field
  if (S.pendingKey){
    S['pending' + fld] = (((S['pending' + fld] || 0) + 1) & 3);
    rebuildGhost();
    renderSelInspector();
    return;
  }
  if (S.selected != null){
    const p = S.design.parts[S.selected];
    if (!S.freePlace && axis === 'y' && collides({ ...p, rot: ((p.rot || 0) + 1) & 3 }, S.selected)){ toast('Rotation would overlap', 'bad'); return; }
    pushUndo();
    p[pfld] = (((p[pfld] || 0) + 1) & 3);
    rebuildAircraft();
    S.selected = S.design.parts.indexOf(p);
    highlightSelected();
    refreshStats();
    emitChange();
  }
}

// ----------------------------------------------------------------------------
//  Aircraft mesh management
// ----------------------------------------------------------------------------
function rebuildAircraft(){
  disposeGroup(S.placedGroup);
  // recreate group (disposeGroup empties it)
  S.partMeshes = [];
  S.design.parts.forEach((p, i) => addPartMesh(p, i));
  applyLivery();
  highlightSelected();
  updateGizmo();
}

function addPartMesh(p, idx){
  const def = PARTS[p.key];
  if (!def){ S.partMeshes[idx] = null; return; }
  const mesh = def.build(THREE, def);
  const g = new THREE.Group();
  g.add(mesh);
  g.position.copy(placePos(p));
  g.rotation.set(-(p.rx || 0) * QTURN, -(p.rot || 0) * QTURN, -(p.rz || 0) * QTURN, 'YXZ');
  g.userData.partIndex = idx;
  // record base emissive so selection highlight can restore it; enable shadows
  mesh.traverse(o => {
    if (o.isMesh){
      o.castShadow = true; o.receiveShadow = true;
      o.userData.partIndex = idx;
      const em = o.material.emissive ? o.material.emissive.getHex() : 0x000000;
      o.userData.baseEmissive = em;
      o.userData.baseEI = o.material.emissiveIntensity ?? 1;
      o.userData.glow = em !== 0x000000;   // engine glow etc. — don't relivery these
    }
  });
  S.placedGroup.add(g);
  S.partMeshes[idx] = g;
}

// recolour structural/wing/armor parts toward the design livery so the craft
// reads as a single aircraft; keep functional colours (engines, guns, glow).
function applyLivery(){
  const col = new THREE.Color(normHex(S.design.color));
  S.partMeshes.forEach((g, i) => {
    if (!g) return;
    const def = PARTS[S.design.parts[i].key];
    const cat = def ? def.category : '';
    // livery the airframe broadly; keep functional colours (engines, thrusters,
    // weapons, power) and glow/transparent bits as-is.
    const noLivery = (cat === 'engine' || cat === 'thruster' || cat === 'gun' || cat === 'missile' || cat === 'bomb' || cat === 'power');
    g.traverse(o => {
      if (o.isMesh && !o.userData.glow && !noLivery && !o.material.transparent){
        o.material.color.copy(col);
      }
    });
  });
}

function applyMeshLivery(mesh, isGhost){
  // ghost just keeps build colours; livery applied via tint instead
}

// ----------------------------------------------------------------------------
//  CoM / CoL gizmo
// ----------------------------------------------------------------------------
function updateGizmo(){
  if (!S.comMarker) return;
  S.comMarker.visible = S.showGizmo && S.design.parts.length > 0;
  S.colMarker.visible = S.showGizmo && S.design.parts.length > 0 && (S.stats ? S.stats.liftArea > 0 : false);
  if (!S.showGizmo) return;
  const st = S.stats || computeStats(S.design);
  if (st.com) S.comMarker.position.set(st.com.x, st.com.y, st.com.z);
  if (st.col) S.colMarker.position.set(st.col.x, st.col.y, st.col.z);
}

// ----------------------------------------------------------------------------
//  Stats readout
// ----------------------------------------------------------------------------
function refreshStats(){
  const st = computeStats(S.design);
  S.stats = st;
  renderStats(st);
  renderWarns(st);
  updateBudget(st);
  updateGizmo();
}

function kv(grid, k, v, cls){
  grid.appendChild(el('div', 'k', k));
  const ve = el('div', 'v' + (cls ? ' ' + cls : ''), v);
  grid.appendChild(ve);
}

// classify a value good/warn/bad against thresholds; returns css suffix
function cls3(v, warnAt, badAt, higherBetter = true){
  if (higherBetter){
    if (v >= warnAt) return 'good';
    if (v >= badAt) return 'warn';
    return 'bad';
  } else {
    if (v <= warnAt) return 'good';
    if (v <= badAt) return 'warn';
    return 'bad';
  }
}

function renderStats(st){
  const g = S.els.stats; clear(g);
  const kmh = (mps) => Math.round(mps * 3.6);

  kv(g, 'Parts', String(st.partCount));
  kv(g, 'Cost', fmtCr(st.cost), typeof S.opts.budget === 'number'
    ? (st.cost <= S.opts.budget ? 'good' : 'bad') : '');

  kv(g, 'Dry mass', fmtMass(st.dryMass));
  kv(g, 'Fuel', fmtMass(st.fuelMass));
  kv(g, 'All-up mass', fmtMass(st.mass));

  kv(g, 'TWR', st.twr.toFixed(2), cls3(st.twr, 1.0, 0.7));
  kv(g, 'Boost TWR', st.twrBoost.toFixed(2), cls3(st.twrBoost, 1.2, 0.9));

  // a surface vessel doesn't fly: show its NAVAL cruise (what it actually does on the water), not the
  // four-figure aerodynamic vMax. Boost/stall are aircraft-only, so drop them for ships.
  const isVessel = S.design && (S.design.role === 'ship' || S.design.role === 'carrier');
  if (isVessel){
    kv(g, 'Naval speed', kmh(navalCruise(st)) + ' km/h', cls3(kmh(navalCruise(st)), 250, 120));
  } else {
    kv(g, 'Top speed', kmh(st.vMax) + ' km/h', cls3(kmh(st.vMax), 700, 400));
    kv(g, 'Boost top', kmh(st.vMaxBoost) + ' km/h', cls3(kmh(st.vMaxBoost), 850, 500));
    kv(g, 'Stall speed', isFinite(st.vStall) ? kmh(st.vStall) + ' km/h' : '—',
      isFinite(st.vStall) ? cls3(kmh(st.vStall), 220, 320, false) : 'bad');
  }

  kv(g, 'Durability', Math.round(st.durability) + ' HP', cls3(st.durability, 150, 80));
  kv(g, 'Armor', Math.round(st.armorHP) + ' HP', st.armorHP > 0 ? 'good' : '');

  kv(g, 'Endurance', isFinite(st.endurance) ? fmtTime(st.endurance) : '∞',
    isFinite(st.endurance) ? cls3(st.endurance, 120, 50) : '');
  kv(g, 'Range', isFinite(st.range) ? Math.round(st.range) + ' km' : '∞', '');

  // heat balance: sustainable if dissipation at the overheat ceiling exceeds peak generation
  const dissCeil = st.heatDiss * (OVERHEAT_TEMP - AMBIENT_TEMP);
  const heatOk = st.heatGenMax <= dissCeil;
  kv(g, 'Heat gen', fmtNum(st.heatGenMax / 1000, 0) + ' kW', '');
  kv(g, 'Heat balance', heatOk ? 'stable' : 'overheats',
    st.heatGenMax === 0 ? '' : (heatOk ? 'good' : 'warn'));

  kv(g, 'Pitch rate', Math.round(st.agility.pitch) + '°/s', cls3(st.agility.pitch, 80, 40));
  kv(g, 'Roll rate', Math.round(st.agility.roll) + '°/s', cls3(st.agility.roll, 140, 70));
  kv(g, 'Yaw rate', Math.round(st.agility.yaw) + '°/s', cls3(st.agility.yaw, 40, 20));

  kv(g, 'Stability', (st.stability >= 0 ? '+' : '') + st.stability.toFixed(2),
    st.stability >= 0.02 ? 'good' : (st.stability >= -0.05 ? 'warn' : 'bad'));

  kv(g, 'Hardpoints', String(st.hardpoints), '');
  kv(g, 'Flares', String(st.flares), '');
  if (st.airbrakeArea > 0) kv(g, 'Airbrake', 'fitted (B)', 'good');
  kv(g, 'Sensor', st.sensor ? 'yes' : 'no', '');
  kv(g, 'Crew', String(st.crew), st.crew >= 1 ? 'good' : 'bad');
}

function renderWarns(st){
  const w = S.els.warns; clear(w);
  for (const e of st.errors){ const d = el('div', 'err', '✕ ' + e); w.appendChild(d); }
  for (const a of st.warnings){ const d = el('div', '', '! ' + a); w.appendChild(d); }
  if (!st.errors.length && !st.warnings.length){
    const ok = el('div', ''); ok.style.color = 'var(--good)'; ok.textContent = '✓ Airworthy';
    w.appendChild(ok);
  }
}

function updateBudget(st){
  if (typeof S.opts.budget !== 'number' || !S.els.budgetFill) return;
  const b = S.opts.budget;
  const pct = b > 0 ? clamp(st.cost / b, 0, 1.2) : 0;
  const over = st.cost > b;
  S.els.budgetFill.style.width = Math.min(100, pct * 100) + '%';
  S.els.budgetFill.style.background = over ? 'var(--bad)' : 'linear-gradient(90deg,var(--accent2),var(--accent))';
  S.els.budgetLbl.innerHTML = '<span>Budget</span><span class="' + (over ? 'bad' : '') + '" style="color:' +
    (over ? 'var(--bad)' : 'var(--ink)') + '">' + fmtCr(st.cost) + ' / ' + fmtCr(b) + '</span>';
  S.els.budgetBox.style.borderColor = over ? 'var(--bad)' : 'var(--edge)';
}

// selected-part / pending inspector in the right panel
function renderSelInspector(){
  const box = S.els.selBox; if (!box) return;
  clear(box);
  let def = null, label = '';
  if (S.selected != null && S.design.parts[S.selected]){
    def = PARTS[S.design.parts[S.selected].key]; label = 'Selected part';
  } else if (S.pendingKey){
    def = PARTS[S.pendingKey]; label = 'Placing';
  }
  if (!def){
    box.innerHTML = '<div class="faint small">Select a part from the palette to place it, or click a part on the aircraft to edit it.</div>';
    return;
  }
  const head = el('div', 'small'); head.style.cssText = 'color:var(--accent);font-family:var(--mono);letter-spacing:.12em;margin-bottom:6px;';
  head.textContent = label.toUpperCase();
  box.appendChild(head);
  const nm = el('div'); nm.style.cssText = 'font-weight:700;margin-bottom:2px;'; nm.textContent = def.name;
  box.appendChild(nm);
  const desc = el('div', 'faint small'); desc.style.lineHeight = '1.4'; desc.textContent = def.desc || '';
  box.appendChild(desc);
  const meta = el('div', 'mono small'); meta.style.cssText = 'margin-top:6px;color:var(--ink-dim);';
  const rot = S.selected != null ? (S.design.parts[S.selected].rot || 0) : (S.pendingRot || 0);
  meta.textContent = metaLine(def) + ' · rot ' + (rot * 90) + '°';
  box.appendChild(meta);
}

// ----------------------------------------------------------------------------
//  File / library actions
// ----------------------------------------------------------------------------
function doSave(){
  core.libSave(S.design);
  toast('Saved “' + (S.design.name || 'Aircraft') + '” to library', 'good');
  sfx('ui', 0.2);
  emitChange(false);
}

function doDuplicate(){
  const c = core.cloneDesign(S.design);
  core.libSave(c);
  toast('Duplicated as “' + c.name + '”', 'good');
  sfx('ui', 0.2);
}

function doExport(){
  const code = core.exportCode(S.design);
  showModal('Export design code', (body, closeFn) => {
    const p = el('div', 'faint small', 'Copy this code and share it — paste into Import to rebuild the aircraft.');
    p.style.marginBottom = '10px';
    body.appendChild(p);
    const ta = el('textarea'); ta.value = code; ta.readOnly = true;
    ta.style.cssText = 'width:100%;height:140px;resize:vertical;font-family:var(--mono);font-size:12px;';
    body.appendChild(ta);
    const row = el('div', 'row'); row.style.marginTop = '12px';
    const copy = el('button', 'btn accent', 'Copy to clipboard');
    copy.onclick = () => {
      ta.select();
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(code);
        else document.execCommand('copy');
        toast('Copied', 'good');
      } catch (e){ document.execCommand('copy'); }
      sfx('click');
    };
    const close = el('button', 'btn', 'Close'); close.onclick = closeFn;
    row.appendChild(copy); row.appendChild(close);
    body.appendChild(row);
    setTimeout(() => ta.focus(), 30);
  });
}

function doImport(){
  showModal('Import design code', (body, closeFn) => {
    const p = el('div', 'faint small', 'Paste an ASK2 design code below. This replaces the current parts.');
    p.style.marginBottom = '10px';
    body.appendChild(p);
    const ta = el('textarea'); ta.placeholder = 'ASK2.…';
    ta.style.cssText = 'width:100%;height:120px;resize:vertical;font-family:var(--mono);font-size:12px;';
    body.appendChild(ta);
    const row = el('div', 'row'); row.style.marginTop = '12px';
    const ok = el('button', 'btn accent', 'Import');
    ok.onclick = () => {
      const d = core.importCode(ta.value.trim());
      if (!d){ toast('Invalid code', 'bad'); sfx('hit', 0.2); return; }
      pushUndo();
      // keep our identity (id) so save() updates the same library slot,
      // but adopt the imported airframe + cosmetics.
      S.design.parts = d.parts;
      S.design.name = d.name || S.design.name;
      S.design.color = d.color || S.design.color;
      S.design.role = d.role || S.design.role;
      S.selected = null; S.pendingKey = null;
      rebuildAircraft();
      buildInfo(S.els.info);
      refreshStats();
      frameCamera();
      emitChange();
      toast('Imported “' + (d.name || 'Aircraft') + '”', 'good');
      sfx('ui', 0.2);
      closeFn();
    };
    const cancel = el('button', 'btn', 'Cancel'); cancel.onclick = closeFn;
    row.appendChild(ok); row.appendChild(cancel);
    body.appendChild(row);
    setTimeout(() => ta.focus(), 30);
  });
}

function doClear(){
  if (!S.design.parts.length){ toast('Already empty', 'warn'); return; }
  showModal('Clear airframe?', (body, closeFn) => {
    body.appendChild(el('div', 'small', 'Remove all ' + S.design.parts.length + ' parts from this aircraft? (Ctrl+Z can undo.)'));
    const row = el('div', 'row'); row.style.marginTop = '14px';
    const yes = el('button', 'btn danger', 'Clear all');
    yes.onclick = () => {
      pushUndo();
      S.design.parts = [];
      S.selected = null; S.pendingKey = null;
      rebuildAircraft();
      refreshStats();
      emitChange();
      sfx('hit', 0.2);
      closeFn();
    };
    const no = el('button', 'btn', 'Cancel'); no.onclick = closeFn;
    row.appendChild(yes); row.appendChild(no);
    body.appendChild(row);
  });
}

// ----------------------------------------------------------------------------
//  Modal helper (uses #modal-root if present, else body)
// ----------------------------------------------------------------------------
function showModal(title, fill){
  const host = $('modal-root') || document.body;
  const bg = el('div', 'modal-bg');
  const m = el('div', 'modal');
  const h = el('h2', '', title); m.appendChild(h);
  const body = el('div'); m.appendChild(body);
  bg.appendChild(m);
  host.appendChild(bg);
  const closeFn = () => { bg.remove(); };
  bg.onclick = (e) => { if (e.target === bg) closeFn(); };
  // Esc closes; scoped listener removed on close
  const onKey = (e) => { if (e.key === 'Escape'){ closeFn(); removeEventListener('keydown', onKey, true); } };
  addEventListener('keydown', onKey, true);
  fill(body, () => { closeFn(); removeEventListener('keydown', onKey, true); });
  return closeFn;
}

// ----------------------------------------------------------------------------
//  Input handling (mouse on the stage + global keys)
// ----------------------------------------------------------------------------
function installInput(){
  const stage = S.els.stage;
  const onDown = (e) => {
    // ignore clicks that originate on UI overlays (toolbar/hint/budget)
    if (e.target.closest('.hangar-toolbar, .hangar-hint, .budgetbar')) return;
    stage.focus?.();
    S.lastMx = e.clientX; S.lastMy = e.clientY;
    setMouse(e);
    if (e.button === 0){
      // grab a move-gizmo axis arrow? (only when a part is selected and shown)
      if (S.moveGizmo && S.moveGizmo.visible && !S.pendingKey){
        S.raycaster.setFromCamera(S.mouseNDC, S.camera);
        const handles = [...S.gizmoHandles.x, ...S.gizmoHandles.y, ...S.gizmoHandles.z];
        const gh = S.raycaster.intersectObjects(handles, false);
        if (gh.length){ beginGizmoDrag(gh[0].object.userData.gizmoAxis); S.downX = e.clientX; S.downY = e.clientY; S.moved = false; return; }
      }
      // left: either orbit-or-place. We treat a click (no drag) as place/select.
      S.dragMode = 'orbit';
      S.downX = e.clientX; S.downY = e.clientY; S.moved = false;
    } else if (e.button === 2 || e.button === 1){
      e.preventDefault();
      S.dragMode = 'pan';
      S.downX = e.clientX; S.downY = e.clientY; S.moved = false;
    }
  };
  const onMove = (e) => {
    setMouse(e);
    if (!S.dragMode){ return; }
    const dx = e.clientX - S.lastMx, dy = e.clientY - S.lastMy;
    S.lastMx = e.clientX; S.lastMy = e.clientY;
    if (Math.abs(e.clientX - S.downX) + Math.abs(e.clientY - S.downY) > 4) S.moved = true;
    if (S.dragMode === 'orbit' && S.moved){
      S.camYaw -= dx * 0.006;
      S.camPitch += dy * 0.006;
      updateCamera();
    } else if (S.dragMode === 'pan' && S.moved){
      panCamera(dx, dy);
    } else if (S.dragMode === 'gizmo'){
      S.moved = true;
      dragGizmo();
    }
  };
  const onUp = (e) => {
    setMouse(e);
    const mode = S.dragMode; S.dragMode = null;
    if (mode === 'gizmo'){
      S.gizmoDrag = null;
      if (S.moved){ refreshStats(); emitChange(); sfx('ui', 0.16); }
      return;
    }
    if (e.button === 0 && mode === 'orbit' && !S.moved){
      handleLeftClick(e);
    } else if ((e.button === 2 || e.button === 1) && mode === 'pan' && !S.moved){
      handleRightClick(e);
    }
  };
  const onWheel = (e) => {
    e.preventDefault();
    S.camDist *= (1 + Math.sign(e.deltaY) * 0.12);
    updateCamera();
  };
  const onCtx = (e) => { if (e.target.closest('.hangar-stage')) e.preventDefault(); };
  const onLeave = () => { S.haveMouse = false; };

  stage.addEventListener('mousedown', onDown);
  // move/up on window so a drag continues outside the stage
  addEventListener('mousemove', onMove);
  addEventListener('mouseup', onUp);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('contextmenu', onCtx);
  stage.addEventListener('mouseleave', onLeave);
  addEventListener('keydown', onKeyDown);

  S._input = { onDown, onMove, onUp, onWheel, onCtx, onLeave, onKeyDown, stage };
}

function removeInput(){
  const i = S._input; if (!i) return;
  i.stage.removeEventListener('mousedown', i.onDown);
  removeEventListener('mousemove', i.onMove);
  removeEventListener('mouseup', i.onUp);
  i.stage.removeEventListener('wheel', i.onWheel);
  i.stage.removeEventListener('contextmenu', i.onCtx);
  i.stage.removeEventListener('mouseleave', i.onLeave);
  removeEventListener('keydown', i.onKeyDown);
  S._input = null;
}

function setMouse(e){
  const r = S.els.stage.getBoundingClientRect();
  S.mouseNDC.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  S.mouseNDC.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  S.haveMouse = true;
}

function panCamera(dx, dy){
  // pan in the camera's screen plane, scaled by distance for KSP-like feel
  const cam = S.camera;
  const right = new THREE.Vector3(); const up = new THREE.Vector3();
  cam.matrixWorld.extractBasis(right, up, new THREE.Vector3());
  const scale = S.camDist * 0.0016;
  const move = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
  S.camTarget.add(move);
  updateCamera();
}

// ---- move-gizmo drag: translate the selected part along one world axis --------
function beginGizmoDrag(axis){
  const p = S.design.parts[S.selected]; if (!p) return;
  const axisDir = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  const center = placePos(p);
  // drag plane through the part centre, normal = camera-forward flattened off the axis,
  // so the cursor's motion along the axis maps cleanly to displacement.
  const camDir = new THREE.Vector3(); S.camera.getWorldDirection(camDir);
  const n = camDir.clone().addScaledVector(axisDir, -camDir.dot(axisDir));
  if (n.lengthSq() < 1e-4) n.set(0, 1, 0).addScaledVector(axisDir, -axisDir.y);
  n.normalize();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, center);
  S.raycaster.setFromCamera(S.mouseNDC, S.camera);
  const hit = new THREE.Vector3();
  const ok = S.raycaster.ray.intersectPlane(plane, hit);
  S.dragMode = 'gizmo';
  S.gizmoDrag = { axisDir, plane, center, startScalar: ok ? hit.sub(center).dot(axisDir) : 0,
    kx: axis === 'x' ? 1 : 0, ky: axis === 'y' ? 1 : 0, kz: axis === 'z' ? 1 : 0,
    origGx: p.gx, origGy: p.gy, origGz: p.gz, partRef: p, pushed: false };
}

function dragGizmo(){
  const g = S.gizmoDrag; if (!g) return;
  S.raycaster.setFromCamera(S.mouseNDC, S.camera);
  const hit = new THREE.Vector3();
  if (!S.raycaster.ray.intersectPlane(g.plane, hit)) return;
  const scalar = hit.sub(g.center).dot(g.axisDir);
  const cells = Math.round(scalar - g.startScalar);                 // 1 grid cell = 1 m
  const nx = g.origGx + g.kx * cells, ny = g.origGy + g.ky * cells, nz = g.origGz + g.kz * cells;
  const p = g.partRef;
  if (p.gx === nx && p.gy === ny && p.gz === nz) return;
  if (collides({ ...p, gx: nx, gy: ny, gz: nz }, S.selected)) return;  // don't shove into another part
  if (!g.pushed){ pushUndo(); g.pushed = true; }
  p.gx = nx; p.gy = ny; p.gz = nz;
  const mesh = S.partMeshes[S.selected];
  if (mesh) mesh.position.copy(placePos(p));
  refreshStats();
  updateMoveGizmo();
}

function handleLeftClick(e){
  setMouse(e);
  if (S.pendingKey){
    placeGhost();
    return;
  }
  // otherwise: select a placed part under the cursor
  S.raycaster.setFromCamera(S.mouseNDC, S.camera);
  const hits = S.raycaster.intersectObjects(S.partMeshes.filter(Boolean), true);
  if (hits.length){
    let o = hits[0].object;
    while (o && o.userData.partIndex === undefined) o = o.parent;
    if (o && o.userData.partIndex !== undefined){ selectPlaced(o.userData.partIndex); sfx('click'); return; }
  }
  // clicked empty space → deselect
  if (S.selected != null){ S.selected = null; highlightSelected(); renderSelInspector(); }
}

function handleRightClick(e){
  setMouse(e);
  // right-click on a placed part removes it
  S.raycaster.setFromCamera(S.mouseNDC, S.camera);
  const hits = S.raycaster.intersectObjects(S.partMeshes.filter(Boolean), true);
  if (hits.length){
    let o = hits[0].object;
    while (o && o.userData.partIndex === undefined) o = o.parent;
    if (o && o.userData.partIndex !== undefined){ selectPlaced(o.userData.partIndex); deleteSelected(); return; }
  }
  // right-click empty space while placing → cancel placement
  if (S.pendingKey){ S.pendingKey = null; rebuildGhost(); highlightPalette(); renderSelInspector(); }
}

function onKeyDown(e){
  if (!S || S.destroyed) return;
  // don't hijack typing in inputs/textarea
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  // modal open? let Escape pass to its own handler.
  if ($('modal-root') && $('modal-root').querySelector('.modal-bg')) return;
  if (document.querySelector('.modal-bg')) return;

  const k = e.key.toLowerCase();
  if (k === 'r'){ e.preventDefault(); rotateActive('y'); }
  else if (k === 't'){ e.preventDefault(); rotateActive('x'); }
  else if (k === 'y'){ e.preventDefault(); rotateActive('z'); }
  else if (k === 'delete' || k === 'backspace'){ e.preventDefault(); deleteSelected(); }
  else if (k === 'escape'){ if (S.pendingKey){ S.pendingKey = null; rebuildGhost(); highlightPalette(); renderSelInspector(); } else if (S.selected != null){ S.selected = null; highlightSelected(); renderSelInspector(); } }
  else if (k === 'z' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); undo(); }
  else if (k === 'f'){ e.preventDefault(); frameCamera(); }
  else if (k === 'g'){ e.preventDefault(); S.showGizmo = !S.showGizmo; updateGizmo(); }
  else if (e.key === ']' || e.key === '='){ e.preventDefault(); S.planeY = Math.min(40, (S.planeY || 0) + 1); toast('Build height: ' + S.planeY); updateGhost(); }
  else if (e.key === '[' || e.key === '-'){ e.preventDefault(); S.planeY = Math.max(0, (S.planeY || 0) - 1); toast('Build height: ' + S.planeY); updateGhost(); }
}

// ----------------------------------------------------------------------------
//  Misc helpers
// ----------------------------------------------------------------------------
function emitChange(refresh = true){
  if (refresh && S.stats == null) S.stats = computeStats(S.design);
  if (S.opts.onChange) try { S.opts.onChange(S.design, S.stats || computeStats(S.design)); } catch (e){ console.error(e); }
}

function normHex(c){
  if (!c) return '#cfd8e3';
  c = String(c).trim();
  if (c[0] !== '#') c = '#' + c;
  if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#cfd8e3';
}

function disposeGroup(group){
  if (!group) return;
  const kids = group.children.slice();
  for (const ch of kids){
    ch.traverse?.(o => {
      if (o.isMesh){
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose?.());
        else o.material?.dispose?.();
      }
    });
    group.remove(ch);
  }
}

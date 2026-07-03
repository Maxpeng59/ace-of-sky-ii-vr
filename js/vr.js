// ============================================================================
//  Ace of Sky II · VR — vr.js
//  The WebXR layer for the VR edition. Adds an "Enter VR" button, manages the
//  immersive session + motion controllers, and drives the two immersive modes:
//    · HANGAR  — point a controller at the parts shelf, squeeze to grab a part,
//                carry it to the build grid and release to snap it onto the plane.
//    · COCKPIT — you sit INSIDE the aircraft: a rig follows the craft so the
//                world banks around you, and you fly with a grabbable centre
//                stick (pitch/roll/yaw) + a throttle lever; trigger = fire.
//  Desktop play is untouched — none of this runs unless the player taps Enter VR
//  on a WebXR-capable device, and every hook is guarded by isPresenting().
// ============================================================================
import * as THREE from 'three';
import { getRenderer, onVRFrame, isPresenting, setScene } from './engine.js';
import { PARTS, CATEGORIES } from './parts.js';

let session = null, renderer = null;
const controllers = [];                 // [{ ctrl, grip, ray, hand, squeezing, selecting, grabbed }]
let mode = 'menu', ctx = null;          // active immersive mode + its context
let rig = null;                          // group: camera + cockpit + controllers; follows the craft in cockpit mode
const TMP = new THREE.Vector3(), TMP2 = new THREE.Vector3(), TMPQ = new THREE.Quaternion();
const buttons = new Set();

export function vrAvailable(){ return !!(navigator.xr); }
export function vrActive(){ return !!session; }

// ---------------------------------------------------------------------------
//  Enter-VR button (hidden unless a headset/runtime is actually present)
// ---------------------------------------------------------------------------
export function addEnterVRButton(parent, label = '🥽 ENTER VR'){
  const btn = document.createElement('button');
  btn.className = 'btn'; btn.textContent = label; btn.style.display = 'none';
  parent.appendChild(btn); buttons.add(btn);
  if (navigator.xr && navigator.xr.isSessionSupported){
    navigator.xr.isSessionSupported('immersive-vr')
      .then(ok => { btn.style.display = ok ? '' : 'none'; })
      .catch(() => { btn.style.display = 'none'; });
  }
  btn.addEventListener('click', () => { session ? endVR() : enterVR(); });
  return btn;
}
function setButtonsLabel(t){ for (const b of buttons) if (b.isConnected) b.textContent = t; }

export async function enterVR(){
  renderer = getRenderer();
  if (!renderer || !navigator.xr){ return; }
  let s;
  try { s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'] }); }
  catch (e){ console.warn('[vr] session request failed', e); return; }
  session = s;
  try { renderer.xr.setReferenceSpaceType('local-floor'); } catch (e){ /* fallback to default */ }
  await renderer.xr.setSession(session);
  setupControllers();
  setButtonsLabel('🥽 EXIT VR');
  session.addEventListener('end', onSessionEnd);
  // Entering from the MENU: there is no 3D scene yet (the menu is pure DOM, which an immersive
  // session can't show), so without this the player stands in a BLACK VOID. Give them a lit
  // holodeck-style room with instructions instead.
  if (!ctx || mode === 'menu') showMenuSpace();
}
export function endVR(){ if (session) session.end(); }
function onSessionEnd(){
  session = null; teardownControllers();
  detachRig();
  disposeMenuSpace();
  setButtonsLabel('🥽 ENTER VR');
}

// remove the rig and UNDO its side effects: re-show the player's airframe that cockpit
// mode hid, and hand the camera back to its old parent so the desktop chase-cam works.
function detachRig(){
  if (!rig) return;
  const u = rig.userData || {};
  if (u.cam){ rig.remove(u.cam); if (u.camParent) u.camParent.add(u.cam); }
  if (u.hidCraft && u.hidCraft.group) u.hidCraft.group.visible = true;
  if (rig.parent) rig.parent.remove(rig);
  rig = null;
}

// ---------------------------------------------------------------------------
//  MENU SPACE — a small lit room shown when VR starts outside a battle/hangar,
//  so entering from the menu is never a black void.
// ---------------------------------------------------------------------------
let menuSpace = null;
function showMenuSpace(){
  disposeMenuSpace();
  const sc = new THREE.Scene();
  sc.background = new THREE.Color(0x0e1620);
  sc.fog = new THREE.Fog(0x0e1620, 12, 70);
  sc.add(new THREE.HemisphereLight(0x9fc6ff, 0x1a232e, 1.1));
  const grid = new THREE.GridHelper(60, 30, 0x39d0ff, 0x1f3a52); sc.add(grid);
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 256;
  const c2 = cv.getContext('2d');
  c2.fillStyle = '#0e1620'; c2.fillRect(0, 0, 1024, 256);
  c2.strokeStyle = '#39d0ff'; c2.lineWidth = 6; c2.strokeRect(8, 8, 1008, 240);
  c2.fillStyle = '#dfe8f5'; c2.font = 'bold 52px monospace'; c2.textAlign = 'center';
  c2.fillText('ACE OF SKY — VR READY', 512, 92);
  c2.font = '34px monospace'; c2.fillStyle = '#9fc0d8';
  c2.fillText('Take the headset off / exit VR, launch a battle', 512, 156);
  c2.fillText('from the page — the cockpit then loads around you.', 512, 204);
  const tex = new THREE.CanvasTexture(cv);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ map: tex }));
  panel.position.set(0, 1.5, -3); sc.add(panel);
  const cam = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
  sc.add(cam);                                   // headset pose applies relative to the scene floor
  menuSpace = { sc, cam, tex, panel, grid };
  setScene(sc, cam);
}
function disposeMenuSpace(){
  if (!menuSpace) return;
  menuSpace.tex.dispose(); menuSpace.panel.geometry.dispose(); menuSpace.panel.material.dispose();
  if (menuSpace.grid.geometry) menuSpace.grid.geometry.dispose();
  if (menuSpace.grid.material && menuSpace.grid.material.dispose) menuSpace.grid.material.dispose();
  setScene(null, null);
  menuSpace = null;
}

// ---------------------------------------------------------------------------
//  Motion controllers — a ray for pointing + a simple "hand" box for grabbing
// ---------------------------------------------------------------------------
function setupControllers(){
  teardownControllers();
  for (let i = 0; i < 2; i++){
    const ctrl = renderer.xr.getController(i);
    const grip = renderer.xr.getControllerGrip(i);
    // pointing ray
    const rg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const ray = new THREE.Line(rg, new THREE.LineBasicMaterial({ color: 0x39d0ff, transparent: true, opacity: 0.8 }));
    ray.scale.z = 5; ctrl.add(ray);
    // a small "hand" so the controller has presence
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.12), new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.5, roughness: 0.5 }));
    hand.position.z = -0.02; grip.add(hand);
    const rec = { ctrl, grip, ray, hand, squeezing: false, selecting: false, grabbed: null };
    ctrl.addEventListener('selectstart', () => { rec.selecting = true; });
    ctrl.addEventListener('selectend', () => { rec.selecting = false; });
    ctrl.addEventListener('squeezestart', () => { rec.squeezing = true; });
    ctrl.addEventListener('squeezeend', () => { rec.squeezing = false; releaseGrab(rec); });
    controllers.push(rec);
  }
}
function teardownControllers(){
  for (const c of controllers){
    if (c.ray && c.ray.parent) c.ray.parent.remove(c.ray);
    if (c.hand && c.hand.parent) c.hand.parent.remove(c.hand);
  }
  controllers.length = 0;
}

// add the controllers (+rig children) into whatever scene the active mode owns
function ensureControllersIn(scene){
  if (!scene) return;
  for (const c of controllers){
    if (c.ctrl.parent !== scene && c.ctrl.parent == null) scene.add(c.ctrl);
    if (c.grip.parent !== scene && c.grip.parent == null) scene.add(c.grip);
  }
}

// ---------------------------------------------------------------------------
//  Mode dispatch — battle/hangar tell VR what to drive (and give it their scene)
// ---------------------------------------------------------------------------
export function setVRMode(m, context){
  mode = m || 'menu'; ctx = context || null;
  detachRig();
  if (!isPresenting() || !ctx) return;
  disposeMenuSpace();                         // a real mode replaces the holding room
  if (mode === 'cockpit') buildCockpit();
  else if (mode === 'hangar') buildHangarVR();
}

onVRFrame((dt) => {
  if (!isPresenting() || !ctx) return;
  if (mode === 'cockpit') updateCockpit(dt);
  else if (mode === 'hangar') updateHangar(dt);
});

// ===========================================================================
//  COCKPIT MODE — sit in the plane and fly with a stick + throttle
// ===========================================================================
let cockpit = null;   // { stick, throttle, baseQuat, seatY }
function buildCockpit(){
  const scene = ctx.scene, cam = ctx.camera;
  if (!scene || !cam) return;
  rig = new THREE.Group(); scene.add(rig);
  // the headset camera rides in the rig; controllers too, so they move with the plane
  rig.userData.cam = cam; rig.userData.camParent = cam.parent || null;
  if (cam.parent) cam.parent.remove(cam);
  rig.add(cam);
  for (const c of controllers){ rig.add(c.ctrl); rig.add(c.grip); }
  // HIDE the pilot's own airframe: the rig sits at the craft's centre, which is INSIDE the
  // fuselage geometry — leaving it visible walls the pilot in darkness and buries the stick
  // and throttle inside the hull. First-person standard: you ARE the plane, so don't draw it.
  // (detachRig restores visibility on exit / mode change.)
  if (ctx.sim && ctx.sim.player && ctx.sim.player.group){
    ctx.sim.player.group.visible = false;
    rig.userData.hidCraft = ctx.sim.player;
  }

  const g = new THREE.Group(); rig.add(g); cockpit = { group: g };
  const dark = (c) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.5, roughness: 0.5 });
  // canopy frame ring + dash, sized around a seated pilot at eye y≈1.1, looking -Z(fwd of craft is +Z, see below)
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.35, 0.4), dark(0x20262d)); dash.position.set(0, 0.78, 1.0); g.add(dash);
  const coam = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.18), dark(0x171b20)); coam.position.set(0, 0.98, 1.12); g.add(coam);
  for (const sx of [-1, 1]){ const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 1.4), dark(0x171b20)); rail.position.set(sx * 0.62, 1.05, 0.5); rail.rotation.x = -0.3; g.add(rail); }
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.5), dark(0x2a3038)); seat.position.set(0, 0.45, -0.15); g.add(seat);
  const seatback = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.1), dark(0x2a3038)); seatback.position.set(0, 0.8, -0.4); g.add(seatback);
  // ---- centre flight stick ----
  const stick = new THREE.Group(); stick.position.set(0, 0.5, 0.35); g.add(stick);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.34, 12), dark(0x2c3138)); shaft.position.y = 0.17; stick.add(shaft);
  const grip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshStandardMaterial({ color: 0x39d0ff, emissive: 0x0a3344, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 })); grip.position.y = 0.36; stick.add(grip);
  cockpit.stick = stick; cockpit.stickGrip = grip; cockpit.stickHome = stick.position.clone();
  // ---- throttle lever (left console) ----
  const throt = new THREE.Group(); throt.position.set(-0.5, 0.55, 0.15); g.add(throt);
  const tl = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 10), dark(0x2c3138)); tl.position.y = 0.11; throt.add(tl);
  const tk = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), new THREE.MeshStandardMaterial({ color: 0xff8a3d, emissive: 0x3a1a00, emissiveIntensity: 0.6 })); tk.position.y = 0.22; throt.add(tk);
  cockpit.throttle = throt; cockpit.throttleKnob = tk;
  cockpit.eye = new THREE.Vector3(0, 1.05, -0.1);   // seated eye offset within the rig (craft-local)
}

function updateCockpit(dt){
  const sim = ctx.sim; if (!rig || !cockpit || !sim || !sim.player || !sim.player.alive) return;
  const p = sim.player;
  // rig rides the craft: position at the cockpit, orientation = airframe (world banks around you)
  rig.position.copy(p.pos);
  rig.quaternion.copy(p.group.quaternion);
  // the craft's own +Z is the nose; place the seat so the pilot looks forward (+Z)
  // (cockpit group already faces +Z; nothing extra needed)

  // ---- grab handling: each controller, if squeezing near the stick/throttle, drives it ----
  for (const c of controllers){
    const gpW = TMP.setFromMatrixPosition(c.grip.matrixWorld);
    if (c.squeezing && !c.grabbed){
      const sW = TMP2.setFromMatrixPosition(cockpit.stickGrip.matrixWorld);
      const tW = new THREE.Vector3().setFromMatrixPosition(cockpit.throttleKnob.matrixWorld);
      if (gpW.distanceTo(sW) < 0.18) c.grabbed = 'stick';
      else if (gpW.distanceTo(tW) < 0.18) c.grabbed = 'throttle';
    }
  }
  // STICK: deflection of the grabbing hand from the stick base (both in the craft
  // frame) steers the reticle the nose chases. Signs are tunable in-headset.
  const sc = controllers.find(c => c.grabbed === 'stick' && c.squeezing);
  if (sc){
    const handL = rig.worldToLocal(TMP.setFromMatrixPosition(sc.grip.matrixWorld));
    const baseL = rig.worldToLocal(TMP2.setFromMatrixPosition(cockpit.stick.matrixWorld));
    const dx = THREE.MathUtils.clamp((handL.x - baseL.x) / 0.25, -1, 1);   // lean left / right
    const dz = THREE.MathUtils.clamp((handL.z - baseL.z) / 0.25, -1, 1);   // +Z toward nose (push) / -Z toward pilot (pull)
    const RATE = 1.9;
    sim.aimYaw += dx * RATE * dt;                                          // lean right → bank/turn right
    sim.aimPitch = THREE.MathUtils.clamp(sim.aimPitch - dz * RATE * dt, -1.4, 1.4);   // pull back → nose up
    cockpit.stick.rotation.z = -dx * 0.4; cockpit.stick.rotation.x = dz * 0.4;        // visual lean
  } else if (cockpit.stick){ cockpit.stick.rotation.z *= 0.8; cockpit.stick.rotation.x *= 0.8; }
  // THROTTLE: hand forward/back on the lever → drive the same key channels readPlayerInput
  // reads (it recomputes throttle from keys every frame, so we must set keys, not throttle).
  const tc = controllers.find(c => c.grabbed === 'throttle' && c.squeezing);
  if (tc){
    const tBase = rig.worldToLocal(TMP.setFromMatrixPosition(cockpit.throttle.matrixWorld));
    const hand = rig.worldToLocal(TMP2.setFromMatrixPosition(tc.grip.matrixWorld));
    const fwd = THREE.MathUtils.clamp((hand.z - tBase.z) / 0.2 + 0.5, 0, 1);
    const K = sim.keys || (sim.keys = {});
    p.engineOn = fwd > 0.04;                  // lever to the floor = cut engine / glide
    K['w'] = fwd > 0.6;                        // forward = full power
    K['s'] = fwd > 0.05 && fwd < 0.25;         // back = brake
    if (cockpit.throttleKnob) cockpit.throttleKnob.position.y = 0.22 - (1 - fwd) * 0.16;
  }
  // TRIGGER on either hand = fire (set the key channel readPlayerInput consumes)
  if (sim.keys) sim.keys[' '] = controllers.some(c => c.selecting);
}
// release on squeeze-end: cockpit grips are 'stick'/'throttle' strings (just let go);
// a hangar grab is a carried part Object3D — drop it onto the build grid.
function releaseGrab(rec){
  if (!rec || !rec.grabbed) return;
  const g = rec.grabbed; rec.grabbed = null;
  if (g && g.isObject3D){
    const w = TMP.setFromMatrixPosition(g.matrixWorld);
    if (ctx && ctx.place) ctx.place(g.userData.partKey, w);   // hangar maps world → grid cell + adds the part
    if (g.parent) g.parent.remove(g);
    if (hangarVR){ const i = hangarVR.held.indexOf(g); if (i >= 0) hangarVR.held[i] = null; }
  }
}

// ===========================================================================
//  HANGAR MODE — grab parts off a shelf and place them on the build grid
// ===========================================================================
let hangarVR = null;
function buildHangarVR(){
  const scene = ctx.scene; if (!scene) return;
  rig = new THREE.Group(); scene.add(rig);
  for (const c of controllers){ scene.add(c.ctrl); scene.add(c.grip); }
  hangarVR = { shelf: new THREE.Group(), held: [null, null] };
  scene.add(hangarVR.shelf);
  // a curved shelf of grabbable part chips in front of the player (one per common part)
  const keys = ctx.paletteKeys || pickPaletteKeys();
  const n = keys.length, R = 1.6;
  keys.forEach((key, i) => {
    const def = PARTS[key]; if (!def || !def.build) return;
    let mesh; try { mesh = def.build(THREE, def); } catch (e){ return; }
    const chip = new THREE.Group(); chip.add(mesh);
    const a = (i / Math.max(1, n - 1) - 0.5) * 1.4;       // fan ±0.7 rad
    chip.position.set(Math.sin(a) * R, 1.1 + (i % 2) * 0.25, -Math.cos(a) * R + 0.3);
    chip.userData.partKey = key; chip.userData.shelfHome = chip.position.clone();
    hangarVR.shelf.add(chip);
  });
}
function pickPaletteKeys(){
  // a sensible starter set: one representative per category that has buildable parts
  const want = ['cockpit_light', 'fuselage_s', 'fuel_small', 'jet_basic', 'wing_delta', 'tail_v', 'tail_h', 'gun_mg', 'missile_ir', 'intake'];
  return want.filter(k => PARTS[k] && PARTS[k].build);
}
function updateHangar(dt){
  if (!hangarVR) return;
  controllers.forEach((c, idx) => {
    const gpW = TMP.setFromMatrixPosition(c.grip.matrixWorld);
    // grab a shelf chip on squeeze
    if (c.squeezing && !c.grabbed){
      let best = null, bd = 0.2;
      hangarVR.shelf.children.forEach(chip => { const d = gpW.distanceTo(TMP2.setFromMatrixPosition(chip.matrixWorld)); if (d < bd){ bd = d; best = chip; } });
      if (best){ const def = PARTS[best.userData.partKey]; let m; try { m = def.build(THREE, def); } catch (e){ m = new THREE.Group(); }
        const held = new THREE.Group(); held.add(m); held.userData.partKey = best.userData.partKey; ctx.scene.add(held);
        c.grabbed = held; hangarVR.held[idx] = held; }
    }
    // carry the held part with the hand (drop is handled in releaseGrab on squeeze-end)
    if (c.grabbed && c.grabbed.isObject3D){ c.grabbed.position.copy(gpW); c.grip.getWorldQuaternion(c.grabbed.quaternion); }
  });
}

// ============================================================================
//  Ace of Sky II — battle.js
//  THE DOGFIGHT SIMULATION. The heart of the game.
//
//  Responsibilities:
//    - Build a world for config.env (day/dusk/night/sea): sky, lights, terrain,
//      fog. Uses the shared engine (setScene / onFrame) and tears down on stop.
//    - Spawn every aircraft (player, allies, enemies, carriers) by building a
//      THREE.Group from its design.parts via PARTS[key].build(THREE, def),
//      placed at partCenter() with quarter-turn Y rotation. computeStats() is
//      cached per craft and DRIVES the entire flight model.
//    - A real flight integrator: thrust→accel, afterburner (boostThrust, drains
//      fuel at boostBurn), aero drag (dragForce), lift vs weight with a stall
//      regime below stats.vStall, turn rates from stats.agility, fuel burn,
//      thermoStep heat → overheat damage, durability HP pool, armor soak,
//      gravity, and ground/sea collision.
//    - Player controls: W/S throttle, mouse pitch+yaw (invertY respected),
//      A/D roll, Shift boost, Space fire, Tab/Q/E cycle weapon, F flares,
//      G jettison drop tanks. Chase camera with lag + shake.
//    - Combat: guns (fast tracer projectiles), missiles (homeMissile),
//      lockmissile (LockSystem full-lock then auto-fire), bombs (ballistic).
//      Splash, sparks, sfx, explosions on kill.
//    - HUD on the 2D <canvas id="hud-canvas"> + DOM bars: HP/armor, fuel,
//      boost, heat, weapon+ammo, radar, objective, speed/alt/throttle, warnings.
//      THE PREDICTION SYSTEM: a LockSystem instance, drawPrediction (gun lead
//      pipper) + drawLockReticle (lockmissile) every frame.
//    - AI from ai.js for all non-player craft.
//    - Objectives: deathmatch / survive / escort / sink / pvp. Tracks
//      kills/deaths/time/score, calls config.onEnd(result).
//    - Netplay: if config.net present it's HUMAN vs HUMAN — send player state +
//      fire events each tick, spawn the remote fleet from received design codes,
//      drive remote craft from received transforms (NO AI), interpolate.
// ============================================================================
import * as THREE from 'three';
import { clamp, lerp, dampF, $, el, show, hide, sfx, toast, fmtNum } from './util.js';
import { computeStats, dragForce, thermoStep, partCenter, navalCruise, AMBIENT_TEMP, OVERHEAT_TEMP, RHO } from './physics.js';
import { PARTS } from './parts.js';
import { State, importCode, exportCode, stockGet } from './core.js';
import { setScene, onFrame, resetView, isPresenting } from './engine.js';
import { setVRMode, addEnterVRButton } from './vr.js';
import {
  LockSystem, leadPoint, homeMissile, drawPrediction, drawLockReticle,
} from './prediction.js';
import { initAI, updateAI, updateBomber, updateCarrierPD, pickTarget } from './ai.js';

// ---------------------------------------------------------------------------
//  Environment presets — sky gradient, sun, fog and surface look per env.
// ---------------------------------------------------------------------------
const ENVS = {
  day:  { top: 0x4a93d6, bot: 0xbfe2ff, sun: 0xfff3da, sunInt: 1.5, hemi: 0x9fc6ff, hemiGround: 0x4a5a44, fog: 0xbfe2ff, fogNear: 1400, fogFar: 9000, sunPos: [-0.4, 0.7, 0.5], ground: 0x4a6a3a, sea: false, ambient: 0.55 },
  dusk: { top: 0x2a2350, bot: 0xff8a4a, sun: 0xffb066, sunInt: 1.2, hemi: 0xff9a6a, hemiGround: 0x281c30, fog: 0xc66a44, fogNear: 1100, fogFar: 7500, sunPos: [-0.85, 0.18, 0.2], ground: 0x4a3a32, sea: false, ambient: 0.4 },
  night:{ top: 0x05080f, bot: 0x0d1626, sun: 0x7088c0, sunInt: 0.45, hemi: 0x223355, hemiGround: 0x05080f, fog: 0x080d18, fogNear: 700, fogFar: 5200, sunPos: [-0.3, 0.6, 0.4], ground: 0x10161e, sea: false, ambient: 0.25, stars: true },
  sea:  { top: 0x3f86c8, bot: 0xa9d6f5, sun: 0xfff0d0, sunInt: 1.45, hemi: 0x9fd0ff, hemiGround: 0x12506e, fog: 0xa9d6f5, fogNear: 1600, fogFar: 9500, sunPos: [-0.5, 0.6, 0.4], ground: 0x14506e, sea: true, ambient: 0.5 },
};

const DEG = Math.PI / 180;
// sign that makes a nose-right (yaw +) demand bank the aircraft to the right too,
// given the body-frame roll convention in integrate(). Verified empirically.
const BANK_SIGN = -1;
const MAX_BANK = 1.15;            // ≈66° — the bank the auto-coordinator holds at full turn demand
const GROUND_CLEAR = 8;           // belly clearance a craft rests at on the surface (must exceed the +2 crash line)
const SHIP_SCALE = 2;             // the PLAYER's piloted ship (a ship/carrier design flown via makeCraft) renders at
                                  // this scale; its hitbox, water clearance and chase camera track it via scaleMul.
const CARRIER_SCALE = SHIP_SCALE * 2.5;  // NPC ships/carriers (makeCarrier) render 2.5× the player's vessel — bigger,
                                  // more imposing capital ships on the horizon. (= 5× true size at SHIP_SCALE 2.)
const TMP = new THREE.Vector3(), TMP2 = new THREE.Vector3(), TMP3 = new THREE.Vector3();
const _R = new THREE.Vector3(), _ACC = new THREE.Vector3();
const QTMP = new THREE.Quaternion();
// scratch for the auto-turret traverse/aim math (kept separate from the flight TMPs)
const _TV = new THREE.Vector3(), _TV2 = new THREE.Vector3(), _TV3 = new THREE.Vector3();
const _TQ = new THREE.Quaternion(), _TQ2 = new THREE.Quaternion();
const _ZAXIS = new THREE.Vector3(0, 0, 1);
const _turretLead = new THREE.Vector3();

// Animate the open-ocean surface: three travelling swell components at different
// headings/speeds (a living sea instead of a flat, icy plane). Heights stay small
// vs the play scale, so the +8 m float clearance keeps the collision feel intact.
function updateSeaGeo(geo, base, t){
  const pa = geo.attributes.position;
  for (let i = 0; i < pa.count; i++){
    const x = base[i * 2], z = base[i * 2 + 1];
    pa.setY(i, Math.sin(x * 0.0042 + t * 0.55) * 3.4
             + Math.cos(z * 0.0056 + t * 0.43) * 2.7
             + Math.sin((x + z) * 0.011 + t * 0.95) * 1.2);
  }
  pa.needsUpdate = true;
  geo.computeVertexNormals();
}

// ===========================================================================
//  Build an aircraft mesh Group from a design (parts placed by partCenter)
// ===========================================================================
// ---- DRAW-CALL OPTIMISATION ------------------------------------------------
// A detailed airframe is ~250 sub-meshes; 40 of them is >10k draw calls and the GPU
// (not the sim) is what lags. After the mesh is built + liveried we MERGE every static
// part into one geometry per distinct material appearance — turning ~250 draw calls per
// craft into ~10. TURRET parts (their barrels traverse) and JETTISON drop-tanks keep their
// own meshes; a fixed manual weapon bakes its visual but keeps an empty node for its muzzle.
function _bucket(x){ return Math.round((x || 0) * 4) / 4; }     // quantise metal/rough to 0.25 steps so
function _matKey(m){                                            // near-identical materials merge into one group
  return (m.color ? m.color.getHexString() : '') + '|' + _bucket(m.metalness) + '|' + _bucket(m.roughness) + '|' +
    (m.transparent ? 't' + _bucket(m.opacity == null ? 1 : m.opacity) : 'o') + '|' + (m.emissive ? m.emissive.getHexString() : '') + '|' +
    (Math.round(m.emissiveIntensity || 0)) + '|' + (m.side || 0);
}
function mergeStaticMeshes(group){
  group.updateMatrixWorld(true);
  const collect = [];
  for (const child of [...group.children]){
    const k = child.userData && child.userData.partKey;
    const def = k ? PARTS[k] : null;
    if (def && (def.autoTurret || def.jettison)) continue;
    child.updateMatrixWorld(true);
    child.traverse(o => { if (o.isMesh && o.geometry) collect.push(o); });
    const isWeapon = def && (def.category === 'gun' || def.category === 'missile' || def.category === 'bomb');
    if (isWeapon) child.clear();   // a fixed weapon: bake its visual but KEEP the empty node (claimNode/muzzle resolve its mount)
    else group.remove(child);
  }
  if (collect.length < 8) { collect.forEach(o => group.add(o)); return; }
  const groups = new Map();
  for (const m of collect){
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (!mat) continue;
    const key = _matKey(mat);
    let e = groups.get(key); if (!e){ e = { mat, list: [] }; groups.set(key, e); }
    e.list.push(m);
  }
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert(), mtx = new THREE.Matrix4();
  for (const { mat, list } of groups.values()){
    const pos = [], nor = [];
    for (const m of list){
      let g = m.geometry;
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      const ng = g.index ? g.toNonIndexed() : g.clone();
      ng.applyMatrix4(mtx.multiplyMatrices(inv, m.matrixWorld));
      const p = ng.getAttribute('position'), nn = ng.getAttribute('normal');
      for (let i = 0; i < p.count; i++){ pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(nn.getX(i), nn.getY(i), nn.getZ(i)); }
      ng.dispose();
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    const mesh = new THREE.Mesh(geom, mat.clone());
    mesh.castShadow = true; mesh.receiveShadow = false;
    group.add(mesh);
  }
  for (const m of collect){
    if (m.geometry && m.geometry.dispose) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    mats.forEach(mm => mm && mm.dispose && mm.dispose());
  }
}

function buildAircraftMesh(design){
  const group = new THREE.Group();
  const parts = (design && design.parts) || [];
  let cx = 0, cy = 0, cz = 0, n = 0;
  const dropTanks = [];     // meshes that can be jettisoned
  for (const p of parts){
    const def = PARTS[p.key];
    if (!def || !def.build) continue;
    let obj;
    try { obj = def.build(THREE, def); } catch (e){ continue; }
    const c = partCenter(p, def);
    obj.position.set(c.x, c.y, c.z);
    obj.rotation.y = (p.rot || 0) * Math.PI / 2;
    obj.userData.partKey = p.key;
    if (def.jettison) dropTanks.push(obj);
    obj.traverse(o => { if (o.isMesh){ o.castShadow = true; o.receiveShadow = false; } });
    group.add(obj);
    cx += c.x; cy += c.y; cz += c.z; n++;
  }
  // re-centre the group on its part centroid so it rotates about its middle
  const off = n ? { x: cx / n, y: cy / n, z: cz / n } : { x: 0, y: 0, z: 0 };
  for (const ch of group.children) ch.position.sub(new THREE.Vector3(off.x, off.y, off.z));
  group.userData.centroidOff = off;   // hitbox builders subtract this to place the hull box exactly on the mesh
  // tint untextured structure with the design colour for team/identity reading
  if (design && design.color){
    const col = new THREE.Color(design.color);
    group.traverse(o => {
      if (o.isMesh && o.material && o.material.color){
        const k = o.userData.partKey || (o.parent && o.parent.userData.partKey);
        if (k && (PARTS[k]?.category === 'structure' || PARTS[k]?.category === 'wing' || PARTS[k]?.category === 'command')){
          o.material = o.material.clone();
          o.material.color.lerp(col, 0.5);
        }
      }
    });
  }
  group.userData.dropTanks = dropTanks;
  mergeStaticMeshes(group);    // collapse the static airframe to a handful of draw calls
  return group;
}

// big slab "carrier" mesh (when no carrier design is supplied) ---------------
function buildCarrierMesh(design, isSea){
  if (design && design.parts && design.parts.length){
    const g = buildAircraftMesh(design);
    g.scale.setScalar(CARRIER_SCALE);   // NPC ships render bigger than the player's vessel
    return g;
  }
  // default carrier: a long deck on a hull
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(60, 26, 280), new THREE.MeshStandardMaterial({ color: 0x46505a, metalness: 0.6, roughness: 0.6 }));
  hull.position.y = -8; hull.castShadow = true; g.add(hull);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(70, 4, 300), new THREE.MeshStandardMaterial({ color: 0x2a2f34, metalness: 0.3, roughness: 0.9 }));
  deck.position.y = 6; deck.receiveShadow = true; g.add(deck);
  // island superstructure
  const island = new THREE.Mesh(new THREE.BoxGeometry(14, 30, 40), new THREE.MeshStandardMaterial({ color: 0x3a4046, metalness: 0.5, roughness: 0.7 }));
  island.position.set(26, 23, -40); island.castShadow = true; g.add(island);
  // deck centre stripe
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 280), new THREE.MeshStandardMaterial({ color: 0xffce5a, emissive: 0x554400, emissiveIntensity: 0.4 }));
  stripe.position.y = 8.3; g.add(stripe);
  // a couple of CIWS turrets for flavour
  for (const [x, z] of [[-30, 120], [30, -120], [-30, -100]]){
    const t = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 6, 8), new THREE.MeshStandardMaterial({ color: 0x20252a }));
    t.position.set(x, 10, z); g.add(t);
  }
  return g;
}

// ===========================================================================
//  The Battle singleton
// ===========================================================================
export const Battle = {
  _live: false,
  _S: null,            // the running sim state

  start(config){
    if (this._live) this.stop();
    this._live = true;
    this._S = new Sim(config);
    this._S.boot();
  },

  stop(){
    if (!this._live) return;
    this._live = false;
    if (this._S){ this._S.teardown(); this._S = null; }
  },
};

// ===========================================================================
//  Sim — owns the whole battle. One instance per Battle.start().
// ===========================================================================
class Sim {
  constructor(config){
    this.cfg = config;
    this.env = ENVS[config.env] || ENVS.day;
    this.objective = config.objective || { type: 'deathmatch', label: 'Destroy all enemies' };
    // 'strike' is just a sink-the-carrier mission — alias it so the win condition,
    // HUD carrier-HP readout and objective label all fire (without this, sinking the
    // carrier registered no win and the mission was unbeatable).
    if (this.objective.type === 'strike') this.objective = { ...this.objective, type: 'sink' };
    this.timeLimit = config.timeLimit || (this.objective.type === 'survive' ? (this.objective.timeLimit || 120) : 0);

    this.scene = null;
    this.camera = null;
    this.unsubFrame = null;

    this.craft = [];          // all aircraft actors
    this.carriers = [];       // carrier actors (large, mostly static)
    this.bullets = [];        // tracer projectiles
    this.missiles = [];       // homing/ballistic ordnance
    this.torpedoes = [];      // sea-skimming torpedoes (surface-running, vs ships)
    this.flares = [];         // countermeasure flares
    this.fx = [];             // visual effects (sparks, explosions)
    this.player = null;
    this.remote = null;       // remote human craft (netplay)

    this.time = 0;
    this.over = false;
    this.result = { win: false, kills: 0, deaths: 0, time: 0, score: 0, reason: '' };

    this.groundY = 0;
    this.statsCache = new Map();   // design -> stats (avoid recompute)

    // world view passed to AI helpers
    this.world = {
      craft: this.craft, carriers: this.carriers, missiles: this.missiles,
      player: null, groundY: 0, time: 0,
    };

    // input — Gravity-Front-style FREE-AIM: the mouse moves a reticle DIRECTION
    // (aimYaw/aimPitch) and the aircraft noses toward it at its agility turn rate.
    this.keys = Object.create(null);
    this.aimYaw = 0; this.aimPitch = 0;   // free look/aim direction (radians)
    this.pointerLocked = false;
    this.assistOn = false;                // P: auto-aim guns at the lead point on lock

    // camera state
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.shake = 0;

    // lock system (the headline prediction feature)
    this.lock = new LockSystem({ range: 2800, acquireAngle: 0.40, holdAngle: 0.62, team: 0 });

    // hud
    this.hud = null;       // dom root #hud
    this.hudCanvas = null;
    this.hudCtx = null;
    this.dom = {};         // cached dom bar elements

    // netplay
    this.net = config.net || null;
    this.netAccum = 0;
    this.netRemoteState = null;     // latest received transform
    this.netSpawned = false;
    this.fireEvents = [];           // queued local fire events to send

    // bound handlers (so we can remove them)
    this._onKeyDown = this.onKeyDown.bind(this);
    this._onKeyUp = this.onKeyUp.bind(this);
    this._onMouseMove = this.onMouseMove.bind(this);
    this._onMouseDown = this.onMouseDown.bind(this);
    this._onPointerLock = this.onPointerLock.bind(this);
    this._onContext = (e) => e.preventDefault();
  }

  stats(design){
    let s = this.statsCache.get(design);
    if (!s){ s = computeStats(design); this.statsCache.set(design, s); }
    return s;
  }

  // ---------------------------------------------------------------------
  //  BOOT: build world, spawn, hud, listeners, register the frame loop.
  // ---------------------------------------------------------------------
  boot(){
    this.buildWorld();
    this.buildHUD();
    this.spawnAll();
    this.bindInput();
    this.world.player = this.player;
    this.world.groundY = this.groundY;

    // place chase camera behind the player to start
    this.camPos.copy(this.player.pos).add(new THREE.Vector3(0, 6, -28));
    this.camLook.copy(this.player.pos);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    setScene(this.scene, this.camera);
    // VR: drop the player INTO the cockpit (a rig follows the craft; you fly with the
    // grabbable stick + throttle). Desktop is unaffected — only fires if presenting.
    if (isPresenting()) setVRMode('cockpit', { scene: this.scene, camera: this.camera, sim: this });
    this.unsubFrame = onFrame((dt) => this.frame(dt));

    // netplay subscribe
    if (this.net){
      this.net.onMsg((msg) => this.onNetMsg(msg));
      // announce our fleet immediately and periodically until peer spawns
      this.sendFleet();
    }

    toast(this.objective.label || objectiveLabel(this.objective), '');
  }

  // ---------------------------------------------------------------------
  //  WORLD: scene, sky, lights, terrain/sea, fog.
  // ---------------------------------------------------------------------
  buildWorld(){
    const env = this.env;
    const scene = new THREE.Scene();
    this.scene = scene;
    scene.fog = new THREE.Fog(env.fog, env.fogNear, env.fogFar);

    // chase camera
    this.camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.5, 14000);
    this.camera.position.set(0, 360, -640);

    // sky gradient as a big inward-facing sphere with a vertex-coloured shader-ish gradient
    const skyGeo = new THREE.SphereGeometry(12000, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(env.top) }, bot: { value: new THREE.Color(env.bot) } },
      vertexShader: 'varying vec3 vp; void main(){ vp = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vp; uniform vec3 top; uniform vec3 bot; void main(){ float h = clamp(vp.y/12000.0*0.5+0.5,0.0,1.0); gl_FragColor = vec4(mix(bot, top, pow(h,0.8)),1.0); }',
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.renderOrder = -1;            // draw first, behind everything
    scene.add(sky);
    this.sky = sky;                  // kept centred on the camera each frame (see updateCamera)
    // so the far side of the 12 km dome never falls outside the camera far plane and
    // clips to a black "dome" when you fly away from the world origin.

    // stars at night
    if (env.stars){
      const starGeo = new THREE.BufferGeometry();
      const N = 1200, pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++){
        const r = 11000, u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        pos[i * 3] = r * s * Math.cos(th); pos[i * 3 + 1] = Math.abs(r * u) * 0.8 + 200; pos[i * 3 + 2] = r * s * Math.sin(th);
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 26, sizeAttenuation: true })));
    }

    // lights
    const sun = new THREE.DirectionalLight(env.sun, env.sunInt);
    sun.position.set(env.sunPos[0] * 2000, env.sunPos[1] * 2000, env.sunPos[2] * 2000);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.near = 50; sc.far = 4000; sc.left = -600; sc.right = 600; sc.top = 600; sc.bottom = -600;
    scene.add(sun); scene.add(sun.target);
    this.sun = sun;
    scene.add(new THREE.HemisphereLight(env.hemi, env.hemiGround, env.ambient * 1.4));
    scene.add(new THREE.AmbientLight(0xffffff, env.ambient * 0.3));

    // ground / sea — a big plane with subtle detail
    const size = 24000;
    const segs = env.sea ? 160 : 64;                 // finer mesh on water so swells actually read
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    if (env.sea){
      // a LIVING sea: cache each vertex's base (x,z) and animate the height every
      // frame (see updateSea) so the ocean rolls instead of sitting flat like ice.
      const pa = geo.attributes.position;
      const base = new Float32Array(pa.count * 2);
      for (let i = 0; i < pa.count; i++){ base[i * 2] = pa.getX(i); base[i * 2 + 1] = pa.getZ(i); }
      this.seaGeo = geo; this.seaBase = base; this.seaT = 0;
      updateSeaGeo(geo, base, 0);                    // seed the first wave field
    } else {
      const pa = geo.attributes.position;
      for (let i = 0; i < pa.count; i++){
        const x = pa.getX(i), z = pa.getZ(i);
        pa.setY(i, Math.sin(x * 0.004) * 22 + Math.cos(z * 0.0033) * 26);  // rolling hills
      }
      geo.computeVertexNormals();
    }
    const groundMat = new THREE.MeshStandardMaterial({
      color: env.ground, metalness: env.sea ? 0.08 : 0.0, roughness: env.sea ? 0.52 : 0.95,
      flatShading: !env.sea,
    });
    const ground = new THREE.Mesh(geo, groundMat);
    ground.receiveShadow = true;
    scene.add(ground);
    this.ground = ground;
    this.groundY = 0;

    // grid-ish reference lines on land so motion/altitude reads clearly
    if (!env.sea){
      const grid = new THREE.GridHelper(size, 120, 0x2a3a2a, 0x1a241a);
      grid.position.y = 1; grid.material.opacity = 0.25; grid.material.transparent = true;
      scene.add(grid);
    }
  }

  // ---------------------------------------------------------------------
  //  SPAWN: player, allies, enemies, carriers.
  // ---------------------------------------------------------------------
  spawnAll(){
    const cfg = this.cfg;
    // player (team 0) at origin, facing +Z.
    // "Start airborne" (default on) puts you at altitude already moving; turning it
    // off begins you resting on the surface (a runway on land, the water on a sea
    // map) so you take off under your own power — pull up once you have flying speed.
    const airborne = cfg.startAirborne !== false;
    let playerPos;
    if (airborne){
      playerPos = new THREE.Vector3(0, 360, -600);
    } else {
      const surfY = this.surfaceHeight(0, -600);
      playerPos = new THREE.Vector3(0, surfY + GROUND_CLEAR, -600);
    }
    this.player = this.makeCraft(cfg.player, 0, playerPos, 0, false);
    this.player.isPlayer = true;
    this.player.name = (cfg.player && cfg.player.name) || 'You';
    if (this.player.isShipCraft){
      // a piloted SHIP fights ON the water, never airborne — sit it at its waterline (≈sea level)
      // from the start, regardless of the "start airborne" toggle (it can't take off anyway).
      this.player.grounded = true;
      this.player.vel.set(0, 0, 0);
      this.player.pos.y = this.shipRestY(this.player);
      this.player.group.position.copy(this.player.pos);
    } else if (!airborne){
      // a true STANDING START: rest on the surface at ZERO speed and take off under
      // your own power (the throttle spools up; hold W for full power). With no engine
      // the craft simply sits — it can't move itself. The surface holds it up (see
      // integrate's grounded branch) until it has flying speed.
      this.player.grounded = true;
      this.player.vel.set(0, 0, 0);
    }

    // allies / wingmen (team 0). A CARRIER set as a wingman is a SHIP — it starts and
    // fights on the ocean (steaming + point-defence), never a flying aircraft. Other
    // wingmen scramble from the surface beside you (zero speed) on a standing start,
    // else form up at altitude.
    let carrierAllies = 0;
    (cfg.allies || []).forEach((d, i) => {
      if (!d) return;
      if (d.isCarrier || d.role === 'carrier' || d.role === 'ship'){
        const k = carrierAllies++;
        this.makeCarrier(d, 0, new THREE.Vector3(260 + k * 150, 0, -1500 - k * 220));
        return;
      }
      const side = (i % 2) ? 1 : -1;
      let pos;
      if (airborne){
        pos = new THREE.Vector3(side * (70 + i * 14), 340 + i * 8, -700 - i * 40);
      } else {
        const sx = side * (55 + i * 20), sz = -600 - (i + 1) * 50;
        pos = new THREE.Vector3(sx, this.surfaceHeight(sx, sz) + GROUND_CLEAR, sz);
      }
      const c = this.makeCraft(d, 0, pos, 0, true);
      if (!airborne){ c.grounded = true; c.vel.set(0, 0, 0); }   // scramble from rest
      c.name = (d.name || 'Wingman ' + (i + 1));
      c.role = (this.stats(d).weapons.some(w => w.type === 'bomb')) ? 'bomber' : 'fighter';
    });

    if (this.net){
      // PvP: the remote player's fleet spawns on receipt of their codes (team 1).
      // We don't spawn AI enemies at all.
    } else {
      // enemies (team 1) — for each entry, `count` copies with the given skill.
      // A carrier design fights as a ship on the surface, not an aircraft in the sky.
      let ei = 0, ecn = 0;
      (cfg.enemies || []).forEach((entry) => {
        const d = entry.design;
        if (!d) return;
        if (d.isCarrier || d.role === 'carrier' || d.role === 'ship'){
          for (let k = 0; k < (entry.count || 1); k++){
            this.makeCarrier(d, 1, new THREE.Vector3(-300 + ecn * 220, 0, 2200 + ecn * 350));
            ecn++;
          }
          return;
        }
        const st = this.stats(d);
        const isBomber = st.weapons.some(w => w.type === 'bomb');
        for (let k = 0; k < (entry.count || 1); k++){
          const ang = (ei / 6) * Math.PI * 2;
          const R = 1400 + (ei % 3) * 260;
          const pos = new THREE.Vector3(Math.sin(ang) * R, 320 + (ei % 4) * 70, 1400 + Math.cos(ang) * R * 0.4);
          const c = this.makeCraft(d, 1, pos, Math.PI, true, entry.skill ?? 0.5);
          c.name = (d.name || 'Bandit') + ' ' + (ei + 1);
          c.role = isBomber ? 'bomber' : 'fighter';
          ei++;
        }
      });
    }

    // carriers
    if (cfg.carrier){
      this.makeCarrier(cfg.carrier, 0, new THREE.Vector3(0, 0, -2200));
    }
    if (cfg.enemyCarrier){
      this.makeCarrier(cfg.enemyCarrier, 1, new THREE.Vector3(0, 0, 3000));
    } else if (this.objective.type === 'sink'){
      // sink objective with no design → spawn a default enemy carrier
      this.makeCarrier(null, 1, new THREE.Vector3(0, 0, 3000));
    }
    if (this.objective.type === 'escort' && !cfg.carrier){
      this.makeCarrier(null, 0, new THREE.Vector3(0, 0, -2200));
    }

    this.world.player = this.player;
  }

  // build one flyable craft actor
  makeCraft(design, team, pos, yaw, isAI, skill = 0.5){
    const stats = this.stats(design);
    const group = buildAircraftMesh(design);
    group.position.copy(pos);
    group.rotation.y = yaw;
    // A ship/carrier design flown as a craft renders at the shared SHIP_SCALE so it's the
    // same size as the wingmen/enemy ships (NPC ships route to makeCarrier; only the PLAYER
    // ever reaches makeCraft with a ship design). scaleMul also scales its hitbox, water
    // clearance and chase-camera distance below.
    const scaleMul = (design && (design.role === 'ship' || design.role === 'carrier' || design.isCarrier)) ? SHIP_SCALE : 1;
    if (scaleMul !== 1) group.scale.setScalar(scaleMul);
    this.scene.add(group);

    // weapon runtime state (clip / reserve ammo / cooldown / heat already in stats)
    const allWeapons = (stats.weapons || []).map((w) => ({
      ...w,
      ammo: w.clip,                       // rounds in current clip
      reserve: Math.max(0, (w.ammo || w.clip) - w.clip),  // spare rounds
      cool: 0,                            // seconds until next shot
      reloading: 0,                       // seconds left on reload
    }));
    // Pair EVERY weapon with the mesh of the part that mounts it (by partKey, consuming
    // duplicates in order) so each gun fires from its OWN barrel, not the hull centre —
    // matters on a long ship where the guns are spread metres apart. Auto-turrets traverse
    // + fire themselves (updateTurrets); manual weapons remember their mount for the muzzle.
    const _usedNodes = new Set();
    const claimNode = (key) => { for (const o of group.children){ if (!_usedNodes.has(o) && o.userData && o.userData.partKey === key){ _usedNodes.add(o); return o; } } return null; };
    const weapons = [];
    const turrets = [];
    const torpedoMounts = [];
    for (const w of allWeapons){
      const node = claimNode(w.partKey);
      // a piloted SHIP's deck torpedo tubes AUTO-launch (like its guns do via updateTurrets);
      // an AIRCRAFT's torpedo stays a manual drop the pilot aims (scaleMul===1).
      if (w.torpedo && scaleMul > 1) torpedoMounts.push({ w: { ...w, cool: 0 }, node });
      else if (w.turret) turrets.push({ w, node, aimYaw: 0, target: null });
      else { w.node = node; weapons.push(w); }
    }

    // HULL-SHAPED HITBOX: an oriented box in the craft's local frame — centre corrected for the
    // part-centroid recentre, half-extents from the design bbox × render scale, plus a little
    // arcade slop (clipping a wingtip still counts). Replaces the old bounding sphere, which
    // ballooned far beyond thin airframes and long hulls (see segHitsHull).
    const _bb = stats.bbox, _co = group.userData.centroidOff || { x: 0, y: 0, z: 0 };
    const hullCenter = new THREE.Vector3(
      ((_bb.min.x + _bb.max.x) / 2 - _co.x) * scaleMul,
      ((_bb.min.y + _bb.max.y) / 2 - _co.y) * scaleMul,
      ((_bb.min.z + _bb.max.z) / 2 - _co.z) * scaleMul);
    const hullHalf = new THREE.Vector3(
      Math.max(_bb.size.x / 2 * scaleMul + 0.8, 2),
      Math.max(_bb.size.y / 2 * scaleMul + 0.8, 2),
      Math.max(_bb.size.z / 2 * scaleMul + 0.8, 2));

    const fwd = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const craft = {
      design, stats, group,
      hullCenter, hullHalf,                // oriented-box hitbox (local frame; see segHitsHull)
      team, isPlayer: false, isAI: !!isAI, isRemote: false,
      scaleMul,                            // >1 for a ship/carrier hull flown as a craft
      isShipCraft: scaleMul > 1,           // a piloted SHIP: floats on the sea, never an aircraft
      name: design.name || 'Aircraft',
      role: 'fighter',
      pos: group.position,                 // alias (Vector3)
      // An engineless craft (a carrier, a powerless hull) NEVER gets gifted speed —
      // it can't move itself. A powered craft begins at cruise ONLY when it spawns
      // airborne (already in flight); a surface/standing start zeroes this in spawnAll.
      vel: stats.thrust > 0 ? fwd.clone().multiplyScalar(Math.max(80, stats.cruise * 0.6)) : new THREE.Vector3(),
      speed: 0,
      quat: group.quaternion,
      hp: stats.durability || 100,
      maxHp: stats.durability || 100,
      armor: stats.armor || 0,
      fuel: stats.fuelMass || 0,
      maxFuel: stats.fuelMass || 1,
      temp: AMBIENT_TEMP,
      flares: stats.flares || 0,
      weapons,
      turrets,                             // auto-traversing defensive turrets (fire themselves)
      torpedoMounts,                       // a piloted ship's deck torpedo tubes (auto-launch, see updateTorpedoMounts)
      curWeapon: weapons.length ? 0 : -1,
      throttle: 0.7,
      throttleTarget: 0.7,    // player: Z toggles engine on/off → 1 or 0; W/S fine-trim
      engineOn: true,
      boost: false,
      airbrakeOn: false,      // deployable speed brake (B), if the craft mounts any airbrakes
      ctrlPitch: 0, ctrlYaw: 0, ctrlRoll: 0,   // steering demand (set per-frame; init avoids NaN in HUD stick)
      stalled: false,
      alive: true,
      dead: false,
      // input/ai intents
      wantGun: false, wantMissile: false, wantBomb: false, wantFlare: false,
      aiDesired: null, aiWeaponIdx: -1,
      dropTanksGone: false,
      grounded: false,        // true only during a surface takeoff roll (startAirborne off)
    };
    if (isAI){
      initAI(craft, skill);
    }
    this.craft.push(craft);
    return craft;
  }

  makeCarrier(design, team, pos){
    const isSea = this.env.sea;
    const isShip = !!(design && design.role === 'ship');   // a 'ship' actively hunts surface targets
    const mesh = buildCarrierMesh(design, isSea);
    mesh.position.copy(pos);
    // carriers sit on the surface
    mesh.position.y = isSea ? 4 : 14;
    this.scene.add(mesh);
    // Tough but sinkable in a strike run: was durability*8+6000 (~16k for a Goliath),
    // which no realistic bomb/missile loadout could chew through inside the time limit.
    const hp = design ? this.stats(design).durability * 3 + 1800 : 5000;

    // Extract the design's auto-turret weapons AND wire each to its mesh node so the
    // BARRELS physically traverse to track targets (mirrors makeCraft). The carrier mesh
    // is scaled up in buildCarrierMesh, but a child's quaternion still rotates it visibly;
    // updateTurrets scales node.position by the group scale to place the muzzle correctly.
    const designStats = design ? this.stats(design) : null;
    // Pair EVERY deck gun (turret or fixed) with its own mesh node so it fires from its
    // barrel, not the hull centre — and traverses to track. Matched by partKey, consuming
    // duplicates in order (the carrier mesh is scaled, but updateTurrets lifts node.position
    // by the group scale).
    const _usedNodes = new Set();
    const claimNode = (key) => { for (const o of mesh.children){ if (!_usedNodes.has(o) && o.userData && o.userData.partKey === key){ _usedNodes.add(o); return o; } } return null; };
    const turrets = designStats
      ? (designStats.weapons || [])
          .filter(w => w.type === 'gun')
          .map(w => ({ w: { ...w, ammo: w.clip, reserve: Math.max(0, (w.ammo || w.clip) - w.clip), cool: 0, reloading: 0 }, node: claimNode(w.partKey), aimYaw: 0, target: null }))
      : [];
    // Deck torpedo tubes (a `torpedo`-flagged weapon, any type) auto-launch at the nearest enemy
    // surface vessel — their own slow pass (updateTorpedoMounts), separate from the gun turrets.
    const torpedoMounts = designStats
      ? (designStats.weapons || [])
          .filter(w => w.torpedo)
          .map(w => ({ w: { ...w, cool: 0 }, node: claimNode(w.partKey) }))
      : [];

    // collision radius tracks the rendered hull (design bbox × SHIP_SCALE) — kept as the
    // BROAD radius for shoving / melee / standoff maths. Precise SHOT hits use the oriented
    // hull box below (segHitsHull): a long hull is no longer a giant sphere that "catches"
    // rounds metres beside and above the deck.
    const hbb = designStats && designStats.bbox ? designStats.bbox.size : null;
    const hitR = hbb ? Math.max(hbb.x, hbb.z) * 0.55 * CARRIER_SCALE : (design ? 60 : 150);
    let hullCenter, hullHalf;
    if (designStats && designStats.bbox){
      const _bb = designStats.bbox, _co = mesh.userData.centroidOff || { x: 0, y: 0, z: 0 };
      hullCenter = new THREE.Vector3(
        ((_bb.min.x + _bb.max.x) / 2 - _co.x) * CARRIER_SCALE,
        ((_bb.min.y + _bb.max.y) / 2 - _co.y) * CARRIER_SCALE,
        ((_bb.min.z + _bb.max.z) / 2 - _co.z) * CARRIER_SCALE);
      hullHalf = new THREE.Vector3(
        Math.max(_bb.size.x / 2 * CARRIER_SCALE + 2, 4),
        Math.max(_bb.size.y / 2 * CARRIER_SCALE + 2, 4),
        Math.max(_bb.size.z / 2 * CARRIER_SCALE + 2, 4));
    } else {
      // default slab carrier: hull 70×~34×300 around a deck at y≈6
      hullCenter = new THREE.Vector3(0, 4, 0);
      hullHalf = new THREE.Vector3(36, 26, 150);
    }
    const carrier = {
      design, mesh, team, hitR,
      hullCenter, hullHalf,           // oriented-box hitbox (local frame; see segHitsHull)
      pos: mesh.position,
      vel: isShip ? new THREE.Vector3() : new THREE.Vector3((team === 1 ? -1 : 1) * 6, 0, 0),  // ships steer under pursuit AI; carriers steam slowly
      hp, maxHp: hp,
      alive: true,
      pdRange: 1700, pdSpeed: 1100, pdCool: 0,
      isCarrier: true,
      isShip, shipSpeed: isShip ? navalCruise(designStats) : 24,   // naval cruise from the design's engines (see updateCarrier)
      isAI: true,            // so updateTurrets gives it AI-style infinite reloads
      group: mesh,           // alias so updateTurrets can read .group.quaternion
      turrets, torpedoMounts,
      name: design ? design.name : (team === 0 ? 'Friendly Carrier' : 'Enemy Carrier'),
    };
    this.carriers.push(carrier);
    return carrier;
  }

  // ---------------------------------------------------------------------
  //  HUD scaffolding (DOM bars + 2D canvas overlay)
  // ---------------------------------------------------------------------
  buildHUD(){
    const hud = $('hud');
    this.hud = hud;
    show(hud);
    // clear any prior children except the canvas
    Array.from(hud.children).forEach(ch => { if (ch.id !== 'hud-canvas') ch.remove(); });
    let canvas = $('hud-canvas');
    if (!canvas){ canvas = el('canvas'); canvas.id = 'hud-canvas'; hud.appendChild(canvas); }
    this.hudCanvas = canvas;
    this.hudCtx = canvas.getContext('2d');
    this.resizeHUD();
    this._onResize = () => this.resizeHUD();
    addEventListener('resize', this._onResize);

    // ENTER VR lives on the battle HUD too (it used to exist only on the main menu, which
    // made the cockpit unreachable: an immersive session can't see or tap the page DOM, so
    // you could never enter VR once a battle was running). Hidden unless WebXR is available.
    const vrWrap = el('div');
    vrWrap.style.cssText = 'position:absolute;top:12px;right:14px;pointer-events:auto;z-index:12;';
    addEnterVRButton(vrWrap);
    hud.appendChild(vrWrap);

    // bottom-left: status bars
    const bl = el('div', 'hud-bl');
    bl.innerHTML = `
      <div class="hud-bar-label"><span>HP / ARMOR</span><span class="v-hp">100%</span></div>
      <div class="hud-bar"><i class="hp" style="width:100%"></i></div>
      <div class="hud-bar-label"><span>FUEL</span><span class="v-fuel">100%</span></div>
      <div class="hud-bar"><i class="fuel" style="width:100%"></i></div>
      <div class="hud-bar-label"><span>BOOST</span><span class="v-boost"></span></div>
      <div class="hud-bar"><i class="boost" style="width:100%"></i></div>
      <div class="hud-bar-label"><span>HEAT</span><span class="v-heat"></span></div>
      <div class="hud-bar"><i class="heat" style="width:0%"></i></div>
      <div class="hud-weapon v-weapon">—</div>`;
    hud.appendChild(bl);

    // top-left: speed/alt/throttle
    const tl = el('div', 'hud-tl');
    tl.innerHTML = `<div class="v-spd">SPD —</div><div class="v-alt">ALT —</div><div class="v-thr">THR —</div><div class="v-mach"></div>`;
    hud.appendChild(tl);

    // top-centre: objective
    const tc = el('div', 'hud-tc');
    tc.innerHTML = `<div class="v-obj" style="font-size:13px;color:var(--accent);letter-spacing:.14em;"></div><div class="v-objsub" style="font-size:12px;color:var(--ink-dim);"></div>`;
    hud.appendChild(tc);

    // bottom-right: radar
    const br = el('div', 'hud-br');
    const radar = el('canvas');
    radar.width = 180; radar.height = 180;
    radar.style.cssText = 'border:1px solid var(--edge);border-radius:50%;background:rgba(6,12,20,.6);';
    br.appendChild(radar);
    hud.appendChild(br);
    this.radar = radar; this.radarCtx = radar.getContext('2d');

    // centre warning message
    const msg = el('div', 'hud-msg');
    hud.appendChild(msg);

    // controls legend — fades out a few seconds into the sortie
    const help = el('div', 'hud-help');
    help.innerHTML = '<b>MOUSE</b> aim &amp; fly (nose chases the reticle) · <b>SHIFT</b> boost · <b>S</b> brake · <b>Z</b> engine on/off · ' +
      '<b>B</b> airbrake · <b>SPACE</b> fire · <b>P</b> aim-assist · <b>TAB</b>/<b>Q</b>/<b>E</b> weapon · <b>F</b> flares · <b>G</b> drop tanks · click to capture mouse';
    hud.appendChild(help);
    this._helpEl = help;
    this._helpT1 = setTimeout(() => help.classList.add('fade'), 6500);
    this._helpT2 = setTimeout(() => { if (help.parentNode) help.remove(); }, 8200);

    this.dom = {
      hp: bl.querySelector('.hp'), hpv: bl.querySelector('.v-hp'),
      fuel: bl.querySelector('.fuel'), fuelv: bl.querySelector('.v-fuel'),
      boost: bl.querySelector('.boost'), boostv: bl.querySelector('.v-boost'),
      heat: bl.querySelector('.heat'), heatv: bl.querySelector('.v-heat'),
      weapon: bl.querySelector('.v-weapon'),
      spd: tl.querySelector('.v-spd'), alt: tl.querySelector('.v-alt'), thr: tl.querySelector('.v-thr'), mach: tl.querySelector('.v-mach'),
      obj: tc.querySelector('.v-obj'), objsub: tc.querySelector('.v-objsub'),
      msg,
    };
    this.dom.obj.textContent = objectiveLabel(this.objective);
  }

  resizeHUD(){
    if (!this.hudCanvas) return;
    // cap the HUD overlay at 1.5× — reticles/markers/bars don't need full Retina, and 2×
    // nearly doubles the 2D-canvas fill redrawn EVERY frame on top of the 3D render.
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    this.hudCanvas.width = innerWidth * dpr;
    this.hudCanvas.height = innerHeight * dpr;
    this.hudCanvas.style.width = innerWidth + 'px';
    this.hudCanvas.style.height = innerHeight + 'px';
    this.hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = innerWidth; this.H = innerHeight;
  }

  // ---------------------------------------------------------------------
  //  INPUT
  // ---------------------------------------------------------------------
  bindInput(){
    addEventListener('keydown', this._onKeyDown);
    addEventListener('keyup', this._onKeyUp);
    addEventListener('mousemove', this._onMouseMove);
    addEventListener('mousedown', this._onMouseDown);
    addEventListener('contextmenu', this._onContext);
    document.addEventListener('pointerlockchange', this._onPointerLock);
  }
  unbindInput(){
    removeEventListener('keydown', this._onKeyDown);
    removeEventListener('keyup', this._onKeyUp);
    removeEventListener('mousemove', this._onMouseMove);
    removeEventListener('mousedown', this._onMouseDown);
    removeEventListener('contextmenu', this._onContext);
    document.removeEventListener('pointerlockchange', this._onPointerLock);
    if (this._onResize) removeEventListener('resize', this._onResize);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  onKeyDown(e){
    const k = e.key.toLowerCase();
    this.keys[k] = true;
    if (k === 'tab'){ e.preventDefault(); this.cycleWeapon(1); }
    else if (k === 'q'){ this.cycleWeapon(-1); }
    else if (k === 'e'){ this.cycleWeapon(1); }
    else if (k === 'z'){ e.preventDefault(); this.toggleEngine(); }
    else if (k === 'b'){ this.toggleAirbrake(); }
    else if (k === 'p'){ this.assistOn = !this.assistOn; this.flashMsg(this.assistOn ? 'AIM ASSIST ON' : 'AIM ASSIST OFF', this.assistOn ? 'good' : '', 1.0); }
    else if (k === 'f'){ this.firePlayerFlare(); }
    else if (k === 'g'){ this.jettison(this.player); }
    else if (k === 'escape'){ this.endBattle(false, 'Aborted'); }
  }

  // Z toggles the engine master switch: ON spools to full thrust, OFF cuts to a glide.
  toggleEngine(){
    const p = this.player; if (!p || !p.alive) return;
    p.engineOn = !p.engineOn;
    p.throttleTarget = p.engineOn ? 1 : 0;
    this.flashMsg(p.engineOn ? 'ENGINE ON' : 'ENGINE CUT — GLIDING', p.engineOn ? 'good' : 'warn', 0.9);
    sfx(p.engineOn ? 'thrust' : 'click', 0.3);
  }

  // B deploys/retracts the airbrakes (only if the airframe actually mounts any).
  toggleAirbrake(){
    const p = this.player; if (!p || !p.alive) return;
    if (!(p.stats.airbrakeArea > 0)){ this.flashMsg('NO AIRBRAKES FITTED', 'warn', 0.7); return; }
    p.airbrakeOn = !p.airbrakeOn;
    this.flashMsg(p.airbrakeOn ? 'AIRBRAKE OUT' : 'AIRBRAKE IN', '', 0.7);
    sfx('click', 0.3);
  }
  onKeyUp(e){ this.keys[e.key.toLowerCase()] = false; }

  onMouseMove(e){
    if (isPresenting()) return;   // VR: the cockpit stick steers, not the mouse
    if (!this.pointerLocked) return;
    const sens = 0.0026;
    const invert = State.settings && State.settings.invertY ? -1 : 1;
    // move a free reticle direction; the nose chases it (see integrate()).
    this.aimYaw -= e.movementX * sens;
    this.aimPitch = clamp(this.aimPitch - e.movementY * sens * invert, -1.2, 1.2);  // mouse up = look up
  }
  onMouseDown(e){
    if (!this.pointerLocked && e.button === 0){
      const cv = $('gl');
      if (cv && cv.requestPointerLock){
        // requestPointerLock rejects (browser security) if called too soon after the
        // user exited the lock — swallow that so it never becomes a fatal "unhandled
        // promise rejection". The user just clicks again a moment later.
        try { const r = cv.requestPointerLock({ unadjustedMovement: false }); if (r && typeof r.catch === 'function') r.catch(() => {}); }
        catch (_){ /* older browsers throw synchronously — ignore */ }
      }
    }
  }
  onPointerLock(){ this.pointerLocked = !!document.pointerLockElement; }

  cycleWeapon(dir){
    const p = this.player; if (!p || !p.weapons.length) return;
    p.curWeapon = (p.curWeapon + dir + p.weapons.length) % p.weapons.length;
    this.lock.reset();
    sfx('ui', 0.3);
  }

  // ---------------------------------------------------------------------
  //  MAIN FRAME
  // ---------------------------------------------------------------------
  frame(dt){
    // VR: attach the cockpit rig the moment a session goes live — however it was entered
    // (mid-battle from the HUD button included), not only if the battle STARTED while
    // presenting. Detach + restore the airframe/camera when the session ends.
    const vrNow = isPresenting();
    if (vrNow !== this._vrOn){
      this._vrOn = vrNow;
      setVRMode(vrNow ? 'cockpit' : 'menu', vrNow ? { scene: this.scene, camera: this.camera, sim: this } : null);
    }
    if (this.over){ this.renderHUD(dt); return; }
    if (!(dt > 0)) return;              // guard zero/negative dt (paused/odd clock)
    dt = Math.min(dt, 0.05);            // extra safety for the physics step
    this.time += dt;
    this.result.time = this.time;
    this.world.time = this.time;

    // 1. player input → intents
    this.readPlayerInput(dt);

    // 2. AI for non-player, non-remote craft
    for (const c of this.craft){
      if (!c.alive || c.isPlayer || c.isRemote) continue;
      if (c.role === 'bomber' && this.carriers.some(cc => cc.alive && cc.team !== c.team)) updateBomber(c, this.world, dt);
      else updateAI(c, this.world, dt);
    }

    // 3. integrate flight for every craft
    for (const c of this.craft){ if (c.alive && !c.isRemote) this.integrate(c, dt); }

    // 4. remote interpolation (netplay)
    if (this.net) this.netTick(dt);

    // 5. firing
    for (const c of this.craft){ if (c.alive && !c.isRemote) this.handleFiring(c, dt); }

    // 5b. auto-turrets traverse + fire on their own (player + AI + carrier deck guns)
    for (const c of this.craft){ if (c.alive && !c.isRemote) this.updateTurrets(c, dt); }
    for (const c of this.craft){ if (c.alive && !c.isRemote && c.torpedoMounts && c.torpedoMounts.length) this.updateTorpedoMounts(c, dt); }
    for (const cc of this.carriers){ if (cc.alive && cc.turrets && cc.turrets.length) this.updateTurrets(cc, dt); }
    for (const cc of this.carriers){ if (cc.alive && cc.torpedoMounts && cc.torpedoMounts.length) this.updateTorpedoMounts(cc, dt); }

    // 6. carriers (move + point defence)
    for (const cc of this.carriers){ if (cc.alive) this.updateCarrier(cc, dt); }

    // 7. ordnance
    this.updateBullets(dt);
    this.updateMissiles(dt);
    this.updateTorpedoes(dt);
    this.updateFlares(dt);
    this.updateFX(dt);
    if (this.seaGeo){ this.seaT += dt; updateSeaGeo(this.seaGeo, this.seaBase, this.seaT); }  // roll the ocean

    // 8. lock system (player) + camera
    this.updateLock(dt);
    this.updateCamera(dt);

    // 9. objective + end conditions
    this.checkObjective(dt);

    // 10. HUD
    this.renderHUD(dt);

    // 11. net send
    if (this.net) this.netSend(dt);
  }

  // ---------------------------------------------------------------------
  //  PLAYER INPUT → throttle / steering / fire intents
  // ---------------------------------------------------------------------
  readPlayerInput(dt){
    const p = this.player; if (!p || !p.alive) return;
    const K = this.keys;
    // throttle (Gravity-Front style): the engine always cruises forward; SHIFT
    // boosts (afterburner), S brakes. Z cuts the engine entirely (glide). The
    // throttle spools toward the target so power never snaps on/off.
    let tgt;
    if (!p.engineOn) tgt = 0;                                  // engine cut → glide
    else if (K['shift'] && p.fuel > 0) tgt = 1;                // boost
    else if (K['s']) tgt = 0.35;                               // brake
    else if (K['w']) tgt = 1;                                  // hold full power
    else tgt = 0.82;                                           // cruise
    p.throttleTarget = tgt;
    p.throttle = dampF(p.throttle, tgt, 2.4, dt);
    p.boost = !!K['shift'] && p.fuel > 0 && p.engineOn;

    // --- free-aim: the mouse moves a reticle DIRECTION; the nose chases it at the
    //     airframe's agility turn rate (the steering lives in integrate()). This is
    //     the Gravity Front "fly toward where you're looking" dogfight model. -----
    const cp = Math.cos(this.aimPitch);
    p.flyDir = (p.flyDir || new THREE.Vector3()).set(Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), Math.cos(this.aimYaw) * cp);
    p.aimDir = (p.aimDir || new THREE.Vector3()).copy(p.flyDir);   // guns fire along the reticle (see fireWeapon)
    p.manualRoll = (K['a'] ? 1 : 0) + (K['d'] ? -1 : 0);          // optional manual roll on top of auto-bank

    // fire
    p.wantGun = false; p.wantMissile = false; p.wantBomb = false;
    if (K[' '] || K['spacebar']){
      const w = p.weapons[p.curWeapon];
      if (w){
        if (w.type === 'gun') p.wantGun = true;
        else if (w.type === 'bomb') p.wantBomb = true;
        else if (w.type === 'lockmissile'){ /* auto-fires on full lock */ }
        else p.wantMissile = true;   // ir / radar → fire on press toward lock target
      }
    }
    p.aiWeaponIdx = p.curWeapon;
  }

  // ---------------------------------------------------------------------
  //  FLIGHT INTEGRATOR — the physics, all derived from stats.
  // ---------------------------------------------------------------------
  integrate(c, dt){
    const s = c.stats;
    const mass = Math.max(50, s.dryMass + c.fuel);     // live mass (fuel burns off)
    const fwd = TMP.set(0, 0, 1).applyQuaternion(c.group.quaternion);
    const v = c.vel;
    const speed = v.length();
    c.speed = speed;

    // --- orientation: turn the nose toward a DESIRED DIRECTION at agility rate ---
    // The player and the AI share this: the player's target is the mouse reticle
    // (flyDir), the AI's is its computed pursuit heading (aiDesired). The nose
    // chases that direction, banking into the turn — the Gravity Front model.
    let dPitch = 0, dYaw = 0, dRoll = 0;
    const ag = s.agility;
    const want = c.isPlayer ? c.flyDir : c.aiDesired;
    if (want){
      const wn = TMP2.copy(want).normalize();
      const up = TMP3.set(0, 1, 0).applyQuaternion(c.group.quaternion);
      const right = _R.set(1, 0, 0).applyQuaternion(c.group.quaternion);
      const yawErr = Math.atan2(wn.dot(right), wn.dot(fwd));
      const pitchErr = Math.asin(clamp(wn.dot(up), -1, 1));
      const gain = c.isPlayer ? 2.4 : 1;                  // the player snaps to the reticle harder than the AI lazily tracks
      const yawD = clamp(yawErr * gain, -1, 1), pitchD = clamp(pitchErr * gain, -1, 1);
      dYaw = yawD * ag.yaw * DEG * dt;
      dPitch = pitchD * ag.pitch * DEG * dt;
      // coordinated bank — drive roll toward a target bank ANGLE (proportional to the
      // turn demand, capped at MAX_BANK), NOT a raw rate. A rate would integrate without
      // bound in a sustained turn and roll the aircraft inverted (and kill its lift).
      const bankNow = Math.atan2(right.y, up.y);
      const bankWant = yawD * BANK_SIGN * MAX_BANK;
      const authority = clamp(up.y, 0, 1);               // fade near knife-edge/inverted so loops aren't fought
      let rollD = authority * clamp((bankWant - bankNow) * 3.0, -1, 1);
      if (c.isPlayer) rollD = clamp(rollD + (c.manualRoll || 0), -1, 1);   // manual roll layered on top
      dRoll = rollD * ag.roll * DEG * dt;
      if (c.isPlayer){ c.ctrlPitch = pitchD; c.ctrlYaw = yawD; c.ctrlRoll = rollD; }        // expose to the HUD stick
    }

    // stall: below vStall the control surfaces bite poorly and the nose drops
    const stallV = isFinite(s.vStall) ? s.vStall : 0;
    c.stalled = speed < stallV * 0.92 && (c.pos.y - this.groundY) > 5;
    let ctrlScale = 1;
    if (c.stalled){
      ctrlScale = clamp(speed / Math.max(1, stallV), 0.15, 0.6);   // mushy controls
    }
    dPitch *= ctrlScale; dYaw *= ctrlScale; dRoll *= ctrlScale;

    // apply rotations in body frame: roll, then pitch, then yaw.
    // NOTE: a positive pitch DEMAND must raise the nose. Rotating about body +X
    // lowers the nose, so we negate here — this single sign fixes BOTH the player
    // (mouse-up / pull = nose-up) and the AI (dPitch = +pitchErr toward a target
    // that is above the nose), which share this code path.
    QTMP.setFromAxisAngle(TMP.set(0, 0, 1), dRoll); c.group.quaternion.multiply(QTMP);
    QTMP.setFromAxisAngle(TMP.set(1, 0, 0), -dPitch); c.group.quaternion.multiply(QTMP);
    QTMP.setFromAxisAngle(TMP.set(0, 1, 0), dYaw); c.group.quaternion.multiply(QTMP);
    c.group.quaternion.normalize();

    // recompute forward after rotation
    fwd.set(0, 0, 1).applyQuaternion(c.group.quaternion);

    // --- forces ---
    const acc = _ACC.set(0, 0, 0);

    // thrust along forward (no thrust if out of fuel)
    let thrust = 0;
    let genFrac = 0;
    if (c.fuel > 0){
      thrust = s.thrust * c.throttle;
      genFrac = c.throttle * 0.5;
      if (c.boost && c.fuel > 0){
        thrust = s.boostThrust * Math.max(c.throttle, 0.6);
        genFrac = 1;
      }
    }
    acc.addScaledVector(fwd, thrust / mass);

    // drag opposes velocity (+ deployed airbrakes add a big slab of drag).
    // base drag reuses dragForce (single source of truth); brake is capped so a
    // craft stacked with airbrakes can't pull non-physical 50g+ deceleration.
    if (speed > 0.1){
      const brake = c.airbrakeOn ? Math.min(s.airbrakeArea || 0, s.dragArea * 4) : 0;
      let drag = dragForce(s, speed) + 0.5 * RHO * brake * speed * speed;
      // While rolling/planing on the surface the craft is on wheels or a hull
      // skimming the water — not ploughing through it. Cut drag hard so the
      // ground run is a brisk accelerate-to-rotate, not a sticky, icy crawl.
      if (c.grounded) drag *= 0.28;
      acc.addScaledVector(v, -(drag / mass) / speed);
    }

    // lift: wings convert forward speed into an upward force opposing gravity.
    // We model lift as acting along the craft's up axis, scaled by speed²,
    // capped so it can roughly balance weight at/above cruise. Below stall the
    // wing loses lift and the aircraft sinks.
    const upAxis = TMP2.set(0, 1, 0).applyQuaternion(c.group.quaternion);
    if (s.liftArea > 0 && speed > 1){
      const liftCap = mass * 9.80665 * 1.15;     // can pull a bit more than 1g
      let lift = 0.5 * RHO * s.liftArea * speed * speed * 1.1;
      if (speed < stallV) lift *= clamp(speed / Math.max(1, stallV), 0, 1) * 0.5;  // stall drop-off
      lift = Math.min(lift, liftCap);
      acc.addScaledVector(upAxis, lift / mass);
    }

    // gravity
    acc.y -= 9.80665;

    // integrate velocity & position
    v.addScaledVector(acc, dt);
    // clamp to physical top speed (boost vs normal) to keep it sane
    const vCap = (c.boost ? s.vMaxBoost : s.vMax) * 1.05 || 400;
    const sp2 = v.length();
    if (sp2 > vCap && vCap > 0) v.multiplyScalar(vCap / sp2);
    c.pos.addScaledVector(v, dt);

    // --- fuel burn ---
    if (c.fuel > 0 && thrust > 0){
      let burn = s.burnRate * c.throttle;
      if (c.boost) burn += s.boostBurn;
      c.fuel = Math.max(0, c.fuel - burn * dt);
      if (c.fuel <= 0 && c.isPlayer) this.flashMsg('FUEL EXHAUSTED', 'bad');
    }

    // --- heat / overheat ---
    // gun fire adds heat impulsively in handleFiring; engine adds via genFrac here
    c.temp = thermoStep(s, c.temp, genFrac, speed, dt);
    if (c.temp > s.overheat){
      const over = (c.temp - s.overheat);
      this.damage(c, over * 0.02 * dt * 60, null, false);   // continuous overheat damage
      if (c.isPlayer) this.flashMsg('OVERHEAT', 'bad');
    }
    c.temp = Math.max(AMBIENT_TEMP, c.temp);

    // --- ground / sea collision ---
    const surfY = this.surfaceHeight(c.pos.x, c.pos.z);

    // takeoff roll: a craft that began on the surface (startAirborne off) rests on
    // it rather than crashing — the surface supports it against gravity while it
    // builds speed. It lifts off once it has flying speed and is actually climbing.
    if (c.grounded){
      if (c.isShipCraft){
        // a piloted SHIP is a surface vessel: float it at its waterline (a small draft + swell bob)
        // and never climb out. The old GROUND_CLEAR×scaleMul belly-lift parked a 2× hull ~17 m up.
        c.pos.y = this.shipRestY(c);
        c.vel.y = 0;
        c.group.position.copy(c.pos);
        return;                                       // stays on the water; never takes off, never crashes
      }
      const rest = surfY + GROUND_CLEAR * (c.scaleMul || 1);
      if (c.pos.y < rest) c.pos.y = rest;
      if (c.vel.y < 0) c.vel.y = 0;                 // surface holds it up
      const stallV = isFinite(s.vStall) ? s.vStall : 60;
      if (speed > stallV && c.vel.y > 0.5){
        c.grounded = false;                         // wheels/hull up — flying now
      } else {
        c.group.position.copy(c.pos);
        return;                                      // still on the surface; skip the crash check
      }
    }

    if (c.pos.y <= surfY + 2){
      // crash
      if (speed > 40 || Math.abs(v.y) > 18 || c.pos.y < surfY){
        this.killCraft(c, this.env.sea ? 'Splashed down' : 'Crashed', null);
      } else {
        // gentle — bounce/limit (basically landed; treat as crash for the sim simplicity but soft)
        this.killCraft(c, this.env.sea ? 'Ditched' : 'Crashed', null);
      }
      return;
    }

    // keep group transform synced
    c.group.position.copy(c.pos);
  }

  surfaceHeight(x, z){
    if (this.env.sea) return Math.sin(x * 0.01) * 1.6 + Math.cos(z * 0.013) * 1.4;
    return Math.sin(x * 0.004) * 22 + Math.cos(z * 0.0033) * 26;
  }

  // the Y a piloted SHIP floats at: the local sea surface + a believable draft (scales with the
  // hull's height × its render scale, so a tall ship rides higher) + a gentle swell bob. This sits
  // the vessel on the water at ≈sea level instead of GROUND_CLEAR×scaleMul (~17 m) up in the air.
  shipRestY(c){
    const surfY = this.surfaceHeight(c.pos.x, c.pos.z);
    const draft = Math.max(1, ((c.stats && c.stats.bbox && c.stats.bbox.size.y) || 3) * (c.scaleMul || 1) * 0.15);
    return surfY + draft + (this.env.sea ? Math.sin((this.time || 0) * 0.6) * 0.5 : 0);
  }

  // ---------------------------------------------------------------------
  //  FIRING — guns / missiles / lockmissile / bombs
  // ---------------------------------------------------------------------
  handleFiring(c, dt){
    if (!c.weapons || !c.weapons.length) return;
    // tick cooldown / reload on all weapons
    for (const w of c.weapons){
      if (w.cool > 0) w.cool -= dt;
      if (w.reloading > 0){
        w.reloading -= dt;
        if (w.reloading <= 0){
          const take = Math.min(w.clip, w.reserve > 0 ? w.reserve : w.clip);
          w.ammo = c.isAI ? w.clip : take;            // AI gets simplified infinite-ish reloads
          if (!c.isAI && w.reserve > 0){ w.reserve -= take; }
          if (c.isAI) w.reserve = w.clip;
        }
      }
    }

    const idx = c.isPlayer ? c.curWeapon : (c.aiWeaponIdx >= 0 ? c.aiWeaponIdx : c.curWeapon);
    const w = c.weapons[idx];
    if (!w) return;

    // lockmissile is special: it auto-fires for the player on full lock; for AI
    // it behaves like a normal homing missile via wantMissile.
    if (c.isPlayer && w.type === 'lockmissile'){
      // handled in updateLock via this.tryFireLockMissile
    }

    const wantsThis = (w.type === 'gun' && c.wantGun) ||
                      ((w.type === 'missile' || w.type === 'radar') && c.wantMissile) ||
                      (w.type === 'bomb' && c.wantBomb) ||
                      (w.type === 'lockmissile' && c.isAI && c.wantMissile);

    if (!wantsThis) return;
    if (w.reloading > 0 || w.cool > 0) return;
    if (w.ammo <= 0){
      if (w.reserve > 0 || c.isAI){ w.reloading = w.reload; if (c.isPlayer && c === this.player) this.flashMsg('RELOADING…', 'warn'); }
      return;
    }

    // overheat lock-out for guns
    if (w.type === 'gun' && c.temp > c.stats.overheat * 0.98){ return; }

    this.fireWeapon(c, w, idx);
    w.cool = 1 / Math.max(0.1, w.rof);
    w.ammo -= 1;
    if (w.ammo <= 0 && (w.reserve > 0 || c.isAI)) w.reloading = w.reload;
  }

  // muzzle world position + forward for craft c (offset to the nose)
  muzzle(c, out, w){
    out = out || new THREE.Vector3();
    const q = c.group.quaternion;
    if (w && w.node){
      // fire from the actual gun's mount: its (unscaled-local) position lifted by the
      // craft scale into world space, nudged forward to clear the hull.
      const s = c.group.scale.x || 1;
      out.copy(w.node.position).multiplyScalar(s).applyQuaternion(q).add(c.pos);
      out.addScaledVector(TMP.set(0, 0, 1).applyQuaternion(q), 2 * s);
    } else {
      out.copy(c.pos).addScaledVector(TMP.set(0, 0, 1).applyQuaternion(q), 8);
    }
    return out;
  }

  fireWeapon(c, w, idx){
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(c.group.quaternion);
    const muzzle = this.muzzle(c, null, w);   // fire from this weapon's own mount, not the hull centre
    if (w.type === 'gun'){
      // fast tracer projectile with spread.
      const spread = w.spread || 0;
      // the player fires along the AIM reticle ("shoot where you look"); with aim
      // assist on and a lock, the line snaps to the computed lead point.
      let dir;
      if (c.isPlayer && c.aimDir){
        if (this.assistOn && this.lock.target && this.lock.target.alive){
          const lead = leadPoint(muzzle, this.lock.target, w.speed || 1200);
          dir = new THREE.Vector3(lead.x - muzzle.x, lead.y - muzzle.y, lead.z - muzzle.z).normalize();
        } else {
          // GUN CONVERGENCE — the chase camera sits ~11 m above the airframe and
          // looks parallel to the gun line, so firing straight along the reticle
          // sends rounds UNDER whatever the player has centred (the old "you have
          // to aim on top of them to hit" bug). Instead aim from the muzzle THROUGH
          // the point the crosshair is looking at, at the target's range, so the
          // centre of the reticle lands on the enemy's centre of mass.
          const lt = this.lock && this.lock.target && this.lock.target._src;
          const range = (lt && lt.alive && lt.pos)
            ? Math.hypot(lt.pos.x - this.camPos.x, lt.pos.y - this.camPos.y, lt.pos.z - this.camPos.z)
            : 650;
          dir = new THREE.Vector3(
            this.camPos.x + c.aimDir.x * range - muzzle.x,
            this.camPos.y + c.aimDir.y * range - muzzle.y,
            this.camPos.z + c.aimDir.z * range - muzzle.z,
          ).normalize();
          // back out the craft's own velocity (spawnBullet adds it to the round) so
          // the bullet's TRUE trajectory — not just its launch heading — crosses the
          // reticle. Matters most for fast jets and slow rounds (rockets).
          const spd = w.speed || 1200;
          dir.set(dir.x - c.vel.x / spd, dir.y - c.vel.y / spd, dir.z - c.vel.z / spd).normalize();
        }
      } else dir = fwd.clone();
      if (spread){
        dir.x += (Math.random() - 0.5) * spread * 2;
        dir.y += (Math.random() - 0.5) * spread * 2;
        dir.z += (Math.random() - 0.5) * spread * 2;
        dir.normalize();
      }
      this.spawnBullet(c, muzzle, dir, w);
      // heat
      c.temp += (w.heatPerShot || 0) / Math.max(1, c.stats.heatCap) * 1;
      if (c.isPlayer) this.shake = Math.min(0.5, this.shake + (w.key === 'cannon' ? 0.18 : 0.05));
      sfx(w.key === 'cannon' ? 'cannon' : (w.key === 'gatling' ? 'gatling' : 'mg'), c.isPlayer ? 0.22 : 0.09);
    } else if (w.type === 'missile' || w.type === 'radar' || w.type === 'lockmissile'){
      // homing missile toward current lock/AI target. The lock stores a lockView
      // ({position,vel,_src}); unwrap to the real craft (._src) so the missile homer,
      // which reads target.pos, gets a live object instead of crashing every frame.
      let target = null;
      if (c.isPlayer){ target = (this.lock.target && this.lock.target._src) || this.bestForwardTarget(c); }
      else { target = c.ai ? c.ai.target : pickTarget(c, this.world); }
      const launchDir = (c.isPlayer && c.aimDir) ? c.aimDir : fwd;   // player missiles leave along the reticle
      if (w.torpedo){
        // a torpedo isn't a missile: it splashes down and RUNS along the sea toward a surface
        // vessel (an aircraft-dropped aerial torpedo, or a player warship's tube). See spawnTorpedo.
        this.spawnTorpedo(c, muzzle, launchDir, w, target);
      } else {
        this.spawnMissile(c, muzzle, launchDir, w, target);
        sfx('missile', c.isPlayer ? 0.3 : 0.12);
        if (c.isPlayer) this.shake = Math.min(0.6, this.shake + 0.12);
      }
    } else if (w.type === 'bomb'){
      this.spawnBomb(c, muzzle, w);
      sfx('ui', 0.2);
    }
  }

  // find the most nose-on enemy for the player's missiles when no lock yet
  bestForwardTarget(c){
    const fwd = TMP.set(0, 0, 1).applyQuaternion(c.group.quaternion);
    let best = null, bestDot = 0.5;
    for (const o of this.craft){
      if (!o.alive || o.team === c.team) continue;
      const to = TMP2.set(o.pos.x - c.pos.x, o.pos.y - c.pos.y, o.pos.z - c.pos.z);
      const d = to.length(); if (d < 1 || d > 3500) continue;
      const dot = to.multiplyScalar(1 / d).dot(fwd);
      if (dot > bestDot){ bestDot = dot; best = o; }
    }
    for (const cc of this.carriers){
      if (!cc.alive || cc.team === c.team) continue;
      const to = TMP2.set(cc.pos.x - c.pos.x, cc.pos.y - c.pos.y, cc.pos.z - c.pos.z);
      const d = to.length(); if (d < 1 || d > 4000) continue;
      const dot = to.multiplyScalar(1 / d).dot(fwd);
      if (dot > bestDot){ bestDot = dot; best = cc; }
    }
    return best;
  }

  // ---- projectile spawns ----
  spawnBullet(c, pos, dir, w){
    const geom = Sim.bulletGeom || (Sim.bulletGeom = new THREE.SphereGeometry(0.6, 6, 4));
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(w.tracer || '#fff2a8') });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(pos);
    // a stretched tracer trail
    const trail = new THREE.Mesh(
      Sim.trailGeom || (Sim.trailGeom = new THREE.CylinderGeometry(0.18, 0.18, 1, 5)),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(w.tracer || '#fff2a8'), transparent: true, opacity: 0.6 })
    );
    trail.rotation.x = Math.PI / 2;
    trail.scale.z = 14;
    trail.position.copy(pos);
    trail.quaternion.copy(c.group.quaternion);
    this.scene.add(mesh); this.scene.add(trail);
    this.bullets.push({
      mesh, trail, team: c.team, owner: c,
      pos: mesh.position, vel: dir.clone().multiplyScalar(w.speed || 1200).add(c.vel),
      dmg: w.dmg, splash: w.splash || 0, life: 2.6,
    });
  }

  spawnMissile(c, pos, fwd, w, target){
    const grp = new THREE.Group();
    // one shared steel material per round drives body + nose + fins; flame is its own.
    const skin = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, metalness: 0.5, roughness: 0.45 });
    const body = new THREE.Mesh(
      Sim.missileGeom || (Sim.missileGeom = new THREE.CylinderGeometry(0.2, 0.2, 3.0, 9)), skin);
    body.rotation.x = Math.PI / 2; grp.add(body);
    const nose = new THREE.Mesh(
      Sim.missileNoseGeom || (Sim.missileNoseGeom = new THREE.ConeGeometry(0.2, 0.95, 10)), skin);
    nose.rotation.x = Math.PI / 2; nose.position.z = 1.95; grp.add(nose);
    const finGeom = Sim.missileFinGeom || (Sim.missileFinGeom = new THREE.BoxGeometry(0.035, 0.55, 0.7));
    for (let f = 0; f < 4; f++){ const fin = new THREE.Mesh(finGeom, skin); fin.position.set(0, 0.42, -1.18);
      const piv = new THREE.Group(); piv.add(fin); piv.rotation.z = f * Math.PI / 2; grp.add(piv); }
    const flame = new THREE.Mesh(
      Sim.flameGeom || (Sim.flameGeom = new THREE.ConeGeometry(0.34, 2.4, 8)),
      new THREE.MeshBasicMaterial({ color: 0xffd070, transparent: true, opacity: 0.9 })
    );
    flame.rotation.x = -Math.PI / 2; flame.position.z = -2.2; grp.add(flame);
    grp.position.copy(pos);
    grp.quaternion.copy(c.group.quaternion);
    this.scene.add(grp);
    const spd = w.speed || 600;
    this.missiles.push({
      mesh: grp, flame, team: c.team, owner: c,
      pos: grp.position, vel: fwd.clone().multiplyScalar(spd).add(c.vel.clone().multiplyScalar(0.3)),
      speed: spd, dmg: w.dmg, splash: w.splash || 0, turn: w.turn || 2.5,
      kind: w.key, target, ballistic: false, life: 9, alive: true, armTime: 0.25,
    });
  }

  spawnBomb(c, pos, w){
    const grp = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0x8a6bbf, metalness: 0.35, roughness: 0.55 });
    const body = new THREE.Mesh(
      Sim.bombGeom || (Sim.bombGeom = new THREE.CylinderGeometry(0.36, 0.36, 1.9, 10)), skin);
    body.rotation.x = Math.PI / 2; grp.add(body);
    const nose = new THREE.Mesh(
      Sim.bombNoseGeom || (Sim.bombNoseGeom = new THREE.ConeGeometry(0.36, 0.95, 10)), skin);
    nose.rotation.x = Math.PI / 2; nose.position.z = 1.4; grp.add(nose);
    const finGeom = Sim.bombFinGeom || (Sim.bombFinGeom = new THREE.BoxGeometry(0.05, 0.52, 0.6));
    for (let f = 0; f < 4; f++){ const fin = new THREE.Mesh(finGeom, skin); fin.position.set(0, 0.5, -0.98);
      const piv = new THREE.Group(); piv.add(fin); piv.rotation.z = f * Math.PI / 2 + Math.PI / 4; grp.add(piv); }
    grp.position.copy(pos);
    grp.quaternion.copy(c.group.quaternion);
    this.scene.add(grp);
    this.missiles.push({
      mesh: grp, flame: null, team: c.team, owner: c,
      pos: grp.position, vel: c.vel.clone(),
      speed: 0, dmg: w.dmg, splash: w.splash || 40, turn: 0,
      kind: w.key, target: null, ballistic: true, life: 14, alive: true, armTime: 0.4,
    });
  }

  // ---------------------------------------------------------------------
  //  ORDNANCE UPDATES
  // ---------------------------------------------------------------------
  updateBullets(dt){
    for (let i = this.bullets.length - 1; i >= 0; i--){
      const b = this.bullets[i];
      b.life -= dt;
      const prev = TMP.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      // orient trail along travel
      if (b.trail){ b.trail.position.copy(b.pos); }
      // collision: segment vs craft/carrier spheres
      let hit = null;
      for (const o of this.craft){
        if (!o.alive || o.team === b.team) continue;
        if (this.segHitsCraft(prev, b.pos, o)){ hit = o; break; }
      }
      if (!hit) for (const cc of this.carriers){
        if (!cc.alive || cc.team === b.team) continue;
        if (this.segHitsCarrier(prev, b.pos, cc)){ hit = cc; break; }
      }
      // ground
      const surf = this.surfaceHeight(b.pos.x, b.pos.z);
      if (!hit && b.pos.y <= surf + 0.5){ hit = 'ground'; }

      if (hit || b.life <= 0){
        if (hit && hit !== 'ground'){
          this.damage(hit, b.dmg, b.owner, true);
          this.spawnSpark(b.pos, b.team === 0 ? 0x39ff88 : 0xff8844);
          sfx('hit', hit === this.player ? 0.3 : 0.05);
          if (b.splash) this.splashDamage(b.pos, b.splash, b.dmg * 0.4, b.owner, b.team);
        } else if (hit === 'ground'){
          this.spawnSpark(b.pos, 0xbbaa88);
        }
        this.removeBullet(i);
      }
    }
  }

  removeBullet(i){
    const b = this.bullets[i];
    this.scene.remove(b.mesh);
    if (b.trail){ this.scene.remove(b.trail); b.trail.material.dispose(); }
    if (b.mesh.material) b.mesh.material.dispose();
    this.bullets.splice(i, 1);
  }

  updateMissiles(dt){
    for (let i = this.missiles.length - 1; i >= 0; i--){
      const m = this.missiles[i];
      m.life -= dt; m.armTime -= dt;
      if (m.ballistic){
        m.vel.y -= 9.80665 * dt;
        m.vel.multiplyScalar(1 - 0.02 * dt);  // light air drag
      } else {
        // homing toward target (flares can decoy IR)
        let tgt = m.target;
        // flare decoy: IR missiles may re-target a nearby friendly-to-target flare
        if (m.kind === 'ir'){
          for (const fl of this.flares){
            if (!fl.alive) continue;
            const d = TMP.set(fl.pos.x - m.pos.x, fl.pos.y - m.pos.y, fl.pos.z - m.pos.z).length();
            if (d < 110 && Math.random() < 0.6 * dt){ m.decoyed = fl; }
          }
          if (m.decoyed && m.decoyed.alive) tgt = m.decoyed;
        }
        if (tgt && (tgt.alive)){
          homeMissile({ position: m.pos, vel: m.vel, speed: m.speed }, { position: tgt.pos, vel: tgt.vel || { x: 0, y: 0, z: 0 }, alive: true }, m.turn, dt);
        }
        // keep up to speed
        const sp = m.vel.length() || 1;
        m.vel.multiplyScalar(m.speed / sp);
        // orient mesh to velocity
        if (sp > 1){ m.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), TMP.copy(m.vel).normalize()); }
      }
      const prev = TMP2.copy(m.pos);
      m.pos.addScaledVector(m.vel, dt);

      // detonation checks
      let det = false, at = m.pos;
      if (m.armTime <= 0){
        for (const o of this.craft){
          if (!o.alive || o.team === m.team) continue;
          if (this.segHitsCraft(prev, m.pos, o, 6)){ det = true; at = o.pos; break; }
        }
        if (!det) for (const cc of this.carriers){
          if (!cc.alive || cc.team === m.team) continue;
          if (this.segHitsCarrier(prev, m.pos, cc, 10)){ det = true; at = cc.pos; break; }
        }
      }
      const surf = this.surfaceHeight(m.pos.x, m.pos.z);
      if (!det && m.pos.y <= surf + 1){ det = true; at = TMP3.set(m.pos.x, surf, m.pos.z); }

      if (det || m.life <= 0){
        if (det){
          this.spawnExplosion(at, m.splash > 40 ? 1.5 : 1);
          this.splashDamage(at, m.splash, m.dmg, m.owner, m.team);
          sfx('boom', 0.4);
        }
        this.removeMissile(i);
      }
    }
  }

  removeMissile(i){
    const m = this.missiles[i];
    this.scene.remove(m.mesh);
    this.missiles.splice(i, 1);
  }

  // ---- TORPEDOES ----
  // A torpedo is its own slow ordnance that RUNS along the sea surface toward a surface vessel —
  // launched by an aircraft (aerial torpedo) or a warship's deck tubes (updateTorpedoMounts). It
  // gets a dedicated pipeline (not the missile loop) precisely because a missile detonates the
  // instant it touches the water, whereas a torpedo intentionally rides the waterline.
  spawnTorpedo(c, pos, dir, w, target){
    const grp = new THREE.Group();
    const skin = this.torpedoMat || (this.torpedoMat = new THREE.MeshStandardMaterial({ color: 0x2b3138, metalness: 0.5, roughness: 0.5 }));
    const body = new THREE.Mesh(Sim.torpedoGeom || (Sim.torpedoGeom = new THREE.CylinderGeometry(0.55, 0.55, 5.2, 10)), skin);
    body.rotation.x = Math.PI / 2; grp.add(body);
    const nose = new THREE.Mesh(Sim.torpedoNoseGeom || (Sim.torpedoNoseGeom = new THREE.ConeGeometry(0.55, 1.2, 10)), skin);
    nose.rotation.x = Math.PI / 2; nose.position.z = 3.1; grp.add(nose);
    // a pale foam wake streaking astern along the surface (lies flat; trails with the run heading)
    const wmat = this.wakeMat || (this.wakeMat = new THREE.MeshBasicMaterial({ color: 0xd6ecff, transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide }));
    const wake = new THREE.Mesh(Sim.wakeGeom || (Sim.wakeGeom = new THREE.PlaneGeometry(3.2, 30)), wmat);
    wake.rotation.x = -Math.PI / 2; wake.position.set(0, 0.2, -15); grp.add(wake);
    grp.position.copy(pos);
    this.scene.add(grp);
    const sp = w.torpSpeed || 100;
    let hx = dir.x, hz = dir.z, hl = Math.hypot(hx, hz);
    if (hl < 1e-4){
      // launch heading is near-vertical (a torpedo-bomber nosed straight up/down): fall back to the
      // firer's horizontal forward bearing instead of the degenerate (0,0)→due-north default.
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(c.group.quaternion);
      hx = f.x; hz = f.z; hl = Math.hypot(hx, hz) || 1;
    }
    const range = w.turretRange || 3200;
    // torpedoes only chase things on the water — if handed an airborne lock, find a surface target.
    const tgt = (target && target.alive && this.isSurface(target)) ? target : this.nearestSurfaceEnemy(c.team, pos, range);
    this.torpedoes.push({
      mesh: grp, team: c.team, owner: c, pos: grp.position,
      vel: new THREE.Vector3(hx / hl * sp, 0, hz / hl * sp),
      speed: sp, dmg: w.dmg, splash: w.splash || 60, turn: w.turn || 1.0,
      // arm after a FIXED ~25 m of run (not a fixed time) so a fast torpedo doesn't fly un-armed
      // straight THROUGH a close target — 0.4 s × 2600 m/s would be a ~1 km dead zone.
      runDepth: w.runDepth || 0.15, range, target: tgt, life: 18, arm: Math.min(0.4, 25 / sp),
    });
    sfx('ui', c.isPlayer ? 0.22 : 0.08);
  }

  updateTorpedoes(dt){
    for (let i = this.torpedoes.length - 1; i >= 0; i--){
      const t = this.torpedoes[i];
      t.life -= dt; if (t.arm > 0) t.arm -= dt;
      // STRAIGHT-RUNNING torpedo: it holds its launch heading and speed — NO homing / no turn
      // (a fast unguided fish; the launcher/pilot aims it). Velocity is constant; just integrate.
      const prev = TMP2.copy(t.pos);
      t.pos.x += t.vel.x * dt; t.pos.z += t.vel.z * dt;
      // ride the waterline: settle just below the surface (half-submerged), descending fast if air-dropped
      const runY = this.surfaceHeight(t.pos.x, t.pos.z) - t.runDepth;
      t.pos.y += clamp(runY - t.pos.y, -45 * dt, 18 * dt);
      t.mesh.position.copy(t.pos);
      t.mesh.rotation.y = Math.atan2(t.vel.x, t.vel.z);

      // detonate on a surface vessel (never on the open water — it lives there). Armed after launch.
      let det = false, at = t.pos;
      if (t.arm <= 0){
        for (const cc of this.carriers){
          if (!cc.alive || cc.team === t.team) continue;
          if (this.segHitsCarrier(prev, t.pos, cc, 6)){ det = true; at = cc.pos; break; }
        }
        if (!det) for (const o of this.craft){
          if (!o.alive || o.team === t.team || !this.isSurface(o)) continue;
          if (this.segHitsCraft(prev, t.pos, o, 5)){ det = true; at = o.pos; break; }
        }
      }
      if (det || t.life <= 0){
        if (det){
          const surf = this.surfaceHeight(at.x, at.z);
          this.spawnExplosion(TMP3.set(at.x, surf + 2, at.z), 1.7);
          this.splashDamage(at, t.splash, t.dmg, t.owner, t.team);
          sfx('boom', 0.5);
        }
        this.removeTorpedo(i);
      }
    }
  }

  removeTorpedo(i){
    this.scene.remove(this.torpedoes[i].mesh);
    // geometry is shared-static; materials are the per-battle cache (disposed in teardown).
    this.torpedoes.splice(i, 1);
  }

  // a vessel sits on/at the water: carriers always; a craft only when near the local sea surface
  // (so a torpedo never tries to chase — or hit — an airborne aircraft).
  isSurface(o){
    if (o.isCarrier) return true;
    return (o.pos.y - this.surfaceHeight(o.pos.x, o.pos.z)) <= 14;
  }

  // nearest enemy SURFACE vessel to `from` within range (ships always; sea-level craft too).
  nearestSurfaceEnemy(team, from, range){
    let best = null, bd = range * range;
    for (const cc of this.carriers){
      if (!cc.alive || cc.team === team) continue;
      const dx = cc.pos.x - from.x, dz = cc.pos.z - from.z, d2 = dx * dx + dz * dz;
      if (d2 < bd){ bd = d2; best = cc; }
    }
    for (const o of this.craft){
      if (!o.alive || o.team === team || !this.isSurface(o)) continue;
      const dx = o.pos.x - from.x, dz = o.pos.z - from.z, d2 = dx * dx + dz * dz;
      if (d2 < bd){ bd = d2; best = o; }
    }
    return best;
  }

  // a warship's deck torpedo tubes: train on the nearest enemy ship and launch on a long cooldown.
  // Mirrors updateTurrets (cosmetic node traverse + launch from the tube tip) but spawns a sea-
  // running torpedo, not a shell, and only ever engages SURFACE vessels.
  updateTorpedoMounts(cc, dt){
    const mounts = cc.torpedoMounts;
    if (!mounts || !mounts.length) return;
    const q = cc.group.quaternion;
    for (const m of mounts){
      const w = m.w;
      if (w.cool > 0) w.cool -= dt;
      const range = w.turretRange || 3000;
      const tgt = this.nearestSurfaceEnemy(cc.team, cc.pos, range);
      const node = m.node;
      const base = _TV.set(0, 0, 0);
      if (node) base.copy(node.position).multiplyScalar(cc.group.scale.x || 1).applyQuaternion(q);
      base.add(cc.pos);
      if (!tgt) continue;
      const aimW = _TV2.set(tgt.pos.x - base.x, 0, tgt.pos.z - base.z);
      if (aimW.lengthSq() < 1e-6) continue;
      aimW.normalize();
      // slew the tube toward the target bearing — the torpedo runs STRAIGHT from here (no homing),
      // so it must be properly lined up before it launches.
      if (node){
        const localAim = _TV3.copy(aimW).applyQuaternion(_TQ2.copy(q).invert()).normalize();
        _TQ.setFromUnitVectors(_ZAXIS, localAim);
        node.quaternion.rotateTowards(_TQ, 1.6 * dt);
      }
      if (w.cool > 0) continue;
      const barrelW = node
        ? _TV3.set(0, 0, 1).applyQuaternion(_TQ2.multiplyQuaternions(q, node.quaternion)).normalize()
        : aimW;
      // fire ONLY when the straight shot will actually LAND: the closer the target, the more
      // angular slop its hull forgives (no homing to correct a sloppy launch).
      const dist = Math.hypot(tgt.pos.x - base.x, tgt.pos.z - base.z) || 1;
      const aimTol = clamp((tgt.hitR || 30) * 0.8 / dist, 0.012, 0.22);
      if (barrelW.dot(aimW) < Math.cos(aimTol)) continue;
      const muzzle = _TV.copy(base).addScaledVector(barrelW, 3 * (cc.group.scale.x || 1));
      this.spawnTorpedo(cc, muzzle, barrelW, w, tgt);
      w.cool = 1 / Math.max(0.05, w.rof);
    }
  }

  updateFlares(dt){
    for (let i = this.flares.length - 1; i >= 0; i--){
      const f = this.flares[i];
      f.life -= dt;
      f.vel.y -= 4 * dt;
      f.pos.addScaledVector(f.vel, dt);
      f.mesh.material.opacity = clamp(f.life / 2, 0, 1);
      if (f.life <= 0){ f.alive = false; this.scene.remove(f.mesh); f.mesh.material.dispose(); this.flares.splice(i, 1); }
    }
  }

  updateFX(dt){
    for (let i = this.fx.length - 1; i >= 0; i--){
      const e = this.fx[i];
      e.life -= dt;
      e.t += dt;
      if (e.kind === 'spark'){
        for (const p of e.parts){ p.pos.addScaledVector(p.vel, dt); p.vel.multiplyScalar(0.92); }
        e.mesh.geometry.attributes.position.needsUpdate = true;
        const arr = e.mesh.geometry.attributes.position.array;
        e.parts.forEach((p, k) => { arr[k * 3] = p.pos.x; arr[k * 3 + 1] = p.pos.y; arr[k * 3 + 2] = p.pos.z; });
        e.mesh.material.opacity = clamp(e.life / e.maxLife, 0, 1);
      } else if (e.kind === 'boom'){
        const s = lerp(e.from, e.to, 1 - e.life / e.maxLife);
        e.mesh.scale.setScalar(s);
        e.mesh.material.opacity = clamp(e.life / e.maxLife, 0, 1) * 0.9;
        if (e.light) e.light.intensity = clamp(e.life / e.maxLife, 0, 1) * 6;
      }
      if (e.life <= 0){
        this.scene.remove(e.mesh);
        if (e.mesh.material) e.mesh.material.dispose();
        if (e.light) this.scene.remove(e.light);
        this.fx.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------------
  //  HIT TESTS
  // ---------------------------------------------------------------------
  // HULL-SHAPED hit test: slab-intersect the shot segment against the unit's ORIENTED box
  // (hullCenter/hullHalf in its local frame). Replaces the old bounding SPHERE, which on a
  // long ship flagged hits metres of empty air beside/above the hull, and ballooned a thin
  // airframe's profile vertically. `pad` inflates every face (missile/torpedo proximity).
  segHitsHull(a, b, o, pad){
    const q = _TQ2.copy((o.group || o.mesh).quaternion).invert();
    const la = _TV.copy(a).sub(o.pos).applyQuaternion(q).sub(o.hullCenter);
    const lb = _TV2.copy(b).sub(o.pos).applyQuaternion(q).sub(o.hullCenter);
    const h = o.hullHalf;
    let t0 = 0, t1 = 1;
    for (const ax of ['x', 'y', 'z']){
      const p0 = la[ax], d = lb[ax] - p0, e = h[ax] + pad;
      if (Math.abs(d) < 1e-9){ if (p0 < -e || p0 > e) return false; continue; }
      let u = (-e - p0) / d, v = (e - p0) / d;
      if (u > v){ const w = u; u = v; v = w; }
      if (u > t0) t0 = u;
      if (v < t1) t1 = v;
      if (t0 > t1) return false;
    }
    return true;
  }
  segHitsCraft(a, b, o, pad = 0){
    if (o.hullHalf) return this.segHitsHull(a, b, o, pad);
    const r = (o.stats.bbox ? Math.max(o.stats.bbox.size.x, o.stats.bbox.size.z) * 0.6 : 8) * (o.scaleMul || 1) + pad;
    return distSegPoint(a, b, o.pos) <= r;
  }
  segHitsCarrier(a, b, o, pad = 0){
    if (o.hullHalf) return this.segHitsHull(a, b, o, pad);
    const r = (o.hitR || (o.design ? 60 : 150)) + pad;
    return distSegPoint(a, b, o.pos) <= r;
  }

  // ---------------------------------------------------------------------
  //  DAMAGE / SPLASH / KILL
  // ---------------------------------------------------------------------
  damage(o, amount, attacker, allowArmor){
    if (!o.alive) return;
    let dmg = amount;
    if (allowArmor && o.armor){
      // armor soaks a fraction proportional to armor vs total HP
      const soak = clamp(o.armor / (o.maxHp || 1), 0, 0.7);
      dmg *= (1 - soak);
    }
    o.hp -= dmg;
    if (o.isPlayer){ this.shake = Math.min(0.8, this.shake + Math.min(0.4, dmg / 120)); this.flashMsg('HIT', 'bad'); }
    if (o.hp <= 0){
      if (o.isCarrier) this.killCarrier(o, attacker);
      else this.killCraft(o, 'Shot down', attacker);
    }
  }

  splashDamage(center, radius, dmg, attacker, team){
    if (radius <= 0){ return; }
    for (const o of this.craft){
      if (!o.alive || o.team === team) continue;
      const d = Math.hypot(o.pos.x - center.x, o.pos.y - center.y, o.pos.z - center.z);
      if (d < radius){ this.damage(o, dmg * (1 - d / radius), attacker, true); }
    }
    for (const cc of this.carriers){
      if (!cc.alive || cc.team === team) continue;
      const d = Math.hypot(cc.pos.x - center.x, cc.pos.y - center.y, cc.pos.z - center.z);
      if (d < radius + 60){ this.damage(cc, dmg * (1 - d / (radius + 60)) * 1.5, attacker, false); }
    }
  }

  killCraft(c, reason, attacker){
    if (!c.alive) return;
    c.alive = false; c.dead = true;
    this.spawnExplosion(c.pos, 1.8);
    sfx('boom', c.isPlayer ? 0.6 : 0.3);
    // drop the wreck — and free its GPU buffers. A craft's merged airframe geometry + materials
    // are built per-craft (never shared), so disposing them on death is safe and stops a steady
    // VRAM leak in a long fight where dozens of craft are destroyed.
    this.scene.remove(c.group);
    c.group.traverse(o => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material){ const mm = Array.isArray(o.material) ? o.material : [o.material]; mm.forEach(m => m && m.dispose && m.dispose()); }
    });
    // scoring
    if (attacker === this.player && !c.isPlayer){ this.result.kills++; this.result.score += 100 + Math.round((c.stats.cost || 0) / 100); toast(`${c.name} destroyed`, 'good'); }
    if (c.isPlayer){
      this.result.deaths++;
      this.flashMsg(reason.toUpperCase(), 'bad');
      this.endBattle(false, reason);
    } else if (this.lock.target && this.lock.target._src === c){   // lock holds a lockView, not the craft — compare its source
      this.lock.reset();
    }
  }

  killCarrier(cc, attacker){
    if (!cc.alive) return;
    cc.alive = false;
    // multi-blast
    for (let i = 0; i < 5; i++){
      const off = new THREE.Vector3((Math.random() - 0.5) * 120, Math.random() * 30, (Math.random() - 0.5) * 200);
      this.spawnExplosion(TMP.copy(cc.pos).add(off), 2.4);
    }
    sfx('boom', 0.7);
    setTimeout(() => { if (cc.mesh){ this.scene.remove(cc.mesh); cc.mesh.traverse(o => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material){ const mm = Array.isArray(o.material) ? o.material : [o.material]; mm.forEach(m => m && m.dispose && m.dispose()); }
    }); } }, 200);
    toast(`${cc.name} sunk!`, cc.team === 1 ? 'good' : 'bad');
    if (attacker === this.player) this.result.score += 800;
  }

  // ---------------------------------------------------------------------
  //  FLARES / COUNTERMEASURES
  // ---------------------------------------------------------------------
  firePlayerFlare(){ this.fireFlare(this.player); }
  fireFlare(c){
    if (!c || !c.alive || c.flares <= 0) return;
    c.flares -= Math.min(4, c.flares);
    for (let i = 0; i < 3; i++){
      const mesh = new THREE.Mesh(
        Sim.flareGeom2 || (Sim.flareGeom2 = new THREE.SphereGeometry(0.6, 6, 4)),
        new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 1 })
      );
      mesh.position.copy(c.pos);
      this.scene.add(mesh);
      const back = TMP.set(0, 0, -1).applyQuaternion(c.group.quaternion);
      this.flares.push({
        mesh, pos: mesh.position, team: c.team, alive: true, life: 2,
        vel: c.vel.clone().multiplyScalar(0.5).add(back.multiplyScalar(20)).add(new THREE.Vector3((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 30)),
      });
    }
    if (c.isPlayer){ sfx('ui', 0.3); this.flashMsg('FLARES', 'warn'); }
  }

  jettison(c){
    if (!c || !c.alive || c.dropTanksGone) return;
    const tanks = c.group.userData.dropTanks || [];
    if (!tanks.length){ if (c.isPlayer) this.flashMsg('NO DROP TANKS', 'warn'); return; }
    for (const t of tanks){ t.visible = false; }
    c.dropTanksGone = true;
    // shed the drag/mass of drop tanks by recomputing a leaner stat profile
    const lean = { ...c.design, parts: c.design.parts.filter(p => !(PARTS[p.key] && PARTS[p.key].jettison)) };
    const ns = computeStats(lean);
    // splice: keep current hp/fuel ratios but adopt lighter mass/drag/agility
    c.stats = ns;
    c.fuel = Math.min(c.fuel, ns.fuelMass);
    c.maxFuel = ns.fuelMass || c.maxFuel;
    if (c.isPlayer){ sfx('ui', 0.3); this.flashMsg('DROP TANKS RELEASED', 'good'); toast('Drop tanks jettisoned — lighter & cleaner', 'good'); }
  }

  // ---------------------------------------------------------------------
  //  CARRIERS
  // ---------------------------------------------------------------------
  updateCarrier(cc, dt){
    if (cc.isShip){
      // SHIP: steer toward the nearest enemy SURFACE unit (carrier/ship) and close to gun
      // standoff — a moving surface combatant, not a slow-steaming carrier. Its turrets
      // engage whatever's in range via updateTurrets; this just drives the hull.
      let tgt = null, bd = Infinity;
      for (const o of this.carriers){
        if (!o.alive || o.team === cc.team || o === cc) continue;
        const dx = o.pos.x - cc.pos.x, dz = o.pos.z - cc.pos.z, d2 = dx * dx + dz * dz;
        if (d2 < bd){ bd = d2; tgt = o; }
      }
      if (tgt){
        const dist = Math.sqrt(bd) || 1;
        const want = dist > 650 ? (cc.shipSpeed || 24) : 0;   // hold at ~gun range, don't ram
        cc.vel.set((tgt.pos.x - cc.pos.x) / dist * want, 0, (tgt.pos.z - cc.pos.z) / dist * want);
      } else {
        cc.vel.multiplyScalar(0.96);                          // no surface target → coast to a stop
      }
    } else if (Math.abs(cc.pos.x) > 3000){
      cc.vel.x *= -1;                                         // carrier: slow steam, turn at map edges
    }
    cc.pos.addScaledVector(cc.vel, dt);
    cc.pos.y = this.env.sea ? 4 + Math.sin(this.time * 0.6) * 0.6 : 14;
    cc.mesh.position.copy(cc.pos);
    if (cc.vel.lengthSq() > 0.01) cc.mesh.rotation.y = Math.atan2(cc.vel.x, cc.vel.z);

    // point defence
    cc.pdCool -= dt;
    // point-defence flak fires from the hull centre — keep it ONLY as a fallback for a
    // gunless hull (the default slab carrier). A ship with deck guns already engages from
    // its own barrels via updateTurrets, so skip the centre-fire flak there.
    if (cc.pdCool <= 0 && (!cc.turrets || cc.turrets.length === 0)){
      const pd = updateCarrierPD(cc, this.world, dt);
      if (pd){
        // fire a flak tracer at the lead point
        const dir = TMP.set(pd.lead.x - cc.pos.x, pd.lead.y - cc.pos.y, pd.lead.z - cc.pos.z).normalize();
        const origin = TMP2.copy(cc.pos); origin.y += 24;
        const w = { dmg: 28, speed: cc.pdSpeed, splash: 8, tracer: '#ff5544' };
        // create a bullet manually (carrier isn't a craft)
        const fakeOwner = { team: cc.team, group: cc.mesh, vel: new THREE.Vector3(), pos: origin };
        const mesh = new THREE.Mesh(Sim.bulletGeom || (Sim.bulletGeom = new THREE.SphereGeometry(0.6, 6, 4)), new THREE.MeshBasicMaterial({ color: 0xff5544 }));
        mesh.position.copy(origin); this.scene.add(mesh);
        this.bullets.push({ mesh, trail: null, team: cc.team, owner: cc, pos: mesh.position, vel: dir.multiplyScalar(cc.pdSpeed), dmg: 28, splash: 8, life: 2.5 });
        cc.pdCool = 0.12;
        if (Math.random() < 0.2) sfx('cannon', 0.05);
      }
    }
  }

  // ---------------------------------------------------------------------
  //  AUTO-TURRETS — defensive turrets that traverse to the nearest enemy
  //  and fire on their own. Mounted on any craft (the player included); they
  //  spin idly to scan when nothing is in range. Set up in makeCraft.
  // ---------------------------------------------------------------------
  updateTurrets(c, dt){
    const turrets = c.turrets;
    if (!turrets || !turrets.length) return;
    const q = c.group.quaternion;
    // OPTIMISATION: a ship's guns all sit within metres of each other relative to target
    // ranges of hundreds–thousands, so scan for the nearest hostile ONCE per ship/frame (from
    // the hull centre, at the widest gun range) instead of once per gun — a big battleship has
    // dozens of guns, so this is dozens× fewer O(units) scans. Each gun applies its own range.
    let _maxR = 0; for (const t of turrets){ const r = t.w.turretRange || 1500; if (r > _maxR) _maxR = r; }
    const _shared = this.nearestEnemy(c, c.pos, _maxR, true);
    const _sd2 = _shared ? (_shared.pos.x - c.pos.x) ** 2 + (_shared.pos.y - c.pos.y) ** 2 + (_shared.pos.z - c.pos.z) ** 2 : Infinity;
    for (const t of turrets){
      const w = t.w, node = t.node;

      // cooldown / reload tick (mirrors handleFiring)
      if (w.cool > 0) w.cool -= dt;
      if (w.reloading > 0){
        w.reloading -= dt;
        if (w.reloading <= 0){
          const take = Math.min(w.clip, w.reserve > 0 ? w.reserve : w.clip);
          w.ammo = c.isAI ? w.clip : take;
          if (!c.isAI && w.reserve > 0) w.reserve -= take; else if (c.isAI) w.reserve = w.clip;
        }
      }

      // turret muzzle base in world space: node-local mount rotated into the body, + craft pos.
      // node.position is in the (unscaled) parent-local frame, so lift it by the group scale
      // first — carriers render at 6×, aircraft at 1× (no-op there).
      const base = _TV.set(0, 0, 0);
      if (node) base.copy(node.position).multiplyScalar(c.group.scale.x || 1).applyQuaternion(q);
      base.add(c.pos);

      // engage the shared per-ship nearest-hostile (scanned once above) only if it's within
      // THIS gun's own range. ANY gun may target enemy SHIPS too (a player-flown warship's
      // main guns can shell an enemy carrier).
      const range = w.turretRange || 1500;
      const tgt = (_shared && _sd2 <= range * range) ? _shared : null;
      t.target = tgt;

      // desired barrel direction in WORLD space — lead the target, or idle-sweep
      let aimW;
      if (tgt){
        const lead = leadPoint(base, { position: tgt.pos, vel: tgt.vel, alive: true }, w.speed || 820, _turretLead);
        aimW = _TV2.set(lead.x - base.x, lead.y - base.y, lead.z - base.z);
        if (aimW.lengthSq() < 1e-6) aimW.set(0, 0, 1);
        aimW.normalize();
      } else {
        // IDLE: don't whirl a full 360°. Hold a random bearing inside a forward 180° arc
        // (±90° traverse) tilted slightly UP — never below level into the deck — and pick a
        // fresh heading every few seconds, so the barrels pan slowly instead of spinning.
        if (t.scanT === undefined || (t.scanT -= dt) <= 0){
          t.scanYaw = (Math.random() - 0.5) * Math.PI;       // ±90° → 180° total sweep
          t.scanPitch = Math.random() * 0.45;                // 0…~26° up, never down
          t.scanT = 2.5 + Math.random() * 3.5;               // hold this heading 2.5–6 s
        }
        const cp = Math.cos(t.scanPitch);
        aimW = _TV2.set(Math.sin(t.scanYaw) * cp, Math.sin(t.scanPitch), Math.cos(t.scanYaw) * cp).applyQuaternion(q).normalize();
      }

      // slew the node toward the aim (convert the world aim into the body/parent frame)
      if (node){
        const localAim = _TV3.copy(aimW).applyQuaternion(_TQ2.copy(q).invert()).normalize();
        _TQ.setFromUnitVectors(_ZAXIS, localAim);
        node.quaternion.rotateTowards(_TQ, (tgt ? 4.0 : 1.4) * dt);
      }

      if (!tgt || w.cool > 0 || w.reloading > 0) continue;
      if (w.ammo <= 0){ if (w.reserve > 0 || c.isAI) w.reloading = w.reload; continue; }

      // only shoot once the barrels are actually pointed near the aim line
      const barrelW = node
        ? _TV3.set(0, 0, 1).applyQuaternion(_TQ2.multiplyQuaternions(q, node.quaternion)).normalize()
        : _TV3.copy(aimW);
      if (barrelW.dot(aimW) < 0.985) continue;

      // fire a flak round from the muzzle tip along the barrel (+ a touch of spread).
      // scale the tip offset by the group scale so a 6× carrier turret clears its own barrel.
      const muzzle = _TV.copy(base).addScaledVector(barrelW, (node ? 1.4 : 6) * (c.group.scale.x || 1));
      const dir = barrelW.clone();
      const sp = w.spread || 0;
      if (sp){ dir.x += (Math.random() - 0.5) * sp * 2; dir.y += (Math.random() - 0.5) * sp * 2; dir.z += (Math.random() - 0.5) * sp * 2; dir.normalize(); }
      this.spawnBullet(c, muzzle, dir, w);
      w.cool = 1 / Math.max(0.1, w.rof);
      w.ammo -= 1;
      if (w.ammo <= 0 && (w.reserve > 0 || c.isAI)) w.reloading = w.reload;
      if (Math.random() < 0.25) sfx('cannon', c.isPlayer ? 0.06 : 0.03);
    }
  }

  // nearest living hostile aircraft to `from` within `range` (squared-distance scan)
  nearestEnemy(c, from, range, includeCarriers){
    let best = null, bd = range * range;
    const scan = (list) => {
      for (const o of list){
        if (!o.alive || o.team === c.team || o === c) continue;
        const dx = o.pos.x - from.x, dy = o.pos.y - from.y, dz = o.pos.z - from.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bd){ bd = d2; best = o; }
      }
    };
    scan(this.craft);
    if (includeCarriers) scan(this.carriers);
    return best;
  }

  // ---------------------------------------------------------------------
  //  LOCK SYSTEM (player) — the headline prediction feature.
  // ---------------------------------------------------------------------
  updateLock(dt){
    const p = this.player;
    if (!p || !p.alive){ this.lockState = null; return; }
    const w = p.weapons[p.curWeapon];
    const origin = TMP.copy(p.pos);
    // the lock cone follows the AIM reticle (where you point), not the lagging nose,
    // so you acquire what you look at.
    const acp = Math.cos(this.aimPitch), asp = Math.sin(this.aimPitch);
    const fwd = TMP2.set(Math.sin(this.aimYaw) * acp, asp, Math.cos(this.aimYaw) * acp);
    // candidates: enemy craft + enemy carriers, exposed as {position,vel,alive,team}
    const candidates = [];
    for (const o of this.craft){ if (o.alive && o.team !== p.team){ candidates.push(this.lockView(o)); } }
    for (const cc of this.carriers){ if (cc.alive && cc.team !== p.team){ candidates.push(this.lockView(cc)); } }

    const lockTime = w ? (w.lockTime || 1.2) : 1.2;
    // the lock builds for any weapon (gun gets a soft firm-up; missiles need it)
    const ready = !!w;
    const res = this.lock.update(dt, { origin: { x: origin.x, y: origin.y, z: origin.z }, fwd: { x: fwd.x, y: fwd.y, z: fwd.z }, candidates, lockTime, ready });
    this.lockState = res;
    if (res.justLocked){ sfx('lockfull', 0.4); }
    else if (res.target && res.progress > 0 && res.progress < 1 && Math.random() < dt * 6){ sfx('lock', 0.15); }

    // lockmissile auto-fire on full lock (movie style)
    if (w && w.type === 'lockmissile' && res.locked && res.target){
      this.tryFireLockMissile(p, w, p.curWeapon, res.target._src);
    }
  }

  // expose a craft/carrier as a lock candidate; carry a back-ref to the real object
  lockView(o){
    return { position: o.pos, vel: o.vel || { x: 0, y: 0, z: 0 }, aimY: o.isCarrier ? 24 : 0, alive: o.alive, team: o.team, _src: o };
  }

  tryFireLockMissile(p, w, idx, target){
    if (w.cool > 0 || w.reloading > 0) return;
    if (w.ammo <= 0){ if (w.reserve > 0) w.reloading = w.reload; return; }
    const muzzle = this.muzzle(p);
    const fwd = TMP.set(0, 0, 1).applyQuaternion(p.group.quaternion);
    this.spawnMissile(p, muzzle, fwd, w, target);
    sfx('missile', 0.32); this.flashMsg('FOX — LOCK MISSILE AWAY', 'warn');
    this.shake = Math.min(0.6, this.shake + 0.12);
    w.cool = 1 / Math.max(0.1, w.rof);
    w.ammo -= 1;
    if (w.ammo <= 0 && w.reserve > 0) w.reloading = w.reload;
    this.lock.reset();
  }

  // ---------------------------------------------------------------------
  //  CAMERA — chase behind the aircraft, slight lag + shake.
  // ---------------------------------------------------------------------
  updateCamera(dt){
    if (isPresenting()) return;   // VR drives the camera via the cockpit rig (see vr.js)
    const p = this.player;
    if (!p){ return; }
    // The camera looks ALONG the aim reticle (not the banking nose) so the crosshair
    // stays screen-centred over an upright horizon while the airframe rolls below it
    // — the Gravity Front chase view. When dead, the last aim direction is kept.
    const cp = Math.cos(this.aimPitch), sp = Math.sin(this.aimPitch);
    const aimFwd = TMP.set(Math.sin(this.aimYaw) * cp, sp, Math.cos(this.aimYaw) * cp);
    const cm = (p.scaleMul || 1);                            // a piloted ship sits farther from the eye
    const dollyBack = (30 + clamp(p.speed * 0.03, 0, 16)) * cm;
    const desired = TMP2.copy(p.pos).addScaledVector(aimFwd, -dollyBack);
    desired.y += 11 * cm;
    const surfY = this.surfaceHeight(p.pos.x, p.pos.z);
    if (desired.y < surfY + 6) desired.y = surfY + 6;        // keep the camera above the ground
    this.camPos.lerp(desired, 1 - Math.exp(-7 * dt));

    // shake
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const sh = this.shake;
    this.camera.position.copy(this.camPos);
    this.camera.position.x += (Math.random() - 0.5) * sh * 2.4;
    this.camera.position.y += (Math.random() - 0.5) * sh * 2.4;
    this.camera.up.set(0, 1, 0);                             // upright horizon (the plane banks, the view doesn't)
    if (this.sky) this.sky.position.copy(this.camera.position);   // skybox follows the eye (never clips to a black dome)
    const look = TMP3.copy(this.camera.position).addScaledVector(aimFwd, 120);
    this.camera.lookAt(look);
    // boost narrows the FOV for a speed rush
    this.camera.fov = lerp(this.camera.fov, p.boost ? 58 : 66, 1 - Math.exp(-4 * dt));
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------------
  //  FX SPAWNERS
  // ---------------------------------------------------------------------
  spawnSpark(pos, color){
    const N = 8;
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(N * 3);
    const parts = [];
    for (let i = 0; i < N; i++){
      arr[i * 3] = pos.x; arr[i * 3 + 1] = pos.y; arr[i * 3 + 2] = pos.z;
      parts.push({ pos: pos.clone(), vel: new THREE.Vector3((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40) });
    }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mesh = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 1.4, transparent: true, opacity: 1 }));
    this.scene.add(mesh);
    this.fx.push({ kind: 'spark', mesh, parts, life: 0.5, maxLife: 0.5, t: 0 });
  }

  spawnExplosion(pos, scale = 1){
    const mesh = new THREE.Mesh(
      Sim.boomGeom || (Sim.boomGeom = new THREE.SphereGeometry(1, 12, 10)),
      new THREE.MeshBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.9 })
    );
    mesh.position.copy(pos);
    this.scene.add(mesh);
    const light = new THREE.PointLight(0xff8833, 6, 200);
    light.position.copy(pos); this.scene.add(light);
    this.fx.push({ kind: 'boom', mesh, light, from: 1 * scale, to: 26 * scale, life: 0.6, maxLife: 0.6, t: 0 });
    this.spawnSpark(pos, 0xffcc66);
  }

  // ---------------------------------------------------------------------
  //  OBJECTIVE / END
  // ---------------------------------------------------------------------
  checkObjective(dt){
    if (this.over) return;
    const type = this.objective.type;
    const enemiesAlive = this.craft.filter(c => c.alive && c.team !== 0).length;
    const enemyCarrierAlive = this.carriers.some(cc => cc.alive && cc.team === 1);
    const friendlyCarrier = this.carriers.find(cc => cc.team === 0);

    if (type === 'deathmatch' || type === 'pvp'){
      if (this.net){
        // PvP: win when all team-1 (remote) craft are gone, after they've spawned
        if (this.netSpawned && enemiesAlive === 0 && this.craft.some(c => c.team === 1)){
          this.endBattle(true, 'Enemy fleet destroyed');
        }
      } else if (enemiesAlive === 0 && this.craft.length > 0){
        this.endBattle(true, 'All enemies destroyed');
      }
    } else if (type === 'survive'){
      if (this.time >= this.timeLimit){ this.endBattle(true, 'Survived'); }
      else if (enemiesAlive === 0 && this.cfg.enemies && this.cfg.enemies.length){ this.endBattle(true, 'All enemies destroyed'); }
    } else if (type === 'sink'){
      if (!enemyCarrierAlive){ this.endBattle(true, 'Enemy carrier sunk'); }
    } else if (type === 'escort'){
      if (friendlyCarrier && !friendlyCarrier.alive){ this.endBattle(false, 'Carrier was lost'); }
      else if (enemiesAlive === 0){ this.endBattle(true, 'Carrier escorted safely'); }
    }

    // generic timeout (non-survive)
    if (this.timeLimit && type !== 'survive' && this.time >= this.timeLimit){
      this.endBattle(enemiesAlive === 0, 'Time up');
    }
  }

  endBattle(win, reason){
    if (this.over) return;
    this.over = true;
    this.result.win = win;
    this.result.reason = reason;
    this.result.time = this.time;
    this.result.score += win ? 500 : 0;
    this.flashMsg(win ? 'MISSION COMPLETE' : 'MISSION FAILED', win ? 'good' : 'bad', 5);
    toast((win ? 'VICTORY — ' : 'DEFEAT — ') + reason, win ? 'good' : 'bad');
    if (document.pointerLockElement) document.exitPointerLock();
    // give the explosion/message a beat, then tear the battle down and hand back to
    // the caller. Without Battle.stop() the HUD overlay, input handlers and frame loop
    // linger on top of the hub — leaving the player stuck until a full refresh.
    const cb = this.cfg.onEnd;
    const res = { ...this.result };
    setTimeout(() => {
      if (this.net && this.net.close) try { this.net.close(); } catch (e) {}
      Battle.stop();                              // unbind input, hide HUD, stop frame loop, reset view
      if (typeof cb === 'function') cb(res);
    }, 2400);
  }

  // ---------------------------------------------------------------------
  //  NETPLAY (human vs human)
  // ---------------------------------------------------------------------
  sendFleet(){
    if (!this.net) return;
    // my fleet = player + allies, as export codes; team flag tells peer to mirror
    const fleet = [this.player.design, ...(this.cfg.allies || []).filter(Boolean)].map(d => exportCode(d));
    this.net.send({ t: 'fleet', fleet, name: this.player.name });
  }

  onNetMsg(msg){
    if (!msg) return;
    if (msg.t === 'fleet' && !this.netSpawned){
      this.spawnRemoteFleet(msg.fleet || []);
    } else if (msg.t === 'state'){
      this.netRemoteState = msg;     // {pos, quat, vel, throttle, t}
    } else if (msg.t === 'fire'){
      this.applyRemoteFire(msg);
    } else if (msg.t === 'bye'){
      this.endBattle(true, 'Opponent disconnected');
    }
  }

  spawnRemoteFleet(codes){
    if (this.netSpawned) return;
    this.netSpawned = true;
    codes.forEach((code, i) => {
      const d = importCode(code) || stockGet('stock_falcon');
      if (!d) return;
      // remote fleet faces us, mirrored to the far side of the map
      const pos = new THREE.Vector3((i % 2 ? 1 : -1) * (40 + i * 30), 360 + i * 20, 1800 + i * 60);
      const c = this.makeCraft(d, 1, pos, Math.PI, false);
      c.name = d.name || ('Enemy ' + (i + 1));
      if (i === 0){ c.isRemote = true; this.remote = c; }   // the human-controlled lead — NO AI
      else { c.isAI = true; initAI(c, 0.55); }              // the rest of their fleet flown by light AI
    });
    toast('Opponent fleet engaged', 'warn');
  }

  applyRemoteFire(msg){
    const c = this.remote; if (!c || !c.alive) return;
    // spawn the matching projectile from the remote craft toward msg.target/dir
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(c.group.quaternion);
    const muzzle = this.muzzle(c);
    if (msg.torpedo){
      // replicate as a real sea-running torpedo (not an air missile); spawnTorpedo picks its own
      // surface target on this peer's sim when handed target=null.
      this.spawnTorpedo(c, muzzle, fwd, { key: msg.w, dmg: msg.dmg, splash: msg.splash, turn: msg.turn,
        torpSpeed: msg.torpSpeed, runDepth: msg.runDepth, turretRange: msg.turretRange }, null);
      return;
    }
    if (msg.w === 'gun'){
      this.spawnBullet(c, muzzle, fwd, { dmg: msg.dmg || 14, speed: msg.speed || 1300, splash: 0, tracer: '#ff9a8a' });
      sfx('mg', 0.08);
    } else {
      // missile at nearest of our craft
      let tgt = null, bd = Infinity;
      for (const o of this.craft){ if (o.alive && o.team === 0){ const d = Math.hypot(o.pos.x - c.pos.x, o.pos.y - c.pos.y, o.pos.z - c.pos.z); if (d < bd){ bd = d; tgt = o; } } }
      this.spawnMissile(c, muzzle, fwd, { dmg: msg.dmg || 380, speed: msg.speed || 600, splash: msg.splash || 24, turn: msg.turn || 3, key: msg.w || 'ir' }, tgt);
      sfx('missile', 0.12);
    }
  }

  netSend(dt){
    if (!this.net || !this.player) return;
    this.netAccum += dt;
    if (this.netAccum < 0.05) return;     // ~20 Hz state stream
    this.netAccum = 0;
    const p = this.player;
    this.net.send({
      t: 'state',
      pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      quat: { x: p.group.quaternion.x, y: p.group.quaternion.y, z: p.group.quaternion.z, w: p.group.quaternion.w },
      vel: { x: p.vel.x, y: p.vel.y, z: p.vel.z },
      hp: p.hp / p.maxHp, alive: p.alive, time: this.time,
    });
    // flush queued fire events
    while (this.fireEvents.length){ this.net.send(this.fireEvents.shift()); }
  }

  netTick(dt){
    // interpolate the remote human craft toward last received transform
    const c = this.remote;
    if (!c || !c.alive) return;
    const st = this.netRemoteState;
    if (!st){ return; }
    const tp = TMP.set(st.pos.x, st.pos.y, st.pos.z);
    // dead-reckon with received velocity, then smooth toward it
    if (st.vel){ tp.addScaledVector(TMP2.set(st.vel.x, st.vel.y, st.vel.z), Math.min(0.12, this.time - (st._applied || 0))); }
    c.pos.lerp(tp, 1 - Math.exp(-10 * dt));
    if (st.quat){ QTMP.set(st.quat.x, st.quat.y, st.quat.z, st.quat.w); c.group.quaternion.slerp(QTMP, 1 - Math.exp(-10 * dt)); }
    if (st.vel) c.vel.set(st.vel.x, st.vel.y, st.vel.z);
    c.group.position.copy(c.pos);
    if (st.alive === false && c.alive){ this.killCraft(c, 'Shot down', this.player); }
  }

  // queue a fire event for net (called from player fire path)  — wired via wrap below
  queueNetFire(w){
    if (!this.net) return;
    this.fireEvents.push({ t: 'fire', w: w.type === 'gun' ? 'gun' : (w.key || 'ir'), dmg: w.dmg, speed: w.speed, splash: w.splash, turn: w.turn,
      torpedo: !!w.torpedo, torpSpeed: w.torpSpeed, runDepth: w.runDepth, turretRange: w.turretRange });
  }

  // ---------------------------------------------------------------------
  //  HUD RENDER (2D canvas overlay + DOM bars + radar + prediction)
  // ---------------------------------------------------------------------
  flashMsg(text, kind = '', secs = 1.2){
    if (!this.dom.msg) return;
    this.dom.msg.textContent = text;
    this.dom.msg.style.color = kind === 'bad' ? 'var(--bad)' : kind === 'good' ? 'var(--good)' : 'var(--warn)';
    this.dom.msg.classList.add('show');
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => this.dom.msg.classList.remove('show'), secs * 1000);
  }

  renderHUD(dt){
    const ctx = this.hudCtx; if (!ctx) return;
    const W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    const p = this.player;

    // ---- prediction guide (gun lead pipper / lock reticle) ----
    if (p && p.alive){
      const w = p.weapons[p.curWeapon];
      const shooterPos = p.pos;
      const ls = this.lockState;
      if (ls && ls.target){
        const tgtView = ls.target;      // {position,vel,alive,...,_src}
        const tgt = { position: tgtView.position, vel: tgtView.vel, aimY: tgtView.aimY || 0, alive: tgtView.alive };
        if (w && w.type === 'lockmissile'){
          drawLockReticle({ ctx, camera: this.camera, W, H, target: tgt, progress: ls.progress, flash: this.lock.flash, shooterPos });
        } else {
          drawPrediction({ ctx, camera: this.camera, W, H, shooterPos, target: tgt, weapon: w, progress: ls.progress, locked: ls.locked, assist: this.assistOn && w && w.type === 'gun' });
        }
        // ---- lock note + target distance banner (missile weapons) ----
        if (w && (w.type === 'missile' || w.type === 'radar' || w.type === 'lockmissile')){
          const tp = tgt.position;
          const rng = Math.round(Math.hypot(tp.x - shooterPos.x, tp.y - shooterPos.y, tp.z - shooterPos.z));
          const locked = ls.locked, pct = Math.round(ls.progress * 100);
          const txt = locked ? `◉ MISSILE LOCK  ·  ${rng} m` : `◎ LOCKING ${pct}%  ·  ${rng} m`;
          const col = locked ? '#ff3b3b' : '#ffce3b';
          ctx.save();
          ctx.font = 'bold 17px monospace'; ctx.textAlign = 'center';
          const bw = ctx.measureText(txt).width + 30, bx = W / 2, by = 64;
          ctx.globalAlpha = locked ? 0.55 + 0.45 * Math.abs(Math.sin(this.time * 6)) : 0.95;
          ctx.fillStyle = 'rgba(8,12,18,0.55)'; ctx.fillRect(bx - bw / 2, by - 17, bw, 29);
          ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.strokeRect(bx - bw / 2, by - 17, bw, 29);
          ctx.fillStyle = col; ctx.fillText(txt, bx, by + 3);
          ctx.restore();
        }
      }
      // centre crosshair
      ctx.save();
      ctx.strokeStyle = 'rgba(57,255,136,.8)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(W / 2 - 12, H / 2); ctx.lineTo(W / 2 - 4, H / 2);
      ctx.moveTo(W / 2 + 4, H / 2); ctx.lineTo(W / 2 + 12, H / 2);
      ctx.moveTo(W / 2, H / 2 - 12); ctx.lineTo(W / 2, H / 2 - 4);
      ctx.moveTo(W / 2, H / 2 + 4); ctx.lineTo(W / 2, H / 2 + 12);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(W / 2, H / 2, 2, 0, 7); ctx.stroke();
      ctx.restore();

      // ---- virtual control-stick + throttle (live input feedback) ----
      {
        const cx = W / 2, cy = H - 104, R = 34;
        ctx.save();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(120,150,180,.30)';
        ctx.strokeRect(cx - R, cy - R, R * 2, R * 2);
        ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
        const sx = cx + clamp(p.ctrlRoll, -1, 1) * R;
        const sy = cy - clamp(p.ctrlPitch, -1, 1) * R;      // up = nose-up demand
        ctx.strokeStyle = 'rgba(57,255,136,.5)';
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(sx, sy); ctx.stroke();
        ctx.fillStyle = p.stalled ? 'rgba(255,77,109,.95)' : 'rgba(57,255,136,.95)';
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.fill();
        // throttle column to the left
        const tx = cx - R - 14, th = R * 2;
        ctx.strokeStyle = 'rgba(120,150,180,.30)';
        ctx.strokeRect(tx - 5, cy - R, 10, th);
        const tfill = clamp(p.throttle, 0, 1) * th;
        ctx.fillStyle = p.boost ? 'rgba(255,154,61,.95)' : 'rgba(57,208,255,.85)';
        ctx.fillRect(tx - 5, cy + R - tfill, 10, tfill);
        ctx.restore();
      }

      // off-screen / on-screen enemy markers (small boxes)
      ctx.save();
      ctx.lineWidth = 1.2;
      for (const o of this.craft){
        if (!o.alive || o.team === p.team) continue;
        const sc = this.project(o.pos);
        if (sc && sc.front){
          ctx.strokeStyle = 'rgba(255,77,109,.7)';
          ctx.strokeRect(sc.x - 10, sc.y - 10, 20, 20);
        }
      }
      ctx.restore();
    }

    // ---- DOM bars ----
    if (p){
      const hp = clamp(p.hp / p.maxHp, 0, 1);
      this.dom.hp.style.width = (hp * 100) + '%';
      this.dom.hpv.textContent = Math.max(0, Math.round(p.hp)) + ' HP' + (p.armor ? ' /' + Math.round(p.armor) + 'A' : '');
      const fuel = clamp(p.fuel / p.maxFuel, 0, 1);
      this.dom.fuel.style.width = (fuel * 100) + '%';
      this.dom.fuelv.textContent = Math.round(fuel * 100) + '%';
      // boost = fuel headroom-ish; show as available while fuel remains
      this.dom.boost.style.width = (p.boost ? 100 : (p.fuel > 0 ? 60 : 0)) + '%';
      this.dom.boostv.textContent = p.boost ? 'ON' : (p.fuel > 0 ? 'RDY' : '—');
      const heat = clamp((p.temp - AMBIENT_TEMP) / (p.stats.overheat - AMBIENT_TEMP), 0, 1);
      this.dom.heat.style.width = (heat * 100) + '%';
      this.dom.heatv.textContent = Math.round(p.temp) + '°C';
      // weapon + ammo
      const w = p.weapons[p.curWeapon];
      if (w){
        const ammoTxt = w.reloading > 0 ? 'RELOAD…' : (w.ammo + (w.reserve ? '+' + w.reserve : ''));
        this.dom.weapon.textContent = `▸ ${w.name}  [${ammoTxt}]  (${p.curWeapon + 1}/${p.weapons.length})  ✦${p.flares}`;
      } else this.dom.weapon.textContent = 'NO WEAPONS';
      // speed / alt / throttle
      const kmh = Math.round(p.speed * 3.6);
      const alt = Math.round(p.pos.y - this.groundY);
      this.dom.spd.textContent = `SPD ${kmh} km/h`;
      this.dom.alt.textContent = `ALT ${alt} m`;
      this.dom.thr.textContent = `THR ${Math.round(p.throttle * 100)}%${p.boost ? ' +AB' : ''}${p.engineOn ? '' : ' ⏻OFF'}${p.airbrakeOn ? ' ✖BRAKE' : ''}`;
      this.dom.mach.textContent = p.stalled ? 'STALL' : (kmh > 1100 ? 'SUPERSONIC' : '');
      this.dom.mach.className = 'v-mach' + (p.stalled ? ' hud-warn-tone' : '');

      // warnings
      if (p.stalled) this.flashMsgLow('STALL — LOWER NOSE / ADD POWER');
      else if (p.temp > p.stats.overheat * 0.95) this.flashMsgLow('OVERHEAT');
      else if (p.fuel <= 0) this.flashMsgLow('NO FUEL');
    }

    // ---- objective sub line ----
    if (this.dom.objsub){
      const enemiesAlive = this.craft.filter(c => c.alive && c.team !== 0).length;
      let sub = '';
      if (this.objective.type === 'survive'){ sub = `Survive ${Math.max(0, Math.ceil(this.timeLimit - this.time))}s · Bandits ${enemiesAlive}`; }
      else if (this.objective.type === 'sink'){ const cc = this.carriers.find(c => c.team === 1); sub = cc ? `Carrier HP ${Math.max(0, Math.round(cc.hp))}` : 'Carrier sunk'; }
      else if (this.objective.type === 'escort'){ const cc = this.carriers.find(c => c.team === 0); sub = cc && cc.alive ? `Carrier HP ${Math.max(0, Math.round(cc.hp))} · Bandits ${enemiesAlive}` : 'Carrier lost'; }
      else { sub = `Bandits remaining: ${enemiesAlive} · Kills ${this.result.kills}`; }
      this.dom.objsub.textContent = sub;
    }

    // ---- radar ----
    this.renderRadar();
  }

  flashMsgLow(text){
    // low-priority warning that only shows if nothing more urgent is up
    if (this.dom.msg && !this.dom.msg.classList.contains('show')) this.flashMsg(text, 'warn', 0.6);
  }

  project(v){
    TMP.copy(v).project(this.camera);
    if (TMP.z > 1) return { x: 0, y: 0, front: false };
    return { x: (TMP.x * 0.5 + 0.5) * this.W, y: (-TMP.y * 0.5 + 0.5) * this.H, front: true };
  }

  renderRadar(){
    const ctx = this.radarCtx; if (!ctx) return;
    const S = 180, R = S / 2, scale = R / 3200;
    ctx.clearRect(0, 0, S, S);
    const p = this.player; if (!p) return;
    // rings
    ctx.strokeStyle = 'rgba(57,208,255,.25)'; ctx.lineWidth = 1;
    for (let r = 1; r <= 3; r++){ ctx.beginPath(); ctx.arc(R, R, R * r / 3, 0, 7); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(R, 0); ctx.lineTo(R, S); ctx.moveTo(0, R); ctx.lineTo(S, R); ctx.stroke();
    // orient radar to player's heading (forward = up)
    const yaw = Math.atan2(
      new THREE.Vector3(0, 0, 1).applyQuaternion(p.group.quaternion).x,
      new THREE.Vector3(0, 0, 1).applyQuaternion(p.group.quaternion).z
    );
    const cos = Math.cos(-yaw), sin = Math.sin(-yaw);
    const blip = (o, color, size) => {
      let dx = o.pos.x - p.pos.x, dz = o.pos.z - p.pos.z;
      const rx = dx * cos - dz * sin, rz = dx * sin + dz * cos;
      const x = R + rx * scale, y = R - rz * scale;
      if (Math.hypot(x - R, y - R) > R) return;
      ctx.fillStyle = color;
      ctx.fillRect(x - size, y - size, size * 2, size * 2);
    };
    for (const o of this.craft){
      if (!o.alive || o === p) continue;
      blip(o, o.team === p.team ? '#39ff88' : '#ff4d6d', 2);
    }
    for (const cc of this.carriers){ if (cc.alive) blip(cc, cc.team === p.team ? '#39d0ff' : '#ff8844', 3.4); }
    // player at centre
    ctx.fillStyle = '#fff'; ctx.beginPath();
    ctx.moveTo(R, R - 5); ctx.lineTo(R - 4, R + 4); ctx.lineTo(R + 4, R + 4); ctx.closePath(); ctx.fill();
  }

  // ---------------------------------------------------------------------
  //  TEARDOWN
  // ---------------------------------------------------------------------
  teardown(){
    if (this.unsubFrame) this.unsubFrame();
    setVRMode('menu');            // detach the VR cockpit rig
    this.unbindInput();
    clearTimeout(this._msgT);
    clearTimeout(this._helpT1); clearTimeout(this._helpT2);   // don't leak the controls-legend timers on fast restart
    // dispose scene contents (but keep the cross-battle shared geometry cache)
    const shared = new Set([Sim.bulletGeom, Sim.trailGeom, Sim.missileGeom, Sim.missileNoseGeom, Sim.missileFinGeom, Sim.flameGeom, Sim.bombGeom, Sim.bombNoseGeom, Sim.bombFinGeom, Sim.boomGeom, Sim.flareGeom2, Sim.torpedoGeom, Sim.torpedoNoseGeom, Sim.wakeGeom].filter(Boolean));
    if (this.scene){
      this.scene.traverse(o => {
        if (o.geometry && o.geometry.dispose && !shared.has(o.geometry)) o.geometry.dispose();
        if (o.material){
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          // material.dispose() does NOT free the material's textures — dispose those too,
          // or every battle leaks them (the sky/HUD/any mapped material).
          mats.forEach(m => { if (!m) return; for (const k in m){ const v = m[k]; if (v && v.isTexture) v.dispose(); } m.dispose && m.dispose(); });
        }
        // a DirectionalLight's 2048² shadow map is a GPU render target the scene drop never
        // frees — dispose it or every battle leaks a ~16 MB depth texture (the #1 leak).
        if (o.isLight && o.shadow && o.shadow.map){ o.shadow.map.dispose(); o.shadow.map = null; }
      });
    }
    // per-battle torpedo materials (shared across all torpedoes; may have no live mesh at teardown)
    if (this.torpedoMat){ this.torpedoMat.dispose(); this.torpedoMat = null; }
    if (this.wakeMat){ this.wakeMat.dispose(); this.wakeMat = null; }
    this.bullets.length = 0; this.missiles.length = 0; this.torpedoes.length = 0; this.flares.length = 0; this.fx.length = 0;
    this.craft.length = 0; this.carriers.length = 0;
    resetView();
    if (this.hud){
      hide(this.hud);
      Array.from(this.hud.children).forEach(ch => { if (ch.id !== 'hud-canvas') ch.remove(); });
      if (this.hudCtx) this.hudCtx.clearRect(0, 0, this.hudCanvas.width, this.hudCanvas.height);
    }
  }
}

// ---------------------------------------------------------------------------
//  geometry / math helpers
// ---------------------------------------------------------------------------
// distance from point P to segment AB (all Vector3-like with x/y/z)
function distSegPoint(a, b, p){
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz || 1;
  let t = (apx * abx + apy * aby + apz * abz) / ab2;
  t = clamp(t, 0, 1);
  const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz);
}

function objectiveLabel(obj){
  if (!obj) return 'Engage';
  if (obj.label) return obj.label;
  switch (obj.type){
    case 'deathmatch': return 'DESTROY ALL ENEMIES';
    case 'survive': return 'SURVIVE THE ONSLAUGHT';
    case 'sink': return 'SINK THE ENEMY CARRIER';
    case 'escort': return 'ESCORT THE CARRIER';
    case 'pvp': return 'PVP — DESTROY THE ENEMY FLEET';
    default: return 'ENGAGE';
  }
}

// ---------------------------------------------------------------------------
//  Hook the player fire paths into the net so fire events propagate. We wrap
//  fireWeapon so any local player shot is mirrored to the peer.
// ---------------------------------------------------------------------------
const _origFire = Sim.prototype.fireWeapon;
Sim.prototype.fireWeapon = function(c, w, idx){
  _origFire.call(this, c, w, idx);
  if (this.net && c === this.player) this.queueNetFire(w);
};

// ============================================================================
//  Ace of Sky II — parts.js
//  The part catalogue (KSP-style toolbox) + weapons table + 3D mesh builders.
//  Forward (nose) = +Z. Engines exhaust toward -Z, guns/missiles fire toward +Z.
//  Each def carries the physical properties read by physics.computeStats().
//  build(THREE) returns an Object3D sized in metres, centred on its origin;
//  placement (grid position + quarter-turn rotation) is applied by the caller.
// ============================================================================
import { GRID } from './physics.js';   // NOTE: physics.js does not import builders, only PARTS/WEAPONS — no cycle at call time

// ---- material/colour palette ----------------------------------------------
export const CAT_COLORS = {
  command: '#5fd0ff', structure: '#9aa6b2', aero: '#7fb0d0', fuel: '#e0a14a', engine: '#ff6b3d',
  thruster: '#ff9a3d', wing: '#cfd8e3', control: '#a6dcef', gear: '#8a8f96', coupling: '#c0843a',
  power: '#ffd24d', armor: '#6f7a86', gun: '#ffe14d', missile: '#ff4d6d', bomb: '#b06bff', utility: '#4dffa0',
};

// small mesh DSL ------------------------------------------------------------
function mat(THREE, color, opts = {}){
  return new THREE.MeshStandardMaterial({
    color, metalness: opts.metal ?? 0.55, roughness: opts.rough ?? 0.5,
    emissive: opts.emissive || 0x000000, emissiveIntensity: opts.ei || 1,
    transparent: opts.transparent || false, opacity: opts.opacity ?? 1,
  });
}
function box(THREE, w, h, l, color, opts){ const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat(THREE, color, opts)); return m; }
// rounder default geometry (22 sides) so cylinders/cones read as smooth metal
function cyl(THREE, rt, rb, h, color, opts){ return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, opts?.seg || 22, 1, opts?.open || false), mat(THREE, color, opts)); }
function cylZ(THREE, rt, rb, h, color, opts){ const m = cyl(THREE, rt, rb, h, color, opts); m.rotation.x = Math.PI / 2; return m; }
function cone(THREE, r, h, color, opts){ return new THREE.Mesh(new THREE.ConeGeometry(r, h, opts?.seg || 22), mat(THREE, color, opts)); }
// a torus banding ring around the Z axis — tank bands, engine collars, intake lips
function ringZ(THREE, r, tube, color, opts){ const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, opts?.seg || 24), mat(THREE, color, opts)); return m; }
// a hemispherical end cap facing +Z (set scaleZ negative side via rotation)
function capZ(THREE, r, color, opts, back){ const m = new THREE.Mesh(new THREE.SphereGeometry(r, opts?.seg || 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(THREE, color, opts)); m.rotation.x = back ? Math.PI / 2 : -Math.PI / 2; return m; }
// an engine nozzle bell (frustum flaring rearward) with a dark scorched interior
// a CURVED (parabolic) rocket-nozzle bell via lathe: narrow throat forward (+Z),
// flaring exit aft (-Z), with a dark scorched interior. The curved flare is what
// makes an engine read as real propulsion hardware rather than a plain cone.
function bell(THREE, rThroat, rExit, h, color, opts){
  const g = new THREE.Group(); const N = 12, prof = [], iprof = [];
  for (let i = 0; i <= N; i++){ const t = i / N, r = rThroat + (rExit - rThroat) * Math.pow(t, 1.85), y = h * 0.5 - t * h;
    prof.push(new THREE.Vector2(Math.max(0.001, r), y)); iprof.push(new THREE.Vector2(Math.max(0.001, r * 0.9), y)); }
  const seg = opts?.seg || 28;
  const outer = new THREE.Mesh(new THREE.LatheGeometry(prof, seg), mat(THREE, color, { metal: 0.85, rough: 0.4 })); outer.rotation.x = Math.PI / 2; outer.material.side = THREE.DoubleSide; g.add(outer);
  const inner = new THREE.Mesh(new THREE.LatheGeometry(iprof, seg), mat(THREE, '#180b05', { metal: 0.5, rough: 0.7, emissive: opts?.hot || 0x140802, ei: 1 })); inner.rotation.x = Math.PI / 2; inner.material.side = THREE.BackSide; g.add(inner);
  // throat cap — LatheGeometry leaves both ends open, so the narrow forward throat
  // is a hole you can see straight through. Seal it with a small emissive disc.
  const cap = new THREE.Mesh(new THREE.CircleGeometry(Math.max(0.02, rThroat * 0.96), seg), mat(THREE, '#180b05', { metal: 0.4, rough: 0.7, emissive: opts?.hot || 0x140802, ei: 1 }));
  cap.material.side = THREE.DoubleSide; cap.position.z = h * 0.5; g.add(cap);
  return g;
}
// exhaust glow disc placed at the nozzle exit
function glowZ(THREE, r, color, ei){ const m = new THREE.Mesh(new THREE.CircleGeometry(r, 18), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: ei || 2.4, side: THREE.DoubleSide })); m.rotation.y = Math.PI; return m; }

// dims in metres derived from grid size
const D = (s) => [s[0] * GRID, s[1] * GRID, s[2] * GRID];

// ---- WEAPONS (shared by parts, hangar readout and the battle sim) ----------
//  type/speed/lockTime are consumed by prediction.js exactly as in Gravity Front.
export const WEAPONS = {
  mg:          { key: 'mg',          name: 'Machine Gun',    type: 'gun',         dmg: 14,  rof: 14,  speed: 1400, clip: 1200, reload: 3, spread: 0.012, splash: 0,  heatPerShot: 60,  tracer: '#fff2a8' },
  cannon:      { key: 'cannon',      name: 'Auto-Cannon',    type: 'gun',         dmg: 90,  rof: 4,   speed: 1100, clip: 200,  reload: 4, spread: 0.004, splash: 6,  heatPerShot: 380, tracer: '#ffd24d' },
  gatling:     { key: 'gatling',     name: 'Gatling Cannon', type: 'gun',         dmg: 20,  rof: 30,  speed: 1300, clip: 2000, reload: 5, spread: 0.02,  splash: 0,  heatPerShot: 110, tracer: '#fff' },
  ir:          { key: 'ir',          name: 'IR Missile',     type: 'missile',     dmg: 380, rof: 0.5, speed: 600,  clip: 2,    reload: 6, spread: 0,     splash: 24, lockTime: 1.2, turn: 3.0 },
  radar:       { key: 'radar',       name: 'Radar Missile',  type: 'missile',     dmg: 520, rof: 0.4, speed: 800,  clip: 2,    reload: 7, spread: 0,     splash: 28, lockTime: 2.2, turn: 2.4, needsSensor: true },
  lockmissile: { key: 'lockmissile', name: 'Lock-On Missile',type: 'lockmissile', dmg: 560, rof: 0.7, speed: 720,  clip: 4,    reload: 5, spread: 0,     splash: 20, lockTime: 3.0, turn: 4.0 },
  bomb:        { key: 'bomb',        name: 'Iron Bomb',      type: 'bomb',        dmg: 900, rof: 0.5, speed: 0,    clip: 2,    reload: 5, spread: 0,     splash: 50 },
  bombheavy:   { key: 'bombheavy',   name: 'Heavy Bomb',     type: 'bomb',        dmg: 2200,rof: 0.3, speed: 0,    clip: 1,    reload: 8, spread: 0,     splash: 90 },
  rocketpod:   { key: 'rocketpod',   name: 'Rocket Salvo',   type: 'gun',         dmg: 55,  rof: 6,   speed: 520,  clip: 28,   reload: 5, spread: 0.02,  splash: 16, heatPerShot: 160, tracer: '#ffae5a' },
  aamheavy:    { key: 'aamheavy',    name: 'Heavy AAM',      type: 'missile',     dmg: 650, rof: 0.4, speed: 940,  clip: 2,    reload: 7, spread: 0,     splash: 32, lockTime: 1.8, turn: 2.6 },
  clusterbomb: { key: 'clusterbomb', name: 'Cluster Bomb',   type: 'bomb',        dmg: 1400,rof: 0.4, speed: 0,    clip: 2,    reload: 6, spread: 0,     splash: 78 },
  heavymg:     { key: 'heavymg',     name: 'Heavy MG',       type: 'gun',         dmg: 28,  rof: 11,  speed: 1350, clip: 800,  reload: 4, spread: 0.013, splash: 0,  heatPerShot: 90,  tracer: '#ffd58a' },
  lightcannon: { key: 'lightcannon', name: 'Light Cannon',   type: 'gun',         dmg: 55,  rof: 6,   speed: 1150, clip: 350,  reload: 3.5,spread: 0.006, splash: 5,  heatPerShot: 200, tracer: '#ffdf7a' },
  revolver:    { key: 'revolver',    name: 'Revolver Cannon',type: 'gun',         dmg: 140, rof: 2.5, speed: 1050, clip: 120,  reload: 4.5,spread: 0.004, splash: 8,  heatPerShot: 520, tracer: '#ffd24d' },
  sraam:       { key: 'sraam',       name: 'Short-Range AAM',type: 'missile',     dmg: 320, rof: 0.6, speed: 700,  clip: 2,    reload: 5, spread: 0,     splash: 22, lockTime: 0.9, turn: 4.2 },
  lraam:       { key: 'lraam',       name: 'Long-Range AAM', type: 'radar',       dmg: 600, rof: 0.3, speed: 1000, clip: 2,    reload: 8, spread: 0,     splash: 30, lockTime: 2.6, turn: 2.2, needsSensor: true },
  antiship:    { key: 'antiship',    name: 'Anti-Ship Missile',type: 'lockmissile',dmg:1400, rof: 0.4, speed: 600,  clip: 2,    reload: 8, spread: 0,     splash: 60, lockTime: 3.0, turn: 1.6 },
  guidedbomb:  { key: 'guidedbomb',  name: 'Guided Bomb',    type: 'bomb',        dmg: 1100,rof: 0.4, speed: 0,    clip: 1,    reload: 6, spread: 0,     splash: 55 },
  napalm:      { key: 'napalm',      name: 'Incendiary Bomb',type: 'bomb',        dmg: 700, rof: 0.5, speed: 0,    clip: 2,    reload: 5, spread: 0,     splash: 110 },
  torpedo:     { key: 'torpedo',     name: 'Aerial Torpedo', type: 'missile',     dmg: 1600,rof: 0.3, speed: 450,  clip: 1,    reload: 9, spread: 0,     splash: 50, lockTime: 2.0, turn: 1.2, torpedo: true, torpSpeed: 3000, runDepth: 0.15 },
  // ---- new arsenal (parts added below; types reuse the sim-handled set) ----
  minigun:     { key: 'minigun',     name: 'Light Minigun',  type: 'gun',         dmg: 13,  rof: 34,  speed: 1250, clip: 2400, reload: 4,  spread: 0.026, splash: 0,  heatPerShot: 70,   tracer: '#fff6c8' },
  flak:        { key: 'flak',        name: 'Flak Cannon',    type: 'gun',         dmg: 80,  rof: 3,   speed: 820,  clip: 150,  reload: 4.5,spread: 0.012, splash: 26, heatPerShot: 300,  tracer: '#ffd58a' },
  railgun:     { key: 'railgun',     name: 'Railgun',        type: 'gun',         dmg: 300, rof: 1,   speed: 2800, clip: 40,   reload: 6,  spread: 0.0015,splash: 5,  heatPerShot: 1300, tracer: '#bfe6ff' },
  cruise:      { key: 'cruise',      name: 'Cruise Missile', type: 'lockmissile', dmg: 1300,rof: 0.25,speed: 480,  clip: 1,    reload: 10, spread: 0,     splash: 70, lockTime: 3.5, turn: 1.0 },
  // ---- heavy warship batteries (gun-type so carriers auto-fire them; big & slow) ----
  ciws:         { key: 'ciws',         name: 'CIWS Phalanx',        type: 'gun', dmg: 15,  rof: 38,  speed: 1300, clip: 1500, reload: 4,  spread: 0.02,   splash: 3,  heatPerShot: 70,   tracer: '#ffeebb' },
  navalcannon:  { key: 'navalcannon',  name: 'Naval Cannon',        type: 'gun', dmg: 240, rof: 1.5, speed: 950,  clip: 90,   reload: 6,  spread: 0.004,  splash: 36, heatPerShot: 900,  tracer: '#ffd24d' },
  navalheavy:   { key: 'navalheavy',   name: 'Twin Naval Turret',   type: 'gun', dmg: 330, rof: 1.0, speed: 1000, clip: 70,   reload: 7,  spread: 0.004,  splash: 48, heatPerShot: 1300, tracer: '#ffcf66' },
  battleshipgun:{ key: 'battleshipgun',name: 'Battleship Main Gun', type: 'gun', dmg: 720, rof: 0.45,speed: 1050, clip: 24,   reload: 9,  spread: 0.0025, splash: 95, heatPerShot: 2800, tracer: '#ffe08a' },
  // ---- ship torpedoes: type 'missile' + `torpedo` flag → a slow wake-homing run ALONG the sea
  //      surface vs surface vessels (deck tubes auto-launch; the aircraft 'torpedo' above shares it)
  shiptorpedo:  { key: 'shiptorpedo',  name: 'Heavy Torpedo',       type: 'missile', dmg: 2600, rof: 0.2, speed: 92,  clip: 4,    reload: 16, spread: 0,      splash: 110,lockTime: 0,  turn: 0.8, torpedo: true, torpSpeed: 2600, runDepth: 0.2 },
};

// ---- PART CATALOGUE --------------------------------------------------------
const LIST = [
  // ---------------- COMMAND ----------------
  { key: 'cockpit_light', name: 'Light Cockpit', category: 'command', size: [1, 1, 2], mass: 280, cost: 600, hp: 70, crew: 1, ctrlPitch: 2, ctrlYaw: 1, drag: 0.12,
    desc: 'Single-seat command pod. Required — no aircraft flies without crew.',
    build: (T, d) => buildCockpit(T, d, {}) },
  { key: 'cockpit_heavy', name: 'Armored Cockpit', category: 'command', size: [1, 1, 2], mass: 540, cost: 1200, hp: 150, armor: 50, crew: 1, ctrlPitch: 2, drag: 0.14,
    desc: 'Heavily armored command pod. Survives hits a light canopy never would.',
    build: (T, d) => buildCockpit(T, d, { color: '#7a8794', metal: 0.72, glass: '#9fd8ff', style: 'heavy' }) },
  { key: 'cockpit_mk3', name: 'Mk3 Bomber Cockpit', category: 'command', size: [1, 1, 2], mass: 560, cost: 1400, hp: 175, armor: 35, crew: 2, ctrlPitch: 1, ctrlYaw: 1, drag: 0.13,
    desc: 'Wide multi-pane bomber cockpit — a glazed crew station with a BLUNT face (no nose). Bolt a nose cone ahead of it.',
    build: (T, d) => buildCockpit(T, d, { color: '#aab3bd', metal: 0.6, style: 'mk3' }) },

  // ---------------- STRUCTURE ----------------
  { key: 'nose_cone', name: 'Nose Cone', category: 'structure', size: [1, 1, 1], mass: 60, cost: 90, hp: 30, drag: -0.12,
    desc: 'Streamlined nose. Cuts drag — put it at the very front.',
    build: (T, d) => { const s = D(d.size); const c = cone(T, s[0] * 0.45, s[2], CAT_COLORS.structure, { metal: 0.5 }); c.rotation.x = Math.PI / 2; return c; } },
  { key: 'fuselage_s', name: 'Fuselage', category: 'structure', size: [1, 1, 2], mass: 120, cost: 120, hp: 60, fuel: 90, drag: 0.12,
    desc: 'Structural body section. Holds a little fuel and ties parts together.',
    build: (T, d) => { const s = D(d.size); return cylZ(T, s[1] * 0.45, s[1] * 0.45, s[2], CAT_COLORS.structure, { metal: 0.6 }); } },
  { key: 'fuselage_l', name: 'Long Fuselage', category: 'structure', size: [1, 1, 3], mass: 210, cost: 210, hp: 110, fuel: 160, drag: 0.16,
    desc: 'Long structural spine. More integral fuel and hardpoint room.',
    build: (T, d) => { const s = D(d.size); return cylZ(T, s[1] * 0.46, s[1] * 0.46, s[2], CAT_COLORS.structure, { metal: 0.6 }); } },
  { key: 'tailboom', name: 'Tail Boom', category: 'structure', size: [1, 1, 2], mass: 55, cost: 110, hp: 50, drag: 0.06,
    desc: 'Thin boom to carry tail surfaces aft of the wing.',
    build: (T, d) => { const s = D(d.size); return cylZ(T, s[1] * 0.25, s[1] * 0.3, s[2], CAT_COLORS.structure, { metal: 0.6 }); } },

  // ---------------- FUEL ----------------
  { key: 'fuel_small', name: 'Fuel Tank', category: 'fuel', size: [1, 1, 2], mass: 40, cost: 160, hp: 40, fuel: 320, drag: 0.1,
    desc: '300 kg internal fuel. Bread-and-butter endurance.',
    build: (T, d) => buildTank(T, d, {}) },
  { key: 'fuel_large', name: 'Large Fuel Tank', category: 'fuel', size: [1, 1, 3], mass: 62, cost: 380, hp: 62, fuel: 500, drag: 0.14,
    desc: '800 kg internal fuel for long-range patrol or thirsty rockets.',
    build: (T, d) => buildTank(T, d, {}) },
  { key: 'fuel_drop', name: 'Drop Tank', category: 'fuel', size: [1, 1, 2], mass: 60, cost: 200, hp: 18, fuel: 280, drag: 0.32, jettison: true,
    desc: 'External 500 kg tank. Cheap range but draggy — jettisonable in flight.',
    build: (T, d) => { const s = D(d.size); const g = new T.Group(); const b = cylZ(T, s[1] * 0.4, s[1] * 0.4, s[2] * 0.8, CAT_COLORS.fuel, { metal: 0.5 }); g.add(b);
      const n = cone(T, s[1] * 0.4, s[2] * 0.3, CAT_COLORS.fuel); n.rotation.x = Math.PI / 2; n.position.z = s[2] * 0.5; g.add(n); return g; } },

  // ---------------- ENGINES ----------------
  { key: 'jet_basic', name: 'J-33 "Wheesley" Turbofan', category: 'engine', size: [1, 1, 1], mass: 1500, cost: 1400, hp: 50, thrust: 120000, burn: 1.0, heatGen: 120000, drag: 0.08,
    desc: '120 kN non-afterburning turbofan (TWR 8.16). The reliable bread-and-butter jet — strong cruise thrust, no reheat.',
    build: (T, d) => buildJet(T, d, {}) },
  { key: 'turbofan', name: 'J-90 "Goliath" Turbofan', category: 'engine', size: [2, 2, 2], mass: 4500, cost: 2600, hp: 110, thrust: 360000, burn: 2.4, heatGen: 260000, drag: 0.14,
    desc: '360 kN high-bypass radial turbofan — the biggest subsonic thrust there is. Huge fan, huge intake, huge pull.',
    build: (T, d) => { const g = buildJet(T, d, { glow: '#cfe6ff' }); const s = D(d.size); const R = Math.min(s[0], s[1]) * 0.46;
      const cowl = ringZ(T, R * 1.12, 0.05, '#2a2f35', { metal: 0.7 }); cowl.position.z = s[2] * 0.44; g.add(cowl);
      const fan2 = cylZ(T, R * 0.9, R * 0.9, 0.02, '#2c343d', { metal: 0.9, rough: 0.3 }); fan2.position.z = s[2] * 0.47; g.add(fan2); return g; } },
  { key: 'rocket', name: 'Liquid-Fuel Rocket', category: 'engine', size: [1, 1, 2], mass: 850, cost: 1400, hp: 40, thrust: 160000, burn: 7.0, heatGen: 320000, drag: 0.08,
    desc: '160 kN liquid-fuel booster. Big sea-level thrust for a heavy main stage — drinks fuel, no afterburner needed.',
    build: (T, d) => buildRocket(T, d, {}) },

  // ---------------- THRUSTERS / BOOST ----------------
  { key: 'afterburner_pod', name: 'Booster Pod', category: 'thruster', size: [1, 1, 1], mass: 250, cost: 760, hp: 30, boostThrust: 40000, boostBurn: 3.5, heatGen: 90000, drag: 0.06,
    desc: 'Bolt-on radial booster — 40 kN of on-demand boost thrust. Spends fuel fast while held.',
    build: (T, d) => a_nozzle(T, d, {}) },
  { key: 'rcs', name: 'RCS Thrusters', category: 'thruster', size: [1, 1, 1], mass: 30, cost: 200, hp: 15, ctrlYaw: 4, ctrlRoll: 4, ctrlPitch: 2, drag: 0.02,
    desc: 'Reaction-control jets. Adds nimbleness in all axes.',
    build: (T, d) => a_rcs(T, d, {}) },
  { key: 'vector_nozzle', name: 'Thrust Vectoring', category: 'thruster', size: [1, 1, 1], mass: 90, cost: 900, hp: 25, ctrlPitch: 9, ctrlYaw: 6, drag: 0.03,
    desc: 'Vectored nozzle gimbal. Big boost to pitch/yaw authority.',
    build: (T, d) => a_nozzle(T, d, {}) },

  // ---------------- WINGS / CONTROL ----------------
  { key: 'wing_main', name: 'Main Wing', category: 'wing', size: [3, 1, 2], mass: 160, cost: 400, hp: 50, lift: 2, ctrlRoll: 3, drag: 0.14,
    desc: 'Primary lifting surface. The bigger the wing, the lower the stall speed.',
    build: (T, d) => a_wing(T, d, { taper: 0.7 }) },
  { key: 'wing_delta', name: 'Delta Wing', category: 'wing', size: [4, 1, 3], mass: 200, cost: 600, hp: 60, lift: 2, ctrlRoll: 3, ctrlPitch: 2, drag: 0.18,
    desc: 'Large delta — high lift and some pitch authority, more drag.',
    build: (T, d) => a_wing(T, d, { taper: 0.18, sweep: 0.62, thick: 0.1 }) },
  { key: 'canard', name: 'Canard', category: 'wing', size: [2, 1, 1], mass: 60, cost: 220, hp: 25, lift: 5, ctrlPitch: 10, drag: 0.05,
    desc: 'Forward control surface. Strong nose authority, mount ahead of the wing.',
    build: (T, d) => a_wing(T, d, { taper: 0.5 }) },
  { key: 'tail_h', name: 'Horizontal Stab', category: 'wing', size: [2, 1, 1], mass: 100, cost: 720, hp: 25, lift: 0.5, ctrlPitch: 6, drag: 0.05,
    desc: 'Tailplane. Pitch stability + control — mount aft.',
    build: (T, d) => a_wing(T, d, { taper: 0.5 }) },
  { key: 'tail_v', name: 'Vertical Stab', category: 'wing', size: [1, 2, 1], mass: 125, cost: 600, hp: 25, lift: 0.61, ctrlYaw: 7, drag: 0.05,
    desc: 'Fin/rudder. Yaw stability + control — mount aft and up.',
    build: (T, d) => a_finV(T, d, {}) },
  { key: 'winglet', name: 'Winglet', category: 'wing', size: [1, 1, 1], mass: 37, cost: 500, hp: 15, lift: 0.37, ctrlRoll: 3, drag: 0.03,
    desc: 'Small tip surface. A little extra lift and roll.',
    build: (T, d) => a_winglet(T, d, {}) },

  // ---------------- ARMOR ----------------
  { key: 'armor_plate', name: 'Heavy Armor', category: 'armor', size: [1, 1, 1], mass: 240, cost: 300, hp: 40, armor: 120,
    desc: '+120 HP of ablative plating. Heavy — protects but costs speed and agility.',
    build: (T, d) => a_armor(T, d, {}) },
  { key: 'armor_light', name: 'Light Armor', category: 'armor', size: [1, 1, 1], mass: 90, cost: 140, hp: 20, armor: 50,
    desc: '+50 HP ablative composite. Cheap survivability with less mass penalty.',
    build: (T, d) => a_armor(T, d, { color: '#7d7060' }) },

  // ---------------- GUNS ----------------
  { key: 'gun_mg', name: 'Machine Gun', category: 'gun', size: [1, 1, 2], mass: 80, cost: 300, hp: 20, weapon: 'mg', ammo: 1200, heatGen: 20000, drag: 0.04,
    desc: 'Rapid 14-dmg rounds. High rate of fire, low per-hit damage.',
    build: (T, d) => buildGun(T, d, 0.06) },
  { key: 'gun_cannon', name: 'Auto-Cannon', category: 'gun', size: [1, 1, 2], mass: 180, cost: 700, hp: 25, weapon: 'cannon', ammo: 200, heatGen: 30000, drag: 0.05,
    desc: 'Hard-hitting 90-dmg shells with small splash. Slower fire.',
    build: (T, d) => buildGun(T, d, 0.1) },
  { key: 'gun_gatling', name: 'Gatling Cannon', category: 'gun', size: [1, 1, 3], mass: 260, cost: 1200, hp: 30, weapon: 'gatling', ammo: 2000, heatGen: 60000, drag: 0.06,
    desc: 'Six-barrel storm of fire. Shreds targets but runs hot and heavy.',
    build: (T, d) => buildGatling(T, d, { barrels: 6 }) },

  // ---------------- MISSILES ----------------
  { key: 'missile_ir', name: 'IR Missile Rack', category: 'missile', size: [1, 1, 2], mass: 160, cost: 600, hp: 15, weapon: 'ir', ammo: 2, drag: 0.18,
    desc: 'Heat-seekers. Short lock time, decent damage, can be flared.',
    build: (T, d) => buildMissile(T, d, '#ff4d6d', 2) },
  { key: 'missile_radar', name: 'Radar Missile Rack', category: 'missile', size: [1, 1, 2], mass: 220, cost: 1100, hp: 15, weapon: 'radar', ammo: 2, drag: 0.22,
    desc: 'Long-range radar homing. Needs a radar sensor part to guide.',
    build: (T, d) => buildMissile(T, d, '#ff7d4d', 2, { seeker: 'radar' }) },
  { key: 'missile_lock', name: 'Lock-On Pod', category: 'missile', size: [1, 1, 2], mass: 240, cost: 900, hp: 15, weapon: 'lockmissile', ammo: 4, drag: 0.2,
    desc: 'Movie-style 3s full lock then auto-fires a hard-turning homer (ported from Gravity Front).',
    build: (T, d) => buildMissile(T, d, '#ff4d6d', 4) },

  // ---------------- BOMBS ----------------
  { key: 'bomb', name: 'Bomb Rack', category: 'bomb', size: [1, 1, 2], mass: 300, cost: 400, hp: 10, weapon: 'bomb', ammo: 2, drag: 0.22,
    desc: 'Unguided iron bombs. Big splash on ground and carrier targets.',
    build: (T, d) => buildBomb(T, d, 0.22, 2) },
  { key: 'bomb_heavy', name: 'Heavy Bomb', category: 'bomb', size: [1, 1, 2], mass: 600, cost: 700, hp: 10, weapon: 'bombheavy', ammo: 1, drag: 0.4,
    desc: 'One massive bomb. Carrier-cracker — heavy and very draggy.',
    build: (T, d) => buildBomb(T, d, 0.34, 1) },

  // ---------------- UTILITY ----------------
  { key: 'radiator', name: 'Radiator', category: 'utility', size: [2, 1, 1], mass: 60, cost: 300, hp: 15, heatDiss: 8000, drag: 0.06,
    desc: 'Sheds heat. Lets engines/guns sustain fire without overheating.',
    build: (T, d) => a_radiator(T, d, {}) },
  { key: 'sensor_radar', name: 'Radar Sensor', category: 'utility', size: [1, 1, 1], mass: 90, cost: 800, hp: 15, sensor: 1, drag: 0.04,
    desc: 'Search radar. Extends lock range and enables radar missiles.',
    build: (T, d) => { const s = D(d.size); const R = Math.min(s[0], s[1]) * 0.4; const g = new T.Group();
      g.add(dishZ(T, R, R * 0.52, '#cfd6dd'));
      const stalk = cylZ(T, R * 0.12, R * 0.12, s[2] * 0.3, '#5a626b', { metal: 0.6 }); stalk.position.z = -s[2] * 0.22; g.add(stalk);
      const base = box(T, s[0] * 0.42, s[1] * 0.22, s[2] * 0.32, '#3a4046', { metal: 0.6 }); base.position.set(0, -s[1] * 0.08, -s[2] * 0.34); g.add(base); return g; } },
  { key: 'flare', name: 'Flare Dispenser', category: 'utility', size: [1, 1, 1], mass: 40, cost: 250, hp: 10, flares: 12, drag: 0.03,
    desc: 'Countermeasures. Pops flares to decoy incoming IR missiles.',
    build: (T, d) => { const s = D(d.size); const g = new T.Group();
      g.add(box(T, s[0] * 0.52, s[1] * 0.42, s[2] * 0.7, '#3a3d42', { metal: 0.6 }));                 // dispenser housing
      for (let ix = 0; ix < 2; ix++) for (let iz = 0; iz < 3; iz++){ const t = cyl(T, s[1] * 0.05, s[1] * 0.05, s[1] * 0.34, '#d6c24a', { metal: 0.4, emissive: 0x3a3000, ei: 0.3 }); t.position.set((ix - 0.5) * s[0] * 0.22, -s[1] * 0.22, (iz - 1) * s[2] * 0.2); g.add(t); }  // downward flare tubes
      return g; } },
  { key: 'intake', name: 'Air Intake', category: 'utility', size: [1, 1, 1], mass: 30, cost: 150, hp: 10, heatDiss: 3000, drag: 0.04,
    desc: 'Ram-air intake. Modest passive cooling, feeds the engines.',
    build: (T, d) => { const s = D(d.size); const R = s[1] * 0.4; const g = new T.Group();
      g.add(cylZ(T, R, R * 1.04, s[2] * 0.7, '#556', { metal: 0.7, rough: 0.4 }));                    // cowl
      const lip = ringZ(T, R, R * 0.06, '#3a4046', { metal: 0.7 }); lip.position.z = s[2] * 0.35; g.add(lip);  // intake lip
      const inner = cylZ(T, R * 0.78, R * 0.78, s[2] * 0.5, '#0c0e10', { metal: 0.3, rough: 0.8, open: true }); inner.position.z = s[2] * 0.16; g.add(inner);  // dark duct
      const floor = capZ(T, R * 0.78, '#1a1d20', {}, true); floor.position.z = -s[2] * 0.18; g.add(floor); return g; } },

  // ====================== EXPANSION PACK (KSP-inspired) =======================
  // ---------------- COMMAND ----------------
  { key: 'core_drone', name: 'Drone Core', category: 'command', size: [1, 1, 1], mass: 200, cost: 800, hp: 40, crew: 1, ctrlPitch: 1, ctrlYaw: 1, ctrlRoll: 1, drag: 0.04,
    desc: 'Unmanned avionics core. Counts as command — build pilotless drones — but it is fragile and brings only token control authority.',
    build: (T, d) => { const s = D(d.size); const g = new T.Group(); g.add(box(T, s[0] * 0.55, s[1] * 0.5, s[2] * 0.85, '#3a6c8c', { metal: 0.7 }));
      const eye = cylZ(T, s[1] * 0.14, s[1] * 0.14, s[2] * 0.2, '#7fe0ff', { emissive: 0x2090c0, ei: 1.6 }); eye.position.z = s[2] * 0.42; g.add(eye);
      const ant = cyl(T, 0.02, 0.02, s[1] * 0.5, '#aaa'); ant.position.y = s[1] * 0.45; g.add(ant); return g; } },

  // ---------------- STRUCTURE ----------------
  { key: 'shock_cone', name: 'Shock Cone Intake', category: 'structure', size: [1, 1, 1], mass: 70, cost: 220, hp: 25, drag: -0.10, heatDiss: 4000,
    desc: 'Supersonic nose intake. Cuts drag like a nose cone AND feeds cooling air to the engines.',
    build: (T, d) => { const s = D(d.size); const g = new T.Group(); const c = cone(T, s[0] * 0.42, s[2] * 0.9, CAT_COLORS.structure, { metal: 0.6 }); c.rotation.x = Math.PI / 2; c.position.z = s[2] * 0.05; g.add(c);
      const ring = cylZ(T, s[1] * 0.34, s[1] * 0.34, s[2] * 0.18, '#223', { metal: 0.9 }); ring.position.z = -s[2] * 0.4; g.add(ring); return g; } },
  { key: 'tail_cone', name: 'Tail Cone', category: 'structure', size: [1, 1, 1], mass: 50, cost: 120, hp: 25, drag: -0.08,
    desc: 'Aft fairing. Smooths the base of the fuselage to cut drag — mount at the very back.',
    build: (T, d) => { const s = D(d.size); const c = cone(T, s[0] * 0.4, s[2] * 0.9, CAT_COLORS.structure, { metal: 0.55 }); c.rotation.x = -Math.PI / 2; return c; } },
  { key: 'structural_panel', name: 'Structural Panel', category: 'structure', size: [2, 1, 1], mass: 50, cost: 70, hp: 35, drag: 0.04,
    desc: 'Flat load-bearing plate. A cheap mounting surface for wings, armor and pods.',
    build: (T, d) => { const s = D(d.size); return box(T, s[0] * 0.95, s[1] * 0.18, s[2] * 0.95, '#8b97a4', { metal: 0.5 }); } },

  // ---------------- FUEL ----------------
  { key: 'fuel_tiny', name: 'Compact Tank', category: 'fuel', size: [1, 1, 1], mass: 20, cost: 70, hp: 20, fuel: 140, drag: 0.06,
    desc: '140 kg of fuel in a single cell. Tops off range without committing to a big tank.',
    build: (T, d) => buildTank(T, d, { r: 0.42 }) },
  { key: 'fuel_xl', name: 'XL Fuel Tank', category: 'fuel', size: [1, 1, 4], mass: 150, cost: 680, hp: 110, fuel: 700, drag: 0.22,
    desc: '1400 kg long-range tank. For bombers, loiter drones and thirsty rockets.',
    build: (T, d) => buildTank(T, d, { r: 0.49 }) },

  // ---------------- ENGINES ----------------
  { key: 'turbojet', name: 'J-404 "Panther" Afterburning Turbofan', category: 'engine', size: [1, 1, 1], mass: 1200, cost: 2000, hp: 60, thrust: 85000, burn: 1.0, afterburner: 1.53, boostBurn: 2.6, heatGen: 200000, drag: 0.07,
    desc: '85 kN dry / 130 kN wet low-bypass afterburning turbofan. Sleek and very fast at full reheat — runs hot.',
    build: (T, d) => buildJet(T, d, { ab: true, color: '#8f969d', hot: 0xff6a20, glow: '#ffd0a0' }) },
  { key: 'prop_engine', name: 'Turboprop', category: 'engine', size: [1, 1, 2], mass: 280, cost: 500, hp: 45, thrust: 22000, burn: 0.4, heatGen: 18000, drag: 0.05,
    desc: '22 kN turboprop. Low thrust and top speed, but cheap and superb endurance for slow drones and trainers.',
    build: (T, d) => buildProp(T, d, {}) },
  { key: 'rocket_small', name: 'Light Rocket', category: 'engine', size: [1, 1, 2], mass: 320, cost: 600, hp: 35, thrust: 60000, burn: 3.5, heatGen: 130000, drag: 0.06,
    desc: '60 kN light rocket. Punchy in a small package — cheap, thirsty, and no afterburner needed.',
    build: (T, d) => buildRocket(T, d, { color: '#c4472a' }) },
  { key: 'srb_booster', name: 'Solid Booster', category: 'engine', size: [1, 1, 3], mass: 1000, cost: 2400, hp: 50, thrust: 160000, burn: 14, heatGen: 360000, drag: 0.1,
    desc: '250 kN solid rocket. Brutal thrust that guzzles fuel — bolt on for a blistering dash, then run dry.',
    build: (T, d) => buildSRB(T, d, {}) },

  // ---------------- THRUSTERS ----------------
  { key: 'reaction_wheel', name: 'Reaction Wheel', category: 'thruster', size: [1, 1, 1], mass: 70, cost: 600, hp: 20, ctrlPitch: 6, ctrlRoll: 6, ctrlYaw: 6, drag: 0.0,
    desc: 'Internal gyros add control authority in every axis with no fuel and no drag — agility you can bury inside the airframe.',
    build: (T, d) => a_reactionWheel(T, d, {}) },
  { key: 'tvc_3d', name: '3D Thrust Vectoring', category: 'thruster', size: [1, 1, 1], mass: 140, cost: 1500, hp: 25, ctrlPitch: 14, ctrlYaw: 10, ctrlRoll: 4, drag: 0.03,
    desc: 'Heavy all-axis vectored nozzle. Enormous nose authority — mount behind an engine for cobra-grade pitch.',
    build: (T, d) => a_nozzle(T, d, {}) },

  // ---------------- WINGS / AERO ----------------
  { key: 'wing_swept', name: 'Swept Wing', category: 'wing', size: [3, 1, 2], mass: 200, cost: 620, hp: 50, lift: 1.37, ctrlRoll: 3, ctrlPitch: 2, drag: 0.1,
    desc: 'Swept lifting surface. A touch less lift than a straight wing but lower drag — built for speed.',
    build: (T, d) => a_wing(T, d, { taper: 0.4 }) },
  { key: 'wing_long', name: 'High-Lift Wing', category: 'wing', size: [4, 1, 2], mass: 280, cost: 700, hp: 70, lift: 24, ctrlRoll: 5, drag: 0.2,
    desc: 'Big high-aspect wing. Loads of lift and a low stall speed — perfect for bombers and loiterers, but draggy.',
    build: (T, d) => a_wing(T, d, { taper: 0.85, thick: 0.2 }) },
  { key: 'elevon', name: 'Elevon', category: 'wing', size: [2, 1, 1], mass: 50, cost: 240, hp: 25, lift: 2, ctrlPitch: 7, ctrlRoll: 7, drag: 0.04,
    desc: 'Combined elevator/aileron control surface. Strong pitch AND roll — the tailless-delta favourite.',
    build: (T, d) => a_ctrlSurface(T, d, { color: '#b9c4d0' }) },
  { key: 'strake', name: 'Strake (LERX)', category: 'wing', size: [1, 1, 2], mass: 40, cost: 180, hp: 20, lift: 4, ctrlPitch: 5, drag: 0.03,
    desc: 'Leading-edge root extension. A little extra lift and nose authority at high angle of attack.',
    build: (T, d) => a_wing(T, d, { taper: 0.12, sweep: 0.7, thick: 0.06 }) },
  { key: 'airbrake', name: 'Airbrake', category: 'wing', size: [1, 1, 1], mass: 80, cost: 350, hp: 20, ctrlPitch: 2, drag: 0.03, airbrakeDrag: 1.3,
    desc: 'Deployable speed brake. Press B in flight to throw out huge drag — bleed energy, force an overshoot, then snap back onto his six.',
    build: (T, d) => { const s = D(d.size); const g = new T.Group(); const p = box(T, s[0] * 0.8, s[1] * 0.7, s[2] * 0.12, '#9aa6b2', { metal: 0.5 }); p.rotation.x = 0.5; g.add(p); return g; } },

  // ---------------- ARMOR ----------------
  { key: 'armor_composite', name: 'Composite Armor', category: 'armor', size: [1, 1, 1], mass: 150, cost: 220, hp: 30, armor: 80,
    desc: '+80 HP of ablative composite. A balanced middle ground between light shield and heavy steel.',
    build: (T, d) => a_armor(T, d, { color: '#6f5a44' }) },
  { key: 'armor_reactive', name: 'Reactive Armor', category: 'armor', size: [1, 1, 1], mass: 300, cost: 600, hp: 50, armor: 180,
    desc: '+180 HP ablative re-entry shield. The toughest plating there is — heavy, pricey, and it shrugs off cannon fire.',
    build: (T, d) => a_armor(T, d, { style: 'reactive' }) },

  // ---------------- GUNS ----------------
  { key: 'gun_rocketpod', name: 'Rocket Pod', category: 'gun', size: [1, 1, 2], mass: 200, cost: 800, hp: 20, weapon: 'rocketpod', ammo: 28, heatGen: 30000, drag: 0.12,
    desc: 'Pod of unguided rockets. A fast salvo of splash-damage shots — murder on bombers, ground and carriers.',
    build: (T, d) => buildRocketPod(T, d, {}) },

  // ---------------- MISSILES ----------------
  { key: 'missile_aam', name: 'Heavy AAM Rack', category: 'missile', size: [1, 1, 2], mass: 300, cost: 1400, hp: 15, weapon: 'aamheavy', ammo: 2, drag: 0.24,
    desc: 'Long-reach heat-seeker. Hits hard from far out with a big warhead — fewer shots, heavier punch.',
    build: (T, d) => buildMissile(T, d, '#ff6a4d', 1, { seeker: 'aam' }) },

  // ---------------- BOMBS ----------------
  { key: 'bomb_cluster', name: 'Cluster Bomb', category: 'bomb', size: [1, 1, 2], mass: 450, cost: 650, hp: 10, weapon: 'clusterbomb', ammo: 2, drag: 0.3,
    desc: 'Wide-area submunitions. Saturates a big radius — ideal against soft and clustered targets.',
    build: (T, d) => buildBomb(T, d, 0.2, 2) },

  // ====================== EXTENDED ARSENAL (bespoke models) ==================
  // ---------------- GUNS ----------------
  { key: 'gun_heavymg', name: 'Heavy Machine Gun', category: 'gun', size: [1, 1, 2], mass: 110, cost: 420, hp: 22, weapon: 'heavymg', ammo: 800, heatGen: 26000, drag: 0.04,
    desc: 'Big-bore .50-class autogun. A water-jacketed barrel that bites harder than the rifle MG, fed from a side ammo can.',
    build: (T, d) => buildHeavyMG(T, d) },
  { key: 'gun_lightcannon', name: 'Light Auto-Cannon', category: 'gun', size: [1, 1, 2], mass: 150, cost: 560, hp: 24, weapon: 'lightcannon', ammo: 350, heatGen: 28000, drag: 0.05,
    desc: 'Fast-cycling 20 mm autocannon. Slim, accurate and drum-fed with a touch of HE splash — the bridge between MG and cannon.',
    build: (T, d) => buildLightCannon(T, d) },
  { key: 'gun_revolver', name: 'Revolver Cannon', category: 'gun', size: [1, 1, 3], mass: 230, cost: 980, hp: 28, weapon: 'revolver', ammo: 360, heatGen: 42000, drag: 0.05,
    desc: 'Five-chamber revolver cannon. Slow cyclic rate but a brutal 130-dmg single-shot punch and pinpoint grouping.',
    build: (T, d) => buildRevolverCannon(T, d) },
  { key: 'gun_minigun', name: 'Light Minigun', category: 'gun', size: [1, 1, 2], mass: 110, cost: 620, hp: 20, weapon: 'minigun', ammo: 2400, heatGen: 30000, drag: 0.05,
    desc: 'Compact three-barrel electric rotary. A blistering, wide stream of light rounds — lighter and cooler than a full gatling.',
    build: (T, d) => buildGatling(T, d, { barrels: 3 }) },
  { key: 'gun_flak', name: 'Flak Cannon', category: 'gun', size: [1, 1, 3], mass: 260, cost: 1050, hp: 30, weapon: 'flak', ammo: 150, heatGen: 44000, drag: 0.07,
    desc: 'Large-bore proximity-fuzed AAA. Modest direct hits but the biggest gun-splash there is — made to break up bomber formations.',
    build: (T, d) => buildFlak(T, d) },
  { key: 'gun_railgun', name: 'Electromagnetic Railgun', category: 'gun', size: [1, 1, 4], mass: 360, cost: 2200, hp: 30, weapon: 'railgun', ammo: 40, heatGen: 90000, drag: 0.06,
    desc: 'Capacitor-fed coilgun. A tungsten slug at hypervelocity on a dead-flat path — highest speed and per-hit punch of any gun, but slow and blistering hot.',
    build: (T, d) => buildRailgun(T, d) },

  // ---------------- MISSILES ----------------
  { key: 'missile_sraam', name: 'Short-Range AAM Rail', category: 'missile', size: [1, 1, 2], mass: 150, cost: 560, hp: 15, weapon: 'sraam', ammo: 2, drag: 0.17,
    desc: 'Twin high-agility dogfight heat-seekers. Snap lock and a hard-turning tail — built for the knife fight.',
    build: (T, d) => buildSRAAM(T, d) },
  { key: 'missile_lraam', name: 'Long-Range AAM Rail', category: 'missile', size: [1, 1, 3], mass: 280, cost: 1500, hp: 16, weapon: 'lraam', ammo: 2, sensor: 1, drag: 0.24,
    desc: 'Twin long-burn active-radar missiles. Opens the fight from outside gun range; carries its own radar to self-cue.',
    build: (T, d) => buildLRAAM(T, d) },
  { key: 'missile_antiship', name: 'Anti-Ship Missile Rail', category: 'missile', size: [2, 1, 3], mass: 420, cost: 1900, hp: 18, weapon: 'antiship', ammo: 2, drag: 0.3,
    desc: 'A pair of heavy sea-skimmers with cropped wings and a belly intake — built to gut warships in one hit.',
    build: (T, d) => buildAntiShip(T, d) },
  { key: 'missile_torpedo', name: 'Aerial Torpedo Cradle', category: 'missile', size: [2, 1, 3], mass: 480, cost: 2000, hp: 18, weapon: 'torpedo', ammo: 1, drag: 0.32,
    desc: 'A single heavy aerial torpedo in a drop cradle. Fat, blunt and slow, with a ducted ring tail — the deliberate ship-killer.',
    build: (T, d) => buildTorpedo(T, d) },
  { key: 'missile_cruise', name: 'Cruise Missile Pylon', category: 'missile', size: [2, 1, 4], mass: 520, cost: 2400, hp: 18, weapon: 'cruise', ammo: 1, sensor: 1, drag: 0.34,
    desc: 'A single long-range stand-off cruise missile: pop-out wings and a tucked turbofan intake behind a heavy unitary warhead.',
    build: (T, d) => buildCruise(T, d) },

  // ---------------- BOMBS ----------------
  { key: 'bomb_guided', name: 'Guided Bomb Rack', category: 'bomb', size: [1, 1, 2], mass: 380, cost: 820, hp: 10, weapon: 'guidedbomb', ammo: 1, drag: 0.26,
    desc: 'A single precision glide bomb. A seeker nose and pop-out canards walk it onto a pinpoint aimpoint.',
    build: (T, d) => buildGuidedBomb(T, d) },
  { key: 'bomb_napalm', name: 'Incendiary Bomb Rack', category: 'bomb', size: [1, 1, 2], mass: 350, cost: 520, hp: 10, weapon: 'napalm', ammo: 2, drag: 0.28,
    desc: 'A pair of finless firebombs. Low per-hit damage but the widest area soak in the game — washes the deck in flame.',
    build: (T, d) => buildNapalm(T, d) },

  // ---------------- UTILITY ----------------
  { key: 'radiator_large', name: 'Large Radiator', category: 'utility', size: [2, 1, 2], mass: 110, cost: 520, hp: 20, heatDiss: 18000, drag: 0.08,
    desc: 'Big heat exchanger. Keeps gatlings, rockets and afterburners firing without cooking the airframe.',
    build: (T, d) => a_radiator(T, d, {}) },
  { key: 'targeting_pod', name: 'Targeting Pod', category: 'utility', size: [1, 1, 1], mass: 70, cost: 900, hp: 15, sensor: 1, drag: 0.03,
    desc: 'Lightweight sensor/designator. Enables radar missiles like a full radar — lighter, but it costs more credits.',
    build: (T, d) => { const s = D(d.size); const g = new T.Group(); g.add(cylZ(T, s[1] * 0.22, s[1] * 0.24, s[2] * 0.5, '#445', { metal: 0.7 }));   // pod body
      const ring = ringZ(T, s[1] * 0.25, s[1] * 0.03, '#2a3038', { metal: 0.7 }); ring.position.z = s[2] * 0.22; g.add(ring);                        // gimbal ring
      const ball = new T.Mesh(new T.SphereGeometry(s[1] * 0.24, 16, 12), mat(T, '#1a1d22', { metal: 0.4, rough: 0.3 })); ball.position.z = s[2] * 0.3; g.add(ball);  // sensor ball
      const win = new T.Mesh(new T.CircleGeometry(s[1] * 0.12, 16), mat(T, '#2a6a88', { metal: 0.2, rough: 0.1, emissive: 0x0a2a3a, ei: 0.6 })); win.position.z = s[2] * 0.43; g.add(win); return g; } },   // sensor window
  { key: 'intake_ram', name: 'Ram Intake', category: 'utility', size: [1, 1, 1], mass: 40, cost: 200, hp: 10, heatDiss: 5000, drag: 0.05,
    desc: 'Large ram scoop. More cooling airflow than a basic intake for heat-heavy builds.',
    build: (T, d) => { const s = D(d.size); const R = s[1] * 0.42; const g = new T.Group();
      g.add(cylZ(T, R, R * 1.05, s[2] * 0.72, '#556', { metal: 0.7, rough: 0.4 }));                   // cowl
      const lip = ringZ(T, R, R * 0.07, '#3a4046', { metal: 0.75 }); lip.position.z = s[2] * 0.36; g.add(lip);
      const inner = cylZ(T, R * 0.8, R * 0.8, s[2] * 0.55, '#0c0e10', { metal: 0.3, rough: 0.8, open: true }); inner.position.z = s[2] * 0.16; g.add(inner);
      const shock = cone(T, R * 0.42, s[2] * 0.42, '#cdd3d9', { metal: 0.7 }); shock.rotation.x = Math.PI / 2; shock.position.z = s[2] * 0.34; g.add(shock); return g; } },   // shock cone centrebody
];

// ---- shared weapon-mesh helpers (KSP-grade procedural detail) --------------
// A lathe-turned ogive nose pointing +Z (tip at +Z, base at -Z). `sharp` > 1
// drives a slimmer, pointier radome; ~1 gives a rounded warhead ogive.
function ogiveZ(T, R, h, color, o = {}){
  const N = 14, sharp = o.sharp ?? 1, pts = [];
  for (let i = 0; i <= N; i++){ const t = i / N;                       // 0 = base → 1 = tip
    pts.push(new T.Vector2(Math.max(1e-3, R * Math.pow(Math.cos(t * Math.PI * 0.5), sharp)), -h * 0.5 + t * h)); }
  const m = new T.Mesh(new T.LatheGeometry(pts, o.seg || 18), mat(T, color, o));
  m.rotation.x = Math.PI / 2; return m;
}
// Four radial fins in a cruciform, roots sitting at `rootR`, extending `span`
// outboard, with axial chord `chord`. `offset` rotates the whole set (π/4 = X).
function cruciform(T, g, z, rootR, span, chord, thick, color, o = {}){
  for (let f = 0; f < 4; f++){ const fin = box(T, thick, span, chord, color, { metal: o.metal ?? 0.4, rough: o.rough ?? 0.45 });
    fin.position.set(0, rootR + span * 0.5, z);
    const piv = new T.Group(); piv.add(fin); piv.rotation.z = f * Math.PI / 2 + (o.offset || 0); g.add(piv); }
}
// A small dorsal sight rib for gun receivers — a touch of top-surface detail.
function sightRib(T, s, zc){ const rib = box(T, s[0] * 0.05, s[1] * 0.12, s[2] * 0.3, '#1c1d1f', { metal: 0.7 }); rib.position.set(0, s[1] * 0.36, zc); return rib; }

// A mounted autocannon / machine gun: receiver + breech, ammo feed, mount lug,
// a long barrel with either a vented cooling shroud (rapid-fire MG) or recoil
// bands (big-bore cannon), capped by a ported muzzle brake.
function buildGun(T, d, r, o = {}){
  const s = D(d.size); const g = new T.Group();
  const heavy = o.heavy ?? (r >= 0.085);
  const steel = '#3a3d42', gun = '#26282b', dark = '#16171a';
  const recv = box(T, s[0] * 0.4, s[1] * 0.44, s[2] * 0.5, steel, { metal: 0.72, rough: 0.4 }); recv.position.z = -s[2] * 0.2; g.add(recv);   // receiver
  const dorsal = box(T, s[0] * 0.3, s[1] * 0.16, s[2] * 0.42, '#30333a', { metal: 0.7 }); dorsal.position.set(0, s[1] * 0.3, -s[2] * 0.18); g.add(dorsal);
  const feed = box(T, s[0] * 0.16, s[1] * 0.28, s[2] * 0.22, '#2b2e34', { metal: 0.6, rough: 0.55 }); feed.position.set(s[0] * 0.26, s[1] * 0.05, -s[2] * 0.28); g.add(feed);   // ammo feed
  const lug = box(T, s[0] * 0.16, s[1] * 0.2, s[2] * 0.34, '#4a4d52', { metal: 0.7 }); lug.position.set(0, -s[1] * 0.32, -s[2] * 0.12); g.add(lug);                              // mount lug
  const barL = s[2] * 0.95;
  const barrel = cylZ(T, r, r * 1.04, barL, gun, { metal: 0.92, rough: 0.26 }); barrel.position.z = s[2] * 0.32; g.add(barrel);
  if (heavy){
    for (let i = 0; i < 3; i++){ const band = ringZ(T, r * 1.16, 0.022, steel, { metal: 0.7 }); band.position.z = s[2] * (0.12 + i * 0.22); g.add(band); }   // recoil bands
  } else {
    const shroud = cylZ(T, r * 1.9, r * 1.9, barL * 0.62, '#34373c', { metal: 0.7, rough: 0.45, open: true }); shroud.position.z = s[2] * 0.22; g.add(shroud);  // cooling jacket
    for (let i = 0; i < 5; i++){ const v = ringZ(T, r * 1.92, 0.014, dark, { metal: 0.6 }); v.position.z = s[2] * (0.02 + i * 0.09); g.add(v); }                  // vent bands
  }
  const brakeZ = s[2] * 0.74;
  const brake = cylZ(T, r * 1.7, r * 1.5, s[2] * 0.13, '#202225', { metal: 0.85, rough: 0.4 }); brake.position.z = brakeZ; g.add(brake);     // muzzle brake
  const portV = cyl(T, r * 0.4, r * 0.4, r * 3.7, dark); portV.position.z = brakeZ; g.add(portV);                                            // muzzle ports
  const portH = cyl(T, r * 0.4, r * 0.4, r * 3.7, dark); portH.rotation.z = Math.PI / 2; portH.position.z = brakeZ; g.add(portH);
  const bore = cylZ(T, r * 0.72, r * 0.72, s[2] * 0.05, '#0a0a0b'); bore.position.z = s[2] * 0.5; g.add(bore);                               // dark bore
  return g;
}

// A multi-barrel rotary cannon: receiver drum, a clustered barrel set carried
// on front/rear plates with a mid clamp and central spindle, plus a mount lug.
function buildGatling(T, d, o = {}){
  const s = D(d.size); const g = new T.Group();
  const n = o.barrels || 6;
  const HR = Math.min(s[0], s[1]) * 0.42, ringR = HR * 0.6, barR = HR * 0.15;
  const drum = cylZ(T, HR, HR * 1.02, s[2] * 0.32, '#34373c', { metal: 0.78, rough: 0.4 }); drum.position.z = -s[2] * 0.3; g.add(drum);
  for (let i = 0; i < 2; i++){ const b = ringZ(T, HR * 1.03, 0.022, '#26282b', { metal: 0.7 }); b.position.z = s[2] * (-0.42 + i * 0.2); g.add(b); }
  const rplate = cylZ(T, ringR + barR * 1.5, ringR + barR * 1.5, s[2] * 0.05, '#2b2d31', { metal: 0.8 }); rplate.position.z = -s[2] * 0.08; g.add(rplate);
  const fplate = cylZ(T, ringR + barR * 1.7, ringR + barR * 1.7, s[2] * 0.05, '#202225', { metal: 0.85 }); fplate.position.z = s[2] * 0.42; g.add(fplate);
  const barL = s[2] * 0.6;
  for (let i = 0; i < n; i++){ const a = i / n * Math.PI * 2, x = Math.cos(a) * ringR, y = Math.sin(a) * ringR;
    const bar = cylZ(T, barR, barR, barL, '#26282b', { metal: 0.92, rough: 0.26 }); bar.position.set(x, y, s[2] * 0.16); g.add(bar);
    const mz = cylZ(T, barR * 0.6, barR * 0.6, s[2] * 0.04, '#0a0a0b'); mz.position.set(x, y, s[2] * 0.43); g.add(mz); }
  const clamp = cylZ(T, ringR + barR * 0.4, ringR + barR * 0.4, s[2] * 0.05, '#3a3d42', { metal: 0.7, open: true }); clamp.position.z = s[2] * 0.16; g.add(clamp);
  const spindle = cylZ(T, barR * 0.7, barR * 0.7, barL, '#4a4d52', { metal: 0.7 }); spindle.position.z = s[2] * 0.16; g.add(spindle);
  const lug = box(T, s[0] * 0.14, s[1] * 0.2, s[2] * 0.32, '#4a4d52', { metal: 0.7 }); lug.position.set(0, -HR * 1.02, -s[2] * 0.24); g.add(lug);
  return g;
}

// A pod of unguided rockets: banded casing, a recessed honeycomb of tube mouths
// on the front face, a nose rim and a mount lug.
function buildRocketPod(T, d, o = {}){
  const s = D(d.size); const g = new T.Group();
  const R = Math.min(s[0], s[1]) * 0.46;
  g.add(cylZ(T, R, R * 0.97, s[2] * 0.88, o.color || '#5d5340', { metal: 0.58, rough: 0.5 }));
  for (const z of [-0.3, 0, 0.28]){ const b = ringZ(T, R, 0.02, '#3a352a', { metal: 0.5 }); b.position.z = s[2] * z; g.add(b); }
  const rim = cylZ(T, R, R, s[2] * 0.05, '#4a4234', { metal: 0.6 }); rim.position.z = s[2] * 0.42; g.add(rim);
  const tubeR = R * 0.2, faceZ = s[2] * 0.4, cells = [[0, 0]];
  for (let i = 0; i < 6; i++){ const a = i / 6 * Math.PI * 2; cells.push([Math.cos(a) * tubeR * 2.1, Math.sin(a) * tubeR * 2.1]); }
  if (R > 0.42){ for (let i = 0; i < 12; i++){ const a = i / 12 * Math.PI * 2, rr = tubeR * 3.7; if (rr + tubeR < R * 0.97) cells.push([Math.cos(a) * rr, Math.sin(a) * rr]); } }
  for (const [x, y] of cells){
    const mouth = cylZ(T, tubeR, tubeR, s[2] * 0.14, '#1b1b1e', { metal: 0.6, rough: 0.7 }); mouth.position.set(x, y, faceZ - s[2] * 0.05); g.add(mouth);
    const deep = cylZ(T, tubeR * 0.72, tubeR * 0.72, s[2] * 0.04, '#070708'); deep.position.set(x, y, faceZ); g.add(deep); }
  const lug = box(T, s[0] * 0.14, s[1] * 0.2, s[2] * 0.3, '#4a4d52', { metal: 0.7 }); lug.position.set(0, -R, -s[2] * 0.05); g.add(lug);
  return g;
}

// A single guided round: motor body, nose (IR glass seeker dome or pointed
// radome), warhead band, mid control fins + rear tail fins, and a motor nozzle.
function oneMissile(T, R, len, color, seeker){
  const m = new T.Group();
  const body = cylZ(T, R, R, len * 0.6, '#e2e5e9', { metal: 0.45, rough: 0.4 }); body.position.z = -len * 0.05; m.add(body);
  const motor = cylZ(T, R, R * 0.99, len * 0.22, '#c7ccd2', { metal: 0.5, rough: 0.45 }); motor.position.z = -len * 0.38; m.add(motor);
  if (seeker === 'radar' || seeker === 'aam'){
    const nose = ogiveZ(T, R, len * 0.24, '#d7d1c2', { metal: 0.25, rough: 0.55, sharp: seeker === 'aam' ? 1.5 : 1.2 }); nose.position.z = len * 0.37; m.add(nose);
  } else {
    const fore = cylZ(T, R, R, len * 0.13, '#cfd3d8', { metal: 0.5, rough: 0.35 }); fore.position.z = len * 0.31; m.add(fore);
    const dome = capZ(T, R, '#a7dcff', { metal: 0.1, rough: 0.05, transparent: true, opacity: 0.62, emissive: 0x16384f, ei: 0.6 }); dome.position.z = len * 0.38; m.add(dome);
  }
  const band = cylZ(T, R * 1.04, R * 1.04, len * 0.045, color, { metal: 0.4 }); band.position.z = len * 0.16; m.add(band);
  cruciform(T, m, len * 0.04, R, R * 0.85, len * 0.1, 0.012, '#cfd3d8', { offset: Math.PI / 4 });   // control fins
  cruciform(T, m, -len * 0.4, R, R * 1.3, len * 0.16, 0.014, '#c2c7cd');                              // tail fins
  const noz = cylZ(T, R * 0.5, R * 0.74, len * 0.05, '#1a1a1c', { metal: 0.6, open: true }); noz.position.z = -len * 0.5; m.add(noz);
  const throat = new T.Mesh(new T.CircleGeometry(R * 0.46, 12), new T.MeshStandardMaterial({ color: 0x0a0a0b, metalness: 0.5, roughness: 0.8, side: T.DoubleSide })); throat.position.z = -len * 0.49; m.add(throat);
  return m;
}
// A guided-missile rack: a launch rail with hanger lugs carrying 1–3 rounds.
function buildMissile(T, d, color, n, o = {}){
  const s = D(d.size); const g = new T.Group();
  const seeker = o.seeker || 'ir';
  const rail = box(T, s[0] * 0.2, s[1] * 0.24, s[2] * 0.82, '#3f444b', { metal: 0.62, rough: 0.45 }); rail.position.y = s[1] * 0.18; g.add(rail);
  const cnt = Math.min(n, 3), R = cnt > 1 ? 0.072 : 0.1, len = s[2] * 0.95, spacing = s[0] * 0.34;
  for (let i = 0; i < cnt; i++){ const spread = cnt > 1 ? (i - (cnt - 1) / 2) : 0, x = spread * spacing;
    const hang = box(T, 0.03, s[1] * 0.2, R * 1.6, '#2b2d31', { metal: 0.7 }); hang.position.set(x, -s[1] * 0.04, len * 0.04); g.add(hang);
    const m = oneMissile(T, R, len, color, seeker); m.position.set(x, -s[1] * 0.26, 0); g.add(m); }
  return g;
}

// A single iron/guided bomb: ogive nose with a fuze, banded body, boat-tail and
// a cruciform box-fin tail assembly tied off with a strake ring.
function oneBomb(T, r, len, col){
  const b = new T.Group();
  b.add(cylZ(T, r, r, len * 0.52, col, { metal: 0.34, rough: 0.55 }));
  const nose = ogiveZ(T, r, len * 0.26, col, { metal: 0.34, rough: 0.5, sharp: 1.15 }); nose.position.z = len * 0.39; b.add(nose);
  const fuze = cylZ(T, r * 0.26, r * 0.3, len * 0.05, '#2b2d31', { metal: 0.7 }); fuze.position.z = len * 0.52; b.add(fuze);
  const boat = cylZ(T, r * 0.62, r, len * 0.16, col, { metal: 0.34, rough: 0.55 }); boat.position.z = -len * 0.34; b.add(boat);
  const band = cylZ(T, r * 1.03, r * 1.03, len * 0.045, '#d8d24d', { metal: 0.4 }); band.position.z = len * 0.16; b.add(band);
  const finZ = -len * 0.42, span = r * 1.15, chord = len * 0.2;
  cruciform(T, b, finZ, r * 0.5, span, chord, 0.016, '#cfd3d8', { offset: Math.PI / 4 });
  const ring = ringZ(T, r * 0.5 + span, 0.018, '#aeb4bb', { metal: 0.4 }); ring.position.z = finZ - chord * 0.32; b.add(ring);
  return b;
}
// A bomb rack carrying 1–2 bombs with suspension lugs.
function buildBomb(T, d, r, n, o = {}){
  const s = D(d.size); const g = new T.Group();
  const rack = box(T, s[0] * 0.32, s[1] * 0.16, s[2] * 0.64, '#3f444b', { metal: 0.6, rough: 0.45 }); rack.position.y = s[1] * 0.22; g.add(rack);
  const col = o.color || CAT_COLORS.bomb, cnt = Math.min(n, 2);
  for (let i = 0; i < cnt; i++){ const x = (cnt > 1 ? (i - 0.5) : 0) * s[0] * 0.42;
    for (const lz of [-0.14, 0.14]){ const lug = box(T, 0.025, s[1] * 0.18, 0.05, '#2b2d31', { metal: 0.7 }); lug.position.set(x, -s[1] * 0.02, lz * s[2]); g.add(lug); }
    const b = oneBomb(T, r, s[2] * 0.86, col); b.position.set(x, -s[1] * 0.26, 0); g.add(b); }
  return g;
}

// ---- extended arsenal: bespoke weapon builders -----------------------------
// Heavy MG: one fat water-jacketed barrel, cone flash-hider, side ammo can.
function buildHeavyMG(T, d){
  const s = D(d.size); const g = new T.Group();
  const steel = '#3a3d42', gun = '#26282b', dark = '#16171a';
  const recv = box(T, s[0] * 0.4, s[1] * 0.46, s[2] * 0.48, steel, { metal: 0.72, rough: 0.4 }); recv.position.z = -s[2] * 0.22; g.add(recv);
  g.add(sightRib(T, s, -s[2] * 0.2));
  const r = 0.1, barL = s[2] * 0.92;
  const barrel = cylZ(T, r, r, barL, gun, { metal: 0.92, rough: 0.26 }); barrel.position.z = s[2] * 0.32; g.add(barrel);
  const jacket = cylZ(T, 0.15, 0.15, barL * 0.62, '#34373c', { metal: 0.7, rough: 0.45, open: true }); jacket.position.z = s[2] * 0.2; g.add(jacket);
  for (let i = 0; i < 7; i++){ const ring = ringZ(T, 0.16, 0.014, dark, { metal: 0.6 }); ring.position.z = s[2] * (0.02 + i * 0.065); g.add(ring); }
  const fh = cone(T, 0.09, s[2] * 0.13, '#202225', { metal: 0.85 }); fh.rotation.x = Math.PI / 2; fh.position.z = s[2] * 0.5; g.add(fh);
  const can = box(T, s[0] * 0.26, s[1] * 0.34, s[2] * 0.34, '#2b2e34', { metal: 0.55, rough: 0.6 }); can.position.set(s[0] * 0.3, -s[1] * 0.02, -s[2] * 0.24); g.add(can);
  const chute = cylZ(T, 0.05, 0.06, s[2] * 0.2, '#3a3d42', { metal: 0.6 }); chute.rotation.z = 0.5; chute.position.set(s[0] * 0.16, 0, -s[2] * 0.2); g.add(chute);
  const lug = box(T, s[0] * 0.16, s[1] * 0.2, s[2] * 0.32, '#4a4d52', { metal: 0.7 }); lug.position.set(0, -s[1] * 0.34, -s[2] * 0.1); g.add(lug);
  return g;
}
// Light auto-cannon: slim banded barrel, slotted box brake, side drum magazine.
function buildLightCannon(T, d){
  const s = D(d.size); const g = new T.Group();
  const steel = '#3a3d42', gun = '#26282b';
  const recv = box(T, s[0] * 0.36, s[1] * 0.4, s[2] * 0.44, steel, { metal: 0.72, rough: 0.4 }); recv.position.z = -s[2] * 0.2; g.add(recv);
  g.add(sightRib(T, s, -s[2] * 0.18));
  const r = 0.085, barL = s[2] * 0.94;
  const barrel = cylZ(T, r, r, barL, gun, { metal: 0.92, rough: 0.26 }); barrel.position.z = s[2] * 0.32; g.add(barrel);
  for (let i = 0; i < 3; i++){ const band = ringZ(T, 0.1, 0.018, steel, { metal: 0.7 }); band.position.z = s[2] * (0.14 + i * 0.2); g.add(band); }
  const brakeZ = s[2] * 0.76;
  const brake = box(T, s[0] * 0.22, s[1] * 0.22, s[2] * 0.16, '#202225', { metal: 0.85 }); brake.position.z = brakeZ; g.add(brake);
  for (const oz of [-0.04, 0.04]){ const slot = box(T, s[0] * 0.26, s[1] * 0.06, s[2] * 0.04, '#0a0a0b'); slot.position.set(0, 0, brakeZ + oz * s[2]); g.add(slot); }
  const drum = cylZ(T, 0.16, 0.16, s[2] * 0.34, '#2b2e34', { metal: 0.55, rough: 0.55 }); drum.position.set(-s[0] * 0.28, -s[1] * 0.02, -s[2] * 0.2); g.add(drum);
  const lug = box(T, s[0] * 0.16, s[1] * 0.2, s[2] * 0.3, '#4a4d52', { metal: 0.7 }); lug.position.set(0, -s[1] * 0.32, -s[2] * 0.08); g.add(lug);
  return g;
}
// Revolver cannon: a five-chamber revolving breech feeding one heavy barrel.
function buildRevolverCannon(T, d){
  const s = D(d.size); const g = new T.Group();
  const steel = '#3a3d42', gun = '#26282b', dark = '#16171a';
  const recv = box(T, s[0] * 0.4, s[1] * 0.44, s[2] * 0.34, steel, { metal: 0.72, rough: 0.4 }); recv.position.z = -s[2] * 0.3; g.add(recv);
  g.add(sightRib(T, s, -s[2] * 0.32));
  const drum = cylZ(T, 0.22, 0.22, s[2] * 0.12, '#34373c', { metal: 0.78, rough: 0.4 }); drum.position.z = -s[2] * 0.08; g.add(drum);
  for (let i = 0; i < 5; i++){ const a = i / 5 * Math.PI * 2; const ch = cylZ(T, 0.05, 0.05, s[2] * 0.13, '#0a0a0b'); ch.position.set(Math.cos(a) * 0.12, Math.sin(a) * 0.12, -s[2] * 0.02); g.add(ch); }
  const r = 0.1, barL = s[2] * 0.66;
  const barrel = cylZ(T, r, r, barL, gun, { metal: 0.92, rough: 0.26 }); barrel.position.z = s[2] * 0.22; g.add(barrel);
  for (let i = 0; i < 2; i++){ const band = ringZ(T, 0.115, 0.02, steel, { metal: 0.7 }); band.position.z = s[2] * (0.1 + i * 0.18); g.add(band); }
  const brakeZ = s[2] * 0.46;
  const brake = cylZ(T, r * 1.7, r * 1.5, s[2] * 0.09, '#202225', { metal: 0.85 }); brake.position.z = brakeZ; g.add(brake);
  const pV = cyl(T, r * 0.4, r * 0.4, r * 3.7, dark); pV.position.z = brakeZ; g.add(pV);
  const pH = cyl(T, r * 0.4, r * 0.4, r * 3.7, dark); pH.rotation.z = Math.PI / 2; pH.position.z = brakeZ; g.add(pH);
  const rod = cylZ(T, 0.025, 0.025, barL * 0.9, '#4a4d52', { metal: 0.7 }); rod.position.set(0, r * 1.4, s[2] * 0.2); g.add(rod);
  const lug = box(T, s[0] * 0.16, s[1] * 0.2, s[2] * 0.28, '#4a4d52', { metal: 0.7 }); lug.position.set(0, -s[1] * 0.32, -s[2] * 0.22); g.add(lug);
  return g;
}
// Flak cannon: short fat large-bore barrel, flared blast cone, brass shell clip.
function buildFlak(T, d){
  const s = D(d.size); const g = new T.Group();
  const steel = '#3a3d42', gun = '#26282b';
  const recv = box(T, s[0] * 0.46, s[1] * 0.5, s[2] * 0.4, steel, { metal: 0.72, rough: 0.4 }); recv.position.z = -s[2] * 0.26; g.add(recv);
  const r = 0.16, barL = s[2] * 0.5;
  const barrel = cylZ(T, r, r, barL, gun, { metal: 0.9, rough: 0.3 }); barrel.position.z = s[2] * 0.18; g.add(barrel);
  for (let i = 0; i < 2; i++){ const band = ringZ(T, r * 1.12, 0.025, steel, { metal: 0.7 }); band.position.z = s[2] * (0.0 + i * 0.16); g.add(band); }
  const cone1 = new T.Mesh(new T.CylinderGeometry(0.26, r, s[2] * 0.3, 24, 1, true), mat(T, '#202225', { metal: 0.85, rough: 0.4 })); cone1.rotation.x = Math.PI / 2; cone1.position.z = s[2] * 0.5; cone1.material.side = T.DoubleSide; g.add(cone1);
  const fs = ringZ(T, 0.2, 0.02, '#5a5d62', { metal: 0.7 }); fs.position.z = s[2] * 0.42; g.add(fs);
  for (let i = 0; i < 4; i++){ const sh = cyl(T, 0.05, 0.06, 0.22, '#b89a3a', { metal: 0.6, emissive: 0x2a1e00, ei: 0.4 }); sh.position.set((i - 1.5) * s[0] * 0.13, s[1] * 0.34, -s[2] * 0.24); g.add(sh); }
  const mag = box(T, s[0] * 0.6, s[1] * 0.1, s[2] * 0.24, '#2b2e34', { metal: 0.6 }); mag.position.set(0, s[1] * 0.24, -s[2] * 0.24); g.add(mag);
  const lug = box(T, s[0] * 0.18, s[1] * 0.22, s[2] * 0.3, '#4a4d52', { metal: 0.7 }); lug.position.set(0, -s[1] * 0.36, -s[2] * 0.18); g.add(lug);
  return g;
}
// Railgun: twin parallel accelerator rails, glowing coil rings, capacitor bank.
function buildRailgun(T, d){
  const s = D(d.size); const g = new T.Group();
  const breech = box(T, s[0] * 0.4, s[1] * 0.42, s[2] * 0.3, '#2a2f35', { metal: 0.7, rough: 0.4 }); breech.position.z = -s[2] * 0.32; g.add(breech);
  for (const sx of [-1, 1]){ const cap = cylZ(T, 0.06, 0.06, s[2] * 0.2, '#7fc0ff', { metal: 0.4, emissive: 0x2060a0, ei: 1.2 }); cap.position.set(sx * s[0] * 0.18, 0, -s[2] * 0.34); g.add(cap); }
  const arm = box(T, s[0] * 0.12, s[1] * 0.12, s[2] * 0.06, '#bfe6ff', { emissive: 0x4aa0ff, ei: 1.6 }); arm.position.z = -s[2] * 0.14; g.add(arm);
  const railL = s[2] * 0.74, gap = 0.07;
  for (const sx of [-1, 1]){ const rail = box(T, 0.05, 0.08, railL, '#9aa3ab', { metal: 0.9, rough: 0.3 }); rail.position.set(sx * gap, 0, s[2] * 0.12); g.add(rail); }
  const bridge = box(T, gap * 2 + 0.1, 0.06, s[2] * 0.04, '#7a828c', { metal: 0.85 }); bridge.position.z = s[2] * 0.48; g.add(bridge);
  for (let i = 0; i < 6; i++){ const coil = ringZ(T, 0.13, 0.022, '#4aa0ff', { metal: 0.4, emissive: 0x2060ff, ei: 1.2 }); coil.position.z = s[2] * (-0.18 + i * 0.13); g.add(coil); }
  const glow = glowZ(T, 0.09, '#bfe6ff', 2.0); glow.position.z = s[2] * 0.5; g.add(glow);
  const lug = box(T, s[0] * 0.16, s[1] * 0.2, s[2] * 0.26, '#4a4d52', { metal: 0.7 }); lug.position.set(0, -s[1] * 0.3, -s[2] * 0.1); g.add(lug);
  return g;
}
// Short-range AAM: two stubby IR rounds with oversized double fin sets.
function buildSRAAM(T, d){
  const s = D(d.size); const g = new T.Group();
  const rail = box(T, s[0] * 0.2, s[1] * 0.18, s[2] * 0.7, '#3f444b', { metal: 0.62, rough: 0.45 }); rail.position.y = s[1] * 0.16; g.add(rail);
  const R = 0.078, len = s[2] * 0.66;
  for (const sx of [-1, 1]){ const m = new T.Group();
    const body = cylZ(T, R, R, len * 0.58, '#e2e7ee', { metal: 0.45, rough: 0.4 }); body.position.z = -len * 0.04; m.add(body);
    const motor = cylZ(T, R, R * 0.98, len * 0.2, '#c7ccd2', { metal: 0.5, rough: 0.45 }); motor.position.z = -len * 0.36; m.add(motor);
    const fore = cylZ(T, R, R, len * 0.12, '#cfd3d8', { metal: 0.5, rough: 0.35 }); fore.position.z = len * 0.3; m.add(fore);
    const dome = capZ(T, R, '#a7dcff', { metal: 0.1, rough: 0.05, transparent: true, opacity: 0.62, emissive: 0x16384f, ei: 0.6 }); dome.position.z = len * 0.38; m.add(dome);
    const band = cylZ(T, R * 1.04, R * 1.04, len * 0.05, '#ff5a4d', { metal: 0.4 }); band.position.z = len * 0.14; m.add(band);
    cruciform(T, m, len * 0.06, R, R * 1.6, len * 0.2, 0.016, '#cfd3d8', { offset: Math.PI / 4 });
    cruciform(T, m, -len * 0.36, R, R * 1.45, len * 0.18, 0.016, '#c2c7cd');
    const noz = cylZ(T, R * 0.5, R * 0.72, len * 0.05, '#1a1a1c', { metal: 0.6, open: true }); noz.position.z = -len * 0.47; m.add(noz);
    m.position.set(sx * s[0] * 0.18, -s[1] * 0.24, 0);
    const hang = box(T, 0.03, s[1] * 0.18, R * 1.4, '#2b2d31', { metal: 0.7 }); hang.position.set(sx * s[0] * 0.18, -s[1] * 0.04, 0); g.add(hang);
    g.add(m); }
  return g;
}
// Long-range AAM: two slender radar needles + an antenna patch on the rail.
function buildLRAAM(T, d){
  const s = D(d.size); const g = new T.Group();
  const rail = box(T, s[0] * 0.22, s[1] * 0.16, s[2] * 0.84, '#33404a', { metal: 0.6, rough: 0.45 }); rail.position.y = s[1] * 0.16; g.add(rail);
  const patch = box(T, s[0] * 0.14, s[1] * 0.02, s[2] * 0.3, '#33506a', { metal: 0.4, emissive: 0x102840, ei: 0.8 }); patch.position.set(0, s[1] * 0.25, -s[2] * 0.1); g.add(patch);
  const R = 0.06, len = s[2] * 0.92;
  for (const sx of [-1, 1]){ const m = new T.Group();
    const body = cylZ(T, R, R, len * 0.7, '#c6cdd6', { metal: 0.45, rough: 0.4 }); body.position.z = -len * 0.04; m.add(body);
    const nose = ogiveZ(T, R, len * 0.26, '#d7d1c2', { metal: 0.25, rough: 0.55, sharp: 1.6 }); nose.position.z = len * 0.36; m.add(nose);
    const band = cylZ(T, R * 1.05, R * 1.05, len * 0.04, '#ff7d4d', { metal: 0.4 }); band.position.z = len * 0.18; m.add(band);
    cruciform(T, m, len * 0.02, R, R * 0.8, len * 0.08, 0.012, '#cfd3d8', { offset: Math.PI / 4 });
    cruciform(T, m, -len * 0.4, R, R * 1.0, len * 0.12, 0.012, '#c2c7cd');
    const noz = cylZ(T, R * 0.5, R * 0.7, len * 0.05, '#1a1a1c', { metal: 0.6, open: true }); noz.position.z = -len * 0.46; m.add(noz);
    m.position.set(sx * s[0] * 0.2, -s[1] * 0.2, 0);
    const hang = box(T, 0.03, s[1] * 0.16, R * 1.4, '#2b2d31', { metal: 0.7 }); hang.position.set(sx * s[0] * 0.2, -s[1] * 0.04, 0); g.add(hang);
    g.add(m); }
  return g;
}
// Anti-ship: a pair of winged sea-skimmers with belly intakes on a wide pylon.
function buildAntiShip(T, d){
  const s = D(d.size); const g = new T.Group();
  const pylon = box(T, s[0] * 0.5, s[1] * 0.2, s[2] * 0.7, '#5a626b', { metal: 0.6 }); pylon.position.y = s[1] * 0.2; g.add(pylon);
  const R = 0.11, len = s[2] * 0.9;
  for (const sx of [-1, 1]){ const m = new T.Group();
    const body = cylZ(T, R, R, len * 0.66, '#b8c0ca', { metal: 0.45, rough: 0.45 }); body.position.z = -len * 0.03; m.add(body);
    const nose = ogiveZ(T, R, len * 0.22, '#cfd3d8', { metal: 0.3, rough: 0.5, sharp: 1.2 }); nose.position.z = len * 0.34; m.add(nose);
    const tip = new T.Mesh(new T.SphereGeometry(R * 0.32, 8, 6), mat(T, '#1a1d22', { metal: 0.3, rough: 0.3 })); tip.position.z = len * 0.44; m.add(tip);
    const intake = box(T, R * 0.9, R * 0.7, len * 0.22, '#11151a', { metal: 0.6 }); intake.position.set(0, -R * 1.05, -len * 0.12); m.add(intake);
    for (const wx of [-1, 1]){ const wing = box(T, R * 2.0, 0.02, len * 0.18, '#aeb4bb', { metal: 0.4 }); wing.position.set(wx * (R + R * 1.0), 0, 0); m.add(wing); }
    cruciform(T, m, -len * 0.4, R, R * 0.9, len * 0.12, 0.014, '#c2c7cd');
    const band = cylZ(T, R * 1.03, R * 1.03, len * 0.04, '#ff6a4d', { metal: 0.4 }); band.position.z = len * 0.16; m.add(band);
    const noz = cylZ(T, R * 0.55, R * 0.78, len * 0.05, '#1a1a1c', { metal: 0.6, open: true }); noz.position.z = -len * 0.45; m.add(noz);
    m.position.set(sx * s[0] * 0.26, -s[1] * 0.24, 0);
    const hang = box(T, 0.04, s[1] * 0.2, R * 1.5, '#2b2d31', { metal: 0.7 }); hang.position.set(sx * s[0] * 0.26, -s[1] * 0.04, 0); g.add(hang);
    g.add(m); }
  return g;
}
// Aerial torpedo: one fat blunt body, ducted ring tail, contra-screw, U-cradle.
function buildTorpedo(T, d){
  const s = D(d.size); const g = new T.Group();
  const R = 0.16, len = s[2] * 0.92;
  g.add(cylZ(T, R, R, len * 0.72, '#b0b8c2', { metal: 0.5, rough: 0.6 }));
  const nose = capZ(T, R, '#b0b8c2', { metal: 0.5, rough: 0.6 }); nose.position.z = len * 0.36; g.add(nose);
  for (const z of [-0.1, 0.12]){ const b = ringZ(T, R * 1.02, 0.018, '#7a828c', { metal: 0.5 }); b.position.z = len * z; g.add(b); }
  const ductR = R * 1.5;
  const duct = cylZ(T, ductR, ductR, len * 0.2, '#9aa3ab', { metal: 0.6, rough: 0.45, open: true }); duct.position.z = -len * 0.4; g.add(duct);
  const ductRimF = ringZ(T, ductR, 0.022, '#7a828c', { metal: 0.6 }); ductRimF.position.z = -len * 0.3; g.add(ductRimF);
  const ductRimB = ringZ(T, ductR, 0.022, '#7a828c', { metal: 0.6 }); ductRimB.position.z = -len * 0.5; g.add(ductRimB);
  cruciform(T, g, -len * 0.4, R * 0.9, ductR - R * 0.9, len * 0.14, 0.022, '#9aa3ab');
  const hub = cylZ(T, R * 0.2, R * 0.14, len * 0.1, '#3a3d42', { metal: 0.7 }); hub.position.z = -len * 0.42; g.add(hub);
  for (const [zoff, rot] of [[-len * 0.38, 0], [-len * 0.46, Math.PI / 4]]){ for (let i = 0; i < 4; i++){ const bl = box(T, R * 1.3, 0.035, R * 0.26, '#23282e', { metal: 0.5 }); bl.rotation.z = i * Math.PI / 2 + rot; bl.position.z = zoff; g.add(bl); } }
  for (const zc of [-0.18, 0.18]){ const arm = box(T, R * 2.6, R * 0.4, s[2] * 0.06, '#3f444b', { metal: 0.6 }); arm.position.set(0, R * 0.6, len * zc); g.add(arm);
    for (const ax of [-1, 1]){ const post = box(T, R * 0.3, R * 0.9, s[2] * 0.06, '#3f444b', { metal: 0.6 }); post.position.set(ax * R * 1.1, R * 0.2, len * zc); g.add(post); } }
  return g;
}
// Guided bomb: a seeker-dome nose, steering canards and a boxed lattice tail kit.
function buildGuidedBomb(T, d){
  const s = D(d.size); const g = new T.Group();
  const rack = box(T, s[0] * 0.3, s[1] * 0.16, s[2] * 0.6, '#3f444b', { metal: 0.6 }); rack.position.y = s[1] * 0.22; g.add(rack);
  const lug = box(T, 0.025, s[1] * 0.16, 0.05, '#2b2d31', { metal: 0.7 }); lug.position.set(0, -s[1] * 0.02, 0); g.add(lug);
  const col = CAT_COLORS.bomb, r = 0.16, len = s[2] * 0.86;
  const b = new T.Group();
  b.add(cylZ(T, r, r, len * 0.5, col, { metal: 0.34, rough: 0.55 }));
  const collar = cylZ(T, r * 0.8, r, len * 0.12, '#cfd3d8', { metal: 0.5 }); collar.position.z = len * 0.31; b.add(collar);
  const dome = capZ(T, r * 0.6, '#a7dcff', { metal: 0.1, rough: 0.05, transparent: true, opacity: 0.6, emissive: 0x16384f, ei: 0.6 }); dome.position.z = len * 0.4; b.add(dome);
  const boat = cylZ(T, r * 0.62, r, len * 0.16, col, { metal: 0.34, rough: 0.55 }); boat.position.z = -len * 0.33; b.add(boat);
  const band = cylZ(T, r * 1.03, r * 1.03, len * 0.045, '#d8d24d', { metal: 0.4 }); band.position.z = len * 0.12; b.add(band);
  cruciform(T, b, len * 0.16, r, r * 0.7, len * 0.08, 0.014, '#cfd3d8', { offset: Math.PI / 4 });
  const finR = r * 0.5 + r * 1.1;
  cruciform(T, b, -len * 0.4, r * 0.5, r * 1.1, len * 0.16, 0.018, '#cfd3d8');
  const ring = ringZ(T, finR, 0.02, '#aeb4bb', { metal: 0.4 }); ring.position.z = -len * 0.46; b.add(ring);
  const barH = box(T, finR * 2, 0.02, 0.02, '#9aa3ab'); barH.position.z = -len * 0.46; b.add(barH);
  const barV = box(T, 0.02, finR * 2, 0.02, '#9aa3ab'); barV.position.z = -len * 0.46; b.add(barV);
  b.position.set(0, -s[1] * 0.26, 0); g.add(b);
  return g;
}
// Napalm: two fat finless rounded firebomb cannisters on a twin-lug rack.
function buildNapalm(T, d){
  const s = D(d.size); const g = new T.Group();
  const rack = box(T, s[0] * 0.32, s[1] * 0.16, s[2] * 0.62, '#3f444b', { metal: 0.6 }); rack.position.y = s[1] * 0.22; g.add(rack);
  const R = 0.2;
  for (const sx of [-1, 1]){ const c = new T.Group();
    c.add(cylZ(T, R, R, s[2] * 0.5, '#c87a32', { metal: 0.3, rough: 0.6, emissive: 0x3a1a00, ei: 0.5 }));
    const n1 = capZ(T, R, '#c87a32', { metal: 0.3, rough: 0.6, emissive: 0x3a1a00, ei: 0.5 }); n1.position.z = s[2] * 0.25; c.add(n1);
    const n2 = capZ(T, R, '#c87a32', { metal: 0.3, rough: 0.6, emissive: 0x3a1a00, ei: 0.5 }, true); n2.position.z = -s[2] * 0.25; c.add(n2);
    const band = ringZ(T, R, 0.02, '#ff8a3d', { metal: 0.4, emissive: 0x4a2200, ei: 0.6 }); c.add(band);
    const spike = cylZ(T, 0.02, 0.02, s[2] * 0.12, '#2b2d31', { metal: 0.7 }); spike.position.z = s[2] * 0.33; c.add(spike);
    c.position.set(sx * s[0] * 0.22, -s[1] * 0.26, 0); g.add(c);
    const lug = box(T, 0.025, s[1] * 0.16, 0.05, '#2b2d31', { metal: 0.7 }); lug.position.set(sx * s[0] * 0.22, -s[1] * 0.02, 0); g.add(lug); }
  return g;
}
// Cruise missile: one long air-breather with pop-out wings + ventral intake.
function buildCruise(T, d){
  const s = D(d.size); const g = new T.Group();
  const pylon = box(T, s[0] * 0.22, s[1] * 0.16, s[2] * 0.5, '#5a626b', { metal: 0.6 }); pylon.position.y = s[1] * 0.22; g.add(pylon);
  const R = 0.13, len = s[2] * 0.95;
  const m = new T.Group();
  m.add(cylZ(T, R, R, len * 0.72, '#8a909a', { metal: 0.45, rough: 0.5 }));
  const nose = ogiveZ(T, R, len * 0.16, '#9aa0aa', { metal: 0.4, rough: 0.5, sharp: 1.1 }); nose.position.z = len * 0.4; m.add(nose);
  const win = capZ(T, R * 0.4, '#222', { metal: 0.3, rough: 0.3 }); win.position.z = len * 0.47; m.add(win);
  for (const wx of [-1, 1]){ const wing = box(T, R * 2.4, 0.025, len * 0.16, '#7a828c', { metal: 0.4 }); wing.position.set(wx * (R + R * 1.2), -R * 0.1, 0); m.add(wing); }
  const scoop = cylZ(T, R * 0.5, R * 0.55, len * 0.2, '#11151a', { metal: 0.6 }); scoop.position.set(0, -R * 1.05, -len * 0.14); m.add(scoop);
  const lip = ringZ(T, R * 0.52, 0.02, '#2a2f35', { metal: 0.7 }); lip.position.set(0, -R * 1.05, -len * 0.04); m.add(lip);
  for (const z of [-0.1, 0.14]){ const b = ringZ(T, R * 1.01, 0.016, '#6a727c', { metal: 0.5 }); b.position.z = len * z; m.add(b); }
  cruciform(T, m, -len * 0.42, R, R * 0.9, len * 0.12, 0.016, '#7a828c');
  const noz = bell(T, R * 0.5, R * 0.7, len * 0.08, '#2a2a2c', { hot: 0x402000 }); noz.position.z = -len * 0.48; m.add(noz);
  m.position.set(0, -s[1] * 0.16, 0); g.add(m);
  const hang = box(T, 0.04, s[1] * 0.16, R * 2, '#2b2d31', { metal: 0.7 }); hang.position.set(0, s[1] * 0.02, 0); g.add(hang);
  return g;
}

// ---- high-quality engine / tank / cockpit builders (KSP-style detail) -------
// A jet/turbofan: intake compressor face + spinner, banded casing, afterburner bell + exhaust glow.
// A turbofan: smooth cowling, a deep intake with a visible multi-blade FAN FACE
// (pitched radial blades + central spinner) and a turbine exhaust. o.ab adds an
// afterburner can + brighter flame. This is the shared model for every jet engine.
function buildJet(T, d, o = {}){
  const s = D(d.size); const g = new T.Group(); const R = Math.min(s[0], s[1]) * 0.46, L = s[2];
  const col = o.color || '#9ba2a9';                           // turbofans read grey, not engine-copper
  const fz = L * 0.42;                                        // front (intake) plane
  // smooth cowling, gently tapering toward the exhaust
  g.add(cylZ(T, R, R * 0.9, L * 0.84, col, { metal: 0.68, rough: 0.4 }));
  for (const z of [0.16, -0.16]){ const b = ringZ(T, R * 1.004, 0.008, '#828990', { metal: 0.5, rough: 0.5 }); b.position.z = L * z; g.add(b); }
  // Intake: a dark face over the cowling cap, a pitched-blade FAN around a spinner,
  // ringed by a fat rounded lip so it reads as a recessed turbofan intake. Everything
  // sits PROUD of the cap (the solid cowling would occlude anything recessed behind it).
  const face = cylZ(T, R * 0.86, R * 0.86, 0.02, '#0f1216', { metal: 0.35, rough: 0.85 }); face.position.z = fz + L * 0.006; g.add(face);
  const NB = Math.max(18, Math.round(R * 42));
  for (let i = 0; i < NB; i++){
    const bg = new T.Group(); bg.rotation.z = i / NB * Math.PI * 2;
    const bl = box(T, R * 0.58, 0.016, R * 0.085, '#9aa2ab', { metal: 0.9, rough: 0.28 });
    bl.position.x = R * 0.44; bl.rotation.x = 0.6;           // pitch about the radial axis
    bg.add(bl); bg.position.z = fz + L * 0.02; g.add(bg);
  }
  const hub = cyl(T, R * 0.19, R * 0.21, L * 0.05, '#5a626b', { metal: 0.85 }); hub.rotation.x = Math.PI / 2; hub.position.z = fz + L * 0.03; g.add(hub);
  const spinner = cone(T, R * 0.2, L * 0.07, '#aeb5bd', { metal: 0.8, rough: 0.3 }); spinner.rotation.x = Math.PI / 2; spinner.position.z = fz + L * 0.025; g.add(spinner);
  const lip = ringZ(T, R * 0.9, R * 0.1, '#2a2f35', { metal: 0.85, rough: 0.3 }); lip.position.z = fz + L * 0.03; g.add(lip);
  // rear: turbine exhaust — short taper to a small dark nozzle. Afterburning jets
  // (o.ab, or any part with an afterburner multiplier) grow a reheat can + brighter flame.
  const ab = o.ab || (d && d.afterburner >= 1.4);
  const tail = cylZ(T, R * 0.9, R * 0.56, L * 0.14, '#33373d', { metal: 0.72, rough: 0.45 }); tail.position.z = -L * 0.45; g.add(tail);
  if (ab){ const can = cylZ(T, R * 0.62, R * 0.58, L * 0.14, '#2a2d33', { metal: 0.72, rough: 0.4 }); can.position.z = -L * 0.55; g.add(can);
    const ring = ringZ(T, R * 0.58, R * 0.05, '#1c1f24', { metal: 0.7 }); ring.position.z = -L * 0.58; g.add(ring); }
  else { const ring = ringZ(T, R * 0.56, R * 0.045, '#23262b', { metal: 0.7 }); ring.position.z = -L * 0.52; g.add(ring); }
  const exh = cylZ(T, R * 0.5, R * 0.5, 0.02, '#160b06', { emissive: o.hot ?? 0x3a1206, ei: 1 }); exh.position.z = -L * (ab ? 0.6 : 0.51); g.add(exh);
  const glow = glowZ(T, R * (ab ? 0.54 : 0.46), o.glow || '#ffcaa0', ab ? 2.8 : 1.5); glow.position.z = -L * (ab ? 0.62 : 0.55); g.add(glow);
  return g;
}
// A liquid rocket: injector head + twin turbopumps, a chamber that necks to the
// throat, fuel feed-lines running down to the bell, and a big curved nozzle.
function buildRocket(T, d, o = {}){
  const s = D(d.size); const g = new T.Group(); const R = Math.min(s[0], s[1]) * 0.42;
  const col = o.color || '#c4472a';
  const head = cylZ(T, R * 0.58, R * 0.85, s[2] * 0.13, '#9aa3ab', { metal: 0.82, rough: 0.35 }); head.position.z = s[2] * 0.41; g.add(head);
  for (const sx of [-1, 1]){ const pump = cyl(T, R * 0.2, R * 0.2, R * 0.55, '#7a828a', { metal: 0.8 }); pump.rotation.x = Math.PI / 2; pump.position.set(sx * R * 0.55, 0, s[2] * 0.34); g.add(pump); }
  g.add(cylZ(T, R * 0.84, R * 0.5, s[2] * 0.34, col, { metal: 0.6, rough: 0.45 }));          // chamber → throat
  for (const z of [0.3, 0.18]){ const b = ringZ(T, R * 0.74, 0.025, '#6a6f74', { metal: 0.7 }); b.position.z = s[2] * z; g.add(b); }
  for (const sx of [-1, 1]){ const line = cyl(T, 0.025, 0.025, s[2] * 0.5, '#cfd6dd', { metal: 0.7 }); line.rotation.x = Math.PI / 2; line.rotation.z = sx * 0.1; line.position.set(sx * R * 0.72, 0, -s[2] * 0.04); g.add(line); }
  const noz = bell(T, R * 0.5, R * 0.98, s[2] * 0.5, '#2a2a2c', { hot: o.hot ?? 0x4aa0ff }); noz.position.z = -s[2] * 0.2; g.add(noz);
  const glow = glowZ(T, R * 0.74, o.glow || '#aee0ff', 2.6); glow.position.z = -s[2] * 0.46; g.add(glow);
  return g;
}
// A turboprop: cowled nacelle, spinner and a 4-blade propeller.
function buildProp(T, d, o = {}){
  const s = D(d.size); const g = new T.Group(); const R = Math.min(s[0], s[1]) * 0.34;
  g.add(cylZ(T, R, R * 0.9, s[2] * 0.7, o.color || CAT_COLORS.engine, { metal: 0.6, rough: 0.5 }));
  const cowl = ringZ(T, R * 1.06, 0.04, '#2a2f35', { metal: 0.7 }); cowl.position.z = s[2] * 0.32; g.add(cowl);
  const spin = cone(T, R * 0.3, s[2] * 0.26, '#cdd6df', { metal: 0.7 }); spin.rotation.x = Math.PI / 2; spin.position.z = s[2] * 0.46; g.add(spin);
  for (let i = 0; i < 4; i++){ const bl = box(T, s[0] * 0.78, 0.05, 0.16, '#23282e', { metal: 0.5 }); bl.position.z = s[2] * 0.4; bl.rotation.z = i / 4 * Math.PI * 2; g.add(bl); }
  return g;
}
// A solid rocket booster: segmented casing, nose cap, stubby nozzle.
function buildSRB(T, d, o = {}){
  const s = D(d.size); const g = new T.Group(); const R = Math.min(s[0], s[1]) * 0.46;
  g.add(cylZ(T, R, R, s[2] * 0.82, o.color || '#b7b0a4', { metal: 0.4, rough: 0.7 }));
  for (let z = -0.3; z <= 0.34; z += 0.16){ const b = ringZ(T, R * 1.02, 0.03, '#8a8478', { metal: 0.5 }); b.position.z = s[2] * z; g.add(b); }
  const nose = cone(T, R, s[2] * 0.18, '#9a9488', { metal: 0.5 }); nose.rotation.x = Math.PI / 2; nose.position.z = s[2] * 0.5; g.add(nose);
  const noz = bell(T, R * 0.42, R * 0.7, s[2] * 0.28, '#1f1f1f', { hot: 0xff7a20 }); noz.position.z = -s[2] * 0.5; g.add(noz);
  const glow = glowZ(T, R * 0.5, '#ffd0a0', 2.4); glow.position.z = -s[2] * 0.62; g.add(glow);
  return g;
}
// A banded fuel tank with domed end caps.
function buildTank(T, d, o = {}){
  const s = D(d.size); const g = new T.Group(); const R = Math.min(s[0], s[1]) * (o.r || 0.47);
  const col = o.color || CAT_COLORS.fuel;
  g.add(cylZ(T, R, R, s[2] * 0.9, col, { metal: 0.42, rough: 0.55 }));
  const c1 = capZ(T, R, col, { metal: 0.42, rough: 0.55 }); c1.position.z = s[2] * 0.45; g.add(c1);
  const c2 = capZ(T, R, col, { metal: 0.42, rough: 0.55 }, true); c2.position.z = -s[2] * 0.45; g.add(c2);
  const n = Math.max(2, Math.round(s[2] / 1.0));
  for (let i = 1; i < n; i++){ const b = ringZ(T, R * 1.015, 0.02, '#8a7038', { metal: 0.5 }); b.position.z = s[2] * (-0.5 + i / n); g.add(b); }
  return g;
}
// ----------------------------------------------------------------------------
//  COCKPITS — the crew/command section. Its hero feature is the WINDSCREEN
//  CANOPY, NOT a pointed nose: a cockpit is a fuselage section you bolt a
//  separate nose cone IN FRONT of, so its front face is BLUNT/FLAT (a pointed
//  cockpit reads as a warhead). The ONE exception is the 'mk2' style — a sleek
//  spaceplane cockpit with an INTEGRATED chiselled nose. Styles:
//   'fighter' (default) = blunt fuselage drum + raised framed bubble canopy
//   'inline'  = low flush body + wide low wraparound canopy
//   'heavy'   = 'fighter' + bolt-on armour cheek plates
//   'capsule' = cylindrical command pod (top hatch + side window), no canopy
//   'mk2'     = sleek INTEGRATED nose + faceted forward-raked windscreen (the
//               only style that carries its own nose)
//   'mk3'     = wide heavy-bomber cockpit: blunt full-width multi-pane glasshouse
function buildCockpit(T, d, o = {}){
  const s = D(d.size), g = new T.Group(), R = Math.min(s[0], s[1]) * 0.46, L = s[2];
  const col = o.color || '#c9cfd6', metal = o.metal ?? 0.55, hull = { metal, rough: 0.5 };  // light grey-white hull (KSP-style), not the cyan command tint
  const fc = '#16191d';                                       // window frame / gasket (near-black)
  const gc = o.glass2 || '#1c4150';                           // visible dark teal-blue glass — reads as a canopy on dark AND light backgrounds against the pale hull
  const gmat = { metal: 0.15, rough: 0.12, transparent: true, opacity: 0.84, emissive: 0x0a2330, ei: 0.5 };
  const style = o.style || 'fighter';
  const P = (z, x) => { x.position.z = z; g.add(x); return x; };
  const glassMesh = (geo) => { const m = new T.Mesh(geo, mat(T, gc, gmat)); m.material.side = T.DoubleSide; return m; };
  // standard rear engine-mount collar + base plug shared by the noseless styles
  const rearEnd = () => {
    P(-L * 0.46, cylZ(T, R * 1.03, R * 0.99, L * 0.08, '#3a4046', { metal: 0.72, rough: 0.4 }));
    P(-L * 0.49, ringZ(T, R * 0.99, R * 0.03, fc, { metal: 0.6 }));
    P(-L * 0.47, cylZ(T, R * 0.95, R * 0.95, L * 0.03, '#1c2126', { metal: 0.4, rough: 0.7 }));
  };
  // a BLUNT flat front face (front rim + recessed bulkhead) — where a nose part bolts on
  const bluntFront = (zf) => {
    P(zf, ringZ(T, R * 1.008, R * 0.022, '#3a4046', { metal: 0.5 }));                        // front rim
    P(zf - L * 0.02, cylZ(T, R * 0.9, R * 0.9, L * 0.02, '#23282e', { metal: 0.45, rough: 0.65 }));  // recessed bulkhead
  };

  // ---------- capsule: cylindrical command pod (drum + top hatch + side window) ----------
  if (style === 'capsule'){
    const rb = R, rt = R * 0.84;
    g.add(cylZ(T, rt, rb, L * 0.9, col, hull));
    P(L * 0.45, ringZ(T, rt, R * 0.045, fc, { metal: 0.6 }));
    P(-L * 0.45, ringZ(T, rb, R * 0.045, fc, { metal: 0.6 }));
    P(-L * 0.47, cylZ(T, rb * 0.97, rb * 0.97, L * 0.03, '#1c2126', { metal: 0.4, rough: 0.7 }));
    // top deck + raised hatch with a square window
    P(L * 0.46, cylZ(T, rt * 0.98, rt * 0.98, L * 0.015, '#b3bbc4', { metal: 0.6, rough: 0.4 }));
    const hr = rt * 0.52;
    P(L * 0.49, cylZ(T, hr, hr * 1.05, L * 0.05, '#9aa3ac', { metal: 0.7, rough: 0.35 }));
    P(L * 0.5, ringZ(T, hr, R * 0.025, fc, { metal: 0.6 }));
    const wf = box(T, hr * 0.95, hr * 0.95, 0.025, fc, { metal: 0.5 }); wf.position.z = L * 0.505; g.add(wf);
    const wg = glassMesh(new T.BoxGeometry(hr * 0.72, hr * 0.72, 0.03)); wg.position.z = L * 0.52; g.add(wg);
    // side capsule window on +Y, framed + central divider
    const swH = R * 0.5, swL = L * 0.44;
    const sf = box(T, swH * 1.18, 0.04, swL * 1.12, fc, { metal: 0.5 }); sf.position.set(0, rb * 0.9, 0); g.add(sf);
    const sg = glassMesh(new T.BoxGeometry(swH, 0.05, swL)); sg.position.set(0, rb * 0.92, 0); g.add(sg);
    const dv = box(T, swH * 1.1, 0.055, 0.028, fc, { metal: 0.5 }); dv.position.set(0, rb * 0.93, 0); g.add(dv);
    for (const dz of [-0.16, -0.05, 0.06]){ const v = box(T, 0.02, R * 0.2, 0.012, '#3a4048', { metal: 0.5 }); v.position.set(rb * 0.82, R * 0.05, dz * L); g.add(v); }
    return g;
  }

  // ---------- mk2: the ONE cockpit with an INTEGRATED nose (sleek spaceplane) ----------
  if (style === 'mk2'){
    const bodyL = L * 0.5, nz = bodyL / 2, noseL = L * 0.5;
    g.add(cylZ(T, R, R, bodyL, col, hull));                                                 // rear body
    const nose = ogiveZ(T, R, noseL, col, { ...hull, sharp: 0.9, seg: 26 });                // sleek chiselled nose — the exception
    nose.position.z = nz + noseL / 2; g.add(nose);
    P(nz, ringZ(T, R * 1.006, R * 0.012, '#3a4046', { metal: 0.5 }));                        // body/nose seam
    rearEnd();
    // a sleek LOW canopy seated at the nose base — sits low & forward (spaceplane look),
    // with the chiselled nose running ahead of it. Reads clearly as a cockpit, not a cone.
    const cw = R * 0.74, chH = R * 0.5, clen = L * 0.5, cz = nz + clen * 0.06, cyb = R * 0.8, cl2 = clen * 0.5;
    const dome = glassMesh(new T.SphereGeometry(1, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.5));
    dome.scale.set(cw, chH, cl2); dome.position.set(0, cyb, cz); g.add(dome);
    const baseF = new T.Mesh(new T.TorusGeometry(1, 0.045, 6, 26), mat(T, fc, { metal: 0.5 }));
    baseF.scale.set(cw * 1.03, cl2 * 1.04, 1); baseF.rotation.x = Math.PI / 2; baseF.position.set(0, cyb, cz); g.add(baseF);
    const arch2 = (zz, rs) => { const m = new T.Mesh(new T.TorusGeometry(1, 0.035, 6, 16, Math.PI), mat(T, fc, { metal: 0.55 })); m.scale.set(cw * rs, chH * rs, 1); m.position.set(0, cyb, cz + zz); g.add(m); };
    arch2(cl2 * 0.9, 1.03);                                                                  // windscreen bow (front, raked over the nose)
    arch2(-cl2 * 0.4, 1.02);                                                                 // mid rib → 2 panes
    const spine2 = box(T, 0.022, 0.022, clen * 0.84, fc, { metal: 0.55 }); spine2.position.set(0, cyb + chH * 0.95, cz); g.add(spine2);   // top spine
    return g;
  }

  // ---------- mk3: WIDE heavy-bomber cockpit — blunt, full-width multi-pane glasshouse ----------
  if (style === 'mk3'){
    const bodyL = L * 0.96;
    g.add(cylZ(T, R, R, bodyL, col, hull));                                                 // wide body drum, FLAT front (no nose)
    bluntFront(bodyL / 2 - 0.002);
    rearEnd();
    for (const z of [-0.2, 0.04]){ const r = ringZ(T, R * 1.004, R * 0.01, '#39404a', { metal: 0.5 }); r.position.z = L * z; g.add(r); }  // hull seams
    // a wide, low wraparound glasshouse across the whole front-upper face
    const cw = R * 0.97, chH = R * 0.6, clen = L * 0.5, cz = L * 0.2, cyb = R * 0.58, cl2 = clen * 0.5;
    const dome = glassMesh(new T.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.5));
    dome.scale.set(cw, chH, cl2); dome.position.set(0, cyb, cz); g.add(dome);
    const baseF = new T.Mesh(new T.TorusGeometry(1, 0.05, 6, 34), mat(T, fc, { metal: 0.5 }));
    baseF.scale.set(cw * 1.03, cl2 * 1.04, 1); baseF.rotation.x = Math.PI / 2; baseF.position.set(0, cyb, cz); g.add(baseF);  // sill footprint
    // vertical mullions across the WIDTH → a row of side-by-side windows (the Mk3 'face')
    const front = cz + cl2 * 0.86;
    for (const xf of [-0.78, -0.4, 0, 0.4, 0.78]){
      const bar = box(T, 0.03, chH * 1.05, 0.05, fc, { metal: 0.55 });
      bar.rotation.x = -0.5;
      bar.position.set(xf * cw, cyb + chH * 0.34, front - Math.abs(xf) * cl2 * 0.18); g.add(bar);   // splay back toward the sides
    }
    const brow = new T.Mesh(new T.TorusGeometry(1, 0.045, 6, 20, Math.PI), mat(T, fc, { metal: 0.55 }));   // top brow frame
    brow.scale.set(cw * 1.02, chH * 1.02, 1); brow.position.set(0, cyb, cz - cl2 * 0.9); g.add(brow);
    return g;
  }

  // ---------- fighter / inline / heavy: a BLUNT fuselage hull + a bubble canopy ----------
  // The cockpit is NOT a pointed ogive (that reads as a warhead) — it is a blunt
  // fuselage section whose defining feature is a prominent windscreen CANOPY on
  // the top-front; its front is FLAT so a separate nose cone bolts on ahead of it.
  const inline = style === 'inline';
  const bodyL = L * 0.96;
  g.add(cylZ(T, R, R, bodyL, col, hull));                                                 // main fuselage drum (no nose)
  bluntFront(bodyL / 2 - 0.002);
  rearEnd();
  for (const z of [-0.18, 0.06]){ const r = ringZ(T, R * 1.004, R * 0.01, '#39404a', { metal: 0.5 }); r.position.z = L * z; g.add(r); }  // hull seams

  // ===== windscreen canopy — the hero feature, a raised framed bubble on the top-front =====
  const cw = R * (inline ? 0.66 : 0.82);          // canopy half-width (X)
  const chH = R * (inline ? 0.4 : 0.62);          // rise above its base (Y)
  const clen = L * (inline ? 0.5 : 0.58);         // length (Z)
  const cz = L * (inline ? 0.04 : 0.12);          // centre, toward the front
  const cyb = R * (inline ? 0.92 : 0.88);         // base height — equator sits ~ at the hull top
  const cl2 = clen * 0.5;
  const dome = glassMesh(new T.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5));
  dome.scale.set(cw, chH, cl2); dome.position.set(0, cyb, cz); g.add(dome);               // glass bubble
  const baseF = new T.Mesh(new T.TorusGeometry(1, 0.05, 6, 30), mat(T, fc, { metal: 0.5 }));
  baseF.scale.set(cw * 1.03, cl2 * 1.03, 1); baseF.rotation.x = Math.PI / 2; baseF.position.set(0, cyb, cz); g.add(baseF);  // base frame (footprint)
  const arch = (zz, rs) => { const m = new T.Mesh(new T.TorusGeometry(1, 0.04, 6, 18, Math.PI), mat(T, fc, { metal: 0.55 })); m.scale.set(cw * rs, chH * rs, 1); m.position.set(0, cyb, cz + zz); g.add(m); };
  arch(cl2 * 0.94, 1.03);                          // windscreen bow (front)
  arch(0, 1.015);                                  // centre rib
  arch(-cl2 * 0.92, 1.02);                         // rear rib → multi-pane
  const spine = box(T, 0.024, 0.024, clen * 0.9, fc, { metal: 0.55 }); spine.position.set(0, cyb + chH * 0.96, cz); g.add(spine);  // top spine mullion
  for (const sgn of [-1, 1]){ const v = box(T, 0.02, R * 0.05, L * 0.12, '#2c3137', { metal: 0.55 }); v.position.set(sgn * R * 0.36, R * 0.8, cz - clen * 0.6); g.add(v); }  // dorsal vents aft of canopy

  if (style === 'heavy'){
    for (const sgn of [-1, 1]){ const pl = box(T, R * 0.1, R * 0.56, L * 0.46, '#5b6772', { metal, rough: 0.5 }); pl.position.set(sgn * R * 0.72, R * 0.06, -L * 0.04); g.add(pl); }  // armour cheek plates
    P(L * 0.2, ringZ(T, R * 1.02, R * 0.04, '#4a545e', { metal: 0.7 }));                   // reinforcing band
  }
  return g;
}

// ============================================================================
//  MODEL ARCHETYPES — parametric, high-detail builders shared by the data
//  catalogue below. Original procedural geometry in the general shape language
//  of real aerospace hardware (banded tanks, bell nozzles, gimbals, airfoils),
//  sized to the part's grid footprint. A data part names one of these in `model`
//  and tunes it via `modelOpts`. Every builder defaults gracefully.
// ============================================================================
const Rof = (s) => Math.min(s[0], s[1]) * 0.47;            // body radius that fills the cell

// ---- structure / aero ----
function a_fuselage(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * (o.r || 1); const g = new T.Group();
  g.add(cylZ(T, R, R, s[2] * 0.98, o.color || CAT_COLORS.structure, { metal: o.metal ?? 0.6, rough: 0.45 }));
  for (const z of (o.bands || [0.3, -0.3])){ const b = ringZ(T, R * 1.02, 0.02, '#5a626b', { metal: 0.6 }); b.position.z = s[2] * z; g.add(b); } return g; }
function a_fuselageFlat(T, d, o = {}){ const s = D(d.size); const g = new T.Group(); const col = o.color || CAT_COLORS.structure;
  g.add(box(T, s[0] * 0.9, s[1] * 0.78, s[2] * 0.98, col, { metal: o.metal ?? 0.55, rough: 0.45 }));
  for (const sx of [-1, 1]){ const ch = cylZ(T, s[1] * 0.39, s[1] * 0.39, s[2] * 0.98, col, { metal: o.metal ?? 0.55 }); ch.position.x = sx * s[0] * 0.45; g.add(ch); } return g; }
function a_noseCone(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * (o.r || 1); const g = new T.Group();
  if (o.style === 'ogive'){ const seg = 18, geo = new T.LatheGeometry(Array.from({ length: 12 }, (_, i) => { const t = i / 11; return new T.Vector2(R * Math.sin(t * Math.PI * 0.5) * (1.05 - 0.05 * t), -s[2] * 0.5 + t * s[2]); }), seg); const m = new T.Mesh(geo, mat(T, o.color || CAT_COLORS.structure, { metal: 0.55 })); m.rotation.x = Math.PI / 2; g.add(m); }
  else { const c = cone(T, R, s[2] * (o.len || 1), o.color || CAT_COLORS.structure, { metal: 0.55 }); c.rotation.x = Math.PI / 2; g.add(c); }
  return g; }
function a_adapter(T, d, o = {}){ const s = D(d.size); const rf = Rof(s) * (o.rFront ?? 0.55), rb = Rof(s) * (o.rBack ?? 1); const g = new T.Group();
  const m = cylZ(T, rf, rb, s[2] * 0.96, o.color || CAT_COLORS.structure, { metal: 0.6 }); g.add(m);
  const lip = ringZ(T, rb * 1.02, 0.02, '#5a626b'); lip.position.z = -s[2] * 0.46; g.add(lip); return g; }
function a_fairing(T, d, o = {}){ const s = D(d.size); const R = Rof(s); const g = new T.Group();
  g.add(cylZ(T, R, R, s[2] * 0.6, o.color || '#cfd6dd', { metal: 0.5, rough: 0.4 }));
  const c = cone(T, R, s[2] * 0.4, o.color || '#cfd6dd', { metal: 0.5 }); c.rotation.x = Math.PI / 2; c.position.z = s[2] * 0.5; g.add(c);
  const seam = box(T, 0.02, R * 2.05, s[2] * 0.6, '#2a3038'); g.add(seam); return g; }
function a_intake(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * (o.r || 0.8); const g = new T.Group();
  const lip = ringZ(T, R, R * 0.18, '#2a3038', { metal: 0.85 }); lip.position.z = s[2] * 0.42; g.add(lip);
  g.add(cylZ(T, R * 0.92, R * 0.7, s[2] * 0.8, o.color || CAT_COLORS.aero, { metal: 0.75, rough: 0.35 }));
  const inner = cylZ(T, R * 0.7, R * 0.7, 0.04, '#11151a', { metal: 0.9 }); inner.position.z = s[2] * 0.4; g.add(inner); return g; }
// Static structural plate: a flat reinforced slab with a beveled rim, stiffener ribs and rivet rows.
function a_panel(T, d, o = {}){ const s = D(d.size); const th = s[1] * (o.thick || 0.16); const g = new T.Group();
  g.add(box(T, s[0] * 0.96, th, s[2] * 0.96, o.color || '#8b97a4', { metal: 0.5, rough: 0.5 }));      // plate
  const rim = box(T, s[0] * 0.99, th * 0.55, s[2] * 0.99, '#6a7480', { metal: 0.6 }); rim.position.y = th * 0.24; g.add(rim);   // beveled top skin
  for (let i = 0; i < 2; i++){ const rib = box(T, s[0] * 0.9, th * 0.5, 0.03, '#6a7480', { metal: 0.6 }); rib.position.z = s[2] * (-0.22 + i * 0.44); g.add(rib); }   // stiffener ribs
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++){ const rv = cyl(T, 0.012, 0.012, th * 1.1, '#5a626b'); rv.position.set((c - 1.5) * s[0] * 0.24, 0, (r - 0.5) * s[2] * 0.5); g.add(rv); }   // rivet rows
  return g; }
// Deployable airbrake / speedbrake: a perforated panel on a trailing-edge hinge.
function a_airbrake(T, d, o = {}){ const s = D(d.size); const th = s[1] * (o.thick || 0.14); const g = new T.Group();
  g.add(box(T, s[0] * 0.96, th, s[2] * 0.92, o.color || '#9aa6b2', { metal: 0.5 }));                  // brake panel
  const hinge = cyl(T, th * 0.7, th * 0.7, s[0] * 0.92, '#2a3038', { metal: 0.7 }); hinge.rotation.z = Math.PI / 2; hinge.position.z = -s[2] * 0.44; g.add(hinge);   // trailing-edge hinge
  for (let i = 0; i < 3; i++){ const slot = box(T, s[0] * 0.62, th * 1.1, 0.02, '#39404a', { metal: 0.5 }); slot.position.z = s[2] * (-0.18 + i * 0.18); g.add(slot); }   // perforation slots
  return g; }
function a_strut(T, d, o = {}){ const s = D(d.size); const g = new T.Group(); const col = o.color || '#7d858d';
  const L = s[2] * 0.96;                                                                // I-beam RUNS the full cell length along Z
  g.add(box(T, s[0] * 0.14, s[1] * 0.82, L, col, { metal: 0.6 }));                       // web
  const top = box(T, s[0] * 0.58, s[1] * 0.14, L, col, { metal: 0.6 }); top.position.y = s[1] * 0.42; g.add(top);    // top flange
  const bot = box(T, s[0] * 0.58, s[1] * 0.14, L, col, { metal: 0.6 }); bot.position.y = -s[1] * 0.42; g.add(bot);   // bottom flange
  const n = Math.max(2, Math.round(s[2]) + 1);
  for (let i = 0; i < n; i++){ const rib = box(T, s[0] * 0.2, s[1] * 0.68, 0.025, '#5a626b', { metal: 0.5 }); rib.position.z = (i / (n - 1) - 0.5) * L * 0.94; g.add(rib); }   // stiffener ribs
  return g; }
function a_truss(T, d, o = {}){ const s = D(d.size); const g = new T.Group(); const col = o.color || '#6f767d', r = 0.06;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]){ const bar = cylZ(T, r, r, s[2] * 0.96, col, { metal: 0.6 }); bar.position.set(sx * s[0] * 0.32, sy * s[1] * 0.32, 0); g.add(bar); }
  for (let z = -0.3; z <= 0.34; z += 0.33){ const ring = box(T, s[0] * 0.64, s[1] * 0.64, 0.05, col, { metal: 0.6 }); ring.position.z = s[2] * z; g.add(ring); } return g; }

// ---- fuel ----
function a_tank(T, d, o = {}){ return buildTank(T, d, o); }
function a_tankFlat(T, d, o = {}){ const s = D(d.size); const g = a_fuselageFlat(T, d, { color: o.color || CAT_COLORS.fuel, metal: 0.42 });
  for (const z of [0.25, -0.25]){ const b = box(T, s[0] * 0.92, s[1] * 0.8, 0.04, '#8a7038'); b.position.z = s[2] * z; g.add(b); } return g; }
function a_dropTank(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * 0.82; const g = new T.Group();
  g.add(cylZ(T, R, R, s[2] * 0.7, o.color || CAT_COLORS.fuel, { metal: 0.5 }));
  const nose = cone(T, R, s[2] * 0.22, o.color || CAT_COLORS.fuel); nose.rotation.x = Math.PI / 2; nose.position.z = s[2] * 0.45; g.add(nose);
  const tail = cone(T, R, s[2] * 0.18, o.color || CAT_COLORS.fuel); tail.rotation.x = -Math.PI / 2; tail.position.z = -s[2] * 0.42; g.add(tail);
  for (let f = 0; f < 3; f++){ const fin = box(T, 0.02, R * 1.3, s[2] * 0.22, '#9aa6b2'); fin.position.z = -s[2] * 0.38; fin.rotation.z = f / 3 * Math.PI * 2; g.add(fin); } return g; }
function a_monoTank(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * (o.r || 0.95); const m = new T.Mesh(new T.SphereGeometry(R, 20, 14), mat(T, o.color || CAT_COLORS.fuel, { metal: 0.45, rough: 0.5 })); return m; }
function a_toroidalTank(T, d, o = {}){ const s = D(d.size); const R = Rof(s); const m = new T.Mesh(new T.TorusGeometry(R * 0.7, R * 0.34, 12, 22), mat(T, o.color || CAT_COLORS.fuel, { metal: 0.45 })); m.rotation.x = Math.PI / 2; return m; }
function a_radialTank(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * 0.7; const g = new T.Group();
  g.add(cylZ(T, R, R, s[2] * 0.8, o.color || CAT_COLORS.fuel, { metal: 0.45 }));
  const c1 = capZ(T, R, o.color || CAT_COLORS.fuel, {}); c1.position.z = s[2] * 0.4; g.add(c1);
  const c2 = capZ(T, R, o.color || CAT_COLORS.fuel, {}, true); c2.position.z = -s[2] * 0.4; g.add(c2); return g; }

// ---- propulsion (most reuse the engine builders above) ----
function a_engineIon(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * 0.8; const g = new T.Group();
  g.add(cylZ(T, R, R, s[2] * 0.7, o.color || '#b8a36a', { metal: 0.6 }));
  const grid = cylZ(T, R * 0.78, R * 0.78, 0.05, '#33506a', { emissive: 0x2f7fff, ei: 1.6 }); grid.position.z = -s[2] * 0.36; g.add(grid);
  const glow = glowZ(T, R * 0.7, '#7fc0ff', 1.8); glow.position.z = -s[2] * 0.42; g.add(glow); return g; }
function a_engineRadial(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * 0.55; const g = new T.Group();
  g.add(box(T, s[0] * 0.4, s[1] * 0.4, s[2] * 0.4, '#3a3d42', { metal: 0.7 }));
  const noz = bell(T, R * 0.5, R * 0.8, s[2] * 0.42, '#2f2f33', { hot: o.hot ?? 0xff5a18 }); noz.position.z = -s[2] * 0.28; g.add(noz);
  const glow = glowZ(T, R * 0.5, o.glow || '#ffcaa0', 2); glow.position.z = -s[2] * 0.46; g.add(glow); return g; }
function a_engineAerospike(T, d, o = {}){ const s = D(d.size); const R = Rof(s); const g = new T.Group();
  g.add(cylZ(T, R, R * 0.9, s[2] * 0.4, o.color || '#b85a32', { metal: 0.6 }));
  const spike = cone(T, R * 0.75, s[2] * 0.6, '#2a2a2c', { metal: 0.85 }); spike.rotation.x = -Math.PI / 2; spike.position.z = -s[2] * 0.34; g.add(spike);
  const glow = glowZ(T, R * 0.7, o.glow || '#ffcaa0', 2.2); glow.position.z = -s[2] * 0.18; g.add(glow); return g; }
// SMALL vernier/vectoring thruster — a compact gimbaled nozzle, NOT an engine bell.
// Vectoring / vernier thruster: a mount collar, a gimbal ball joint and a clean
// engine bell. A small steerable motor, not a floating funnel.
function a_nozzle(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * 0.5; const g = new T.Group();
  const collar = cylZ(T, R * 0.5, R * 0.58, s[2] * 0.16, '#8a929b', { metal: 0.75, rough: 0.4 }); collar.position.z = s[2] * 0.26; g.add(collar);
  const ball = new T.Mesh(new T.SphereGeometry(R * 0.4, 14, 12), mat(T, '#454a50', { metal: 0.82, rough: 0.35 })); ball.position.z = s[2] * 0.1; g.add(ball);
  const noz = bell(T, R * 0.42, R * 0.72, s[2] * 0.42, '#2c2f34', { hot: o.hot ?? 0xff6a20 }); noz.position.z = -s[2] * 0.14; g.add(noz);
  return g; }
// RCS block (RV-105 style): a short mounting stalk + a rounded body with a cross of
// flared thruster nozzles, each with a dark scorched mouth. A control thruster, not a motor.
function a_rcs(T, d, o = {}){ const s = D(d.size); const g = new T.Group(); const n = o.ports || 4;
  const c = Math.min(s[0], s[1]) * 0.2;
  const stalk = cylZ(T, c * 0.45, c * 0.55, c * 0.5, '#7a828a', { metal: 0.7 }); stalk.position.z = c * 0.5; g.add(stalk);
  const body = new T.Mesh(new T.SphereGeometry(c * 0.88, 14, 12), mat(T, '#b3bbc4', { metal: 0.7, rough: 0.4 })); body.scale.set(1, 1, 0.85); g.add(body);
  for (let i = 0; i < n; i++){ const a = i / n * Math.PI * 2;
    const noz = cone(T, c * 0.34, c * 0.6, '#2b2f35', { metal: 0.72 });
    noz.position.set(Math.cos(a) * c * 1.04, Math.sin(a) * c * 1.04, 0); noz.rotation.z = -a - Math.PI / 2; g.add(noz);
    const mouth = new T.Mesh(new T.CircleGeometry(c * 0.2, 12), mat(T, '#140a06', { emissive: 0x3a1206, ei: 0.8 }));
    mouth.position.set(Math.cos(a) * c * 1.32, Math.sin(a) * c * 1.32, 0); mouth.lookAt(Math.cos(a) * c * 4, Math.sin(a) * c * 4, 0); g.add(mouth); }
  return g; }
// Reaction wheel — a clean grey gyro housing drum with a recessed hub (no exhaust).
function a_reactionWheel(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * 0.6; const g = new T.Group();
  g.add(cylZ(T, R, R, s[2] * 0.4, o.color || '#9aa6b2', { metal: 0.6, rough: 0.45 }));
  for (const z of [0.2, -0.2]){ const b = ringZ(T, R * 1.005, 0.012, '#5a626b', { metal: 0.6 }); b.position.z = s[2] * z; g.add(b); }
  const hub = cylZ(T, R * 0.46, R * 0.46, s[2] * 0.06, '#5a626b', { metal: 0.75, rough: 0.35 }); hub.position.z = s[2] * 0.2; g.add(hub);
  const hubRing = ringZ(T, R * 0.46, 0.018, '#3a3f45', { metal: 0.7 }); hubRing.position.z = s[2] * 0.22; g.add(hubRing); return g; }

// ---- wings / control ----
function a_wing(T, d, o = {}){ const s = D(d.size); const span = s[0], chord = s[2], maxTh = s[1] * (o.thick || 0.18);
  // A real airfoil, not a flat slab: a chord-segmented box shaped into a NACA-ish
  // teardrop (rounded leading edge, thickest ~30% back, sharp trailing edge). The
  // LEADING edge stays straight at +chord/2 across the full span (so a run of wings
  // tiles flush) and the TRAILING edge tapers toward the tips (full chord at the root).
  const taper = o.taper ?? 0.55, sweep = o.sweep ?? 0, hl = chord / 2, hw = span / 2;
  const geo = new T.BoxGeometry(span, maxTh, chord, 8, 1, 12);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++){
    const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i);
    const tf = hw > 0 ? Math.abs(x0) / hw : 0;
    const u = Math.min(1, Math.max(0, (hl - z0) / chord));            // 0 = leading edge … 1 = trailing
    const b = 0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u * u * u - 0.1036 * u * u * u * u;
    const prof = Math.max(0.04, b / 0.1);                             // normalised so it peaks ~1.0
    pos.setY(i, (y0 >= 0 ? 1 : -1) * maxTh * 0.5 * prof);             // airfoil thickness
    // scale the chord toward a tapered trailing edge while KEEPING the leading edge at
    // +hl and preserving the mid-chord vertex spread (so the airfoil survives the taper);
    // o.sweep>0 shears the whole chord aft toward the tip (swept-wing leading edge).
    const te = -hl + (1 - taper) * chord * tf;
    pos.setZ(i, te + (z0 + hl) / chord * (hl - te) - sweep * chord * tf);
  }
  pos.needsUpdate = true; geo.computeVertexNormals();
  return new T.Mesh(geo, mat(T, o.color || CAT_COLORS.wing, { metal: 0.45, rough: 0.5 })); }
function a_ctrlSurface(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  g.add(a_wing(T, d, { ...o, thick: o.thick || 0.09 }));
  const hinge = box(T, s[0] * 0.98, s[1] * 0.03, 0.04, '#2a3038'); hinge.position.z = -s[2] * 0.3; g.add(hinge); return g; }
// Vertical fin / tail surface: airfoil cross-section, full chord at the ROOT (bottom),
// tapering + sweeping back toward the TIP (top). A real fin, not a flat slab.
function a_finV(T, d, o = {}){ const s = D(d.size); const width = s[0] * (o.thick || 0.16), height = s[1], chord = s[2];
  const hl = chord / 2, hh = height / 2, taper = o.taper ?? 0.42, sweep = (o.sweep ?? 0.45) * chord;
  const geo = new T.BoxGeometry(width, height, chord, 1, 8, 12);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++){
    const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i);
    const hf = hh > 0 ? (y0 + hh) / (2 * hh) : 0;                     // 0 = root (bottom) … 1 = tip (top)
    const u = Math.min(1, Math.max(0, (hl - z0) / chord));
    const b = 0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u * u * u - 0.1036 * u * u * u * u;
    pos.setX(i, (x0 >= 0 ? 1 : -1) * width * 0.5 * Math.max(0.04, b / 0.1));
    const te = -hl + (1 - taper) * chord * hf;
    pos.setZ(i, te + (z0 + hl) / chord * (hl - te) - sweep * hf);      // taper + sweep toward tip
  }
  pos.needsUpdate = true; geo.computeVertexNormals();
  return new T.Mesh(geo, mat(T, o.color || CAT_COLORS.wing, { metal: 0.45, rough: 0.5 })); }
// Winglet = a small, strongly swept + tapered fin.
function a_winglet(T, d, o = {}){ return a_finV(T, d, { taper: o.taper ?? 0.32, sweep: o.sweep ?? 0.7, color: o.color, thick: o.thick || 0.16 }); }

// ---- command ----
function a_cockpit(T, d, o = {}){ return buildCockpit(T, d, o); }
function a_probeCore(T, d, o = {}){ const s = D(d.size); const g = new T.Group(); const R = Rof(s) * 0.95;
  g.add(cylZ(T, R * 0.6, R, s[2] * 0.66, o.color || '#9aa6b2', { metal: 0.55, rough: 0.45 }));   // truncated-cone capsule
  const dome = capZ(T, R * 0.6, o.color || '#9aa6b2', { metal: 0.55 }); dome.position.z = s[2] * 0.33; g.add(dome);
  const band = ringZ(T, R * 1.01, 0.028, '#2a3038', { metal: 0.7 }); band.position.z = -s[2] * 0.18; g.add(band);
  const eye = cylZ(T, R * 0.2, R * 0.2, s[2] * 0.08, '#7fe0ff', { emissive: 0x2090c0, ei: 1.6 }); eye.position.z = s[2] * 0.36; g.add(eye);
  const ant = cyl(T, 0.018, 0.018, s[1] * 0.5, '#aaa'); ant.position.set(R * 0.45, s[1] * 0.4, 0); g.add(ant); return g; }
function a_cabin(T, d, o = {}){ const s = D(d.size); const R = Rof(s), L = s[2]; const g = new T.Group();
  const col = o.color || '#c9cfd6', fc = '#16191d', gc = '#1c4150';
  const gmat = { metal: 0.15, rough: 0.12, transparent: true, opacity: 0.84, emissive: 0x0a2330, ei: 0.5 };
  g.add(cylZ(T, R, R, L * 0.96, col, { metal: 0.5, rough: 0.45 }));                                 // fuselage body
  // blunt FLAT front (no nose — a cabin is a fuselage section; bolt a nose part ahead of it)
  const frim = ringZ(T, R * 1.008, R * 0.022, '#3a4046', { metal: 0.5 }); frim.position.z = L * 0.48; g.add(frim);
  const fblk = cylZ(T, R * 0.9, R * 0.9, L * 0.02, '#23282e', { metal: 0.45, rough: 0.65 }); fblk.position.z = L * 0.47; g.add(fblk);
  const collar = cylZ(T, R * 1.02, R * 0.99, L * 0.06, '#3a4046', { metal: 0.7 }); collar.position.z = -L * 0.46; g.add(collar);   // rear collar
  for (const z of [-0.28, 0, 0.28]){ const r = ringZ(T, R * 1.004, R * 0.01, '#39404a', { metal: 0.5 }); r.position.z = L * z; g.add(r); }   // hull seams
  // long glasshouse canopy on top — multi-pane tandem/crew greenhouse
  const cw = R * 0.66, chH = R * 0.5, clen = L * 0.78, cyb = R * 0.9, cl2 = clen * 0.5;
  const dome = new T.Mesh(new T.SphereGeometry(1, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.5), mat(T, gc, gmat)); dome.material.side = T.DoubleSide;
  dome.scale.set(cw, chH, cl2); dome.position.set(0, cyb, 0); g.add(dome);
  const baseF = new T.Mesh(new T.TorusGeometry(1, 0.045, 6, 30), mat(T, fc, { metal: 0.5 })); baseF.scale.set(cw * 1.03, cl2 * 1.03, 1); baseF.rotation.x = Math.PI / 2; baseF.position.y = cyb; g.add(baseF);
  const arch = (zz, rs) => { const m = new T.Mesh(new T.TorusGeometry(1, 0.035, 6, 16, Math.PI), mat(T, fc, { metal: 0.55 })); m.scale.set(cw * rs, chH * rs, 1); m.position.set(0, cyb, zz); g.add(m); };
  const panes = Math.max(3, Math.round(L));
  for (let i = 0; i <= panes; i++){ arch(-cl2 * 0.94 + (cl2 * 1.88) * i / panes, (i === 0 || i === panes) ? 1.03 : 1.012); }   // a frame rib per pane
  const spine = box(T, 0.022, 0.022, clen * 0.92, fc, { metal: 0.55 }); spine.position.set(0, cyb + chH * 0.96, 0); g.add(spine);
  return g; }

// ---- gear / coupling ----
function a_gear(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  g.add(box(T, s[0] * 0.18, s[1] * 0.55, s[2] * 0.18, '#5a626b', { metal: 0.7 }));     // strut
  const axle = cylZ(T, 0.05, 0.05, s[0] * 0.4, '#444'); axle.rotation.z = Math.PI / 2; axle.position.y = -s[1] * 0.32; g.add(axle);
  for (const sx of (s[0] > 1.5 ? [-1, 1] : [0])){ const wheel = new T.Mesh(new T.TorusGeometry(s[1] * 0.22, s[1] * 0.1, 10, 16), mat(T, '#1c1d1f', { rough: 0.8 })); wheel.position.set(sx * s[0] * 0.22, -s[1] * 0.32, 0); g.add(wheel); } return g; }
function a_wheel(T, d, o = {}){ const s = D(d.size); const r = Math.min(s[0], s[1]) * 0.42; const g = new T.Group();
  const tyre = new T.Mesh(new T.TorusGeometry(r, r * 0.4, 12, 20), mat(T, '#1c1d1f', { rough: 0.85 })); tyre.rotation.y = Math.PI / 2; g.add(tyre);
  const hub = cyl(T, r * 0.5, r * 0.5, s[0] * 0.4, '#8a8f96', { metal: 0.7 }); hub.rotation.z = Math.PI / 2; g.add(hub); return g; }
function a_decoupler(T, d, o = {}){ const s = D(d.size); const R = Rof(s); const g = new T.Group();
  g.add(cylZ(T, R, R, s[2] * 0.5, o.color || CAT_COLORS.coupling, { metal: 0.6 }));
  const band = ringZ(T, R * 1.03, 0.05, '#ffb347', { emissive: 0x301800, ei: 0.6 }); g.add(band); return g; }
function a_dockingPort(T, d, o = {}){ const s = D(d.size); const R = Rof(s); const g = new T.Group();
  g.add(cylZ(T, R, R, s[2] * 0.4, o.color || '#9aa6b2', { metal: 0.7 }));
  const ring = ringZ(T, R * 0.8, 0.08, '#2a3038', { metal: 0.85 }); ring.position.z = s[2] * 0.2; g.add(ring);
  const inner = cylZ(T, R * 0.55, R * 0.55, 0.04, '#11151a'); inner.position.z = s[2] * 0.22; g.add(inner); return g; }
function a_pylon(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  g.add(box(T, s[0] * 0.3, s[1] * 0.5, s[2] * 0.85, o.color || '#5a626b', { metal: 0.65 }));
  const sway = box(T, s[0] * 0.12, s[1] * 0.3, s[2] * 0.4, '#3a3d42'); sway.position.y = -s[1] * 0.32; g.add(sway); return g; }

// ---- power / utility / thermal / comms ----
function a_battery(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  g.add(box(T, s[0] * 0.8, s[1] * 0.7, s[2] * 0.9, o.color || '#2f3b2a', { metal: 0.4, rough: 0.6 }));
  for (let i = 0; i < Math.max(2, Math.round(s[2] * 2)); i++){ const cell = box(T, s[0] * 0.7, s[1] * 0.06, s[2] * 0.8, '#ffd24d', { metal: 0.5 }); cell.position.y = s[1] * (-0.32 + i * 0.16); g.add(cell); } return g; }
function a_solar(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  const panel = box(T, s[0] * 0.95, 0.03, s[2] * 0.95, '#1a2a55', { metal: 0.3, rough: 0.3, emissive: 0x0a1840, ei: 0.5 }); g.add(panel);
  for (let i = 1; i < 4; i++){ const grid = box(T, s[0] * 0.95, 0.035, 0.01, '#3a4a7a'); grid.position.z = s[2] * (-0.4 + i * 0.25); g.add(grid); }
  const spar = box(T, 0.04, 0.04, s[2] * 0.95, '#8a8f96'); g.add(spar); return g; }
// A concave PARABOLIC dish opening toward +Z (a real dish, not a solid dome), with
// a rim, a centre post and a feed horn at the focus. Used by radar/comm/sensor parts.
function dishZ(T, R, depth, color, o = {}){
  const g = new T.Group(); const N = 12, pts = [];
  for (let i = 0; i <= N; i++){ const r = R * i / N; pts.push(new T.Vector2(Math.max(0.001, r), depth * (i / N) * (i / N))); }  // rim forward, vertex back → concave
  const bowl = new T.Mesh(new T.LatheGeometry(pts, o.seg || 24), mat(T, color, { metal: o.metal ?? 0.45, rough: o.rough ?? 0.4 }));
  bowl.material.side = T.DoubleSide; bowl.rotation.x = Math.PI / 2; g.add(bowl);
  const rim = new T.Mesh(new T.TorusGeometry(R, R * 0.05, 6, 26), mat(T, '#3a4046', { metal: 0.6 })); rim.position.z = depth; g.add(rim);
  const post = cylZ(T, R * 0.04, R * 0.04, depth * 0.72, '#9aa3ab', { metal: 0.6 }); post.position.z = depth * 0.36; g.add(post);
  const feed = cone(T, R * 0.12, depth * 0.34, '#cdd3d9', { metal: 0.6 }); feed.rotation.x = -Math.PI / 2; feed.position.z = depth * 0.7; g.add(feed);   // feed horn aimed back into the dish
  return g;
}
// Radiator panel: a dark backing plate with parallel brushed-silver cooling fins.
function a_radiator(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  const col = o.color || '#c2c9d1';
  g.add(box(T, s[0] * 0.96, s[1] * 0.06, s[2] * 0.94, '#3a4047', { metal: 0.6, rough: 0.5 }));   // dark backing / frame
  const N = Math.max(7, Math.round(s[2] * 5));
  for (let i = 0; i < N; i++){ const fin = box(T, s[0] * 0.9, s[1] * 0.11, s[2] * 0.5 / N, col, { metal: 0.82, rough: 0.28 });
    fin.position.z = (i / (N - 1) - 0.5) * s[2] * 0.82; g.add(fin); }
  return g; }
function a_heatShield(T, d, o = {}){ const s = D(d.size); const R = Rof(s); const g = new T.Group();
  const dome = new T.Mesh(new T.SphereGeometry(R * 1.6, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.32), mat(T, o.color || '#6b5240', { metal: 0.2, rough: 0.85 })); dome.rotation.x = Math.PI / 2; dome.position.z = s[2] * 0.2; g.add(dome);
  g.add(cylZ(T, R, R, s[2] * 0.3, '#3a3d42', { metal: 0.6 })); return g; }
function a_parachute(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * 0.8; const g = new T.Group();
  g.add(cylZ(T, R, R * 0.85, s[2] * 0.8, o.color || '#cfd6dd', { metal: 0.5 }));
  const cap = capZ(T, R, '#b04a4a', {}); cap.position.z = s[2] * 0.4; g.add(cap); return g; }
function a_light(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  g.add(box(T, s[0] * 0.3, s[1] * 0.3, s[2] * 0.3, '#3a3d42', { metal: 0.6 }));
  const lens = new T.Mesh(new T.SphereGeometry(Math.min(s[0], s[1]) * 0.2, 10, 8), mat(T, '#fffbe0', { emissive: 0xffeeaa, ei: 1.8 })); lens.position.z = s[2] * 0.2; g.add(lens); return g; }
function a_antenna(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  if (o.style === 'dish'){ const R = Rof(s) * 0.85; g.add(dishZ(T, R, R * 0.46, o.color || '#cfd6dd')); const stalk = cylZ(T, 0.035, 0.035, s[2] * 0.4, '#888', { metal: 0.6 }); stalk.position.z = -s[2] * 0.24; g.add(stalk); }
  else { g.add(box(T, s[0] * 0.3, s[1] * 0.3, s[2] * 0.3, '#3a3d42', { metal: 0.6 })); const whip = cyl(T, 0.015, 0.015, s[1] * 1.2, '#aaa'); whip.position.y = s[1] * 0.6; g.add(whip); } return g; }
// Heat-shield-style armour: a shallow convex ABLATIVE dome bulging +Y, with
// concentric char grooves, a metal mounting rim and a backing plate.
// Sloped tank-style armor plate: a flat plate BENT 10° at its centreline into two facets that
// meet at a proud welded ridge and slope down to the edges (the glacis fold that deflects rounds).
// Outward face = +Y. The fold runs along the part's LONGER footprint axis, so a wide plate folds
// across its depth and a deep plate folds across its width. Rivets (or ERA bricks if reactive).
function a_armor(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  const W = s[0], H = s[1], L = s[2];
  const reactive = o.style === 'reactive';
  const col = o.color || (reactive ? '#6f5a52' : '#5f6973');
  const steel = { metal: 0.5, rough: 0.55 }, edge = { metal: 0.62, rough: 0.42 };
  const longer = Math.max(W, L), shorter = Math.min(W, L), half = shorter * 0.5;
  const t = Math.max(0.12, Math.min(0.34, (o.thick || 0.8) * 0.24)) * H;      // plate thickness
  const theta = 10 * Math.PI / 180;                                           // the 10° fold per side
  const peakY = H * 0.06;                                                      // ridge sits proud; halves slope down

  const base = box(T, longer * 0.98, H * 0.16, shorter * 0.98, '#33383d', { metal: 0.62, rough: 0.5 });  // built in the canonical (ridge-along-X) frame, same as the facets/ridge, so the group rotation below aligns it
  base.position.y = -H * 0.34; g.add(base);                                    // mounting pad the plate bolts onto

  const facet = (sign) => {
    const piv = new T.Group(); piv.position.y = peakY; piv.rotation.x = sign * theta;   // hinge at the ridge, tilt down
    const fb = box(T, longer * 0.98, t, half * 0.98, col, steel); fb.position.z = sign * half * 0.5; piv.add(fb);
    const lip = box(T, longer * 0.98, t * 1.25, half * 0.08, '#41464c', edge); lip.position.z = sign * half * 0.96; piv.add(lip);  // thick welded outer lip
    if (reactive){
      const cols = Math.max(2, Math.round(longer * 1.4)), bw = longer * 0.72 / cols;
      for (let i = 0; i < cols; i++) for (let j = 0; j < 2; j++){
        const bx = (cols === 1 ? 0 : (i / (cols - 1) - 0.5)) * longer * 0.72, bz = sign * (0.30 + j * 0.40) * half;
        const brick = box(T, bw * 0.82, t * 0.7, half * 0.32, col, steel); brick.position.set(bx, t * 0.6, bz); piv.add(brick);
        const seam = box(T, bw * 0.86, t * 0.16, half * 0.34, '#23262a', { metal: 0.5 }); seam.position.set(bx, t * 0.3, bz); piv.add(seam);
      }
    } else {
      const n = Math.max(2, Math.round(longer * 2));
      for (let i = 0; i < n; i++){ const bx = (n === 1 ? 0 : (i / (n - 1) - 0.5)) * longer * 0.78;
        for (const f of [0.34, 0.82]){ const rv = cyl(T, t * 0.22, t * 0.22, t * 0.5, '#2c3035', { metal: 0.7, rough: 0.4 });
          rv.position.set(bx, t * 0.6, sign * f * half); piv.add(rv); } }
    }
    g.add(piv);
  };
  facet(1); facet(-1);

  const ridge = box(T, longer * 0.98, t * 0.5, shorter * 0.05, '#474c52', edge); ridge.position.y = peakY + t * 0.5; g.add(ridge);  // welded ridge bead
  if (L > W) g.rotation.y = Math.PI / 2;        // deep plates: turn the fold to run across the width
  return g; }

// ---- weapons ---- (the data catalogue reuses the detailed shared builders)
function a_gun(T, d, o = {}){ return buildGun(T, d, o.r || 0.06, o); }
function a_gatling(T, d, o = {}){ return buildGatling(T, d, o); }
function a_missilePod(T, d, o = {}){ return buildMissile(T, d, o.color || '#ff4d6d', o.count || 2, { seeker: o.seeker }); }
function a_bombRack(T, d, o = {}){ return buildBomb(T, d, o.r || 0.22, o.count || 2, o); }
function a_rocketPod(T, d, o = {}){ return buildRocketPod(T, d, o); }
// Phalanx-style CIWS: a pedestal, the iconic white search radome and a 6-barrel rotary
// cannon clustered on the +Z firing axis (updateTurrets aims +Z at the target).
function buildCIWS(T, d, o = {}){
  const s = D(d.size), g = new T.Group();
  const W = s[0], H = s[1], L = s[2];
  const ped = cyl(T, W * 0.28, W * 0.36, H * 0.42, '#3c434a', { metal: 0.7, rough: 0.45 }); ped.position.y = -H * 0.2; g.add(ped);   // pedestal
  const dome = new T.Mesh(new T.SphereGeometry(W * 0.34, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), mat(T, o.color || '#e9ece6', { metal: 0.18, rough: 0.6 }));
  dome.position.set(0, H * 0.12, -L * 0.12); g.add(dome);                                                                          // white search radome
  const hous = box(T, W * 0.34, H * 0.26, L * 0.3, '#444b52', { metal: 0.6 }); hous.position.set(0, H * 0.02, L * 0.14); g.add(hous);  // gun housing
  for (let i = 0; i < 6; i++){ const a = i / 6 * Math.PI * 2;                                                                       // 6 rotary barrels
    const bar = cylZ(T, W * 0.028, W * 0.028, L * 0.5, '#1c1f22', { metal: 0.9, rough: 0.3 });
    bar.position.set(Math.cos(a) * W * 0.09, H * 0.02 + Math.sin(a) * W * 0.09, L * 0.42); g.add(bar); }
  const hub = cylZ(T, W * 0.05, W * 0.05, L * 0.36, '#2a2e33', { metal: 0.8 }); hub.position.set(0, H * 0.02, L * 0.4); g.add(hub);
  return g; }

// Heavy naval gun turret: an armoured barbette + faceted house with 1–3 long barrels on
// the +Z firing axis. A capital-ship main battery (scaled up further on a carrier hull).
function buildNavalTurret(T, d, o = {}){
  const s = D(d.size), g = new T.Group();
  const barrels = o.barrels || 1, W = s[0], H = s[1], L = s[2];
  const col = o.color || '#59626b', steel = { metal: 0.72, rough: 0.42 }, dark = '#23282d';
  const barb = cyl(T, W * 0.46, W * 0.54, H * 0.32, '#3c434a', { metal: 0.78, rough: 0.4 }); barb.position.y = -H * 0.2; g.add(barb);   // barbette base
  const house = box(T, W * 0.84, H * 0.46, L * 0.56, col, steel); house.position.set(0, H * 0.07, -L * 0.06); g.add(house);            // armoured house
  const glac = box(T, W * 0.84, H * 0.34, L * 0.2, col, steel); glac.position.set(0, H * 0.02, L * 0.2); glac.rotation.x = -0.62; g.add(glac);  // sloped glacis
  const roof = box(T, W * 0.7, H * 0.06, L * 0.46, '#69727b', { metal: 0.6 }); roof.position.set(0, H * 0.3, -L * 0.06); g.add(roof);
  for (const sx of [-1, 1]){ const ear = box(T, W * 0.07, H * 0.16, L * 0.1, dark, { metal: 0.55 }); ear.position.set(sx * W * 0.39, H * 0.16, -L * 0.16); g.add(ear); }  // rangefinder ears
  const dirc = cyl(T, W * 0.08, W * 0.1, H * 0.12, '#444b52', { metal: 0.6 }); dirc.position.set(0, H * 0.34, -L * 0.16); g.add(dirc);   // roof director
  const off = barrels === 1 ? [0] : barrels === 2 ? [-0.22, 0.22] : [-0.3, 0, 0.3];
  const bR = (barrels >= 3 ? 0.05 : barrels === 2 ? 0.06 : 0.075) * W * 1.6;
  for (const ox of off){ const x = ox * W;                                                                                            // barrels (+Z)
    const sleeve = cylZ(T, bR * 1.5, bR * 1.5, L * 0.18, '#3a4046', { metal: 0.7 }); sleeve.position.set(x, 0, L * 0.32); g.add(sleeve);
    const bar = cylZ(T, bR, bR * 0.88, L * 0.66, '#1c1f22', { metal: 0.9, rough: 0.3 }); bar.position.set(x, 0, L * 0.62); g.add(bar);
    const mz = cylZ(T, bR * 1.12, bR * 1.12, L * 0.05, '#0a0a0b'); mz.position.set(x, 0, L * 0.93); g.add(mz); }
  return g; }

// Deck torpedo battery: a trainable mount carrying a bank of three open launch tubes on the +Z
// firing axis (battle.js updateTorpedoMounts traverses the node toward a surface target, then a
// torpedo runs out the tube and skims the sea toward it). A planted ring + barbette so it doesn't
// look top-heavy, a cradle box, and three bored tubes each with a dark muzzle lip and a peeking nose.
function buildTorpedoTube(T, d, o = {}){
  const s = D(d.size), g = new T.Group();
  const W = s[0], H = s[1], L = s[2];
  const col = o.color || '#4a525b', steel = { metal: 0.7, rough: 0.45 };
  const ring = cyl(T, W * 0.5, W * 0.54, H * 0.16, '#343a40', { metal: 0.78, rough: 0.45 }); ring.position.y = -H * 0.34; g.add(ring);   // traverse ring
  const pivot = cyl(T, W * 0.26, W * 0.32, H * 0.34, '#3c434a', { metal: 0.74, rough: 0.4 }); pivot.position.y = -H * 0.1; g.add(pivot);   // barbette
  const cradle = box(T, W * 0.72, H * 0.24, L * 0.5, col, steel); cradle.position.set(0, H * 0.08, -L * 0.04); g.add(cradle);                // tube cradle
  const tubeR = W * 0.15, off = [-0.27, 0, 0.27];
  for (const ox of off){ const x = ox * W;
    const tube = cylZ(T, tubeR, tubeR, L * 0.74, '#5c656e', { metal: 0.6, rough: 0.4, open: true }); tube.position.set(x, H * 0.2, L * 0.16); g.add(tube);   // open-bored launch tube, +Z
    const lip = ringZ(T, tubeR * 1.04, 0.02, '#23282d', { metal: 0.7 }); lip.position.set(x, H * 0.2, L * 0.52); g.add(lip);                  // muzzle ring
    const bore = cylZ(T, tubeR * 0.82, tubeR * 0.82, L * 0.05, '#0c0e10'); bore.position.set(x, H * 0.2, L * 0.5); g.add(bore);              // dark bore
    const tip = capZ(T, tubeR * 0.68, '#aeb6bf', { metal: 0.5 }); tip.position.set(x, H * 0.2, L * 0.46); g.add(tip); }                       // torpedo nose peeking out
  return g; }

function a_turret(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  const baseR = s[0] * 0.42;
  g.add(cylZ(T, baseR, baseR * 1.05, s[2] * 0.26, '#4a4d52', { metal: 0.72, rough: 0.4 }));   // traverse ring
  const dome = new T.Mesh(new T.SphereGeometry(baseR * 0.82, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(T, '#5a5d62', { metal: 0.72, rough: 0.4 })); dome.position.y = s[1] * 0.06; g.add(dome);
  for (const ox of (o.twin === false ? [0] : [-0.12, 0.12])){
    const bar = cylZ(T, 0.045, 0.045, s[2] * 0.62, '#26282b', { metal: 0.9, rough: 0.26 }); bar.position.set(ox * s[0], s[1] * 0.1, s[2] * 0.34); g.add(bar);
    const mz = cylZ(T, 0.05, 0.05, s[2] * 0.04, '#0a0a0b'); mz.position.set(ox * s[0], s[1] * 0.1, s[2] * 0.64); g.add(mz); }
  return g; }
function a_flarePod(T, d, o = {}){ const s = D(d.size); const g = new T.Group();
  g.add(box(T, s[0] * 0.5, s[1] * 0.45, s[2] * 0.7, '#3a3d42', { metal: 0.6 }));
  for (let i = 0; i < 4; i++){ const tube = cylZ(T, s[1] * 0.07, s[1] * 0.07, s[2] * 0.5, '#dada4d', { metal: 0.5 }); tube.position.set((i % 2 - 0.5) * s[0] * 0.24, (i < 2 ? 1 : -1) * s[1] * 0.12, s[2] * 0.12); g.add(tube); } return g; }
function a_sensorDish(T, d, o = {}){ const s = D(d.size); const R = Rof(s) * 0.92; const g = new T.Group();
  g.add(dishZ(T, R, R * 0.52, o.color || '#cfd6dd'));
  const stalk = cylZ(T, R * 0.09, R * 0.09, s[2] * 0.34, '#5a626b', { metal: 0.6 }); stalk.position.z = -s[2] * 0.22; g.add(stalk);
  const base = cylZ(T, R * 0.42, R * 0.48, s[2] * 0.12, '#3a4046', { metal: 0.6 }); base.position.z = -s[2] * 0.42; g.add(base); return g; }

// archetype name → builder
const ARCHETYPES = {
  fuselage: a_fuselage, fuselageFlat: a_fuselageFlat, noseCone: a_noseCone, adapter: a_adapter, fairing: a_fairing,
  intake: a_intake, panel: a_panel, airbrake: a_airbrake, strut: a_strut, truss: a_truss,
  tank: a_tank, tankFlat: a_tankFlat, dropTank: a_dropTank, monoTank: a_monoTank, toroidalTank: a_toroidalTank, radialTank: a_radialTank,
  engineJet: buildJet, engineRocket: buildRocket, engineSolid: buildSRB, engineProp: buildProp,
  engineIon: a_engineIon, engineRadial: a_engineRadial, engineAerospike: a_engineAerospike,
  nozzle: a_nozzle, rcs: a_rcs, reactionWheel: a_reactionWheel,
  wing: a_wing, ctrlSurface: a_ctrlSurface, finV: a_finV, winglet: a_winglet,
  cockpit: a_cockpit, probeCore: a_probeCore, cabin: a_cabin,
  gear: a_gear, wheel: a_wheel, decoupler: a_decoupler, dockingPort: a_dockingPort, pylon: a_pylon,
  battery: a_battery, solar: a_solar, radiator: a_radiator, heatShield: a_heatShield, parachute: a_parachute,
  light: a_light, antenna: a_antenna, armor: a_armor,
  gun: a_gun, gatling: a_gatling, missilePod: a_missilePod, bombRack: a_bombRack, rocketPod: a_rocketPod,
  turret: a_turret, flarePod: a_flarePod, sensorDish: a_sensorDish,
  ciws: buildCIWS, navalTurret: buildNavalTurret, torpedoTube: buildTorpedoTube,
};

// ============================================================================
//  DATA CATALOGUE — pure-data parts. Each names a model archetype + opts; the
//  build() is attached from ARCHETYPES below. This is where the bulk of the
//  component library lives (filled out across every category).
// ============================================================================
import { CATALOG } from './catalog.js';
for (const p of CATALOG){
  if (!p.build && p.model){ const m = p.model, o = p.modelOpts || {}; p.build = (T, d) => (ARCHETYPES[m] || a_fuselage)(T, d, o); }
}

// keyed map + ordered categories. Inline LIST parts take priority; catalogue
// parts with a colliding key are skipped so the palette never shows duplicates.
const ALL_PARTS = LIST.slice();
const _seenKeys = new Set(LIST.map(p => p.key));
for (const p of CATALOG){ if (p && p.key && !_seenKeys.has(p.key)){ _seenKeys.add(p.key); ALL_PARTS.push(p); } }

// Cosmetic scale-down for weapons. The detailed gun/missile/bomb meshes read as
// oversized bolted onto a fighter (guns fill ~1.0–1.26× of their cell, bombs ~1.18×).
// Shrink the RENDERED mesh so ordnance sits neatly inside its footprint — physics
// reads the declared `size`, not the mesh, so stats/handling are unaffected. Tuned
// per category from measured bounding-box ratios; missiles were already slim so they
// get only a light trim. Wrap each build() once (guarded so it can't double-apply).
const WEAPON_SCALE = { gun: 0.74, bomb: 0.8, missile: 0.88 };
for (const p of ALL_PARTS){
  const k = WEAPON_SCALE[p.category];
  if (k && typeof p.build === 'function' && !p._wScaled){
    const inner = p.build;
    p.build = (T, d) => { const g = inner(T, d); g.scale.multiplyScalar(k); return g; };
    p._wScaled = true;
  }
}
export const PARTS = {};
for (const p of ALL_PARTS) PARTS[p.key] = p;
export const PART_LIST = ALL_PARTS;
export const CATEGORIES = [
  { key: 'command', name: 'Command' }, { key: 'structure', name: 'Structure' }, { key: 'aero', name: 'Aero' },
  { key: 'fuel', name: 'Fuel' }, { key: 'engine', name: 'Engines' }, { key: 'thruster', name: 'Thrusters' },
  { key: 'wing', name: 'Wings' }, { key: 'control', name: 'Control' }, { key: 'gear', name: 'Landing Gear' },
  { key: 'coupling', name: 'Coupling' }, { key: 'power', name: 'Power' }, { key: 'utility', name: 'Utility' },
  { key: 'armor', name: 'Armor' }, { key: 'gun', name: 'Guns' }, { key: 'missile', name: 'Missiles' }, { key: 'bomb', name: 'Bombs' },
];
export function partsByCategory(cat){ return PART_LIST.filter(p => p.category === cat); }

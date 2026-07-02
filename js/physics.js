// ============================================================================
//  Ace of Sky II — physics.js
//  The "ultra-physics" core. computeStats(design) turns a part layout into a
//  full physical profile: mass, thrust, lift/drag, fuel/endurance, durability,
//  thermodynamics, centre of mass / lift & stability, agility and weapons.
//  Every other module (hangar readout, battle flight model, economy cost,
//  pvp budget) derives from THIS so the sim and the editor never disagree.
// ============================================================================
import { G, RHO, clamp } from './util.js';
import { PARTS, WEAPONS } from './parts.js';

export const GRID = 1.0;            // metres per build-grid cell
export const CL_MAX = 1.6;          // max wing lift coefficient before stall
export const OVERHEAT_TEMP = 1100;  // °C structural failure temperature
export const AMBIENT_TEMP = 15;     // °C
export { G, RHO };

// effective footprint after a quarter-turn rotation about Y (swaps x/z)
export function effSize(def, rot){
  const s = def.size || [1, 1, 1];
  return (rot & 1) ? [s[2], s[1], s[0]] : [s[0], s[1], s[2]];
}
// world-space centre of a placed part (grid units → metres)
export function partCenter(p, def){
  const s = effSize(def, p.rot || 0);
  return { x: (p.gx + s[0] / 2) * GRID, y: (p.gy + s[1] / 2) * GRID, z: (p.gz + s[2] / 2) * GRID };
}

// --- the big one ------------------------------------------------------------
export function computeStats(design){
  const parts = (design && design.parts) || [];
  const errors = [], warnings = [];

  let dryMass = 0, fuelCap = 0, cost = 0;
  let thrust = 0, boostExtra = 0, burnRate = 0, boostBurn = 0;
  let dragArea = 0, liftArea = 0, liftWeighted = { z: 0, w: 0 }, airbrakeArea = 0;
  let ctrlPitch = 0, ctrlRoll = 0, ctrlYaw = 0;
  let structureHP = 0, armorHP = 0;
  let heatCap = 0, heatGenMax = 0, heatDiss = 0;
  let crew = 0, hardpoints = 0, flares = 0, sensor = 0;
  const weapons = [];
  let comAcc = { x: 0, y: 0, z: 0 }, massAcc = 0;
  const min = { x: 1e9, y: 1e9, z: 1e9 }, max = { x: -1e9, y: -1e9, z: -1e9 };

  for (const p of parts){
    const def = PARTS[p.key];
    if (!def){ warnings.push('Unknown part: ' + p.key); continue; }
    const c = partCenter(p, def);
    const es = effSize(def, p.rot || 0);
    min.x = Math.min(min.x, c.x - es[0] / 2); max.x = Math.max(max.x, c.x + es[0] / 2);
    min.y = Math.min(min.y, c.y - es[1] / 2); max.y = Math.max(max.y, c.y + es[1] / 2);
    min.z = Math.min(min.z, c.z - es[2] / 2); max.z = Math.max(max.z, c.z + es[2] / 2);

    const partMass = (def.mass || 0) + (def.fuel || 0);   // tank starts full
    dryMass += def.mass || 0;
    fuelCap += def.fuel || 0;
    cost    += def.cost || 0;
    comAcc.x += c.x * partMass; comAcc.y += c.y * partMass; comAcc.z += c.z * partMass;
    massAcc  += partMass;

    thrust    += def.thrust || 0;
    burnRate  += def.burn || 0;
    if (def.afterburner) boostExtra += (def.thrust || 0) * (def.afterburner - 1);
    if (def.boostThrust){ boostExtra += def.boostThrust; boostBurn += def.boostBurn || 0; }

    dragArea += def.drag || 0;
    airbrakeArea += def.airbrakeDrag || 0;     // extra drag, only when the speed brake is deployed in flight
    if (def.lift){ liftArea += def.lift; liftWeighted.z += c.z * def.lift; liftWeighted.w += def.lift; }
    ctrlPitch += def.ctrlPitch || 0; ctrlRoll += def.ctrlRoll || 0; ctrlYaw += def.ctrlYaw || 0;

    structureHP += def.hp || 0;
    armorHP     += def.armor || 0;
    heatCap     += def.heatCap || (def.mass || 0) * 0.45;   // every kg of metal stores heat
    heatGenMax  += def.heatGen || 0;
    heatDiss    += def.heatDiss || 0;

    crew      += def.crew || 0;
    flares    += def.flares || 0;
    sensor     = Math.max(sensor, def.sensor || 0);
    if (def.weapon){
      const w = WEAPONS[def.weapon];
      if (w){ weapons.push({ ...w, ammo: def.ammo || w.clip, mount: c, partKey: p.key, turret: !!def.autoTurret, turretRange: def.turretRange || 0 }); hardpoints++; }
    }
  }

  const partCount = parts.length;
  const fuelMass = fuelCap;
  const mass = dryMass + fuelMass;
  const weight = mass * G;
  const boostThrust = thrust + boostExtra;

  // frontal-area base drag so a brick is draggier than a needle
  const bx = Math.max(0, max.x - min.x), by = Math.max(0, max.y - min.y), bz = Math.max(0, max.z - min.z);
  const frontal = Math.max(0.5, bx * by) * 0.08;
  // floor at a small positive value: drag-reducing parts (nose/shock/tail cones)
  // must never drive the total negative, which would otherwise read as vMax 0 and,
  // worse, make the battle drag force negative (free acceleration) and invert cooling.
  const totalDrag = Math.max(0.05, dragArea + frontal);

  // top speed where thrust == drag : 0.5·ρ·Cd·A·v² = T
  const vMax      = totalDrag > 0 ? Math.sqrt((2 * thrust)      / (RHO * totalDrag)) : 0;
  const vMaxBoost = totalDrag > 0 ? Math.sqrt((2 * boostThrust) / (RHO * totalDrag)) : 0;
  // stall: minimum speed where wings can still hold up the weight
  const vStall = liftArea > 0 ? Math.sqrt((2 * weight) / (RHO * liftArea * CL_MAX)) : Infinity;
  const cruise = vMax * 0.7;

  const endurance = burnRate > 0 ? fuelCap / burnRate : Infinity;     // seconds at cruise throttle
  const range = isFinite(endurance) ? cruise * endurance / 1000 : Infinity; // km

  const durability = structureHP + armorHP;

  // --- agility (deg/s at full control deflection) --------------------------
  // Turn rate = control authority / rotational inertia. Raw moment of inertia
  // (m·L²) is enormous next to control-surface authority, which made every
  // aircraft fly like a barge (a light fighter rolled at ~6°/s). We instead use
  // a *normalized* inertia — mass and length on a gentle curve — so handling is
  // dogfight-grade while still differentiated by design: a ~2t fighter pitches
  // ~65°/s and rolls ~100°/s; a 6t heavy bomber is much more sluggish but flyable.
  const lenSpan = Math.max(2, Math.max(bx, bz));
  const inertiaN = (mass / 1300) * (0.55 + lenSpan / 9) + 0.05;   // ≈1.9 for the Falcon
  // per-axis control authority: surfaces + RCS/vectoring (via ctrl*), plus a
  // thrust bonus on pitch/yaw (powerful engines & TVC help point the nose).
  const pitchAuth = ctrlPitch * 7.5 + thrust * 0.0012 + 6;
  const rollAuth  = ctrlRoll  * 22  + 18;
  const yawAuth   = ctrlYaw   * 3.5 + thrust * 0.0003 + 3;
  const agilityPitch = clamp(pitchAuth / inertiaN, 10, 170);
  const agilityRoll  = clamp(rollAuth  / inertiaN, 22, 340);
  const agilityYaw   = clamp(yawAuth   / inertiaN, 7,  95);

  const com = massAcc > 0 ? { x: comAcc.x / massAcc, y: comAcc.y / massAcc, z: comAcc.z / massAcc } : { x: 0, y: 0, z: 0 };
  const colZ = liftWeighted.w > 0 ? liftWeighted.z / liftWeighted.w : com.z;
  const col = { x: com.x, y: com.y, z: colZ };
  // forward = +Z; statically stable when centre of lift sits BEHIND (smaller Z) the CoM
  const stability = clamp((com.z - colZ) / Math.max(1, bz), -1, 1);

  // ---- validation -----------------------------------------------------------
  if (partCount === 0) errors.push('Empty airframe.');
  if (crew < 1) errors.push('No cockpit — add a command pod.');
  if (thrust <= 0) warnings.push('No engine — this aircraft cannot move under power.');
  if (liftArea <= 0 && (thrust / weight) < 1) warnings.push('No wings & TWR<1 — it will fall out of the sky.');
  if (burnRate > 0 && fuelCap <= 0) errors.push('Engines but no fuel — add a fuel tank.');
  if (isFinite(vStall) && vStall > vMaxBoost && vMaxBoost > 0) warnings.push('Stall speed exceeds top speed — too heavy for its wings.');
  if (stability < -0.05) warnings.push('Centre of lift ahead of CoM — unstable, twitchy handling.');
  if (heatGenMax > heatDiss * (OVERHEAT_TEMP - AMBIENT_TEMP) + 5e5) warnings.push('Poor cooling — sustained burn/fire will overheat.');

  return {
    ok: errors.length === 0,
    errors, warnings,
    partCount,
    dryMass, fuelMass, fuelCap, mass, weight, cost,
    thrust, boostThrust, twr: weight > 0 ? thrust / weight : 0, twrBoost: weight > 0 ? boostThrust / weight : 0,
    dragArea: totalDrag, liftArea, airbrakeArea,
    vMax, vMaxBoost, vStall, cruise,
    burnRate, boostBurn, endurance, range,
    durability, structureHP, armorHP, armor: armorHP,
    heatCap: Math.max(1, heatCap), heatGenMax, heatDiss: heatDiss + frontal * 50, overheat: OVERHEAT_TEMP,
    agility: { pitch: agilityPitch, roll: agilityRoll, yaw: agilityYaw },
    control: { pitch: ctrlPitch, roll: ctrlRoll, yaw: ctrlYaw },
    weapons, hardpoints, flares, sensor, crew,
    com, col, stability,
    bbox: { min, max, size: { x: bx, y: by, z: bz } },
  };
}

// instantaneous aero forces (used by the battle flight integrator)
export function dragForce(stats, v){ return 0.5 * RHO * stats.dragArea * v * v; }
export function liftForce(stats, v, cl){ return 0.5 * RHO * stats.liftArea * v * v * clamp(cl, -CL_MAX, CL_MAX); }

// thermodynamics step: returns new temperature (°C). genFrac 0..1 of heatGenMax,
// speed adds forced-convection cooling. Call each frame from the sim.
export function thermoStep(stats, tempC, genFrac, speed, dt){
  const gen = stats.heatGenMax * clamp(genFrac, 0, 1);
  const diss = (stats.heatDiss + speed * stats.dragArea * 1.2) * (tempC - AMBIENT_TEMP);
  const dT = (gen - diss) / stats.heatCap * dt;
  return tempC + dT;
}

// a compact line of headline numbers for tooltips / debug
export function statLine(s){
  return `${(s.mass / 1000).toFixed(1)}t · TWR ${s.twr.toFixed(2)} · ${Math.round(s.vMax * 3.6)}km/h · ${Math.round(s.durability)}HP`;
}

// A surface vessel (role 'ship'/'carrier') does NOT fly — its real cruise is naval, not the
// aerodynamic vMax (which, for an engined hull, reads in the four-figure km/h and is meaningless
// on water). We read installed propulsion *through* vMax (a thrust/drag proxy) and map it into a
// sane naval band, so MORE/BIGGER ENGINES genuinely make a ship faster — while it never grinds to
// a halt nor planes off at aircraft speed. Used by BOTH the hangar readout and the in-battle
// movement (battle.js makeCarrier) so the number you see is the speed you actually get.
export function navalCruise(st){
  return clamp(((st && st.vMax) || 0) * 0.18, 18, 95);     // m/s   (≈ 65 … 342 km/h)
}

// ============================================================================
//  Ace of Sky II — ai.js
//  Combat AI for every non-player aircraft (enemy fighters, allied wingmen,
//  bombers, and carrier point-defence). The battle sim owns the world and the
//  flight integrator; this module only DECIDES — it reads a craft + the world
//  and writes an intent block (throttle / boost / desired heading / fire flags)
//  back onto the craft, which the integrator then turns into motion.
//
//  Design philosophy (so battle.js stays readable):
//    - A "craft" is the live actor object the sim maintains. AI never moves it
//      directly; it sets craft.ai.* intents and craft.want* flags.
//    - leadPoint() (prediction.js) gives the aim solution; skill (0..1) scales
//      how tight that solution is, how fast the AI reacts, and how aggressive
//      it gets about closing range vs. extending/evading.
//    - Behaviour is a small state machine: SEEK → PURSUE → ATTACK → EXTEND →
//      EVADE. Hysteresis (range bands + a reaction clock) keeps it from
//      twitching between states every frame.
//
//  Public API used by battle.js:
//    initAI(craft, skill)             — seed craft.ai once at spawn
//    updateAI(craft, world, dt)       — per-frame brain for a fighter/wingman
//    updateBomber(craft, world, dt)   — bomber brain (runs on carrier targets)
//    updateCarrierPD(carrier, world, dt) — point-defence target selection
//    pickTarget(craft, world)         — nearest hostile in sensor range
// ============================================================================
import * as THREE from 'three';
import { clamp, lerp } from './util.js';
import { leadPoint, interceptTime } from './prediction.js';

// scratch vectors (module-local, never escape a call) ------------------------
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _to = new THREE.Vector3(), _lead = new THREE.Vector3();

// ---------------------------------------------------------------------------
//  Per-craft AI memory. Called once when the sim spawns a non-player craft.
// ---------------------------------------------------------------------------
export function initAI(craft, skill = 0.5){
  skill = clamp(skill, 0, 1);
  craft.ai = {
    skill,
    state: 'seek',
    target: null,
    react: 0,                 // reaction clock — AI re-decides when this hits 0
    reactTime: lerp(0.55, 0.12, skill),  // skilled pilots think faster
    aimJitter: lerp(0.10, 0.006, skill), // radians of aim error (worse = wider)
    burstT: 0,                // gun burst gating
    burstGap: lerp(1.3, 0.35, skill),
    evadeT: 0,
    evadeDir: 1,
    rollPhase: Math.random() * Math.PI * 2,
    panic: 0,                 // accumulates when under fire → triggers evade
    desired: new THREE.Vector3(0, 0, 1),
    altFloor: 60 + Math.random() * 40,   // each AI keeps its own minimum altitude
    weaponPref: 0,            // index it likes to use; recomputed on target
    fireGun: false,
    fireMissile: false,
    wantFlare: false,
  };
  return craft.ai;
}

// distance helper on raw vec3-likes
function dist(a, b){ return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

// ---------------------------------------------------------------------------
//  Target selection — nearest living hostile within sensor/engagement range.
//  Wingmen (team 0) hunt enemies; enemies (team 1) hunt the player & allies.
// ---------------------------------------------------------------------------
export function pickTarget(craft, world){
  let best = null, bestScore = Infinity;
  const sensorRange = 2200 + (craft.stats?.sensor ? 1400 : 0);
  for (const o of world.craft){
    if (!o.alive || o === craft || o.team === craft.team) continue;
    const d = dist(craft.pos, o.pos);
    if (d > sensorRange * 1.6) continue;
    // prefer closer + already-threatened-by-me targets; the player is juicier
    let score = d;
    if (o === world.player) score *= 0.8;
    if (craft.ai && craft.ai.target === o) score *= 0.6;   // sticky
    if (score < bestScore){ bestScore = score; best = o; }
  }
  return best;
}

// pick a carrier the AI (a bomber) should attack
function pickCarrierTarget(craft, world){
  let best = null, bestD = Infinity;
  for (const c of world.carriers){
    if (!c.alive || c.team === craft.team) continue;
    const d = dist(craft.pos, c.pos);
    if (d < bestD){ bestD = d; best = c; }
  }
  return best;
}

// forward axis of a craft (nose = +Z in local space) into _fwd
function craftForward(craft, out){
  out = out || _fwd;
  out.set(0, 0, 1).applyQuaternion(craft.group.quaternion);
  return out;
}

// pick the weapon index this craft should be using for a given range/target
function chooseWeapon(craft, range, target){
  const ws = craft.weapons;
  if (!ws || !ws.length) return -1;
  // far away → reach for a missile; close → guns. Skip empty/reloading slots.
  const wantMissile = range > 900;
  let gunIdx = -1, missIdx = -1;
  for (let i = 0; i < ws.length; i++){
    const w = ws[i];
    if (w.type === 'bomb') continue;            // bombers handle bombs separately
    if (w.ammo <= 0 && w.reserve <= 0) continue;
    if (w.type === 'gun'){ if (gunIdx < 0) gunIdx = i; }
    else { if (missIdx < 0) missIdx = i; }
  }
  if (wantMissile && missIdx >= 0) return missIdx;
  if (gunIdx >= 0) return gunIdx;
  return missIdx >= 0 ? missIdx : (gunIdx >= 0 ? gunIdx : -1);
}

// ---------------------------------------------------------------------------
//  MAIN FIGHTER / WINGMAN BRAIN
//  Sets on craft.ai: desired (unit heading), and the craft-level intents
//  craft.throttle, craft.boost, craft.wantGun, craft.wantMissile,
//  craft.wantFlare, craft.aiWeaponIdx. The integrator reads these.
// ---------------------------------------------------------------------------
export function updateAI(craft, world, dt){
  const ai = craft.ai;
  if (!ai) return;

  // clocks
  ai.react -= dt;
  ai.burstT -= dt;
  ai.evadeT -= dt;
  ai.panic = Math.max(0, ai.panic - dt * 0.6);
  craft.wantGun = false;
  craft.wantMissile = false;
  craft.wantFlare = false;

  // re-acquire a target periodically (and whenever ours dies)
  if (!ai.target || !ai.target.alive || ai.react <= 0){
    ai.target = pickTarget(craft, world) || ai.target;
    ai.react = ai.reactTime * (0.7 + Math.random() * 0.6);
  }
  const tgt = ai.target;

  // ---- threat sense: is a missile or a nose pointing at me? ----
  let incoming = null, incomingD = Infinity;
  for (const m of world.missiles){
    if (!m.alive || m.team === craft.team || m.target !== craft) continue;
    const d = dist(craft.pos, m.pos);
    if (d < incomingD){ incomingD = d; incoming = m; }
  }
  if (incoming){ ai.panic = Math.min(2.5, ai.panic + dt * 2.5); }

  // base desired heading: straight ahead, gentle altitude-keep
  craftForward(craft, ai.desired);

  // altitude floor — never dive into the ground; pull up if low & descending
  const groundY = world.groundY || 0;
  const alt = craft.pos.y - groundY;
  let needClimb = 0;
  if (alt < ai.altFloor) needClimb = clamp((ai.altFloor - alt) / ai.altFloor, 0, 1);
  if (craft.vel.y < -20 && alt < ai.altFloor * 2.2) needClimb = Math.max(needClimb, 0.4);

  // ---- state machine ----
  let throttle = 0.7, boost = false;

  if (!tgt){
    // SEEK: orbit toward map centre, hold a patrol altitude
    ai.state = 'seek';
    _to.set(-craft.pos.x, (ai.altFloor + 220) - craft.pos.y, -craft.pos.z);
    if (_to.lengthSq() > 1) _to.normalize();
    ai.desired.lerp(_to, 0.02);
    throttle = 0.62;
  } else {
    _to.set(tgt.pos.x - craft.pos.x, tgt.pos.y - craft.pos.y, tgt.pos.z - craft.pos.z);
    const range = _to.length() || 1;
    const fwd = craftForward(craft, _fwd);
    const losDot = (_to.x * fwd.x + _to.y * fwd.y + _to.z * fwd.z) / range; // -1..1 nose-on
    // angle off our tail that the target sits at relative to ITS nose (are we behind them?)
    const tfwd = craftForward(tgt, _a);
    const behindDot = -((_to.x * tfwd.x + _to.y * tfwd.y + _to.z * tfwd.z) / range);

    // EVADE has priority when panicked or a missile is close
    const mustEvade = ai.panic > 1.0 || (incoming && incomingD < 600);
    if (mustEvade){
      ai.state = 'evade';
      if (ai.evadeT <= 0){ ai.evadeT = 0.8 + Math.random() * 0.7; ai.evadeDir = Math.random() < 0.5 ? -1 : 1; }
      // hard break perpendicular to the threat + barrel-roll jink
      const threat = incoming || tgt;
      _b.set(threat.pos.x - craft.pos.x, threat.pos.y - craft.pos.y, threat.pos.z - craft.pos.z).normalize();
      // perpendicular = cross(threat, up) gives a break vector
      _c.set(0, 1, 0).cross(_b).normalize().multiplyScalar(ai.evadeDir);
      ai.desired.copy(_c);
      ai.desired.y += 0.15 * Math.sin(world.time * 8 + ai.rollPhase);  // jink in pitch
      ai.desired.normalize();
      throttle = 1.0; boost = ai.skill > 0.3 && incomingD < 900;
      // flares against IR
      if (incoming && incoming.kind === 'ir' && craft.flares > 0 && Math.random() < 0.04 + ai.skill * 0.08)
        craft.wantFlare = true;
    } else if (range > 1600){
      // SEEK/PURSUE close the distance, lead slightly for intercept
      ai.state = 'pursue';
      leadPoint(craft.pos, { position: tgt.pos, vel: tgt.vel, alive: true }, 900, _lead);
      ai.desired.set(_lead.x - craft.pos.x, _lead.y - craft.pos.y, _lead.z - craft.pos.z).normalize();
      throttle = 1.0; boost = ai.skill > 0.4 && range > 2400;
    } else if (range < 240 && losDot > 0.3){
      // OVERSHOOT guard: too close & nose-on → ease off to avoid collision/scissors
      ai.state = 'extend';
      ai.desired.set(fwd.x, fwd.y + 0.05, fwd.z).normalize();
      throttle = 0.5;
    } else {
      // ATTACK: aim at the lead point of the best weapon, manage energy
      ai.state = 'attack';
      const wi = chooseWeapon(craft, range, tgt);
      craft.aiWeaponIdx = wi;
      const w = wi >= 0 ? craft.weapons[wi] : null;
      const projSpd = w ? (w.speed || 1000) : 1000;
      leadPoint(craft.pos, { position: tgt.pos, vel: tgt.vel, alive: true }, projSpd, _lead);
      // skill-scaled aim jitter so weak pilots spray
      const jit = ai.aimJitter;
      ai.desired.set(
        _lead.x - craft.pos.x + (Math.random() - 0.5) * jit * range,
        _lead.y - craft.pos.y + (Math.random() - 0.5) * jit * range,
        _lead.z - craft.pos.z + (Math.random() - 0.5) * jit * range
      ).normalize();

      // energy: keep speed up, boost if target is escaping or we're slow
      const spd = craft.speed;
      throttle = 0.85;
      if (spd < craft.stats.vStall * 1.3) { throttle = 1; }
      if (range > 800 && ai.skill > 0.5) boost = true;

      // FIRE GATING — only when the nose is genuinely on the lead solution
      const leadDir = _a.set(_lead.x - craft.pos.x, _lead.y - craft.pos.y, _lead.z - craft.pos.z).normalize();
      const aimDot = leadDir.dot(fwd);
      const aimGate = lerp(0.985, 0.9, 1 - ai.skill);  // skilled pilots fire on tighter solutions
      if (w && aimDot > aimGate){
        if (w.type === 'gun'){
          // burst discipline so they don't drain a clip instantly
          if (ai.burstT <= 0){
            craft.wantGun = true;
            if (Math.random() < dt * (3 + ai.skill * 6)) ai.burstT = ai.burstGap * (0.6 + Math.random() * 0.8);
          } else if (range < 700 * Math.min(1, (w.speed || 1300) / 1300)){ craft.wantGun = true; }  // close-fire range scales with projectile speed (slow rockets only point-blank)
        } else {
          // missiles: respect lock time loosely — fire when reasonably nose-on & in range
          if (range < (w.type === 'lockmissile' ? 2400 : 2000) && Math.random() < dt * (0.4 + ai.skill)){
            craft.wantMissile = true;
            craft.aiWeaponIdx = wi;
          }
        }
      }
    }
  }

  // altitude correction always layered on top
  if (needClimb > 0){ ai.desired.y = lerp(ai.desired.y, 1, needClimb); ai.desired.normalize(); throttle = Math.max(throttle, 0.85); }

  // stall avoidance: if slow, drop the nose to regain speed
  if (craft.speed < craft.stats.vStall * 1.05 && alt > ai.altFloor * 1.4){
    ai.desired.y = Math.min(ai.desired.y, -0.1); ai.desired.normalize(); throttle = 1;
  }

  // commit intents
  craft.throttle = clamp(throttle, 0, 1);
  craft.boost = boost && craft.fuel > 0;
  craft.aiDesired = ai.desired;     // unit world heading the integrator steers toward
}

// ---------------------------------------------------------------------------
//  BOMBER BRAIN — heads for the nearest enemy carrier, lines up a run, and
//  pickles bombs/heavy ordnance on the way over; falls back to dogfight AI if
//  there's no carrier to hit.
// ---------------------------------------------------------------------------
export function updateBomber(craft, world, dt){
  const ai = craft.ai;
  if (!ai) return;
  craft.wantGun = false; craft.wantMissile = false; craft.wantBomb = false; craft.wantFlare = false;

  const carrier = pickCarrierTarget(craft, world);
  if (!carrier){ updateAI(craft, world, dt); return; }   // nothing to bomb → fight

  ai.react -= dt; ai.panic = Math.max(0, ai.panic - dt * 0.6);

  _to.set(carrier.pos.x - craft.pos.x, carrier.pos.y - craft.pos.y, carrier.pos.z - craft.pos.z);
  const range = _to.length() || 1;
  craftForward(craft, _fwd);

  // approach run: aim slightly above the carrier then dive the bombs in
  const alt = craft.pos.y - (world.groundY || 0);
  let throttle = 0.85, boost = false;

  // missile threat → quick jink + flares, but keep pressing the attack
  let incoming = null, incomingD = Infinity;
  for (const m of world.missiles){ if (m.alive && m.team !== craft.team && m.target === craft){ const d = dist(craft.pos, m.pos); if (d < incomingD){ incomingD = d; incoming = m; } } }
  if (incoming && incomingD < 500){
    _c.set(0, 1, 0).cross(_to.clone().normalize()).normalize();
    ai.desired.copy(_c); ai.desired.normalize();
    if (incoming.kind === 'ir' && craft.flares > 0 && Math.random() < 0.08) craft.wantFlare = true;
    throttle = 1; boost = true;
  } else {
    // fly toward the carrier, holding a bombing altitude band
    const aimY = carrier.pos.y + clamp((180 - alt), -60, 220) + 90;
    ai.desired.set(carrier.pos.x - craft.pos.x, aimY - craft.pos.y, carrier.pos.z - craft.pos.z).normalize();
    throttle = range > 1400 ? 1 : 0.8;

    // drop bombs when overhead-ish and reasonably close & lined up
    const bombIdx = craft.weapons ? craft.weapons.findIndex(w => w.type === 'bomb' && (w.ammo > 0 || w.reserve > 0)) : -1;
    if (bombIdx >= 0 && range < 700 && Math.abs(craft.pos.x - carrier.pos.x) < 240 && Math.abs(craft.pos.z - carrier.pos.z) < 240){
      if (Math.random() < dt * 3){ craft.wantBomb = true; craft.aiWeaponIdx = bombIdx; }
    }
    // also loose missiles at the carrier from range
    const missIdx = craft.weapons ? craft.weapons.findIndex(w => (w.type === 'missile' || w.type === 'lockmissile') && (w.ammo > 0 || w.reserve > 0)) : -1;
    if (missIdx >= 0 && range < 1800 && _fwd.dot(_to.clone().normalize()) > 0.9 && Math.random() < dt * (0.4 + ai.skill)){
      craft.wantMissile = true; craft.aiWeaponIdx = missIdx;
    }
  }

  // don't fly into the ground / sea
  if (alt < ai.altFloor){ ai.desired.y = Math.max(ai.desired.y, 0.5); ai.desired.normalize(); throttle = 1; }
  if (craft.speed < craft.stats.vStall * 1.1){ ai.desired.y = Math.min(ai.desired.y, 0); throttle = 1; }

  craft.throttle = clamp(throttle, 0, 1);
  craft.boost = boost && craft.fuel > 0;
  craft.aiDesired = ai.desired;
}

// ---------------------------------------------------------------------------
//  CARRIER POINT-DEFENCE — carriers don't fly, but they pick the nearest
//  hostile aircraft and return aim info so the sim can spit flak/CIWS tracers.
//  Returns { target, lead } or null.
// ---------------------------------------------------------------------------
export function updateCarrierPD(carrier, world, dt){
  if (!carrier.alive) return null;
  let best = null, bestD = Infinity;
  const range = carrier.pdRange || 1500;
  for (const o of world.craft){
    if (!o.alive || o.team === carrier.team) continue;
    const d = dist(carrier.pos, o.pos);
    if (d < range && d < bestD){ bestD = d; best = o; }
  }
  if (!best) return null;
  const lead = leadPoint(carrier.pos, { position: best.pos, vel: best.vel, alive: true }, carrier.pdSpeed || 1100, _lead.clone());
  return { target: best, lead, range: bestD };
}

// utility re-exported for battle.js convenience
export { interceptTime };

// ============================================================================
//  Ace of Sky II — prediction.js
//  PORTED FROM "Gravity Front" (js/battle.js): the movement-prediction lead
//  solver, the cone-based lock-on system (with acquire/hold hysteresis), and
//  the hit-prediction HUD. Generalised here from mobile-suits to aircraft.
//
//  Three pieces, same as the original:
//    1. leadPoint()      — iterative intercept solve (where to aim at a mover)
//    2. LockSystem       — updateLockOn(): cone acquire → timed lock → fire
//    3. PredictionHUD    — drawPredict()/drawReticle(): the on-screen guide
// ============================================================================
import * as THREE from 'three';

const _S = new THREE.Vector3(), _T = new THREE.Vector3(), _to = new THREE.Vector3();
const _proj = new THREE.Vector3(), _proj2 = new THREE.Vector3();

// ---------------------------------------------------------------------------
//  1. MOVEMENT PREDICTION — iterative lead solve (ported from leadPoint())
//     where to aim so a `spd` projectile from S intercepts a moving target.
// ---------------------------------------------------------------------------
export function leadPoint(shooterPos, target, spd, out){
  out = out || new THREE.Vector3();
  const S = shooterPos;
  const p = target.position, v = target.vel || { x: 0, y: 0, z: 0 };
  const Tx = p.x, Ty = p.y + (target.aimY || 0), Tz = p.z;
  let t = Math.hypot(Tx - S.x, Ty - S.y, Tz - S.z) / Math.max(1, spd);
  // four refinement passes converge the intercept time (same as the original)
  for (let k = 0; k < 4; k++)
    t = Math.hypot(Tx + v.x * t - S.x, Ty + v.y * t - S.y, Tz + v.z * t - S.z) / Math.max(1, spd);
  return out.set(Tx + v.x * t, Ty + v.y * t, Tz + v.z * t);
}

// time-to-intercept (seconds) for a `spd` shot — handy for HUD readouts/AI
export function interceptTime(shooterPos, target, spd){
  const p = target.position;
  return Math.hypot(p.x - shooterPos.x, p.y + (target.aimY || 0) - shooterPos.y, p.z - shooterPos.z) / Math.max(1, spd);
}

// ---------------------------------------------------------------------------
//  2. LOCK-ON SYSTEM (ported from updateLockOn() / lockConeDot())
//     Cone hysteresis: a narrow cone to ACQUIRE, a wider one to HOLD, so the
//     lock doesn't flicker between targets. Timed build to a full lock.
// ---------------------------------------------------------------------------
export class LockSystem {
  constructor(opts = {}){
    this.range   = opts.range   ?? 2600;
    this.acquire = Math.cos(opts.acquireAngle ?? 0.42);  // ~24° to start a lock
    this.hold    = Math.cos(opts.holdAngle    ?? 0.62);  // ~36° to keep it
    this.team    = opts.team ?? 0;
    this.self    = opts.self ?? null;
    this.target  = null;
    this.lockT   = 0;
    this.flash   = 0;        // brief post-lock flash for the HUD
  }
  _coneDot(e, origin, fwd){
    if (!e || !e.alive || e === this.self || e.team === this.team) return -2;
    const to = _to.set(e.position.x - origin.x, e.position.y - origin.y, e.position.z - origin.z);
    const d = to.length();
    if (d > this.range || d < 1) return -2;
    return to.multiplyScalar(1 / d).dot(fwd);
  }
  // call every frame. opts: { origin, fwd, candidates, lockTime, ready }
  //   ready = caller permits the lock to build (has ammo, trigger held, etc.)
  // returns { target, progress 0..1, locked, justLocked }
  update(dt, opts){
    if (this.flash > 0) this.flash -= dt;
    const { origin, fwd, candidates, lockTime = 2.0, ready = true } = opts;
    // keep the current target while it stays inside the (wider) hold cone…
    let tgt = this.target;
    if (this._coneDot(tgt, origin, fwd) < this.hold){
      tgt = null; let best = this.acquire;                 // …else acquire the most-centred enemy in the (narrow) acquire cone
      for (const e of candidates){ const d = this._coneDot(e, origin, fwd); if (d > best){ best = d; tgt = e; } }
      if (tgt !== this.target) this.lockT = 0;             // new target → restart the lock timer
    }
    this.target = tgt;
    let justLocked = false;
    if (tgt && ready){
      const prev = this.lockT;
      this.lockT = Math.min(lockTime, this.lockT + dt);
      if (prev < lockTime && this.lockT >= lockTime){ justLocked = true; this.flash = 0.6; }
    } else {
      this.lockT = Math.max(0, this.lockT - dt * 2);       // decays when not building
    }
    const progress = lockTime > 0 ? Math.min(1, this.lockT / lockTime) : 1;
    return { target: tgt, progress, locked: progress >= 1, justLocked };
  }
  reset(){ this.target = null; this.lockT = 0; }
}

// ---------------------------------------------------------------------------
//  3. PREDICTION HUD (ported from drawPredict() / drawReticle())
//     Pure visual guide — never auto-aims. Draws the target designator, the
//     acquisition arc, and the lead pipper at leadPoint().
// ---------------------------------------------------------------------------
function toScreen(v, camera, W, H){
  _proj.copy(v).project(camera);
  if (_proj.z > 1) return null;                            // behind camera
  return { x: (_proj.x * 0.5 + 0.5) * W, y: (-_proj.y * 0.5 + 0.5) * H };
}

// opts: { ctx, camera, W, H, shooterPos, target, weapon, progress, locked, assist }
export function drawPrediction(opts){
  const { ctx, camera, W, H, shooterPos, target, weapon, progress = 0, locked = false, assist = false } = opts;
  if (!target || !target.alive) return;
  const aimY = target.aimY || 0;
  _T.set(target.position.x, target.position.y + aimY, target.position.z);
  const sc = toScreen(_T, camera, W, H);
  if (!sc) return;
  const spd = (weapon && weapon.speed) || 1200;
  const col = locked ? (assist ? '#ff5530' : '#ffd23b') : '#39ff88';  // red=auto-aim, amber=locked, green=predicting
  ctx.save();
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = locked ? 2.3 : 1.6;
  ctx.setLineDash(locked ? [] : [5, 4]);
  ctx.beginPath(); ctx.arc(sc.x, sc.y, 18, 0, 7); ctx.stroke();
  if (!locked && progress > 0){                            // acquisition arc fills as the lock builds
    ctx.setLineDash([]); ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.arc(sc.x, sc.y, 22, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.6;
  }
  ctx.setLineDash([]);
  // lead pipper + line — the player aims here to hit a moving target
  if (locked || progress <= 0 || !weapon || weapon.alwaysLead){
    const lead = leadPoint(shooterPos, target, spd);
    const lp = toScreen(lead, camera, W, H);
    if (lp){
      ctx.beginPath(); ctx.moveTo(sc.x, sc.y); ctx.lineTo(lp.x, lp.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(lp.x, lp.y, 7, 0, 7); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(lp.x - 12, lp.y); ctx.lineTo(lp.x + 12, lp.y);
      ctx.moveTo(lp.x, lp.y - 12); ctx.lineTo(lp.x, lp.y + 12); ctx.stroke();
      ctx.font = 'bold 11px monospace'; ctx.textAlign = 'left'; ctx.fillText('AIM', lp.x + 11, lp.y - 9);
    }
  }
  const rng = Math.round(Math.hypot(_T.x - shooterPos.x, _T.y - shooterPos.y, _T.z - shooterPos.z));
  ctx.font = 'bold 12px monospace'; ctx.textAlign = 'left';
  ctx.fillText(locked ? `${assist ? 'AUTO-AIM' : 'LOCKED'} · ${rng}m` : `${rng}m`, sc.x + 23, sc.y + 4);
  ctx.restore();
}

// missile lock reticle — converging brackets over a lock-on-missile target
// (ported from drawReticle()). opts: { ctx, camera, W, H, target, progress, flash }
export function drawLockReticle(opts){
  const { ctx, camera, W, H, target, progress = 0, flash = 0, shooterPos = null } = opts;
  if (!target || !target.alive) return;
  _T.set(target.position.x, target.position.y + (target.aimY || 0), target.position.z);
  const sc = toScreen(_T, camera, W, H);
  if (!sc) return;
  const rng = shooterPos ? Math.round(Math.hypot(_T.x - shooterPos.x, _T.y - shooterPos.y, _T.z - shooterPos.z)) : null;
  const dtxt = rng != null ? ' · ' + rng + ' m' : '';
  const locked = progress >= 1 || flash > 0;
  const col = locked ? '#ff3b3b' : '#ffce3b';
  const s = 80 - 46 * progress, L = 16;
  ctx.save();
  ctx.lineWidth = 2.5; ctx.strokeStyle = col;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]){
    ctx.beginPath();
    ctx.moveTo(sc.x + sx * s, sc.y + sy * s - sy * L);
    ctx.lineTo(sc.x + sx * s, sc.y + sy * s);
    ctx.lineTo(sc.x + sx * s - sx * L, sc.y + sy * s);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.45 + 0.55 * progress;
  ctx.beginPath(); ctx.arc(sc.x, sc.y, s * 0.6, 0, 7); ctx.stroke();
  ctx.globalAlpha = 1;
  if (locked){ ctx.beginPath(); ctx.moveTo(sc.x - 11, sc.y); ctx.lineTo(sc.x + 11, sc.y); ctx.moveTo(sc.x, sc.y - 11); ctx.lineTo(sc.x, sc.y + 11); ctx.stroke(); }
  ctx.fillStyle = col; ctx.font = 'bold 14px monospace'; ctx.textAlign = 'center';
  ctx.fillText((locked ? 'LOCK ON — FOX' : `LOCKING ${Math.round(progress * 100)}%`) + dtxt, sc.x, sc.y - s - 12);
  ctx.restore();
}

// homing guidance for fired missiles (proportional steer toward a lead point),
// generalised from the original missile turn-toward-target logic.
export function homeMissile(missile, target, turnRate, dt){
  if (!target || !target.alive){ return false; }
  const lead = leadPoint(missile.position, target, missile.speed || 700);
  const desired = _to.set(lead.x - missile.position.x, lead.y - missile.position.y, lead.z - missile.position.z);
  if (desired.lengthSq() < 1) return true;
  desired.normalize();
  const vel = missile.vel;
  const cur = _S.set(vel.x, vel.y, vel.z); const spd = cur.length() || 1;
  cur.multiplyScalar(1 / spd);
  // rotate current heading toward desired, capped by turnRate (rad/s)
  const dot = Math.max(-1, Math.min(1, cur.dot(desired)));
  const ang = Math.acos(dot);
  const step = Math.min(ang, turnRate * dt);
  if (ang > 1e-3){
    const tns = step / ang;
    cur.lerp(desired, tns).normalize();
  }
  vel.x = cur.x * spd; vel.y = cur.y * spd; vel.z = cur.z * spd;
  return true;
}

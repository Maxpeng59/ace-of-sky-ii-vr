// ============================================================================
//  Ace of Sky II — net.js
//  Relay client for human-vs-human PvP. There is NO direct peer connection:
//  both browsers talk to the dependency-free relay (server/relay.py), which is
//  a simple store-and-forward mailbox per room. This module:
//    * creates / joins a room (host vs client),
//    * PUSHES outgoing messages with POST /msg (batched, throttled),
//    * PULLS incoming messages with GET /poll on a ~15-20Hz timer,
//    * fans the pulled messages out to typed callbacks,
//    * detects the peer arriving/leaving and surfaces timeouts via onClose.
//
//  Message envelope (what travels over the wire, opaque to the relay):
//      { t:'state'|'event'|'fleet'|'ready'|'hello'|'bye'|'ping', ... }
//  Callers send via the returned send(msg); they receive via the onState /
//  onEvent / onPeer callbacks passed to connect().
//
//  Public API (FROZEN by CONTRACT.md):
//    connect({ url, room, role, onState, onEvent, onPeer, onClose })
//      -> { send(msg), close() }
//  Plus a couple of helper statics on `connect` for the lobby UI (createRoom /
//  joinRoom) that don't start polling — handy before a match begins.
// ============================================================================

// ---- tuning ----------------------------------------------------------------
const POLL_HZ = 18;                  // how often we drain our mailbox
const SEND_HZ = 20;                  // max flush rate for the outgoing batch
const POLL_MS = Math.round(1000 / POLL_HZ);
const SEND_MS = Math.round(1000 / SEND_HZ);
const PEER_TIMEOUT_MS = 9000;        // no peer traffic this long -> consider it dropped
const FAIL_LIMIT = 25;               // consecutive network failures before giving up

const DEFAULT_URL = 'http://localhost:8787';

// normalise a base url (strip trailing slash)
function cleanUrl(u){
  u = (u || DEFAULT_URL).trim();
  if (u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

// fetch JSON with a hard timeout so a dead relay can't wedge the poll loop
async function jfetch(url, opts = {}, timeoutMs = 6000){
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    let body = null;
    try { body = await res.json(); } catch (e){ body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch (e){
    return { ok: false, status: 0, body: null, error: e };
  } finally {
    clearTimeout(tid);
  }
}

// ---------------------------------------------------------------------------
//  Lobby helpers — used by pvp.js BEFORE a live connection exists.
//  They do a single request and return a plain result.
// ---------------------------------------------------------------------------
export async function createRoom(url){
  const base = cleanUrl(url);
  const r = await jfetch(base + '/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (r.ok && r.body && r.body.ok) return { ok: true, room: r.body.room };
  return { ok: false, error: (r.body && r.body.error) || 'relay unreachable' };
}
export async function joinRoom(url, room){
  const base = cleanUrl(url);
  const r = await jfetch(base + '/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: String(room || '').toUpperCase() }),
  });
  if (r.ok && r.body && r.body.ok) return { ok: true, room: r.body.room, peers: r.body.peers || [] };
  return { ok: false, error: (r.body && r.body.error) || 'could not join room' };
}
export async function checkHealth(url){
  const base = cleanUrl(url);
  const r = await jfetch(base + '/health', {}, 4000);
  return !!(r.ok && r.body && r.body.ok);
}

// ---------------------------------------------------------------------------
//  connect() — the live transport. Begins polling immediately on an existing
//  room (the lobby has already created/joined it). Returns { send, close }.
// ---------------------------------------------------------------------------
export function connect({ url, room, role, onState, onEvent, onPeer, onClose }){
  const base = cleanUrl(url);
  const code = String(room || '').toUpperCase();
  const myRole = role === 'host' ? 'host' : 'client';

  // queues / timers / state
  let outbox = [];                   // messages waiting to be flushed
  let alive = true;
  let fails = 0;                     // consecutive network failures
  let peerSeen = false;             // has the other player ever shown up?
  let lastPeerMsg = Date.now();     // last time we heard ANY traffic from them
  let pollTimer = null, sendTimer = null, watchTimer = null;
  let polling = false, sending = false;

  const cbState = typeof onState === 'function' ? onState : () => {};
  const cbEvent = typeof onEvent === 'function' ? onEvent : () => {};
  const cbPeer  = typeof onPeer  === 'function' ? onPeer  : () => {};
  const cbClose = typeof onClose === 'function' ? onClose : () => {};

  let closed = false;
  function shutdown(reason){
    if (closed) return;
    closed = true; alive = false;
    if (pollTimer) clearTimeout(pollTimer);
    if (sendTimer) clearTimeout(sendTimer);
    if (watchTimer) clearInterval(watchTimer);
    pollTimer = sendTimer = watchTimer = null;
    try { cbClose(reason || 'closed'); } catch (e){ /* ignore */ }
  }

  // ---- route one incoming message to the right callback ----
  function route(msg){
    if (!msg || typeof msg !== 'object') return;
    lastPeerMsg = Date.now();
    switch (msg.t){
      case 'state':
        cbState(msg); break;
      case 'event':
        cbEvent(msg); break;
      case 'fleet':
      case 'ready':
      case 'hello':
        // peer-level lobby/handshake messages also flow through onEvent so the
        // lobby and the battle can both react to fleet/ready exchanges.
        cbEvent(msg); break;
      case 'bye':
        cbEvent(msg);
        shutdown('peer left');
        break;
      case 'ping':
        break; // keep-alive only; updates lastPeerMsg above
      default:
        cbEvent(msg);
    }
  }

  // ---- poll loop: drain our mailbox, fan out ----
  async function pollOnce(){
    if (!alive || polling) return;
    polling = true;
    const r = await jfetch(`${base}/poll?room=${encodeURIComponent(code)}&from=${myRole}`, {}, 6000);
    polling = false;
    if (!alive) return;
    if (r.status === 404 || (r.body && r.body.gone)){
      shutdown('room closed'); return;
    }
    if (!r.ok || !r.body){
      if (++fails >= FAIL_LIMIT) shutdown('relay unreachable');
      return;
    }
    fails = 0;
    // peer presence from the room roster
    const peers = r.body.peers || [];
    const other = myRole === 'host' ? 'client' : 'host';
    const hasPeer = peers.indexOf(other) >= 0;
    if (hasPeer && !peerSeen){ peerSeen = true; try { cbPeer({ joined: true, peers }); } catch (e){} }
    // deliver queued messages in order
    const msgs = r.body.messages || [];
    for (const m of msgs) route(m);
  }

  // ---- send loop: flush the outbox as ONE batched POST ----
  async function sendOnce(){
    if (!alive || sending) return;
    if (outbox.length === 0) return;
    sending = true;
    const batch = outbox;
    outbox = [];
    const r = await jfetch(base + '/msg', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: code, from: myRole, data: batch }),
    }, 6000);
    sending = false;
    if (!alive) return;
    if (r.status === 404 || (r.body && r.body.gone)){ shutdown('room closed'); return; }
    if (!r.ok){
      // requeue what we tried to send (cap so a long outage can't balloon memory)
      outbox = batch.concat(outbox).slice(-300);
      if (++fails >= FAIL_LIMIT) shutdown('relay unreachable');
    } else {
      fails = 0;
    }
  }

  // self-rescheduling timers (setTimeout chain avoids overlap pile-ups)
  function schedulePoll(){
    if (!alive) return;
    pollTimer = setTimeout(async () => { await pollOnce(); schedulePoll(); }, POLL_MS);
  }
  function scheduleSend(){
    if (!alive) return;
    sendTimer = setTimeout(async () => { await sendOnce(); scheduleSend(); }, SEND_MS);
  }

  // peer-timeout watchdog: if a peer was seen and then went silent, surface it.
  function startWatch(){
    watchTimer = setInterval(() => {
      if (!alive) return;
      if (peerSeen && (Date.now() - lastPeerMsg) > PEER_TIMEOUT_MS){
        cbPeer({ joined: false, timedOut: true });
        // don't hard-close on first silence; only if it persists much longer
        if ((Date.now() - lastPeerMsg) > PEER_TIMEOUT_MS * 2) shutdown('peer timed out');
      }
    }, 1500);
  }

  // ---- public API ----
  function send(msg){
    if (!alive || !msg) return;
    outbox.push(msg);
    // hard cap so a stalled relay can't grow the queue without bound; state
    // frames are disposable so we drop the oldest non-critical ones first.
    if (outbox.length > 200){
      const keep = outbox.filter(m => m && m.t !== 'state');
      const states = outbox.filter(m => m && m.t === 'state').slice(-40);
      outbox = keep.concat(states).slice(-200);
    }
  }
  function close(){
    // best-effort goodbye so the peer learns immediately
    try {
      navigator.sendBeacon && navigator.sendBeacon(
        base + '/msg',
        new Blob([JSON.stringify({ room: code, from: myRole, data: { t: 'bye' } })], { type: 'application/json' })
      );
    } catch (e){ /* ignore */ }
    shutdown('local close');
  }

  // kick everything off
  send({ t: 'hello', role: myRole });
  schedulePoll();
  scheduleSend();
  startWatch();

  return { send, close };
}

// attach lobby helpers to connect for convenient `import { connect } from`
connect.createRoom = createRoom;
connect.joinRoom = joinRoom;
connect.checkHealth = checkHealth;

export default connect;

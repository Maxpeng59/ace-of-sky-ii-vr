// ============================================================================
//  Ace of Sky II — pvp.js
//  HUMAN vs HUMAN player-versus-player. Never PvE — the opponent's aircraft are
//  driven by the remote human over the relay (see net.js + server/relay.py),
//  not by AI.
//
//  Flow (rendered into #screen-pvp):
//    1. SETUP   — pick a build budget (State.pvp.budget) and a design countdown
//                 (State.pvp.designSeconds, default 300s / 5 min).
//    2. DESIGN  — a live countdown; design as many / as good aircraft as the
//                 budget allows via Hangar.open. Saved craft accumulate into a
//                 FLEET; total spent is tracked against the budget. At 0 (or on
//                 "LOCK FLEET") the fleet is frozen.
//    3. LOBBY   — connect to the relay (net.connect). HOST creates a room and
//                 reads out the code; CLIENT joins by code. Each side exchanges
//                 its fleet as exportCode() strings and flags readiness.
//    4. MATCH   — when BOTH are ready, Battle.start({ player:lead, allies:rest,
//                 enemies:[], net:{role,send,onMsg,close}, objective:{type:'pvp'},
//                 onEnd }). The enemy fleet is spawned from the peer's codes and
//                 driven by the remote human via net.
//
//  Public API (FROZEN): export const Pvp = { show() }.  BACK -> Menu.show().
// ============================================================================
import { $, el, clear, show, hide, toast, sfx, fmtCr, fmtTime, clamp } from './util.js';
import { State, newDesign, cloneDesign, exportCode, importCode, statsOf, save } from './core.js';
import { connect, createRoom, joinRoom, checkHealth } from './net.js';
import { Hangar } from './hangar.js';
import { Battle } from './battle.js';
import { Menu } from './menu.js';

const ROOT_ID = 'screen-pvp';
const SCREEN_IDS = ['screen-menu', 'screen-creative', 'screen-campaign', 'screen-pvp', 'screen-hangar'];
const RELAY_KEY = 'aceofsky2.relayUrl';

// ---- module-scoped session state (one PvP session at a time) ---------------
let root = null;
let session = null;     // see makeSession()
let designTimer = null; // setInterval handle for the design countdown
let net = null;         // live transport from net.connect()
let teardownFns = [];   // listeners to remove on exit

function makeSession(){
  return {
    phase: 'setup',                          // setup | design | lobby | match
    budget: State.pvp.budget || 60000,
    designSeconds: State.pvp.designSeconds || 300,
    remaining: State.pvp.designSeconds || 300,
    fleet: [],                               // array of AircraftDesign (mine)
    locked: false,                           // fleet frozen?
    relayUrl: localStorage.getItem(RELAY_KEY) || 'http://localhost:8787',
    role: null,                              // 'host' | 'client'
    room: '',
    connected: false,
    peerJoined: false,
    myReady: false,
    peerReady: false,
    myFleetCodes: [],                        // exportCode() of my fleet
    peerFleetCodes: [],                      // received from peer
    peerFleetMeta: [],                       // [{name, cost}] for display
    status: '',                              // lobby status line
  };
}

// ---------------------------------------------------------------------------
//  Screen lifecycle
// ---------------------------------------------------------------------------
export const Pvp = {
  show(){
    root = $(ROOT_ID);
    if (!root){ console.error('pvp: #screen-pvp missing'); return; }
    // hide every other screen root, reveal ours
    for (const id of SCREEN_IDS){ const s = $(id); if (s) (id === ROOT_ID ? show(s) : hide(s)); }
    hide($('hud'));
    if (!session) session = makeSession();
    renderPhase();
  },
};

function exitToMenu(){
  cleanupSession();
  Menu.show();
}

function cleanupSession(){
  stopDesignTimer();
  if (net){ try { net.close(); } catch (e){} net = null; }
  for (const fn of teardownFns){ try { fn(); } catch (e){} }
  teardownFns = [];
  session = null;
}

// fleet spend helper -> total cost of all saved designs
function fleetCost(fleet){
  let c = 0;
  for (const d of fleet){ try { c += statsOf(d).cost; } catch (e){} }
  return c;
}

// ---------------------------------------------------------------------------
//  Phase router
// ---------------------------------------------------------------------------
function renderPhase(){
  if (!root || !session) return;
  clear(root);
  if (session.phase === 'setup') renderSetup();
  else if (session.phase === 'design') renderDesign();
  else if (session.phase === 'lobby') renderLobby();
  // 'match' hands off to Battle which owns the screen; nothing to render here.
}

// ===========================================================================
//  PHASE 1 — SETUP
// ===========================================================================
function renderSetup(){
  const wrap = el('div');
  wrap.style.cssText = 'max-width:760px;margin:0 auto;width:100%;';

  const head = el('div', 'row');
  head.style.marginBottom = '6px';
  const back = el('button', 'btn small', '◂ MENU');
  back.onclick = () => { sfx('click'); exitToMenu(); };
  head.appendChild(back);
  const sp = el('div', 'spacer'); head.appendChild(sp);
  wrap.appendChild(head);

  const eyebrow = el('div', 'eyebrow', 'MULTIPLAYER · HUMAN vs HUMAN');
  const h1 = el('h1', 'title', 'PvP DUEL');
  h1.style.fontSize = '48px';
  const sub = el('div', 'subtitle', 'Design a fleet within a budget, connect over the relay, and fight a real opponent.');
  wrap.appendChild(eyebrow); wrap.appendChild(h1); wrap.appendChild(sub);

  const panel = el('div', 'panel');
  panel.style.marginTop = '22px';
  panel.appendChild(el('h2', '', 'Match Setup'));

  // budget control
  const bField = el('label', 'field');
  bField.appendChild(el('span', '', 'Build budget (credits per fleet)'));
  const bRow = el('div', 'row');
  const bInput = el('input');
  bInput.type = 'number'; bInput.min = '5000'; bInput.max = '500000'; bInput.step = '5000';
  bInput.value = String(session.budget); bInput.style.width = '160px';
  const bPreview = el('span', 'credits mono', fmtCr(session.budget));
  bInput.oninput = () => {
    const v = clamp(parseInt(bInput.value || '0', 10) || 0, 5000, 500000);
    session.budget = v; bPreview.textContent = fmtCr(v);
  };
  bRow.appendChild(bInput); bRow.appendChild(bPreview);
  // quick presets
  for (const v of [40000, 60000, 90000, 150000]){
    const p = el('button', 'pill', fmtCr(v));
    p.onclick = () => { session.budget = v; bInput.value = String(v); bPreview.textContent = fmtCr(v); sfx('click'); };
    bRow.appendChild(p);
  }
  bField.appendChild(bRow);
  panel.appendChild(bField);

  // design time control
  const tField = el('label', 'field');
  tField.style.marginTop = '14px';
  tField.appendChild(el('span', '', 'Design phase countdown'));
  const tRow = el('div', 'pill-row');
  const choices = [
    { s: 120, label: '2 min' }, { s: 300, label: '5 min' },
    { s: 600, label: '10 min' }, { s: 1200, label: '20 min' },
  ];
  const tPills = [];
  for (const c of choices){
    const p = el('button', 'pill' + (session.designSeconds === c.s ? ' sel' : ''), c.label);
    p.onclick = () => {
      session.designSeconds = c.s; session.remaining = c.s;
      tPills.forEach(x => x.classList.remove('sel')); p.classList.add('sel'); sfx('click');
    };
    tPills.push(p); tRow.appendChild(p);
  }
  tField.appendChild(tRow);
  panel.appendChild(tField);

  // relay url
  const rField = el('label', 'field');
  rField.style.marginTop = '14px';
  rField.appendChild(el('span', '', 'Relay server URL (run server/relay.py, then paste its address)'));
  const rInput = el('input');
  rInput.type = 'text'; rInput.value = session.relayUrl; rInput.placeholder = 'http://localhost:8787';
  rInput.style.width = '100%';
  rInput.oninput = () => { session.relayUrl = rInput.value.trim(); };
  rField.appendChild(rInput);
  panel.appendChild(rField);

  // help note
  const note = el('div', 'small muted');
  note.style.marginTop = '12px';
  note.innerHTML = 'Start the relay with <span class="kbd">python3 server/relay.py</span>. ' +
    'On a LAN, player&nbsp;2 uses the host machine\'s IP (printed by the server). For internet play, tunnel the port (ngrok/cloudflared).';
  panel.appendChild(note);

  // start design phase
  const actions = el('div', 'row');
  actions.style.marginTop = '20px';
  const go = el('button', 'btn accent big', 'START DESIGN PHASE  ▸');
  go.onclick = () => {
    State.pvp.budget = session.budget;
    State.pvp.designSeconds = session.designSeconds;
    session.remaining = session.designSeconds;
    save();
    sfx('ui');
    session.phase = 'design';
    startDesignTimer();
    renderPhase();
  };
  actions.appendChild(go);

  // option to reuse last fleet
  if (Array.isArray(State.pvp.lastFleet) && State.pvp.lastFleet.length){
    const reuse = el('button', 'btn', 'Reuse last fleet (' + State.pvp.lastFleet.length + ')');
    reuse.onclick = () => {
      session.fleet = State.pvp.lastFleet.map(d => cloneDesign(d, ''));
      toast('Loaded ' + session.fleet.length + ' saved aircraft into the fleet', 'good');
      sfx('ui');
    };
    actions.appendChild(reuse);
  }
  panel.appendChild(actions);

  wrap.appendChild(panel);
  root.appendChild(wrap);
}

// ===========================================================================
//  PHASE 2 — DESIGN  (countdown + fleet management + Hangar.open)
// ===========================================================================
function startDesignTimer(){
  stopDesignTimer();
  designTimer = setInterval(() => {
    if (!session || session.phase !== 'design') return;
    session.remaining -= 1;
    updateTimerDisplay();
    if (session.remaining <= 0){
      session.remaining = 0;
      lockFleet('Time! Fleet locked.');
    }
  }, 1000);
}
function stopDesignTimer(){ if (designTimer){ clearInterval(designTimer); designTimer = null; } }

let timerEl = null, spentEl = null, spentBar = null;
function updateTimerDisplay(){
  if (timerEl){
    timerEl.textContent = fmtTime(Math.max(0, session.remaining));
    timerEl.classList.toggle('hud-warn-tone', session.remaining <= 30 && session.remaining > 0);
  }
}

function renderDesign(){
  const wrap = el('div');
  wrap.style.cssText = 'max-width:980px;margin:0 auto;width:100%;';

  // top bar: timer, budget, spent
  const bar = el('div', 'topbar');
  bar.style.marginBottom = '18px';
  bar.appendChild(el('span', '', 'DESIGN PHASE'));
  const tPill = el('span', 'pill');
  tPill.appendChild(el('span', 'muted', 'TIME '));
  timerEl = el('span', 'mono', fmtTime(session.remaining));
  timerEl.style.fontSize = '16px'; timerEl.style.color = 'var(--accent)';
  tPill.appendChild(timerEl);
  bar.appendChild(tPill);
  const sp = el('div', 'spacer'); bar.appendChild(sp);
  const bPill = el('span', 'pill');
  bPill.appendChild(el('span', 'muted', 'BUDGET '));
  bPill.appendChild(el('span', 'credits', fmtCr(session.budget)));
  bar.appendChild(bPill);
  wrap.appendChild(bar);

  // spent bar
  const spent = fleetCost(session.fleet);
  const spendPanel = el('div', 'panel tight');
  spendPanel.style.marginBottom = '14px';
  const spLabel = el('div', 'hud-bar-label');
  spentEl = el('span', '', fmtCr(spent) + ' / ' + fmtCr(session.budget));
  spLabel.appendChild(el('span', '', 'FLEET COST'));
  spLabel.appendChild(spentEl);
  spendPanel.appendChild(spLabel);
  const barOuter = el('div', 'statbar'); barOuter.style.height = '10px';
  spentBar = el('i');
  const frac = session.budget > 0 ? clamp(spent / session.budget, 0, 1) : 0;
  spentBar.style.width = (frac * 100).toFixed(1) + '%';
  if (spent > session.budget) spentBar.style.background = 'var(--bad)';
  barOuter.appendChild(spentBar);
  spendPanel.appendChild(barOuter);
  if (spent > session.budget){
    const over = el('div', 'warns'); over.style.marginTop = '6px';
    over.innerHTML = '<span class="err">Over budget by ' + fmtCr(spent - session.budget) + ' — trim the fleet before locking in.</span>';
    spendPanel.appendChild(over);
  }
  wrap.appendChild(spendPanel);

  // header row
  const hrow = el('div', 'row');
  hrow.style.marginBottom = '8px';
  hrow.appendChild(el('h2', '', 'Your Fleet (' + session.fleet.length + ')'));
  const hsp = el('div', 'spacer'); hrow.appendChild(hsp);
  const newBtn = el('button', 'btn accent', '✚ NEW AIRCRAFT');
  newBtn.onclick = () => openDesignEditor(null);
  hrow.appendChild(newBtn);
  const impBtn = el('button', 'btn', '⇩ IMPORT CODE');
  impBtn.onclick = importDesignPrompt;
  hrow.appendChild(impBtn);
  wrap.appendChild(hrow);

  // fleet list
  const list = el('div', 'list');
  if (session.fleet.length === 0){
    const empty = el('div', 'panel');
    empty.style.textAlign = 'center'; empty.style.color = 'var(--ink-dim)';
    empty.innerHTML = 'No aircraft yet. Click <b>NEW AIRCRAFT</b> to design your first one.<br>' +
      'The <b>first</b> aircraft in the fleet is your <b>lead</b> (you fly it); the rest are AI-free wingmen you switch to as you lose craft.';
    list.appendChild(empty);
  } else {
    session.fleet.forEach((d, i) => list.appendChild(fleetRow(d, i)));
  }
  wrap.appendChild(list);

  // footer
  const foot = el('div', 'row');
  foot.style.marginTop = '20px';
  const back = el('button', 'btn small', '◂ SETUP');
  back.onclick = () => { stopDesignTimer(); session.phase = 'setup'; renderPhase(); };
  foot.appendChild(back);
  const fsp = el('div', 'spacer'); foot.appendChild(fsp);
  const lock = el('button', 'btn gold big', '🔒 LOCK FLEET & GO TO LOBBY');
  lock.disabled = session.fleet.length === 0 || spent > session.budget;
  lock.onclick = () => lockFleet('Fleet locked.');
  foot.appendChild(lock);
  wrap.appendChild(foot);

  updateTimerDisplay();
  root.appendChild(wrap);
}

function fleetRow(d, i){
  const row = el('div', 'list-row');
  let st; try { st = statsOf(d); } catch (e){ st = null; }
  const swatch = el('div');
  swatch.style.cssText = 'width:30px;height:30px;border-radius:6px;flex:none;border:1px solid rgba(255,255,255,.2);background:' + (d.color || '#cfd8e3');
  row.appendChild(swatch);

  const info = el('div'); info.style.flex = '1';
  const nameLine = el('div');
  nameLine.appendChild(el('b', '', d.name || 'Aircraft'));
  if (i === 0){ const lead = el('span', 'tag'); lead.textContent = 'LEAD'; lead.style.marginLeft = '8px'; lead.style.color = 'var(--gold)'; nameLine.appendChild(lead); }
  info.appendChild(nameLine);
  const meta = el('div', 'small faint mono');
  if (st){
    const warn = (!st.ok) ? ' · ⚠ ' + (st.errors[0] || 'invalid') : '';
    meta.textContent = `${fmtCr(st.cost)} · ${(st.mass/1000).toFixed(1)}t · TWR ${st.twr.toFixed(2)} · ${Math.round(st.vMaxBoost*3.6)}km/h · ${Math.round(st.durability)}HP${warn}`;
    if (!st.ok) meta.style.color = 'var(--bad)';
  } else meta.textContent = 'stats unavailable';
  info.appendChild(meta);
  row.appendChild(info);

  const edit = el('button', 'btn small', 'EDIT');
  edit.onclick = () => openDesignEditor(i);
  row.appendChild(edit);
  const dup = el('button', 'btn small', 'DUP');
  dup.onclick = () => { session.fleet.splice(i + 1, 0, cloneDesign(d)); sfx('click'); renderPhase(); };
  row.appendChild(dup);
  const exp = el('button', 'btn small', 'CODE');
  exp.onclick = () => exportDesignPrompt(d);
  row.appendChild(exp);
  if (i > 0){
    const up = el('button', 'btn small', '▲');
    up.title = 'Promote (move toward lead)';
    up.onclick = () => { const t = session.fleet[i - 1]; session.fleet[i - 1] = d; session.fleet[i] = t; sfx('click'); renderPhase(); };
    row.appendChild(up);
  }
  const del = el('button', 'btn small danger', '✕');
  del.onclick = () => { session.fleet.splice(i, 1); sfx('click'); renderPhase(); };
  row.appendChild(del);
  return row;
}

// open the KSP-style hangar to edit a fleet entry (or create a new one),
// enforcing the remaining-budget as the hangar's budget bar.
function openDesignEditor(index){
  const isNew = index == null;
  const base = isNew ? newDesign('Fleet ' + (session.fleet.length + 1)) : session.fleet[index];
  const editing = cloneDesign(base, '');         // edit a clone; commit on exit
  editing.id = base.id;                           // keep id stable for in-place save
  // remaining budget available to THIS craft = total budget minus other craft
  const spentOthers = fleetCost(session.fleet.filter((_, i) => i !== index));
  const budgetForThis = Math.max(0, session.budget - spentOthers);

  sfx('ui');
  Hangar.open({
    design: editing,
    title: (isNew ? 'NEW AIRCRAFT' : 'EDIT — ' + (base.name || 'Aircraft')) + '   ·   FLEET BUDGET LEFT ' + fmtCr(budgetForThis),
    budget: budgetForThis,
    actions: [
      { label: '✔ SAVE TO FLEET', kind: 'gold', fn: (design, stats) => {
          commitDesign(index, design, stats);
        } },
    ],
    onExit: (design) => {
      // closing without explicit save still commits the current edit (KSP-like)
      let st; try { st = statsOf(design); } catch (e){ st = null; }
      commitDesign(index, design, st);
    },
  });
}

function commitDesign(index, design, stats){
  if (!session) return;
  // validate vs budget for the whole fleet
  const others = session.fleet.filter((_, i) => i !== index);
  const cost = stats ? stats.cost : fleetCost([design]);
  const projected = fleetCost(others) + cost;
  if (index == null){
    session.fleet.push(design);
  } else if (index >= 0 && index < session.fleet.length){
    session.fleet[index] = design;
  } else {
    session.fleet.push(design);
  }
  if (projected > session.budget){
    toast('Saved, but fleet is ' + fmtCr(projected - session.budget) + ' over budget', 'warn');
  } else {
    toast('Saved "' + (design.name || 'Aircraft') + '" to fleet', 'good');
  }
  // back to the design phase screen
  if (Hangar.close) try { Hangar.close(); } catch (e){}
  Pvp.show();
}

function exportDesignPrompt(d){
  const code = exportCode(d);
  showCodeModal('Share code for "' + (d.name || 'Aircraft') + '"', code, false);
  sfx('click');
}
function importDesignPrompt(){
  showCodeModal('Paste an ASK2 design code', '', true, (code) => {
    const d = importCode(code);
    if (!d){ toast('Invalid design code', 'bad'); return; }
    session.fleet.push(d);
    toast('Imported "' + d.name + '"', 'good');
    renderPhase();
  });
}

function lockFleet(msg){
  // drop invalid/empty craft, warn if over budget but allow (battle clamps)
  session.fleet = session.fleet.filter(d => d && d.parts && d.parts.length);
  if (session.fleet.length === 0){ toast('Design at least one aircraft first', 'bad'); session.phase = 'design'; renderPhase(); return; }
  stopDesignTimer();
  session.locked = true;
  // persist for reuse next session
  State.pvp.lastFleet = session.fleet.map(d => cloneDesign(d, ''));
  save();
  session.myFleetCodes = session.fleet.map(d => exportCode(d));
  toast(msg || 'Fleet locked', 'good');
  sfx('lockfull');
  session.phase = 'lobby';
  renderPhase();
}

// ===========================================================================
//  PHASE 3 — LOBBY  (relay connect, fleet exchange, readiness)
// ===========================================================================
function renderLobby(){
  const wrap = el('div');
  wrap.style.cssText = 'max-width:820px;margin:0 auto;width:100%;';

  const head = el('div', 'row');
  head.style.marginBottom = '6px';
  const back = el('button', 'btn small', '◂ DESIGN');
  back.onclick = () => {
    if (net){ try { net.close(); } catch (e){} net = null; }
    session.connected = false; session.peerJoined = false; session.peerReady = false; session.myReady = false;
    session.role = null; session.room = '';
    startDesignTimer();
    session.phase = 'design'; renderPhase();
  };
  head.appendChild(back);
  head.appendChild(el('div', 'spacer'));
  head.appendChild(el('div', 'eyebrow', 'LOBBY'));
  wrap.appendChild(head);

  const h1 = el('h1', 'title', 'LOBBY'); h1.style.fontSize = '40px';
  wrap.appendChild(h1);

  const grid = el('div', 'split');
  grid.style.marginTop = '14px';

  // ---- left: connection ----
  const conn = el('div', 'panel');
  conn.appendChild(el('h2', '', 'Connection'));

  if (!session.connected){
    // relay url
    const rField = el('label', 'field');
    rField.appendChild(el('span', '', 'Relay URL'));
    const rInput = el('input'); rInput.type = 'text'; rInput.value = session.relayUrl; rInput.style.width = '100%';
    rInput.oninput = () => { session.relayUrl = rInput.value.trim(); };
    rField.appendChild(rInput);
    conn.appendChild(rField);

    const btnRow = el('div', 'row'); btnRow.style.marginTop = '14px';
    const hostBtn = el('button', 'btn accent', '⌂ CREATE ROOM (HOST)');
    hostBtn.onclick = () => doHost();
    btnRow.appendChild(hostBtn);
    conn.appendChild(btnRow);

    const joinField = el('label', 'field'); joinField.style.marginTop = '14px';
    joinField.appendChild(el('span', '', 'or join by code'));
    const jrow = el('div', 'row');
    const jInput = el('input'); jInput.type = 'text'; jInput.placeholder = 'CODE'; jInput.maxLength = 8;
    jInput.style.width = '120px'; jInput.style.textTransform = 'uppercase'; jInput.style.fontFamily = 'var(--mono)';
    const joinBtn = el('button', 'btn', 'JOIN');
    joinBtn.onclick = () => doJoin((jInput.value || '').trim().toUpperCase());
    jInput.onkeydown = (e) => { if (e.key === 'Enter') joinBtn.onclick(); };
    jrow.appendChild(jInput); jrow.appendChild(joinBtn);
    joinField.appendChild(jrow);
    conn.appendChild(joinField);

    const health = el('button', 'btn small ghost', 'Test relay');
    health.style.marginTop = '12px';
    health.onclick = async () => {
      const ok = await checkHealth(session.relayUrl);
      toast(ok ? 'Relay reachable ✔' : 'Relay not reachable ✕', ok ? 'good' : 'bad');
    };
    conn.appendChild(health);
  } else {
    // connected — show room + role + peer status
    const roomLine = el('div', 'topbar'); roomLine.style.marginBottom = '12px';
    roomLine.appendChild(el('span', '', session.role === 'host' ? 'HOSTING' : 'JOINED'));
    const codePill = el('span', 'pill');
    codePill.appendChild(el('span', 'muted', 'ROOM '));
    const codeVal = el('span', 'mono', session.room);
    codeVal.style.fontSize = '18px'; codeVal.style.letterSpacing = '.2em'; codeVal.style.color = 'var(--gold)';
    codePill.appendChild(codeVal);
    roomLine.appendChild(codePill);
    if (session.role === 'host'){
      const copy = el('button', 'btn small', 'COPY');
      copy.onclick = () => { copyText(session.room); toast('Code copied — give it to your opponent', 'good'); };
      roomLine.appendChild(copy);
    }
    conn.appendChild(roomLine);

    // peer presence
    const peerBox = el('div', 'card');
    peerBox.appendChild(statusDot('Opponent', session.peerJoined, session.peerJoined ? 'connected' : 'waiting…'));
    conn.appendChild(peerBox);

    const me = el('div', 'card'); me.style.marginTop = '10px';
    me.appendChild(statusDot('You', true, session.myReady ? 'READY' : 'not ready'));
    conn.appendChild(me);

    const drop = el('button', 'btn small danger'); drop.textContent = 'Leave room';
    drop.style.marginTop = '12px';
    drop.onclick = () => {
      if (net){ try { net.close(); } catch (e){} net = null; }
      session.connected = false; session.peerJoined = false; session.peerReady = false; session.myReady = false;
      renderPhase();
    };
    conn.appendChild(drop);

    if (session.status){ const s = el('div', 'small muted'); s.style.marginTop = '10px'; s.textContent = session.status; conn.appendChild(s); }
  }
  grid.appendChild(conn);

  // ---- right: fleets + readiness ----
  const right = el('div', 'panel');
  right.appendChild(el('h2', '', 'Fleets'));

  const mine = el('div');
  mine.appendChild(el('h3', '', 'Your fleet (' + session.fleet.length + ') — ' + fmtCr(fleetCost(session.fleet))));
  for (const d of session.fleet){
    const r = el('div', 'list-row'); r.style.padding = '6px 10px';
    const sw = el('div'); sw.style.cssText = 'width:18px;height:18px;border-radius:4px;flex:none;background:' + (d.color || '#cfd8e3');
    r.appendChild(sw);
    r.appendChild(el('span', '', d.name || 'Aircraft'));
    mine.appendChild(r);
  }
  right.appendChild(mine);

  const peer = el('div'); peer.style.marginTop = '12px';
  const peerCount = session.peerFleetMeta.length;
  peer.appendChild(el('h3', '', 'Opponent fleet (' + (peerCount || '—') + ')'));
  if (peerCount){
    for (const m of session.peerFleetMeta){
      const r = el('div', 'list-row'); r.style.padding = '6px 10px';
      r.appendChild(el('span', '', m.name || 'Aircraft'));
      const sp = el('div', 'spacer'); r.appendChild(sp);
      r.appendChild(el('span', 'small faint mono', fmtCr(m.cost || 0)));
      peer.appendChild(r);
    }
  } else {
    const w = el('div', 'small faint'); w.textContent = session.peerJoined ? 'Waiting for opponent to lock & send fleet…' : 'No opponent yet.';
    peer.appendChild(w);
  }
  right.appendChild(peer);

  // readiness + launch
  if (session.connected){
    const ready = el('div', 'row'); ready.style.marginTop = '16px';
    const readyBtn = el('button', 'btn ' + (session.myReady ? '' : 'accent'),
      session.myReady ? '✓ READY (click to unready)' : 'I AM READY');
    readyBtn.onclick = () => toggleReady();
    ready.appendChild(readyBtn);
    right.appendChild(ready);

    const both = session.myReady && session.peerReady && session.peerJoined && peerCount > 0;
    const status = el('div', 'small'); status.style.marginTop = '10px';
    if (both) { status.style.color = 'var(--good)'; status.textContent = 'Both players ready — launching duel…'; }
    else if (session.myReady && !session.peerReady) { status.style.color = 'var(--warn)'; status.textContent = 'Waiting for opponent to ready up…'; }
    else status.style.color = 'var(--ink-dim)', status.textContent = 'Ready up when your fleet is set.';
    right.appendChild(status);
  }
  grid.appendChild(right);

  wrap.appendChild(grid);
  root.appendChild(wrap);
}

function statusDot(label, on, text){
  const row = el('div', 'row');
  const dot = el('span');
  dot.style.cssText = 'width:12px;height:12px;border-radius:50%;flex:none;background:' + (on ? 'var(--good)' : 'var(--ink-faint)') +
    (on ? ';box-shadow:0 0 8px var(--good)' : '');
  row.appendChild(dot);
  row.appendChild(el('b', '', label));
  row.appendChild(el('div', 'spacer'));
  const txt = el('span', 'small mono', text);
  txt.style.color = on ? 'var(--good)' : 'var(--ink-dim)';
  row.appendChild(txt);
  return row;
}

// ---- relay host / join ----
async function doHost(){
  session.status = 'Creating room…'; renderPhase();
  localStorage.setItem(RELAY_KEY, session.relayUrl);
  const res = await createRoom(session.relayUrl);
  if (!res.ok){ toast('Could not create room: ' + res.error, 'bad'); session.status = res.error; renderPhase(); return; }
  session.role = 'host'; session.room = res.room;
  startLiveNet();
  session.connected = true; session.status = 'Room ' + res.room + ' created. Share the code.';
  toast('Room created: ' + res.room, 'good'); sfx('lockfull');
  renderPhase();
}
async function doJoin(code){
  if (!code){ toast('Enter a room code', 'warn'); return; }
  session.status = 'Joining ' + code + '…'; renderPhase();
  localStorage.setItem(RELAY_KEY, session.relayUrl);
  const res = await joinRoom(session.relayUrl, code);
  if (!res.ok){ toast('Could not join: ' + res.error, 'bad'); session.status = res.error; renderPhase(); return; }
  session.role = 'client'; session.room = res.room;
  startLiveNet();
  session.connected = true;
  session.peerJoined = (res.peers || []).indexOf('host') >= 0;
  session.status = 'Joined room ' + res.room + '.';
  toast('Joined ' + res.room, 'good'); sfx('lockfull');
  renderPhase();
}

// open the live transport and wire lobby-phase handlers
function startLiveNet(){
  if (net){ try { net.close(); } catch (e){} net = null; }
  net = connect({
    url: session.relayUrl,
    room: session.room,
    role: session.role,
    onState: () => {},     // no state frames in the lobby
    onEvent: onLobbyMsg,
    onPeer: onPeerChange,
    onClose: (reason) => {
      if (session && session.phase === 'lobby'){
        session.connected = false; session.peerJoined = false; session.peerReady = false;
        session.status = 'Disconnected: ' + reason;
        toast('Connection lost: ' + reason, 'bad');
        renderPhase();
      }
    },
  });
  // announce ourselves + send fleet immediately so a peer already present gets it
  sendHello();
}

function sendHello(){
  if (!net) return;
  net.send({ t: 'hello', role: session.role });
  // send fleet codes + lightweight meta for the lobby display
  net.send({
    t: 'fleet',
    codes: session.myFleetCodes,
    meta: session.fleet.map(d => { let c = 0; try { c = statsOf(d).cost; } catch (e){} return { name: d.name, cost: c }; }),
  });
  net.send({ t: 'ready', ready: session.myReady });
}

function onPeerChange(info){
  if (!session) return;
  if (info.joined){
    session.peerJoined = true;
    session.status = 'Opponent connected.';
    // re-send our fleet so the late joiner gets it
    sendHello();
    if (session.phase === 'lobby') renderPhase();
  } else if (info.timedOut){
    session.peerJoined = false;
    if (session.phase === 'lobby'){ session.status = 'Opponent went quiet…'; renderPhase(); }
  }
}

function onLobbyMsg(msg){
  if (!session || !msg) return;
  if (msg.t === 'hello'){
    session.peerJoined = true;
    // someone just arrived — make sure they have our fleet/ready state
    sendHello();
    if (session.phase === 'lobby') renderPhase();
    return;
  }
  if (msg.t === 'fleet'){
    session.peerFleetCodes = Array.isArray(msg.codes) ? msg.codes : [];
    session.peerFleetMeta = Array.isArray(msg.meta) ? msg.meta : session.peerFleetCodes.map(() => ({ name: 'Aircraft', cost: 0 }));
    session.peerJoined = true;
    if (session.phase === 'lobby') renderPhase();
    return;
  }
  if (msg.t === 'ready'){
    session.peerReady = !!msg.ready;
    session.peerJoined = true;
    if (session.phase === 'lobby'){ renderPhase(); maybeStartMatch(); }
    return;
  }
  if (msg.t === 'bye'){
    session.peerJoined = false; session.peerReady = false;
    if (session.phase === 'lobby'){ session.status = 'Opponent left.'; renderPhase(); }
    return;
  }
}

function toggleReady(){
  session.myReady = !session.myReady;
  if (net) net.send({ t: 'ready', ready: session.myReady });
  sfx(session.myReady ? 'lock' : 'click');
  renderPhase();
  maybeStartMatch();
}

// both ready + both fleets exchanged -> start the duel.
// The HOST waits a beat to make sure the CLIENT also transitions (both sides
// independently check the same condition, so both will start).
let matchStarting = false;
function maybeStartMatch(){
  if (matchStarting || !session) return;
  if (session.phase !== 'lobby') return;
  if (!(session.myReady && session.peerReady)) return;
  if (!session.peerJoined) return;
  if (!session.peerFleetCodes || session.peerFleetCodes.length === 0) return;
  if (!session.fleet || session.fleet.length === 0) return;
  matchStarting = true;
  session.status = 'Launching…';
  // small delay so the final 'ready' has time to round-trip both ways
  setTimeout(() => startMatch(), 600);
}

// ===========================================================================
//  PHASE 4 — MATCH  (hand off to Battle with a net transport)
// ===========================================================================
function startMatch(){
  if (!session) return;
  matchStarting = false;
  session.phase = 'match';

  // build the enemy fleet from the peer's design codes (human-driven over net)
  const enemyDesigns = [];
  for (const code of session.peerFleetCodes){
    const d = importCode(code);
    if (d) enemyDesigns.push(d);
  }
  if (enemyDesigns.length === 0){
    toast('Opponent fleet missing — cannot start', 'bad');
    session.phase = 'lobby'; renderPhase(); return;
  }

  const myLead = session.fleet[0];
  const myAllies = session.fleet.slice(1);

  // Adapt our net transport to Battle's expected shape:
  //   net: { role, send(msg), onMsg(cb), close() }
  // Battle pushes its own 'state'/'event' messages through send and subscribes
  // via onMsg; we route incoming through a single dispatcher.
  const battleSubs = new Set();
  const battleNet = {
    role: session.role,
    send: (m) => { if (net) net.send(m); },
    onMsg: (cb) => { battleSubs.add(cb); return () => battleSubs.delete(cb); },
    close: () => { /* net is closed in onEnd */ },
    // metadata Battle may use to spawn/identify the remote fleet
    peerFleet: enemyDesigns,
    peerFleetCodes: session.peerFleetCodes.slice(),
  };

  // re-point the live transport's callbacks at the battle dispatcher
  if (net){ try { net.close(); } catch (e){} net = null; }
  net = connect({
    url: session.relayUrl,
    room: session.room,
    role: session.role,
    onState: (m) => { for (const cb of battleSubs) try { cb(m); } catch (e){} },
    onEvent: (m) => {
      if (m && m.t === 'bye'){ toast('Opponent disconnected', 'warn'); }
      for (const cb of battleSubs) try { cb(m); } catch (e){}
    },
    onPeer: (info) => {
      if (info && info.timedOut){ for (const cb of battleSubs) try { cb({ t: 'event', kind: 'peerTimeout' }); } catch (e){} }
    },
    onClose: (reason) => { for (const cb of battleSubs) try { cb({ t: 'event', kind: 'netClose', reason }); } catch (e){} },
  });
  battleNet.send = (m) => { if (net) net.send(m); };

  // hide our screen; Battle owns #hud and the GL view from here
  hide(root);
  sfx('lockfull');

  Battle.start({
    player: myLead,
    allies: myAllies,
    enemies: [],                                   // PvE list is empty — this is human vs human
    env: 'day',
    objective: { type: 'pvp', label: 'PVP DUEL', host: session.role === 'host' },
    net: battleNet,
    onEnd: (result) => onMatchEnd(result),
  });
}

function onMatchEnd(result){
  // close the transport and return to the lobby for a rematch
  if (net){ try { net.close(); } catch (e){} net = null; }
  if (!session){ Menu.show(); return; }
  session.connected = false; session.peerJoined = false; session.peerReady = false; session.myReady = false;
  session.peerFleetCodes = []; session.peerFleetMeta = [];
  session.role = null; session.room = '';
  session.phase = 'lobby';

  if (result){
    const r = result.win ? 'VICTORY' : (result.reason === 'draw' ? 'DRAW' : 'DEFEAT');
    toast(r + ' — ' + (result.kills || 0) + ' kills, ' + (result.deaths || 0) + ' losses', result.win ? 'good' : 'bad');
  }
  // show the pvp screen again, back at a fresh lobby (must reconnect to rematch)
  Pvp.show();
}

// ===========================================================================
//  Small shared UI: a code modal (share / paste) and clipboard helper
// ===========================================================================
function showCodeModal(title, value, editable, onAccept){
  const mroot = $('modal-root') || (() => { const m = el('div'); m.id = 'modal-root'; document.body.appendChild(m); return m; })();
  clear(mroot);
  const bg = el('div', 'modal-bg');
  const modal = el('div', 'modal');
  modal.appendChild(el('h2', '', title));
  const ta = el('textarea');
  ta.style.cssText = 'width:100%;height:120px;font-family:var(--mono);font-size:11px;resize:vertical;';
  ta.value = value || '';
  ta.readOnly = !editable;
  ta.spellcheck = false;
  modal.appendChild(ta);
  const row = el('div', 'row'); row.style.marginTop = '14px'; row.style.justifyContent = 'flex-end';
  if (!editable){
    const copy = el('button', 'btn accent', 'COPY');
    copy.onclick = () => { ta.select(); copyText(ta.value); toast('Copied', 'good'); };
    row.appendChild(copy);
  } else {
    const ok = el('button', 'btn accent', 'IMPORT');
    ok.onclick = () => { const v = ta.value.trim(); clear(mroot); if (onAccept) onAccept(v); };
    row.appendChild(ok);
  }
  const close = el('button', 'btn', 'CLOSE');
  close.onclick = () => clear(mroot);
  row.appendChild(close);
  modal.appendChild(row);
  bg.appendChild(modal);
  bg.onclick = (e) => { if (e.target === bg) clear(mroot); };
  mroot.appendChild(bg);
  if (!editable) setTimeout(() => ta.select(), 0); else setTimeout(() => ta.focus(), 0);
}

function copyText(t){
  try {
    if (navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t); return; }
  } catch (e){ /* fall through */ }
  // legacy fallback
  const ta = el('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e){}
  ta.remove();
}

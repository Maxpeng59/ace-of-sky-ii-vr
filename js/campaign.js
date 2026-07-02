// ============================================================================
//  Ace of Sky II — campaign.js
//  The CAMPAIGN HUB (#screen-campaign). A real economy loop: everything costs
//  money. You buy/design aircraft into a personal hangar, hire named wingmen,
//  commission a single aircraft carrier, then deploy those assets on missions.
//  Win → earn the reward, mark the mission complete, advance the day, and (now
//  and then) earn a promotion. Lose → you keep your kit but pay the day for it.
//
//  Public API (per CONTRACT.md):  export const Campaign  with  Campaign.show()
//  Reads/writes State.campaign + the credit economy; persists with save().
// ============================================================================
import {
  $, el, clear, fmtCr, fmtNum, toast, sfx, clamp,
} from './util.js';
import {
  State, save, spend, earn, canAfford,
  libGet, libSave, cloneDesign, newDesign, statsOf,
  importCode, STOCK_DESIGNS, stockGet, uid, bus,
} from './core.js';
import { Hangar } from './hangar.js';
import { Battle } from './battle.js';
import { Menu } from './menu.js';

// ---------------------------------------------------------------------------
//  RANKS — completing missions advances the day; enough completions promote you.
//  Each promotion bumps your standing and (cosmetically) your reputation.
// ---------------------------------------------------------------------------
const RANKS = [
  { name: 'Cadet',         req: 0 },
  { name: 'Pilot Officer',  req: 2 },
  { name: 'Flight Lieutenant', req: 4 },
  { name: 'Squadron Leader', req: 7 },
  { name: 'Wing Commander',  req: 10 },
  { name: 'Group Captain',   req: 14 },
  { name: 'Air Commodore',   req: 18 },
  { name: 'Air Marshal',     req: 24 },
];
function rankForCompleted(n){
  let r = RANKS[0];
  for (const x of RANKS) if (n >= x.req) r = x;
  return r.name;
}

// ---------------------------------------------------------------------------
//  WINGMAN SKILL TIERS — hiring price scales with the pilot's competence, which
//  feeds straight into Battle's AI `skill` (0..1).
// ---------------------------------------------------------------------------
const SKILL_TIERS = [
  { name: 'Rookie',   skill: 0.35, fee: 1200 },
  { name: 'Regular',  skill: 0.55, fee: 2600 },
  { name: 'Veteran',  skill: 0.72, fee: 5200 },
  { name: 'Ace',      skill: 0.9,  fee: 11000 },
];
const CALLSIGNS = [
  'Viper', 'Maverick', 'Ghost', 'Reaper', 'Talon', 'Specter', 'Hawk', 'Cobra',
  'Raven', 'Falcon', 'Wraith', 'Saber', 'Banshee', 'Nomad', 'Striker', 'Echo',
  'Vandal', 'Lancer', 'Comet', 'Onyx', 'Razor', 'Phoenix', 'Jester', 'Bishop',
];
function randomCallsign(){ return CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)]; }

// ---------------------------------------------------------------------------
//  MISSIONS — the heart of the loop. Each is a discrete challenge with a brief,
//  an environment, an objective passed verbatim to Battle.start, an enemy
//  loadout (stock designs scaled by count + skill), a reward, and optional
//  prerequisites (mission ids in State.campaign.completed). Some require the
//  player's carrier to exist (escort/strike teach the carrier economy).
//
//  enemy entries reference STOCK_DESIGNS by id; Battle resolves them via
//  stockGet().  objective.type is whatever Battle understands — we keep to a
//  small documented vocabulary: 'deathmatch' | 'escort' | 'survive' | 'strike'.
// ---------------------------------------------------------------------------
export const MISSIONS = [
  {
    id: 'm_patrol',
    title: 'Dawn Patrol',
    brief: 'Recon drones are probing the border. Sweep them from the sky before they map our defences. A clean introductory sortie.',
    env: 'day',
    reward: 4200,
    needsCarrier: false,
    requires: [],
    enemies: [{ stock: 'stock_falcon', count: 4, skill: 0.3 }],
    objective: { type: 'deathmatch', label: 'Destroy all 4 recon drones' },
    timeLimit: 0,
  },
  {
    id: 'm_intercept',
    title: 'Intercept the Bomber Wave',
    brief: 'A flight of heavy bombers with light escort is inbound on the airfield. Tear into them before they reach their release point.',
    env: 'dusk',
    reward: 7600,
    needsCarrier: false,
    requires: ['m_patrol'],
    enemies: [
      { stock: 'stock_fortress', count: 2, skill: 0.45 },
      { stock: 'stock_falcon', count: 3, skill: 0.4 },
    ],
    objective: { type: 'deathmatch', label: 'Down 2 bombers and their escort' },
    timeLimit: 0,
  },
  {
    id: 'm_escort',
    title: 'Escort the Carrier',
    brief: 'Your carrier is steaming through contested waters. Enemy strike craft want it on the sea floor — keep them off it until the channel is clear.',
    env: 'sea',
    reward: 9800,
    needsCarrier: true,
    requires: ['m_intercept'],
    enemies: [
      { stock: 'stock_falcon', count: 3, skill: 0.55 },
      { stock: 'stock_falcon', count: 2, skill: 0.5 },
    ],
    objective: { type: 'escort', label: 'Protect your carrier — let none through' },
    timeLimit: 180,
  },
  {
    id: 'm_aceduel',
    title: 'Ace Duel: "Crimson"',
    brief: 'The enemy\'s top ace flies a hand-built interceptor and has never lost. One aircraft, one pilot, one winner. No wingmen — this is personal.',
    env: 'day',
    reward: 12000,
    needsCarrier: false,
    requires: ['m_intercept'],
    soloOnly: true,
    enemies: [{ stock: 'stock_falcon', count: 1, skill: 0.95, name: 'Crimson' }],
    objective: { type: 'deathmatch', label: 'Defeat the ace, one on one' },
    timeLimit: 0,
  },
  {
    id: 'm_strike',
    title: 'Strike: Sink the Enemy Carrier',
    brief: 'Recon found the enemy flat-top anchored in the bay, ringed by air cover. Punch through, put it under the waves, and get home.',
    env: 'sea',
    reward: 16500,
    needsCarrier: false,
    enemyCarrier: 'stock_carrier',
    requires: ['m_escort'],
    enemies: [
      { stock: 'stock_falcon', count: 3, skill: 0.6 },
      { stock: 'stock_falcon', count: 4, skill: 0.45 },
    ],
    objective: { type: 'strike', label: 'Sink the enemy carrier' },
    timeLimit: 240,
  },
  {
    id: 'm_gauntlet',
    title: 'The Gauntlet',
    brief: 'Wave after wave, no reinforcements. Survive everything they send and you walk away rich. Bring everyone you can afford.',
    env: 'night',
    reward: 22000,
    needsCarrier: false,
    requires: ['m_aceduel', 'm_strike'],
    enemies: [
      { stock: 'stock_falcon', count: 4, skill: 0.6 },
      { stock: 'stock_falcon', count: 3, skill: 0.65 },
      { stock: 'stock_goliath', count: 2, skill: 0.7 },
    ],
    objective: { type: 'survive', label: 'Survive all waves', waves: 3 },
    timeLimit: 300,
  },
  {
    id: 'm_nightwatch',
    title: 'Night Watch',
    brief: 'Smugglers run drones under cover of darkness. Hunt them down — they\'re cheap, but there are a lot of them and you can\'t see far.',
    env: 'night',
    reward: 6400,
    needsCarrier: false,
    requires: ['m_patrol'],
    enemies: [{ stock: 'stock_falcon', count: 6, skill: 0.4 }],
    objective: { type: 'deathmatch', label: 'Clear all 6 night runners' },
    timeLimit: 0,
  },
  {
    id: 'm_decisive',
    title: 'Decisive Engagement',
    brief: 'The enemy commits their reserve to one last push. Defend your carrier against a full air wing AND their flagship carrier. Win this and the war is yours.',
    env: 'sea',
    reward: 40000,
    needsCarrier: true,
    enemyCarrier: 'stock_carrier',
    requires: ['m_gauntlet'],
    enemies: [
      { stock: 'stock_falcon', count: 4, skill: 0.7 },
      { stock: 'stock_falcon', count: 4, skill: 0.7 },
      { stock: 'stock_goliath', count: 2, skill: 0.75 },
    ],
    objective: { type: 'escort', label: 'Protect your carrier and break the enemy fleet' },
    timeLimit: 300,
  },
];
function missionById(id){ return MISSIONS.find(m => m.id === id); }

// ---------------------------------------------------------------------------
//  Module state — DOM root, current tab, listeners to clean up on exit.
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'hangar',   label: 'Hangar' },
  { key: 'wingmen',  label: 'Wingmen' },
  { key: 'carrier',  label: 'Carrier' },
  { key: 'missions', label: 'World Map' },
];
let root = null;
let curTab = 'missions';
let curRegion = null;        // selected world-map theatre id
let moneyOff = null;          // bus 'money' unsubscribe
const dom = {};              // cached header nodes for cheap refreshes

// ---------------------------------------------------------------------------
//  helpers
// ---------------------------------------------------------------------------
function hideOtherScreens(){
  for (const id of ['screen-menu', 'screen-creative', 'screen-pvp', 'screen-hangar']){
    const n = $(id); if (n) n.classList.add('hidden');
  }
  const hud = $('hud'); if (hud) hud.classList.add('hidden');
}

// Resolve an owned-hangar id to a live design. Owned ids may point at a library
// design (player-built) or a stock design (factory). We normalise to a design.
function designForOwnedId(id){
  const lib = libGet(id);
  if (lib) return lib;
  const stock = stockGet(id);          // stockGet returns a fresh clone
  if (stock){ stock.id = id; return stock; }
  return null;
}

// The set of designs the player can deploy. Ensures at least a starter exists.
function ownedDesigns(){
  ensureStarterHangar();
  return State.campaign.hangar
    .map(id => designForOwnedId(id))
    .filter(Boolean);
}

// First-run safety: if the player owns nothing, grant one cheap library design
// so the loop is never soft-locked. (They still pay for everything after this.)
function ensureStarterHangar(){
  const c = State.campaign;
  if (!c.hangar) c.hangar = [];
  if (c.hangar.length === 0){
    // gift the cheapest library design they already have, else a Wasp clone.
    let starter = null;
    if (State.library && State.library.length){
      starter = State.library
        .slice()
        .sort((a, b) => statsOf(a).cost - statsOf(b).cost)[0];
    }
    if (!starter){
      starter = cloneDesign(STOCK_DESIGNS.find(s => s.id === 'stock_falcon'), '');
      libSave(starter);
    }
    c.hangar.push(starter.id);
    save();
  }
}

function refreshTopbar(){
  if (!dom.money) return;
  dom.money.textContent = fmtCr(State.money);
  dom.day.textContent = 'Day ' + State.campaign.day;
  dom.rank.textContent = State.campaign.rank;
  const done = State.campaign.completed.length;
  dom.progress.textContent = done + ' / ' + MISSIONS.length + ' missions';
}

// ---------------------------------------------------------------------------
//  PUBLIC: Campaign.show()
// ---------------------------------------------------------------------------
export const Campaign = {
  show(){
    root = $('screen-campaign');
    if (!root){ console.error('campaign: #screen-campaign missing'); return; }
    const c = State.campaign;
    if (!c.rank) c.rank = 'Cadet';
    // migrate older saves: anyone with real progress skips the first-run flow.
    if (c.onboard == null) c.onboard = (c.completed.length || c.carrierId || c.started) ? 'done' : 'intro';
    c.started = true;
    save();

    // FIRST-RUN ONBOARDING owns the whole screen until 'done' (intro → tutorial →
    // carrier → plane). Returns control to the normal hub once complete.
    if (c.onboard !== 'done'){ if (moneyOff){ moneyOff(); moneyOff = null; } renderOnboarding(); return; }

    ensureStarterHangar();
    save();
    hideOtherScreens();
    root.classList.remove('hidden');

    buildShell();
    selectTab(curTab);

    // live-update the credits readout whenever the economy changes elsewhere
    if (moneyOff) moneyOff();
    moneyOff = bus.on('money', () => refreshTopbar());
  },

  // teardown — main.js may call this, and we call it ourselves on BACK.
  close(){
    if (moneyOff){ moneyOff(); moneyOff = null; }
    if (root){ clear(root); root.classList.add('hidden'); }
  },
};

// ===========================================================================
//  FIRST-RUN ONBOARDING — intro → training flight → carrier → first fighter.
//  A scripted establishment: you start with a Falcon, fly a tutorial intercept
//  against a Wasp, then Command stakes you a ¥20,000 carrier and a ¥18,000
//  operating budget for your own plane. After that, normal operations begin.
// ===========================================================================
const STARTING_BUDGET = 18000;     // the "original starting budget" for the first plane
const CARRIER_ALLOWANCE = 20000;   // Command's grant to commission a carrier

function setOnboard(p){ State.campaign.onboard = p; save(); }

// Grant (once) the player's starting Falcon, returning the owned design.
function ensureFalcon(){
  const c = State.campaign;
  if (!c.hangar) c.hangar = [];
  for (const id of c.hangar){ const d = designForOwnedId(id); if (d && /falcon/i.test(d.name || '')) return d; }
  const falcon = cloneDesign(STOCK_DESIGNS.find(s => s.id === 'stock_falcon'), '');
  falcon.author = 'You';
  libSave(falcon); c.hangar.push(falcon.id); save();
  return falcon;
}

// A centred narrative/CTA card used for every onboarding step.
function onboardPanel(eyebrow, title, bodyHTML, cta, fn, opts = {}){
  const wrap = el('div');
  wrap.style.cssText = 'max-width:680px;margin:7vh auto 0;';
  const card = el('div', 'panel'); card.style.cssText = 'padding:34px 40px;';
  card.appendChild(el('div', 'eyebrow', eyebrow));
  const h = el('div'); h.style.cssText = 'font-size:30px;font-weight:800;letter-spacing:.02em;margin:4px 0 18px;';
  h.textContent = title; card.appendChild(h);
  const b = el('div'); b.style.cssText = 'font-size:15px;line-height:1.75;color:#aab6c4;';
  b.innerHTML = bodyHTML; card.appendChild(b);
  const row = el('div', 'row'); row.style.cssText = 'margin-top:28px;justify-content:flex-end;gap:10px;align-items:center;';
  if (opts.note){ const n = el('div', 'muted small', opts.note); n.style.marginRight = 'auto'; row.appendChild(n); }
  const go = el('button', 'btn accent', cta); go.style.cssText = 'font-size:15px;padding:11px 24px;';
  go.onclick = () => { sfx('click'); fn(); };
  row.appendChild(go);
  card.appendChild(row); wrap.appendChild(card);
  return wrap;
}

function renderOnboarding(){
  hideOtherScreens();
  root.classList.remove('hidden');
  clear(root);
  ensureFalcon();
  const step = State.campaign.onboard;
  if (step === 'intro') return onboardIntro();
  if (step === 'tutorial') return onboardTutorial();
  if (step === 'carrier') return onboardCarrier();
  if (step === 'plane') return onboardPlane();
  setOnboard('done'); Campaign.show();   // safety: unknown step → finish
}

function onboardIntro(){
  const pages = [
    { eyebrow: 'Frontier Command · 06:00', title: 'You have the watch',
      body: `Cadet — the border skies have stopped being quiet. Recon drones probe our airspace nightly, and Command is desperately short of pilots.<br><br>You've been issued a <b>Falcon</b> — a clean single-seat interceptor — and a flight slot. Everything else, you earn in the air.` },
    { eyebrow: 'Frontier Command · 06:02', title: 'First, prove you can fly',
      body: `Before they trust you with a real contract you'll fly a <b>training intercept</b>: one lone <b>target drone</b>, low-grade AI. Splash it and you're cleared for operations.<br><br>Clear that, and Command stakes you a <b>carrier</b> of your own design and an operating budget for your first home-built fighter. From there the war pays its own way.` },
  ];
  let i = 0;
  const render = () => {
    clear(root); const p = pages[i];
    root.appendChild(onboardPanel(p.eyebrow, p.title, p.body,
      i < pages.length - 1 ? 'Continue ▸' : 'Begin flight training ▸',
      () => { i++; if (i < pages.length) render(); else { setOnboard('tutorial'); renderOnboarding(); } },
      { note: `Page ${i + 1} / ${pages.length}` }));
  };
  render();
}

function onboardTutorial(){
  const body = `<b>Controls</b><br>· <b>Mouse</b> — aim; your nose chases the reticle.<br>· <b>Shift</b> — boost · <b>S</b> — brake · <b>Z</b> — cut engine to glide.<br>· <b>Left click</b> — guns. <b>Hold</b> on a target to build a missile lock, release to fire.<br>· <b>P</b> — aim-assist (snaps guns to the lead point) · <b>B</b> — airbrake.<br><br>Target: a single <b>target drone</b>. Get on its tail and put it down.`;
  root.appendChild(onboardPanel('Training Flight', 'Intercept the drone', body, 'Launch ▸', () => {
    const falcon = ensureFalcon();
    launchTutorialBattle(falcon);
  }, { note: 'Lose and you can simply re-fly it.' }));
}

function launchTutorialBattle(playerDesign){
  const wasp = stockGet('stock_falcon');
  if (!wasp){ setOnboard('carrier'); Campaign.show(); return; }
  const player = cloneDesign(playerDesign, ''); player.author = 'You';
  const config = {
    player, allies: [],
    enemies: [{ design: wasp, count: 1, skill: 0.2 }],
    env: 'day',
    objective: { type: 'deathmatch', label: 'Down the training drone' },
    timeLimit: 0, carrier: null, enemyCarrier: null, net: null,
    onEnd: (result) => {
      if (result && result.win) setOnboard('carrier');
      Campaign.show();                       // win → carrier step; lose → tutorial again
    },
  };
  if (root) root.classList.add('hidden');
  sfx('lockfull');
  try { Battle.start(config); }
  catch (e){ console.error('tutorial battle failed', e); toast('Could not start: ' + e.message, 'bad'); Campaign.show(); }
}

function onboardCarrier(){
  State.money = CARRIER_ALLOWANCE; save();    // Command's carrier grant
  const body = `Clean kill, pilot — you're cleared for operations.<br><br>Command is staking you a <b>${fmtCr(CARRIER_ALLOWANCE)}</b> allowance to commission your own <b>aircraft carrier</b>: your mobile base for the whole campaign. Big fuselages, armour, defensive guns — design the hull and spend the grant as you see fit.`;
  root.appendChild(onboardPanel('Command Grant', 'Commission your carrier', body, 'Open the carrier yard ▸', () => {
    const draft = newDesign('CV Aegis'); draft.role = 'carrier';
    Hangar.open({
      design: draft, title: 'Carrier Yard — commission (¥20,000 allowance)', budget: CARRIER_ALLOWANCE,
      actions: [{ label: '✔ Commission', kind: 'gold', fn: (d, stats) => {
        if (!stats.ok){ toast('Carrier hull invalid: ' + (stats.errors[0] || ''), 'bad'); return; }
        if (Math.round(stats.cost) > CARRIER_ALLOWANCE){ toast('Over the ¥20,000 allowance', 'bad'); sfx('lock'); return; }
        d.role = 'carrier'; libSave(d); State.campaign.carrierId = d.id;
        State.money = STARTING_BUDGET;        // reset to the operating budget for the plane step
        setOnboard('plane'); save(); sfx('lockfull');
        toast('Carrier commissioned — ' + d.name, 'good');
        Hangar.close(); Campaign.show();
      } }],
      onChange: () => {},
      onExit: () => { Hangar.close(); Campaign.show(); },
    });
  }, { note: 'Allowance: ' + fmtCr(CARRIER_ALLOWANCE) }));
}

function onboardPlane(){
  const body = `Your carrier's afloat. Now build a fighter to fly from it.<br><br>You have your operating budget of <b>${fmtCr(State.money)}</b>. Design an airframe and commit it — this one comes out of your own pocket, so spend wisely. Whatever's left funds your first contracts.`;
  root.appendChild(onboardPanel('Operating Budget', 'Build your first fighter', body, 'Open the design bay ▸', () => {
    const draft = newDesign('My Fighter'); draft.author = 'You';
    Hangar.open({
      design: draft, title: 'Design your fighter — charged on commit', budget: State.money,
      actions: [{ label: '✔ Commit & Buy', kind: 'gold', fn: (d, stats) => {
        if (!stats.ok){ toast('Will not fly: ' + (stats.errors[0] || 'invalid'), 'bad'); return; }
        const price = Math.round(stats.cost);
        if (!canAfford(price)){ toast('Need ' + fmtCr(price), 'bad'); sfx('lock'); return; }
        if (!spend(price)){ toast('Purchase failed', 'bad'); return; }
        d.author = 'You'; libSave(d); State.campaign.hangar.push(d.id);
        setOnboard('done'); save(); sfx('lockfull');
        toast('Fighter built — ' + fmtCr(price), 'good');
        Hangar.close(); Campaign.show();
      } }],
      onChange: () => {},
      onExit: () => { Hangar.close(); Campaign.show(); },
    });
  }, { note: 'Budget: ' + fmtCr(State.money) }));
}

// ---------------------------------------------------------------------------
//  SHELL — top bar (credits/day/rank), tab strip, and a body container.
// ---------------------------------------------------------------------------
function buildShell(){
  clear(root);

  // --- top bar ---
  const bar = el('div', 'topbar');
  bar.style.marginBottom = '18px';

  const brand = el('div');
  brand.innerHTML = '<div class="eyebrow">Campaign</div>';
  const title = el('div'); title.style.cssText = 'font-size:20px;font-weight:800;letter-spacing:.04em;';
  title.textContent = 'Operations';
  brand.appendChild(title);
  bar.appendChild(brand);

  bar.appendChild(el('div', 'spacer'));

  dom.progress = el('div', 'pill mono'); bar.appendChild(dom.progress);
  dom.day = el('div', 'pill mono'); bar.appendChild(dom.day);
  dom.rank = el('div', 'pill mono'); bar.appendChild(dom.rank);

  const creditsPill = el('div', 'pill');
  creditsPill.innerHTML = '<span class="muted small">Credits </span>';
  dom.money = el('span', 'credits'); creditsPill.appendChild(dom.money);
  bar.appendChild(creditsPill);

  const back = el('button', 'btn small', '◂ Menu');
  back.onclick = () => { sfx('ui'); Campaign.close(); Menu.show(); };
  bar.appendChild(back);

  root.appendChild(bar);

  // --- tab strip ---
  const tabs = el('div', 'pill-row');
  tabs.style.marginBottom = '16px';
  dom.tabBtns = {};
  for (const t of TABS){
    const p = el('div', 'pill', t.label);
    p.onclick = () => { sfx('click'); selectTab(t.key); };
    dom.tabBtns[t.key] = p;
    tabs.appendChild(p);
  }
  root.appendChild(tabs);

  // --- body ---
  dom.body = el('div');
  dom.body.style.cssText = 'flex:1;min-height:0;';
  root.appendChild(dom.body);

  refreshTopbar();
}

function selectTab(key){
  curTab = key;
  for (const k in dom.tabBtns) dom.tabBtns[k].classList.toggle('sel', k === key);
  clear(dom.body);
  if (key === 'hangar') renderHangarTab();
  else if (key === 'wingmen') renderWingmenTab();
  else if (key === 'carrier') renderCarrierTab();
  else renderWorldMap();
  refreshTopbar();
}

// ---------------------------------------------------------------------------
//  TAB 1 — HANGAR  (own aircraft: design new, duplicate, import; all cost money)
// ---------------------------------------------------------------------------
function renderHangarTab(){
  const wrap = el('div');
  wrap.style.cssText = 'display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start;';

  // ---- left: owned aircraft grid ----
  const left = el('div', 'panel');
  const head = el('div', 'row');
  head.appendChild(el('h2', '', 'Your Hangar'));
  head.appendChild(el('div', 'spacer'));
  const lead = el('div', 'muted small mono');
  lead.textContent = State.campaign.hangar.length + ' aircraft owned';
  head.appendChild(lead);
  left.appendChild(head);

  const grid = el('div', 'grid');
  grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(240px,1fr))';

  const designs = ownedDesigns();
  if (designs.length === 0){
    grid.appendChild(el('div', 'muted', 'No aircraft. Design or buy one to fly missions.'));
  }
  for (const d of designs){
    grid.appendChild(ownedCard(d));
  }
  left.appendChild(grid);
  wrap.appendChild(left);

  // ---- right: acquisition panel ----
  const right = el('div', 'panel');
  right.appendChild(el('h2', '', 'Acquire'));
  right.appendChild(el('div', 'muted small',
    'Every airframe costs its build price in credits. Spend wisely — missions pay, but losses still cost a day.'));

  const buyNew = el('button', 'btn accent', '✚ Design & Buy New');
  buyNew.style.marginTop = '14px';
  buyNew.onclick = () => openDesignNewAircraft();
  right.appendChild(buyNew);

  const buyStock = el('button', 'btn');
  buyStock.style.marginTop = '10px';
  buyStock.textContent = '🏭 Buy a Factory Aircraft';
  buyStock.onclick = () => openBuyFactory();
  right.appendChild(buyStock);

  const imp = el('button', 'btn');
  imp.style.marginTop = '10px';
  imp.textContent = '⇩ Import a Design Code';
  imp.onclick = () => openImportDesign();
  right.appendChild(imp);

  // small credits footer
  const foot = el('div', 'mono small muted');
  foot.style.marginTop = '16px';
  foot.innerHTML = 'Balance: <span class="credits">' + fmtCr(State.money) + '</span>';
  right.appendChild(foot);

  wrap.appendChild(right);
  dom.body.appendChild(wrap);
}

function ownedCard(design){
  const s = statsOf(design);
  const card = el('div', 'card');

  const top = el('div', 'row');
  const sw = el('div'); sw.style.cssText =
    'width:18px;height:18px;border-radius:4px;border:1px solid rgba(255,255,255,.2);background:' + (design.color || '#cfd8e3');
  top.appendChild(sw);
  const nm = el('div'); nm.style.cssText = 'font-weight:700;font-size:15px;';
  nm.textContent = design.name;
  top.appendChild(nm);
  card.appendChild(top);

  const role = el('div', 'tag'); role.textContent = design.role || 'fighter';
  role.style.marginTop = '6px';
  card.appendChild(role);

  // compact stat block
  const st = el('div', 'stats'); st.style.marginTop = '10px';
  const add = (k, v, cls) => {
    st.appendChild(el('div', 'k', k));
    const ve = el('div', 'v' + (cls ? ' ' + cls : '')); ve.textContent = v; st.appendChild(ve);
  };
  add('Mass', (s.mass / 1000).toFixed(1) + ' t');
  add('TWR', s.twr.toFixed(2), s.twr >= 1 ? 'good' : 'warn');
  add('Top spd', Math.round(s.vMaxBoost * 3.6) + ' km/h');
  add('Durability', Math.round(s.durability) + ' HP');
  add('Weapons', String(s.hardpoints));
  add('Resale', fmtCr(Math.round(s.cost * 0.5)));
  card.appendChild(st);

  if (!s.ok){
    const w = el('div', 'warns');
    w.appendChild(el('div', 'err', '⚠ ' + (s.errors[0] || 'Will not fly')));
    card.appendChild(w);
  }

  // actions
  const acts = el('div', 'row'); acts.style.marginTop = '12px';

  const edit = el('button', 'btn small', 'Edit');
  edit.title = 'Modify this design (free changes that lower cost refund; pricier changes are charged the difference)';
  edit.onclick = () => openEditOwned(design);
  acts.appendChild(edit);

  const dup = el('button', 'btn small', 'Duplicate');
  dup.title = 'Buy a second copy for ' + fmtCr(Math.round(s.cost));
  dup.onclick = () => duplicateOwned(design);
  acts.appendChild(dup);

  const sell = el('button', 'btn small danger', 'Sell');
  sell.title = 'Sell for 50% of build cost';
  sell.onclick = () => sellOwned(design);
  acts.appendChild(sell);

  card.appendChild(acts);
  return card;
}

// --- Design a brand-new aircraft, charged on save -------------------------
function openDesignNewAircraft(){
  const draft = newDesign('New Aircraft');
  draft.author = 'You';
  Hangar.open({
    design: draft,
    title: 'Design New Aircraft — charged on commit',
    budget: State.money,                 // can't commit something you can't pay for
    actions: [{
      label: '✔ Commit & Buy',
      kind: 'gold',
      fn: (d, stats) => commitNewDesign(d, stats),
    }],
    onChange: () => {},
    onExit: () => { Hangar.close(); Campaign.show(); selectTab('hangar'); },
  });
}

function commitNewDesign(d, stats){
  if (!stats.ok){
    toast('This airframe will not fly: ' + (stats.errors[0] || 'invalid'), 'bad');
    return;
  }
  const price = Math.round(stats.cost);
  if (!canAfford(price)){
    toast('Insufficient credits — need ' + fmtCr(price), 'bad'); sfx('lock');
    return;
  }
  if (!spend(price)) { toast('Purchase failed', 'bad'); return; }
  // commit the design to the library + owned hangar
  d.author = 'You';
  libSave(d);
  State.campaign.hangar.push(d.id);
  save();
  sfx('lockfull');
  toast('Bought "' + d.name + '" for ' + fmtCr(price), 'good');
  Hangar.close();
  Campaign.show(); selectTab('hangar');
}

// --- Edit an OWNED design; charge/refund the cost difference ----------------
function openEditOwned(design){
  const before = Math.round(statsOf(design).cost);
  const draft = cloneDesign(design, '');     // edit a working copy, keep id
  draft.id = design.id;
  Hangar.open({
    design: draft,
    title: 'Edit ' + design.name + ' — pay/refund the cost change',
    actions: [{
      label: '✔ Apply Changes',
      kind: 'gold',
      fn: (d, stats) => {
        if (!stats.ok){ toast('Will not fly: ' + (stats.errors[0] || 'invalid'), 'bad'); return; }
        const after = Math.round(stats.cost);
        const diff = after - before;
        if (diff > 0 && !canAfford(diff)){
          toast('Upgrade costs ' + fmtCr(diff) + ' more — not enough credits', 'bad'); sfx('lock');
          return;
        }
        if (diff > 0) spend(diff);
        else if (diff < 0) earn(-diff);
        libSave(d);
        // keep id present in hangar (it is, since we preserved the id)
        if (!State.campaign.hangar.includes(d.id)) State.campaign.hangar.push(d.id);
        save();
        sfx('lockfull');
        toast(diff > 0 ? 'Upgraded — paid ' + fmtCr(diff)
              : diff < 0 ? 'Refit — refunded ' + fmtCr(-diff)
              : 'Changes applied', diff > 0 ? '' : 'good');
        Hangar.close();
        Campaign.show(); selectTab('hangar');
      },
    }],
    onChange: () => {},
    onExit: () => { Hangar.close(); Campaign.show(); selectTab('hangar'); },
  });
}

// --- Duplicate an owned design (costs its cost again) -----------------------
function duplicateOwned(design){
  const price = Math.round(statsOf(design).cost);
  if (!canAfford(price)){ toast('Need ' + fmtCr(price) + ' to duplicate', 'bad'); sfx('lock'); return; }
  confirmModal('Duplicate "' + design.name + '"?',
    'A second airframe will cost ' + fmtCr(price) + '. You will own two.',
    () => {
      if (!spend(price)){ toast('Purchase failed', 'bad'); return; }
      const copy = cloneDesign(design);
      libSave(copy);
      State.campaign.hangar.push(copy.id);
      save();
      sfx('lockfull');
      toast('Bought a second "' + design.name + '"', 'good');
      selectTab('hangar');
    });
}

// --- Sell an owned design back for 50% -------------------------------------
function sellOwned(design){
  if (State.campaign.hangar.length <= 1){
    toast('Can\'t sell your last aircraft', 'warn'); return;
  }
  const refund = Math.round(statsOf(design).cost * 0.5);
  confirmModal('Sell "' + design.name + '"?',
    'You recover ' + fmtCr(refund) + ' (50% of build cost). The airframe leaves your hangar.',
    () => {
      // remove ONE instance of this id from the hangar
      const i = State.campaign.hangar.indexOf(design.id);
      if (i >= 0) State.campaign.hangar.splice(i, 1);
      // if it's no longer owned anywhere and was a library design, leave the
      // library entry (player may re-buy) — just remove ownership.
      earn(refund);
      save();
      sfx('ui');
      toast('Sold "' + design.name + '" for ' + fmtCr(refund), 'good');
      selectTab('hangar');
    }, 'Sell', 'danger');
}

// --- Buy a factory aircraft at list price ----------------------------------
function openBuyFactory(){
  const m = openModal('Factory Aircraft');
  m.body.appendChild(el('div', 'muted small',
    'Off-the-shelf airframes from the factory. Buy one outright — it joins your hangar at list price.'));
  const list = el('div', 'list'); list.style.marginTop = '12px';
  for (const stock of STOCK_DESIGNS){
    const s = statsOf(stock);
    const price = Math.round(s.cost);
    const row = el('div', 'list-row');
    const sw = el('div'); sw.style.cssText =
      'width:16px;height:16px;border-radius:4px;border:1px solid rgba(255,255,255,.2);background:' + stock.color;
    row.appendChild(sw);
    const info = el('div'); info.style.flex = '1';
    info.innerHTML = '<div style="font-weight:700">' + stock.name + '</div>' +
      '<div class="mono small muted">' + (stock.role) + ' · ' + (s.mass / 1000).toFixed(1) + 't · TWR ' +
      s.twr.toFixed(2) + ' · ' + Math.round(s.durability) + ' HP</div>';
    row.appendChild(info);
    const cost = el('div', 'credits mono'); cost.textContent = fmtCr(price);
    cost.style.minWidth = '90px'; cost.style.textAlign = 'right';
    row.appendChild(cost);
    const buy = el('button', 'btn small gold', 'Buy');
    buy.disabled = !canAfford(price);
    buy.onclick = () => {
      if (!spend(price)){ toast('Need ' + fmtCr(price), 'bad'); sfx('lock'); return; }
      const owned = stockGet(stock.id);        // fresh clone with new id
      libSave(owned);
      State.campaign.hangar.push(owned.id);
      save();
      sfx('lockfull');
      toast('Bought "' + stock.name + '" for ' + fmtCr(price), 'good');
      closeModal();
      selectTab('hangar');
    };
    row.appendChild(buy);
    list.appendChild(row);
  }
  m.body.appendChild(list);
}

// --- Import a design code, then buy it -------------------------------------
function openImportDesign(){
  const m = openModal('Import Design Code');
  m.body.appendChild(el('div', 'muted small',
    'Paste an ASK2 design code. We\'ll price it; buying charges its build cost.'));
  const ta = el('textarea');
  ta.style.cssText = 'width:100%;height:90px;margin-top:10px;font-family:var(--mono);font-size:12px;resize:vertical;';
  ta.placeholder = 'ASK2.…';
  m.body.appendChild(ta);

  const preview = el('div', 'panel tight'); preview.style.marginTop = '10px';
  preview.style.display = 'none';
  m.body.appendChild(preview);

  let parsed = null;
  const buyBtn = el('button', 'btn gold', 'Buy'); buyBtn.disabled = true;

  const check = el('button', 'btn', 'Check Code');
  check.onclick = () => {
    parsed = importCode(ta.value.trim());
    if (!parsed){ toast('Invalid design code', 'bad'); preview.style.display = 'none'; buyBtn.disabled = true; return; }
    const s = statsOf(parsed);
    const price = Math.round(s.cost);
    preview.style.display = 'block';
    preview.innerHTML = '<div style="font-weight:700">' + parsed.name + '</div>' +
      '<div class="mono small muted">' + (parsed.role || 'fighter') + ' · ' + parsed.parts.length + ' parts · ' +
      (s.mass / 1000).toFixed(1) + 't · TWR ' + s.twr.toFixed(2) + (s.ok ? '' : ' · <span style="color:var(--bad)">WILL NOT FLY</span>') + '</div>' +
      '<div class="mono" style="margin-top:6px">Price: <span class="credits">' + fmtCr(price) + '</span></div>';
    buyBtn.disabled = !s.ok || !canAfford(price);
    buyBtn.textContent = 'Buy for ' + fmtCr(price);
  };

  buyBtn.onclick = () => {
    if (!parsed) return;
    const s = statsOf(parsed);
    const price = Math.round(s.cost);
    if (!s.ok){ toast('Design will not fly', 'bad'); return; }
    if (!spend(price)){ toast('Need ' + fmtCr(price), 'bad'); sfx('lock'); return; }
    parsed.author = 'Imported';
    libSave(parsed);
    State.campaign.hangar.push(parsed.id);
    save();
    sfx('lockfull');
    toast('Bought imported "' + parsed.name + '"', 'good');
    closeModal();
    selectTab('hangar');
  };

  const row = el('div', 'row'); row.style.marginTop = '12px';
  row.appendChild(check); row.appendChild(buyBtn);
  m.body.appendChild(row);
}

// ---------------------------------------------------------------------------
//  TAB 2 — WINGMEN  (named pilots: assign an owned airframe + a skill tier)
//  State.campaign.wingmen = [{ id, designId, name, skill, tier }]
// ---------------------------------------------------------------------------
function renderWingmenTab(){
  if (!State.campaign.wingmen) State.campaign.wingmen = [];
  const wrap = el('div');
  wrap.style.cssText = 'display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start;';

  // ---- left: hired wingmen ----
  const left = el('div', 'panel');
  const head = el('div', 'row');
  head.appendChild(el('h2', '', 'Your Squadron'));
  head.appendChild(el('div', 'spacer'));
  head.appendChild(el('div', 'muted small mono', State.campaign.wingmen.length + ' pilots'));
  left.appendChild(head);

  const list = el('div', 'list');
  if (State.campaign.wingmen.length === 0){
    list.appendChild(el('div', 'muted', 'No wingmen hired. Recruit pilots to fly alongside you.'));
  }
  for (const wm of State.campaign.wingmen){
    list.appendChild(wingmanRow(wm));
  }
  left.appendChild(list);
  wrap.appendChild(left);

  // ---- right: recruit ----
  const right = el('div', 'panel');
  right.appendChild(el('h2', '', 'Recruit a Pilot'));
  right.appendChild(el('div', 'muted small',
    'A wingman pairs a callsign and skill with one of your owned aircraft. They deploy with you on missions. Hiring is a one-time fee; you also pay for their aircraft separately.'));

  const recruit = el('button', 'btn accent', '✚ Hire Wingman');
  recruit.style.marginTop = '14px';
  recruit.onclick = () => openHireWingman();
  right.appendChild(recruit);

  const tierInfo = el('div', 'stats'); tierInfo.style.marginTop = '16px';
  tierInfo.appendChild(el('div', 'k', 'Tier'));
  tierInfo.appendChild(el('div', 'v', 'Fee'));
  for (const t of SKILL_TIERS){
    tierInfo.appendChild(el('div', 'k', t.name + ' (' + Math.round(t.skill * 100) + '%)'));
    tierInfo.appendChild(el('div', 'v', fmtCr(t.fee)));
  }
  right.appendChild(tierInfo);

  wrap.appendChild(right);
  dom.body.appendChild(wrap);
}

function wingmanRow(wm){
  const row = el('div', 'list-row');
  const design = wm.designId ? designForOwnedId(wm.designId) : null;

  const badge = el('div'); badge.style.cssText =
    'width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
    'font-weight:800;font-family:var(--mono);background:#0c1a2a;border:1px solid var(--edge);color:var(--accent);';
  badge.textContent = (wm.name || '?').slice(0, 2).toUpperCase();
  row.appendChild(badge);

  const info = el('div'); info.style.flex = '1';
  info.innerHTML = '<div style="font-weight:700">' + (wm.name || 'Unnamed') +
    ' <span class="tag" style="margin-left:6px">' + (wm.tier || (Math.round((wm.skill || 0) * 100) + '%')) + '</span></div>' +
    '<div class="mono small muted">flies ' + (design ? design.name : '⚠ no aircraft assigned') + '</div>';
  row.appendChild(info);

  const reassign = el('button', 'btn small', 'Aircraft');
  reassign.title = 'Assign which owned aircraft this pilot flies';
  reassign.onclick = () => openAssignWingmanAircraft(wm);
  row.appendChild(reassign);

  const fire = el('button', 'btn small danger', 'Dismiss');
  fire.onclick = () => {
    confirmModal('Dismiss ' + wm.name + '?', 'They leave the squadron. No refund on the hiring fee.', () => {
      State.campaign.wingmen = State.campaign.wingmen.filter(w => w.id !== wm.id);
      save(); sfx('ui'); toast(wm.name + ' dismissed'); selectTab('wingmen');
    }, 'Dismiss', 'danger');
  };
  row.appendChild(fire);

  return row;
}

function openHireWingman(){
  const owned = ownedDesigns();
  if (owned.length === 0){ toast('Buy an aircraft first', 'warn'); return; }

  const m = openModal('Hire a Wingman');
  // callsign
  const nameField = el('label', 'field');
  nameField.appendChild(el('span', '', 'Callsign'));
  const nameInput = el('input'); nameInput.type = 'text'; nameInput.value = randomCallsign();
  nameField.appendChild(nameInput);
  m.body.appendChild(nameField);
  const reroll = el('button', 'btn small', '🎲 Random callsign');
  reroll.style.marginTop = '6px';
  reroll.onclick = () => { nameInput.value = randomCallsign(); };
  m.body.appendChild(reroll);

  // skill tier
  m.body.appendChild(el('h3', '', 'Skill tier'));
  let tier = SKILL_TIERS[0];
  const tierRow = el('div', 'pill-row');
  const tierPills = [];
  for (const t of SKILL_TIERS){
    const p = el('div', 'pill', t.name + ' · ' + fmtCr(t.fee));
    p.onclick = () => { tier = t; tierPills.forEach(x => x.classList.remove('sel')); p.classList.add('sel'); updateFee(); };
    tierPills.push(p); tierRow.appendChild(p);
  }
  tierPills[0].classList.add('sel');
  m.body.appendChild(tierRow);

  // aircraft
  m.body.appendChild(el('h3', '', 'Assigned aircraft'));
  const sel = el('select');
  for (const d of owned){
    const o = el('option'); o.value = d.id; o.textContent = d.name + ' (' + (d.role || 'fighter') + ')';
    sel.appendChild(o);
  }
  m.body.appendChild(sel);

  const fee = el('div', 'mono'); fee.style.marginTop = '14px';
  m.body.appendChild(fee);
  function updateFee(){
    fee.innerHTML = 'Hiring fee: <span class="credits">' + fmtCr(tier.fee) + '</span>';
  }
  updateFee();

  const hire = el('button', 'btn gold', 'Hire');
  hire.style.marginTop = '12px';
  hire.onclick = () => {
    const name = (nameInput.value || '').trim() || randomCallsign();
    if (!canAfford(tier.fee)){ toast('Need ' + fmtCr(tier.fee), 'bad'); sfx('lock'); return; }
    if (!spend(tier.fee)){ toast('Hire failed', 'bad'); return; }
    State.campaign.wingmen.push({
      id: uid(), name, designId: sel.value, skill: tier.skill, tier: tier.name,
    });
    save(); sfx('lockfull');
    toast('Hired ' + name + ' (' + tier.name + ')', 'good');
    closeModal(); selectTab('wingmen');
  };
  m.body.appendChild(hire);
}

function openAssignWingmanAircraft(wm){
  const owned = ownedDesigns();
  if (owned.length === 0){ toast('No aircraft to assign', 'warn'); return; }
  const m = openModal('Assign Aircraft — ' + wm.name);
  const sel = el('select'); sel.style.width = '100%';
  for (const d of owned){
    const o = el('option'); o.value = d.id; o.textContent = d.name + ' (' + (d.role || 'fighter') + ')';
    if (d.id === wm.designId) o.selected = true;
    sel.appendChild(o);
  }
  m.body.appendChild(sel);
  const ok = el('button', 'btn accent', 'Assign'); ok.style.marginTop = '12px';
  ok.onclick = () => {
    wm.designId = sel.value; save(); sfx('ui');
    toast(wm.name + ' now flies ' + (designForOwnedId(sel.value)?.name || '?'), 'good');
    closeModal(); selectTab('wingmen');
  };
  m.body.appendChild(ok);
}

// ---------------------------------------------------------------------------
//  TAB 3 — CARRIER  (commission ONE big airframe as your mobile base)
//  State.campaign.carrierId points at a library design id.
// ---------------------------------------------------------------------------
function renderCarrierTab(){
  const wrap = el('div');
  wrap.style.cssText = 'display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start;';

  const left = el('div', 'panel');
  left.appendChild(el('h2', '', 'Aircraft Carrier'));

  const carrier = State.campaign.carrierId ? designForOwnedId(State.campaign.carrierId) : null;
  if (carrier){
    const s = statsOf(carrier);
    const card = el('div', 'card');
    card.appendChild(el('div', '', ''));
    const nm = el('div'); nm.style.cssText = 'font-weight:800;font-size:18px;';
    nm.textContent = carrier.name; card.appendChild(nm);
    card.appendChild(el('div', 'tag', 'fleet carrier'));

    const st = el('div', 'stats'); st.style.marginTop = '12px';
    const add = (k, v) => { st.appendChild(el('div', 'k', k)); st.appendChild(el('div', 'v', v)); };
    add('Mass', (s.mass / 1000).toFixed(1) + ' t');
    add('Durability', Math.round(s.durability) + ' HP');
    add('Length', Math.round(s.bbox.size.z) + ' m');
    add('Defences', String(s.hardpoints) + ' guns');
    add('Build cost', fmtCr(Math.round(s.cost)));
    card.appendChild(st);

    const acts = el('div', 'row'); acts.style.marginTop = '12px';
    const edit = el('button', 'btn small', 'Refit');
    edit.onclick = () => openDesignCarrier(carrier);
    acts.appendChild(edit);
    const scrap = el('button', 'btn small danger', 'Decommission');
    scrap.onclick = () => {
      const refund = Math.round(s.cost * 0.4);
      confirmModal('Decommission carrier?', 'You recover ' + fmtCr(refund) + ' (40%). Carrier missions will be locked until you build a new one.', () => {
        State.campaign.carrierId = null; earn(refund); save(); sfx('ui');
        toast('Carrier decommissioned (+' + fmtCr(refund) + ')', 'good'); selectTab('carrier');
      }, 'Decommission', 'danger');
    };
    acts.appendChild(scrap);
    card.appendChild(acts);
    left.appendChild(card);
  } else {
    left.appendChild(el('div', 'muted',
      'No carrier commissioned. A carrier is a large airframe that serves as your mobile base in carrier missions (Escort, Decisive Engagement).'));
  }
  wrap.appendChild(left);

  // right: build/commission panel
  const right = el('div', 'panel');
  right.appendChild(el('h2', '', carrier ? 'Replace Carrier' : 'Commission'));
  right.appendChild(el('div', 'muted small',
    'Design a single large airframe — big fuselages, heavy armor, defensive guns. It costs its full build price. Only one carrier at a time.'));

  const build = el('button', 'btn accent', carrier ? '⟳ Build New Carrier' : '⚓ Commission Carrier');
  build.style.marginTop = '14px';
  build.onclick = () => openDesignCarrier(null);
  right.appendChild(build);

  const template = el('button', 'btn');
  template.style.marginTop = '10px';
  template.textContent = '⚓ Start From Template';
  template.title = 'Begin from the Goliath heavy airframe as a carrier hull';
  template.onclick = () => {
    const base = stockGet('stock_goliath');
    base.name = 'CV Aegis';
    base.role = 'carrier';
    openDesignCarrier(base);
  };
  right.appendChild(template);

  wrap.appendChild(right);
  dom.body.appendChild(wrap);
}

function openDesignCarrier(existing){
  let draft;
  if (existing){
    draft = cloneDesign(existing, '');
    draft.id = existing.id || uid();
  } else {
    draft = newDesign('CV Aegis');
    draft.role = 'carrier';
  }
  const prevCost = existing ? Math.round(statsOf(existing).cost) : 0;
  Hangar.open({
    design: draft,
    title: 'Carrier Yard — ' + (existing ? 'refit' : 'commission'),
    budget: existing ? (State.money + prevCost) : State.money,
    actions: [{
      label: existing ? '✔ Apply Refit' : '✔ Commission',
      kind: 'gold',
      fn: (d, stats) => {
        if (!stats.ok){ toast('Carrier hull invalid: ' + (stats.errors[0] || ''), 'bad'); return; }
        const price = Math.round(stats.cost);
        const net = price - prevCost;        // refit pays only the difference
        if (net > 0 && !canAfford(net)){
          toast('Need ' + fmtCr(net) + ' more', 'bad'); sfx('lock'); return;
        }
        if (net > 0) spend(net); else if (net < 0) earn(-net);
        d.role = d.role || 'carrier';
        libSave(d);
        State.campaign.carrierId = d.id;
        save(); sfx('lockfull');
        toast(existing ? 'Carrier refit complete' : 'Carrier commissioned — ' + fmtCr(price), 'good');
        Hangar.close(); Campaign.show(); selectTab('carrier');
      },
    }],
    onChange: () => {},
    onExit: () => { Hangar.close(); Campaign.show(); selectTab('carrier'); },
  });
}

// ---------------------------------------------------------------------------
//  TAB 4 — MISSIONS  (the deploy loop)
// ---------------------------------------------------------------------------
function missionUnlocked(m){
  return (m.requires || []).every(r => State.campaign.completed.includes(r));
}

// ===========================================================================
//  WORLD MAP — a curated Earth theatre map with DYNAMIC control. Each region
//  hosts a curated story mission (or two) plus a repeatable patrol; winning
//  pushes its control toward you. Secure the regions FEEDING a sector (control
//  ≥ OPEN_AT) to unlock it, and reach SECURE to lock it down. The enemy presses
//  every other un-secured region a notch each sortie, so the front keeps moving.
// ===========================================================================
const REGIONS = [
  { id: 'home',    name: 'Home Waters',    x: 170, y: 380, tier: 1, start: 50, env: 'sea',   requires: [],                  missions: ['m_patrol', 'm_nightwatch'] },
  { id: 'reach',   name: 'The Reach',      x: 300, y: 120, tier: 1, start: 42, env: 'day',   requires: [],                  missions: ['m_intercept'] },
  { id: 'desert',  name: 'Desert Line',    x: 540, y: 300, tier: 2, start: 18, env: 'day',   requires: ['home'],            missions: ['m_escort'] },
  { id: 'straits', name: 'The Straits',    x: 800, y: 350, tier: 2, start: 18, env: 'sea',   requires: ['reach'],           missions: ['m_aceduel'] },
  { id: 'iron',    name: 'Iron Coast',     x: 470, y: 180, tier: 3, start: 8,  env: 'dusk',  requires: ['desert'],          missions: ['m_strike'] },
  { id: 'cross',   name: 'Southern Cross', x: 360, y: 470, tier: 3, start: 8,  env: 'night', requires: ['straits'],         missions: ['m_gauntlet'] },
  { id: 'citadel', name: 'The Citadel',    x: 630, y: 150, tier: 4, start: 0,  env: 'night', requires: ['iron', 'cross'],   missions: ['m_decisive'] },
];
const SECURE = 100, OPEN_AT = 65;   // secured at 100%; a region's feeds unlock it at ≥65%

function ensureRegions(){
  const c = State.campaign;
  if (!c.regions) c.regions = {};
  for (const r of REGIONS){ if (!c.regions[r.id]) c.regions[r.id] = { control: r.start }; }
}
function regionCtrl(id){ ensureRegions(); return State.campaign.regions[id] ? State.campaign.regions[id].control : 0; }
function regionAccessible(r){ return (r.requires || []).every(req => regionCtrl(req) >= OPEN_AT); }
function ctrlColor(v){ return v >= OPEN_AT ? '#5fd0ff' : v >= 28 ? '#e0b14a' : '#d9534f'; }

// A repeatable, control-pushing patrol scaled to the region's tier.
function patrolFor(r){
  return {
    id: 'patrol_' + r.id, title: r.name + ' Patrol', patrol: true, env: r.env,
    reward: 1200 + r.tier * 700, requires: [], needsCarrier: false,
    enemies: [{ stock: 'stock_falcon', count: Math.min(6, 1 + r.tier), skill: Math.min(0.85, 0.34 + r.tier * 0.09) }],
    objective: { type: 'deathmatch', label: 'Clear the patrol sector' }, timeLimit: 0,
    brief: 'Routine sweep over ' + r.name + '. Light contact expected — push the enemy back a notch.',
  };
}

// Win/lose shifts the region's control; the enemy then drifts every OTHER front.
function shiftRegionControl(id, win, isPatrol, firstClear){
  ensureRegions();
  const rc = State.campaign.regions[id]; if (!rc) return;
  if (win) rc.control = Math.min(SECURE, rc.control + (isPatrol ? 12 : (firstClear ? 35 : 18)));
  else rc.control = Math.max(0, rc.control - 6);
  for (const r of REGIONS){
    if (r.id === id) continue;
    const o = State.campaign.regions[r.id];
    if (o && o.control > 0 && o.control < SECURE) o.control = Math.max(0, o.control - 1);
  }
  save();
}

function worldMapSVG(){
  ensureRegions();
  const W = 1000, H = 560;
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;background:#0b1420;">`;
  s += '<g stroke="#16273a" stroke-width="1">';
  for (let x = 0; x <= W; x += 80) s += `<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`;
  for (let y = 0; y <= H; y += 80) s += `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
  s += '</g>';
  const land = ['120,110 300,90 330,300 250,470 130,450 80,290', '300,80 700,70 740,210 540,250 360,230 300,150', '470,250 650,255 630,440 500,460 450,355', '720,130 905,150 915,360 800,400 720,300'];
  s += '<g fill="#1d2c39" stroke="#33485c" stroke-width="1.5">';
  for (const p of land) s += `<polygon points="${p}"/>`;
  s += '</g>';
  s += '<g stroke-width="2.5" stroke-dasharray="4 5">';
  for (const r of REGIONS) for (const req of (r.requires || [])){
    const a = REGIONS.find(x => x.id === req); const lit = regionCtrl(req) >= OPEN_AT;
    s += `<line x1="${a.x}" y1="${a.y}" x2="${r.x}" y2="${r.y}" stroke="${lit ? '#3a6a8a' : '#2a3a4a'}"/>`;
  }
  s += '</g>';
  for (const r of REGIONS){
    const v = regionCtrl(r.id), col = ctrlColor(v), acc = regionAccessible(r), rad = 11 + r.tier * 2;
    s += `<g data-region="${r.id}" style="cursor:pointer" opacity="${acc ? 1 : 0.45}">`;
    s += `<circle cx="${r.x}" cy="${r.y}" r="${rad + 6}" fill="${col}" opacity="0.14"/>`;
    s += `<circle cx="${r.x}" cy="${r.y}" r="${rad}" fill="${col}" stroke="#0b1420" stroke-width="2.5"/>`;
    if (v >= SECURE) s += `<circle cx="${r.x}" cy="${r.y}" r="${rad + 3}" fill="none" stroke="#9fe6ff" stroke-width="2"/>`;
    s += `<text x="${r.x}" y="${r.y + rad + 18}" text-anchor="middle" font-size="15" font-weight="700" fill="#cfe0ee">${r.name}</text>`;
    s += `<text x="${r.x}" y="${r.y + rad + 34}" text-anchor="middle" font-size="12" fill="${col}" font-family="monospace">${v >= SECURE ? 'SECURED' : v + '%'}${acc ? '' : ' 🔒'}</text>`;
    s += '</g>';
  }
  s += '</svg>';
  return s;
}

function contractRow(region, m, isPatrol){
  const done = !isPatrol && State.campaign.completed.includes(m.id);
  const row = el('div', 'card'); row.style.cssText = 'margin-top:10px;padding:12px;';
  const t = el('div', 'row'); const nm = el('div'); nm.style.cssText = 'font-weight:700;'; nm.textContent = m.title; t.appendChild(nm);
  t.appendChild(el('div', 'spacer'));
  if (done) t.appendChild(el('div', 'tag', '✔'));
  const rew = el('div', 'tag'); rew.style.color = 'var(--gold)';
  rew.textContent = '+' + fmtCr(isPatrol ? m.reward : (done ? Math.round(m.reward * 0.4) : m.reward));
  t.appendChild(rew); row.appendChild(t);
  const br = el('div', 'small muted'); br.style.cssText = 'margin-top:6px;line-height:1.45;'; br.textContent = m.brief; row.appendChild(br);
  const threat = (m.enemies || []).reduce((a, e) => a + e.count, 0);
  row.appendChild(el('div', 'mono small faint', 'Threat: ' + threat + ' aircraft' + (m.enemyCarrier ? ' + carrier' : '') + (isPatrol ? '  ·  repeatable' : '')));
  const act = el('div', 'row'); act.style.marginTop = '10px';
  const go = el('button', 'btn accent', isPatrol ? '➤ Fly Patrol' : (done ? '↻ Fly Again' : '➤ Deploy'));
  go.onclick = () => openDeploy({ ...m, _regionId: region.id });
  act.appendChild(go); row.appendChild(act);
  return row;
}

function renderRegionDetail(c, r){
  if (!r){ c.appendChild(el('div', 'muted', 'No accessible theatre. Secure a frontier region to push the front and open the next.')); return; }
  const v = regionCtrl(r.id);
  c.appendChild(el('div', 'eyebrow', 'Theatre · tier ' + r.tier));
  const h = el('div'); h.style.cssText = 'font-size:22px;font-weight:800;margin:2px 0 8px;'; h.textContent = r.name; c.appendChild(h);
  const bar = el('div'); bar.style.cssText = 'height:9px;border-radius:5px;background:#1c2c3e;overflow:hidden;';
  const fill = el('div'); fill.style.cssText = `height:100%;width:${v}%;background:${ctrlColor(v)};transition:width .3s;`; bar.appendChild(fill); c.appendChild(bar);
  c.appendChild(el('div', 'small mono', v >= SECURE ? 'SECURED — under your control' : ('Control: ' + v + '%'))).style.marginTop = '5px';
  c.appendChild(el('h3', '', 'Contracts'));
  for (const mid of r.missions){ const m = missionById(mid); if (m) c.appendChild(contractRow(r, m, false)); }
  c.appendChild(contractRow(r, patrolFor(r), true));
}

function renderWorldMap(){
  ensureRegions();
  clear(dom.body);
  const wrap = el('div'); wrap.style.cssText = 'display:grid;grid-template-columns:1fr 360px;gap:16px;align-items:start;';
  const mapPanel = el('div', 'panel'); mapPanel.style.cssText = 'padding:12px;';
  const mh = el('div', 'row'); mh.appendChild(el('div', 'eyebrow', 'Theatre Map')); mh.appendChild(el('div', 'spacer'));
  const sec = REGIONS.filter(r => regionCtrl(r.id) >= SECURE).length;
  mh.appendChild(el('div', 'pill mono', sec + ' / ' + REGIONS.length + ' secured'));
  mapPanel.appendChild(mh);
  const svgWrap = el('div'); svgWrap.style.cssText = 'margin-top:8px;border-radius:10px;overflow:hidden;border:1px solid #1c2c3e;';
  svgWrap.innerHTML = worldMapSVG();
  svgWrap.querySelector('svg').addEventListener('click', (e) => {
    const g = e.target.closest('[data-region]'); if (!g) return;
    const r = REGIONS.find(x => x.id === g.getAttribute('data-region')); if (!r) return;
    if (!regionAccessible(r)){ toast('Locked — secure the regions feeding it first', 'bad'); sfx('lock'); return; }
    curRegion = r.id; sfx('click'); renderWorldMap();
  });
  mapPanel.appendChild(svgWrap);
  const lg = el('div', 'row small muted'); lg.style.cssText = 'margin-top:10px;gap:16px;flex-wrap:wrap;';
  lg.innerHTML = '<span style="color:#d9534f">● Enemy-held</span><span style="color:#e0b14a">● Contested</span><span style="color:#5fd0ff">● Yours</span><span style="color:#9fe6ff">◎ Secured</span>';
  mapPanel.appendChild(lg);
  wrap.appendChild(mapPanel);
  const detail = el('div', 'panel'); detail.style.cssText = 'padding:18px;';
  const r = REGIONS.find(x => x.id === curRegion && regionAccessible(x)) || REGIONS.find(x => regionAccessible(x));
  curRegion = r ? r.id : null;
  renderRegionDetail(detail, r);
  wrap.appendChild(detail);
  dom.body.appendChild(wrap);
}

// Legacy flat mission list (kept for reference; the World Map is the live view).
function renderMissionsTab(){
  const grid = el('div', 'grid');
  grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(320px,1fr))';
  for (const m of MISSIONS) grid.appendChild(missionCard(m));
  dom.body.appendChild(grid);
}

function missionCard(m){
  const done = State.campaign.completed.includes(m.id);
  const unlocked = missionUnlocked(m);
  const card = el('div', 'card');
  if (done) card.style.opacity = '0.85';

  const head = el('div', 'row');
  const title = el('div'); title.style.cssText = 'font-weight:800;font-size:16px;';
  title.textContent = m.title;
  head.appendChild(title);
  head.appendChild(el('div', 'spacer'));
  if (done) head.appendChild(el('div', 'tag', '✔ Complete'));
  else if (!unlocked) head.appendChild(el('div', 'tag', '🔒 Locked'));
  card.appendChild(head);

  // env + reward tags
  const tags = el('div', 'row'); tags.style.marginTop = '6px';
  tags.appendChild(el('div', 'tag', m.env));
  if (m.needsCarrier) tags.appendChild(el('div', 'tag', 'needs carrier'));
  if (m.soloOnly) tags.appendChild(el('div', 'tag', 'solo'));
  if (m.enemyCarrier) tags.appendChild(el('div', 'tag', 'enemy carrier'));
  const rew = el('div', 'tag'); rew.style.color = 'var(--gold)';
  rew.textContent = '+' + fmtCr(m.reward);
  tags.appendChild(rew);
  card.appendChild(tags);

  const brief = el('div', 'small muted'); brief.style.cssText = 'margin-top:10px;line-height:1.5;';
  brief.textContent = m.brief;
  card.appendChild(brief);

  const obj = el('div', 'mono small'); obj.style.cssText = 'margin-top:8px;color:var(--accent)';
  obj.textContent = '▸ ' + m.objective.label;
  card.appendChild(obj);

  // enemy summary
  const enemyTotal = (m.enemies || []).reduce((a, e) => a + e.count, 0);
  const en = el('div', 'mono small faint'); en.style.marginTop = '6px';
  en.textContent = 'Threat: ' + enemyTotal + ' aircraft' + (m.enemyCarrier ? ' + carrier' : '');
  card.appendChild(en);

  // prerequisites note when locked
  if (!unlocked){
    const need = (m.requires || []).map(r => missionById(r)?.title || r).join(', ');
    const note = el('div', 'small'); note.style.cssText = 'margin-top:8px;color:var(--warn)';
    note.textContent = 'Requires: ' + need;
    card.appendChild(note);
  }

  // deploy / replay
  const acts = el('div', 'row'); acts.style.marginTop = '12px';
  const deploy = el('button', 'btn ' + (done ? '' : 'accent'), done ? '↻ Fly Again' : '➤ Deploy');
  deploy.disabled = !unlocked;
  deploy.onclick = () => openDeploy(m);
  acts.appendChild(deploy);
  card.appendChild(acts);

  return card;
}

// ---------------------------------------------------------------------------
//  DEPLOY FLOW — choose YOUR aircraft + wingmen + (auto) carrier, then launch.
// ---------------------------------------------------------------------------
function openDeploy(mission){
  const owned = ownedDesigns();
  if (owned.length === 0){ toast('Buy an aircraft before deploying', 'warn'); selectTab('hangar'); return; }

  // carrier gate
  if (mission.needsCarrier && !State.campaign.carrierId){
    confirmModal('Carrier required',
      'This mission needs your aircraft carrier. Commission one first in the Carrier tab.',
      () => { selectTab('carrier'); }, 'Go to Carrier');
    return;
  }

  const m = openModal('Deploy — ' + mission.title, true);

  // brief
  m.body.appendChild(el('div', 'small muted', mission.brief));
  const obj = el('div', 'mono small'); obj.style.cssText = 'margin:8px 0;color:var(--accent)';
  obj.textContent = '▸ ' + mission.objective.label + '   ·   Reward ' + fmtCr(mission.reward);
  m.body.appendChild(obj);

  // ---- your aircraft picker ----
  m.body.appendChild(el('h3', '', 'Your aircraft'));
  let chosen = owned[0];
  const acGrid = el('div', 'pill-row');
  const acPills = [];
  for (const d of owned){
    const s = statsOf(d);
    const p = el('div', 'pill', d.name + (s.ok ? '' : ' ⚠'));
    p.onclick = () => {
      if (!s.ok){ toast(d.name + ' will not fly', 'bad'); return; }
      chosen = d; acPills.forEach(x => x.classList.remove('sel')); p.classList.add('sel');
    };
    if (d === chosen) p.classList.add('sel');
    acPills.push(p); acGrid.appendChild(p);
  }
  m.body.appendChild(acGrid);

  // ---- wingmen picker (disabled for solo missions) ----
  const wingmen = State.campaign.wingmen || [];
  const selectedWing = new Set();
  if (mission.soloOnly){
    m.body.appendChild(el('h3', '', 'Wingmen'));
    m.body.appendChild(el('div', 'small warn', 'This is a solo duel — no wingmen permitted.'));
  } else if (wingmen.length){
    m.body.appendChild(el('h3', '', 'Wingmen (deploy with you)'));
    const wGrid = el('div', 'pill-row');
    for (const wm of wingmen){
      const wdesign = wm.designId ? designForOwnedId(wm.designId) : null;
      const ok = wdesign && statsOf(wdesign).ok;
      const p = el('div', 'pill', wm.name + (ok ? '' : ' ⚠'));
      p.title = wdesign ? 'flies ' + wdesign.name : 'no aircraft';
      p.onclick = () => {
        if (!ok){ toast(wm.name + ' has no flyable aircraft', 'bad'); return; }
        if (selectedWing.has(wm.id)){ selectedWing.delete(wm.id); p.classList.remove('sel'); }
        else { selectedWing.add(wm.id); p.classList.add('sel'); }
      };
      wGrid.appendChild(p);
    }
    m.body.appendChild(wGrid);
  } else {
    m.body.appendChild(el('h3', '', 'Wingmen'));
    m.body.appendChild(el('div', 'small muted', 'No wingmen hired. You fly alone (recruit some in the Wingmen tab).'));
  }

  // ---- carrier note ----
  if (mission.needsCarrier || mission.enemyCarrier){
    m.body.appendChild(el('h3', '', 'Capital ships'));
    const cn = el('div', 'small mono muted');
    const lines = [];
    if (mission.needsCarrier){
      const cv = designForOwnedId(State.campaign.carrierId);
      lines.push('Friendly: ' + (cv ? cv.name : 'your carrier'));
    }
    if (mission.enemyCarrier){
      const ec = stockGet(mission.enemyCarrier);
      lines.push('Enemy: ' + (ec ? ec.name : 'enemy carrier'));
    }
    cn.textContent = lines.join('   ·   ');
    m.body.appendChild(cn);
  }

  // ---- launch ----
  const launch = el('button', 'btn gold big', '🚀 Launch Sortie');
  launch.style.marginTop = '16px';
  launch.onclick = () => {
    if (!statsOf(chosen).ok){ toast('Your aircraft will not fly', 'bad'); return; }
    closeModal();
    launchMission(mission, chosen, mission.soloOnly ? [] : [...selectedWing]);
  };
  m.body.appendChild(launch);
}

// Build the Battle config from chosen assets and run it.
function launchMission(mission, playerDesign, wingmanIds){
  // resolve allies from wingmen (their assigned designs, skill-tagged for AI)
  const allies = [];
  for (const id of wingmanIds){
    const wm = (State.campaign.wingmen || []).find(w => w.id === id);
    if (!wm || !wm.designId) continue;
    const d = designForOwnedId(wm.designId);
    if (!d) continue;
    const ally = cloneDesign(d, '');
    ally.name = wm.name;                 // show the pilot's callsign in battle
    ally.author = 'You';
    ally.skill = wm.skill;               // hint for ai.js (clamped fallback if ignored)
    allies.push(ally);
  }

  // resolve enemies → [{design,count,skill}]
  const enemies = (mission.enemies || []).map(e => {
    const d = stockGet(e.stock);
    if (e.name && d) d.name = e.name;     // named ace
    return { design: d, count: e.count, skill: clamp(e.skill ?? 0.5, 0, 1) };
  }).filter(e => e.design);

  // carriers
  const carrier = mission.needsCarrier && State.campaign.carrierId
    ? designForOwnedId(State.campaign.carrierId) : null;
  const enemyCarrier = mission.enemyCarrier ? stockGet(mission.enemyCarrier) : null;

  // hand the battle a copy of the player's aircraft so combat damage never
  // touches the stored design.
  const player = cloneDesign(playerDesign, '');
  player.author = 'You';

  const config = {
    player,
    allies,
    enemies,
    env: mission.env || 'day',
    objective: { ...mission.objective },
    timeLimit: mission.timeLimit || 0,
    carrier,
    enemyCarrier,
    net: null,
    onEnd: (result) => onMissionEnd(mission, result),
  };

  // record the active sortie for inspection / save resilience
  State.campaign.active = {
    missionId: mission.id,
    playerId: playerDesign.id,
    wingmanIds,
    startedDay: State.campaign.day,
  };
  save();

  // hide our screen + HUD-managed-by-battle; Battle owns the render target now.
  if (root) root.classList.add('hidden');
  sfx('lockfull');
  try {
    Battle.start(config);
  } catch (e){
    console.error('Battle.start failed', e);
    toast('Could not start battle: ' + e.message, 'bad');
    Campaign.show(); selectTab('missions');
  }
}

// ---------------------------------------------------------------------------
//  MISSION RESULT — economy + progression + result modal.
// ---------------------------------------------------------------------------
function onMissionEnd(mission, result){
  result = result || { win: false, kills: 0, deaths: 0, time: 0, score: 0, reason: 'aborted' };
  const c = State.campaign;
  const isPatrol = !!mission.patrol;                      // repeatable — never "completed"
  const firstClear = !isPatrol && !c.completed.includes(mission.id);
  let payout = 0, oldRank = c.rank, promoted = false;

  if (result.win){
    // first clear pays full reward; replays/patrols pay a reduced bounty + per-kill.
    payout = firstClear ? mission.reward : Math.round(mission.reward * 0.4);
    payout += Math.round((result.kills || 0) * 250);
    earn(payout);
    if (firstClear) c.completed.push(mission.id);
    c.day += 1;                                           // a sortie burns a day; a win can rank you up
    const newRank = rankForCompleted(c.completed.length);
    if (newRank !== c.rank){ c.rank = newRank; promoted = true; }
  } else {
    c.day += 1;                                           // a failed sortie still costs a day
  }
  // shift the theatre's control (and drift the rest of the front) BEFORE re-rendering
  if (mission._regionId) shiftRegionControl(mission._regionId, result.win, isPatrol, firstClear);
  save();

  // Battle tore down its view; bring the hub (World Map) back with fresh control.
  Campaign.show();
  selectTab('missions');
  refreshTopbar();
  showResultModal(mission, result, { payout, firstClear, promoted, oldRank });
}

function showResultModal(mission, result, info){
  const win = !!result.win;
  const m = openModal(win ? 'Mission Complete' : 'Mission Failed');

  const banner = el('div'); banner.style.cssText =
    'font-size:30px;font-weight:800;letter-spacing:.04em;margin-bottom:4px;color:' +
    (win ? 'var(--good)' : 'var(--bad)') + ';';
  banner.textContent = win ? 'VICTORY' : 'DEFEAT';
  m.body.appendChild(banner);

  m.body.appendChild(el('div', 'muted', mission.title));

  // stat readout
  const st = el('div', 'stats'); st.style.marginTop = '14px';
  const add = (k, v, cls) => { st.appendChild(el('div', 'k', k)); const e = el('div', 'v' + (cls ? ' ' + cls : '')); e.textContent = v; st.appendChild(e); };
  add('Kills', String(result.kills ?? 0), 'good');
  add('Losses', String(result.deaths ?? 0), (result.deaths ? 'bad' : ''));
  if (result.time) add('Sortie time', fmtTimeShort(result.time));
  if (result.score != null) add('Score', fmtNum(result.score));
  if (result.reason) add('Outcome', String(result.reason));
  m.body.appendChild(st);

  // payout / progression
  const eco = el('div', 'panel tight'); eco.style.marginTop = '14px';
  if (win){
    eco.innerHTML =
      '<div class="mono">Reward: <span class="credits">+' + fmtCr(info.payout) + '</span>' +
      (info.firstClear ? '' : ' <span class="faint small">(replay bounty)</span>') + '</div>';
    if (info.promoted){
      const pr = el('div', 'mono'); pr.style.cssText = 'margin-top:8px;color:var(--gold)';
      pr.textContent = '★ Promoted to ' + State.campaign.rank + '!';
      eco.appendChild(pr);
    }
    const adv = el('div', 'mono small muted'); adv.style.marginTop = '6px';
    adv.textContent = 'Advanced to Day ' + State.campaign.day;
    eco.appendChild(adv);
  } else {
    eco.innerHTML = '<div class="mono muted">No reward. A day has passed (Day ' + State.campaign.day +
      ') — regroup and try again.</div>';
  }
  m.body.appendChild(eco);

  // unlocks teaser
  if (win && info.firstClear){
    const unlocked = MISSIONS.filter(x =>
      !State.campaign.completed.includes(x.id) &&
      (x.requires || []).includes(mission.id) &&
      missionUnlocked(x));
    if (unlocked.length){
      const u = el('div', 'small'); u.style.cssText = 'margin-top:12px;color:var(--accent)';
      u.textContent = 'New mission unlocked: ' + unlocked.map(x => x.title).join(', ');
      m.body.appendChild(u);
    }
  }

  const row = el('div', 'row'); row.style.marginTop = '16px';
  const again = el('button', 'btn', '↻ Fly Again');
  again.onclick = () => { closeModal(); openDeploy(mission); };
  row.appendChild(again);
  const ok = el('button', 'btn accent', 'Continue');
  ok.onclick = () => { closeModal(); selectTab('missions'); };
  row.appendChild(ok);
  m.body.appendChild(row);

  sfx(win ? 'lockfull' : 'boom');
}

function fmtTimeShort(sec){
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

// ---------------------------------------------------------------------------
//  MODAL helpers — render into #modal-root (created if absent). Single modal.
// ---------------------------------------------------------------------------
let activeModalBg = null;

function modalRoot(){
  let r = $('modal-root');
  if (!r){ r = el('div'); r.id = 'modal-root'; document.body.appendChild(r); }
  return r;
}
function openModal(titleText, wide){
  closeModal();
  const bg = el('div', 'modal-bg');
  const modal = el('div', 'modal');
  if (wide) modal.style.width = 'min(620px,94vw)';
  const head = el('div', 'row');
  const h = el('h2'); h.style.margin = '0'; h.textContent = titleText;
  head.appendChild(h);
  head.appendChild(el('div', 'spacer'));
  const x = el('button', 'btn small ghost', '✕');
  x.onclick = () => { sfx('click'); closeModal(); };
  head.appendChild(x);
  modal.appendChild(head);
  const body = el('div'); body.style.marginTop = '12px';
  modal.appendChild(body);
  bg.appendChild(modal);
  // click outside to dismiss
  bg.addEventListener('mousedown', (ev) => { if (ev.target === bg) closeModal(); });
  modalRoot().appendChild(bg);
  activeModalBg = bg;
  return { bg, modal, body };
}
function closeModal(){
  if (activeModalBg){ activeModalBg.remove(); activeModalBg = null; }
}
function confirmModal(titleText, msg, onYes, yesLabel, yesKind){
  const m = openModal(titleText);
  m.body.appendChild(el('div', 'muted', msg));
  const row = el('div', 'row'); row.style.marginTop = '16px';
  const no = el('button', 'btn', 'Cancel');
  no.onclick = () => { sfx('click'); closeModal(); };
  row.appendChild(no);
  const yes = el('button', 'btn ' + (yesKind || 'accent'), yesLabel || 'Confirm');
  yes.onclick = () => { closeModal(); onYes && onYes(); };
  row.appendChild(yes);
  m.body.appendChild(row);
}

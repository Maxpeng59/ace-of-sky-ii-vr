# Ace of Sky II — Module Contract (FROZEN)

A browser 3D dogfight game. **ES modules**, no bundler. `index.html` has an import map:
`{ "imports": { "three": "./vendor/three.module.js" } }` — so `import * as THREE from 'three'` works.
All game `.js` lives in `js/`. Convention: **forward (nose) = +Z**, up = +Y, gravity −Y.

## Spine modules (ALREADY WRITTEN — import, do not modify)

### `util.js`
`G, RHO, TAU` consts · `clamp(v,a,b)`, `lerp(a,b,t)`, `inv(t,a,b)`, `dampF(cur,tgt,rate,dt)` ·
`RNG` class (`.next/.range(a,b)/.int(a,b)/.pick(arr)/.chance(p)`) · `hashStr`, `mulberry32` ·
`$(id)`, `$$(sel,root?)`, `el(tag,cls?,text?)`, `clear(node)`, `show(node)`, `hide(node)` ·
`fmtCr(n)` (credits, "1,200 ☼"), `fmtMass(kg)`, `fmtNum(n,d?)`, `fmtTime(sec)` ·
`audio()`, `sfx(kind,vol?)` kinds: `mg cannon gatling missile hit ui lock lockfull click thrust boom` ·
`toast(msg, kind?)` kind: `'' good warn bad`.

### `physics.js`
`GRID`(=1m/cell), `CL_MAX`, `OVERHEAT_TEMP`(1100), `AMBIENT_TEMP`(15), `G`, `RHO`.
`effSize(def,rot)` → `[w,h,l]` footprint after quarter-turn. `partCenter(p,def)` → `{x,y,z}` metres.
**`computeStats(design)` → stats** — THE physics model. Returns:
```
{ ok, errors[], warnings[], partCount,
  dryMass, fuelMass, fuelCap, mass, weight, cost,
  thrust, boostThrust, twr, twrBoost, dragArea, liftArea,
  vMax, vMaxBoost, vStall, cruise,            // m/s
  burnRate, boostBurn, endurance(s), range(km),
  durability, structureHP, armorHP, armor,
  heatCap, heatGenMax, heatDiss, overheat,
  agility:{pitch,roll,yaw}(deg/s), control:{pitch,roll,yaw},
  weapons:[ {key,name,type,dmg,rof,speed,clip,reload,spread,splash,lockTime?,turn?,ammo,mount:{x,y,z},partKey} ],
  hardpoints, flares, sensor, crew,
  com:{x,y,z}, col:{x,y,z}, stability, bbox:{min,max,size} }
```
`dragForce(stats,v)`, `liftForce(stats,v,cl)`, `thermoStep(stats,tempC,genFrac,speed,dt)→newTempC`, `statLine(s)`.

### `parts.js`
`PARTS` (key→def map), `PART_LIST`, `CATEGORIES` `[{key,name}]`, `partsByCategory(cat)`,
`WEAPONS` (key→def), `CAT_COLORS` (category→hex).
**PartDef**: `{ key,name,category,size:[w,h,l],mass,cost,hp,desc, build(THREE,def)→Object3D, ...physics props }`.
`build()` returns a mesh centred on origin, sized in metres, nose detail toward +Z. Placement applies position+rotation.

### `core.js`
`bus` (`.on(ev,fn)→off`, `.emit(ev,data)`) events: `loaded saved money library`.
`uid()`, `newDesign(name?)`, `cloneDesign(d,suffix?)`, `statsOf(d)`.
`exportCode(d)→"ASK2.…"`, `importCode(str)→design|null`.
`State` = `{ money, library:[design], settings:{sfx,invertY,masterVol}, campaign:{started,day,rank,completed[],hangar[],wingmen[],carrierId,active}, pvp:{lastFleet[],budget,designSeconds} }`.
`save()`, `load()`, `resetSave()` · `canAfford(n)`, `spend(n)→bool`, `earn(n)` ·
`libGet(id)`, `libSave(d)`, `libDelete(id)`, `libDuplicate(id)→design` ·
`STOCK_DESIGNS` (array of factory aircraft: Falcon/Vanguard/Fortress/Wasp/Goliath), `stockGet(id)`.
**AircraftDesign** = `{ id, name, author, role, color, parts:[ {key,gx,gy,gz,rot} ] }`. `gz` increases toward nose.

### `engine.js`
`initEngine(canvasEl?)→renderer` (called once by main.js), `getRenderer()`, `getCanvas()`, `resize()`,
`setScene(scene,camera)` (what's drawn), `onFrame(fn)→unsub` (per-frame `fn(dt)`, dt secs clamped ≤0.1),
`clearFrame()`, `resetView()` (clears frame cbs + scene), `start()`, `stop()`.
**Single shared WebGL renderer.** A screen on enter: build its own `THREE.Scene`+camera, `setScene()`, register `onFrame`. On exit: call its unsub + `resetView()`.

### `prediction.js`  (ported from Gravity Front — the requested system)
`leadPoint(shooterPos,target,spd,out?)→Vector3` — target `{position:{x,y,z},vel:{x,y,z},aimY?,alive}`.
`interceptTime(shooterPos,target,spd)`.
`LockSystem` class: `new LockSystem({range,acquireAngle,holdAngle,team,self})`;
`.update(dt,{origin,fwd,candidates,lockTime,ready})→{target,progress,locked,justLocked}`; `.reset()`.
`drawPrediction({ctx,camera,W,H,shooterPos,target,weapon,progress,locked,assist})`.
`drawLockReticle({ctx,camera,W,H,target,progress,flash})`.
`homeMissile(missile,target,turnRate,dt)→bool` — steers `missile.{position,vel,speed}` toward lead.

## Screen modules YOU build — exact public API (main.js calls these)

All are **singletons** (`export const X = {…}`). Each fully owns its DOM (create/destroy inside its
root element) and, if 3D, its own Scene+camera via `engine`. Only ONE screen is active at a time.
Use existing CSS classes from `css/style.css` (`.screen .btn .panel .card .pill .stats .topbar` …,
hangar: `.hangar-root/.hangar-head/.hangar-palette/.hangar-stage/.hangar-info/.part-item/.cat-head`,
HUD: `#hud .hud-bl/.hud-br/.hud-tc/.hud-bar`). Add component-specific inline styles sparingly; never
redefine the tokens. Root containers already exist in index.html (see DOM IDS below) — render into them
and toggle `.hidden`.

### `hangar.js` → `export const Hangar`
`Hangar.open(opts)` where `opts = { design, title?, actions?, onChange?, onExit, budget? }`:
- `design` AircraftDesign to edit (caller passes a clone). `title` header string.
- `actions`: `[{label, kind?('accent'|'gold'|'danger'|''), fn(design,stats)}]` — extra header buttons (e.g. {label:'LAUNCH',kind:'accent',fn}). Always also render a default "◂ EXIT" that calls `onExit(design)`.
- `onChange(design,stats)` fired on every edit (for live budget/cost). `budget` optional number → show a budget bar and flag overspend.
- Renders into `#screen-hangar`. KSP-style: scrollable categorized **part palette** (left), 3D **stage** (centre) with the airframe, **info/stats** panel (right) using `computeStats`. Features: click part in palette then click/drag in stage to place on the build grid; rotate (R), delete (click+Del or right-click), pan/orbit camera (mouse drag + wheel zoom — KSP-like), CoM/CoL gizmo toggle, name field, color, save-to-library, duplicate, export-code/import-code (use `core.exportCode/importCode`, prompt/textarea), undo (Ctrl+Z). Live stats: mass, TWR, top speed, stall, durability, fuel/endurance, heat, agility, cost, warnings/errors.
`Hangar.close()` — tear down, `engine.resetView()`.

### `battle.js` → `export const Battle`  (the dogfight sim — biggest module; may also create `js/ai.js`)
`Battle.start(config)`, `Battle.stop()`. `config`:
```
{ player: design, allies:[design], enemies:[{design,count,skill(0..1)}],
  env:'day'|'dusk'|'night'|'sea', objective:{type,...,label}, timeLimit?,
  carrier?:design|null, enemyCarrier?:design|null,
  net?: null | { role:'host'|'client', send(msg), onMsg(cb), close() },   // PvP transport (optional)
  onEnd(result) }  result = { win:bool, kills, deaths, time, score, reason }
```
Build each aircraft's mesh from its `parts` via `PARTS[key].build(THREE,def)` positioned by `partCenter`.
Flight model derives ALL handling from `computeStats(design)` (thrust→accel, drag, lift/stall, agility→turn
rates, fuel burn drains `fuelMass`/endurance, `thermoStep` heat → overheat damage, durability = HP pool,
armor absorbs). Player input: **W/S** throttle, **mouse** pitch/yaw, **A/D** roll, **Shift** boost (afterburner),
**Space** fire, **Tab/Q/E** cycle weapon, **F** flares, **G** drop tanks. Chase camera.
Combat: guns (hitscan/fast projectiles + tracers), missiles (use `homeMissile`), bombs (ballistic).
HUD overlay on a 2D canvas `#hud-canvas` inside `#hud`: armor/fuel/boost/heat bars, weapon+ammo, radar,
objective, speed/alt, and **the prediction/lock system** — instantiate `LockSystem`, call `.update` each
frame with enemy candidates, and draw via `drawPrediction` (gun lead pipper, always-on guide; aircraft lock
after a moment) + `drawLockReticle` (for `lockmissile` weapons). AI (`ai.js`): enemies/wingmen fly, pursue,
lead their shots via `leadPoint`, evade; `skill` scales aim/aggression. Win when all enemies down (or
objective met); lose when player dead. Call `onEnd`. If `net` present: it's **human vs human** — send player
state + fire events each tick, spawn the remote player's fleet from received designs, apply remote
transforms; NO AI on the human-controlled remote craft (PvP is not PvE).

### `creative.js` → `export const Creative`
`Creative.show()` — battle-setup screen (`#screen-creative`): pick YOUR aircraft from `State.library`
(or button → `Hangar.open` to design/edit, then return), choose enemies (stock + library designs, count,
skill slider), allies/wingmen, environment, and objective options (deathmatch / escort / survive N / etc.).
"LAUNCH" → `Battle.start(config)` with `onEnd` returning to this screen. Back → `Menu.show()`.

### `campaign.js` → `export const Campaign`
`Campaign.show()` — hub (`#screen-campaign`) reading/writing `State.campaign` + economy. Shows credits/day/
rank. **Everything costs money** (`spend`): buying/designing aircraft into your hangar (via `Hangar.open`,
charge `stats.cost`), designing wingmen (named pilots with skill) and an **aircraft carrier** design.
Mission list = tasks/challenges (`MISSIONS` you define: e.g. patrol, intercept bombers, escort carrier,
sink enemy carrier, ace duel) each with objective + reward + enemy loadout. Deploy chosen owned aircraft
(+wingmen, +carrier) → `Battle.start` with the mission objective; on win `earn(reward)`, mark
`State.campaign.completed`. Persist with `save()`. Back → `Menu.show()`.

### `pvp.js` → `export const Pvp`  (also writes `server/relay.py` + `js/net.js`)
`Pvp.show()` — flow on `#screen-pvp`: (1) set **budget** (`State.pvp.budget`) and design time
(default 300s / 5 min). (2) **Design phase**: a countdown timer; build as many/as-good aircraft as the
budget allows using `Hangar.open` (track spent vs budget, can save several into a fleet). (3) **Lobby**:
create or join a room on the relay (`net.js` talking to `server/relay.py`), exchanging each player's fleet
(as `exportCode` strings). (4) When both ready → `Battle.start({ player: yourLead, allies: yourFleet rest,
enemies:[], net:{role,send,onMsg,close}, objective:{type:'pvp'}, onEnd })`. Strictly **human vs human**.
`net.js`: `export function connect({url,room,role,onState,onEvent,onPeer,onClose})→{ send(msg), close() }`
— polling/relay client. `server/relay.py`: dependency-free (stdlib only) HTTP relay with rooms; endpoints
to create/join a room and POST/GET JSON messages (CORS `*`). Document how to run + connect.

### `menu.js` → `export const Menu`
`Menu.show()` — main menu (`#screen-menu`): title, three big mode buttons → `Creative.show()`,
`Campaign.show()`, `Pvp.show()`, plus "Library/Hangar" (open `Hangar` on a chosen/new library design) and
"Settings" (toggles in `State.settings`, `save()`) and a reset-save. main.js calls `Menu.show()` at boot.

## DOM IDs present in index.html (render into these; toggle `.hidden`)
`#gl` (the WebGL canvas), `#screen-menu`, `#screen-creative`, `#screen-campaign`, `#screen-pvp`,
`#screen-hangar`, `#hud` (with child `<canvas id="hud-canvas">`), `#modal-root`, `#toast-root`.
Each `#screen-*` starts with class `screen hidden`. A screen `show()` removes `hidden` from its own root
and adds `hidden` to the others (or call a helper — but simplest: each `show()`/`open()` hides all other
screen roots first).

## Rules for every module
- Pure ES modules; import only from the spine above + `three`. Never edit spine files.
- Don't create a second WebGL renderer — use `engine`. The 2D HUD uses its own `<canvas id="hud-canvas">` 2D context.
- Clean up on exit (remove listeners, `engine.resetView()` if you used it) so screens don't leak.
- Keep it runnable with zero network/assets beyond `vendor/three.module.js`.
- Match the house style: dense, commented where non-obvious, uses the CSS design system.

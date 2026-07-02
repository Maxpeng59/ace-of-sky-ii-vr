// ============================================================================
//  Ace of Sky II — main.js
//  Boot + top-level router. Initializes the shared render engine, loads the
//  save, and hands control to the main menu. Everything else is reached
//  through the screen modules (Menu → Creative / Campaign / Pvp / Hangar).
// ============================================================================
import { initEngine } from './engine.js';
import { load, bus } from './core.js';
import { Menu } from './menu.js';
import { toast } from './util.js';

// surface any uncaught error on-screen — invaluable while integrating modules
function fatal(msg, detail){
  console.error(msg, detail);
  let root = document.getElementById('boot');
  if (!root){ root = document.createElement('div'); root.id = 'boot'; root.className = 'loading'; document.body.appendChild(root); }
  root.classList.remove('hidden');
  root.innerHTML = '';
  const h = document.createElement('div'); h.style.color = '#ff4d6d'; h.style.fontSize = '18px'; h.textContent = '⚠ ' + msg;
  const p = document.createElement('pre'); p.style.cssText = 'max-width:80vw;white-space:pre-wrap;color:#8aa0bd;font-size:12px;text-align:left';
  p.textContent = (detail && (detail.stack || detail.message || String(detail))) || '';
  root.appendChild(h); root.appendChild(p);
}
addEventListener('error', (e) => fatal('Runtime error: ' + (e.message || ''), e.error || e));
addEventListener('unhandledrejection', (e) => {
  // benign browser rejections (e.g. pointer-lock re-acquire timing) must not crash the game
  const msg = String((e.reason && (e.reason.message || e.reason)) || '');
  if (/pointer\s*lock|exited the lock|gesture/i.test(msg)){ e.preventDefault?.(); return; }
  fatal('Unhandled promise rejection', e.reason);
});

function boot(){
  try {
    initEngine(document.getElementById('gl'));
    load();                                  // load save (or seed stock library)
    const splash = document.getElementById('boot');
    if (splash) splash.classList.add('hidden');
    Menu.show();
    bus.emit('booted');
  } catch (err){
    fatal('Failed to start: ' + (err.message || err), err);
  }
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
else boot();

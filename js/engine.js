// ============================================================================
//  Ace of Sky II — engine.js
//  ONE shared WebGL renderer + ONE rAF loop for the whole game, so the hangar,
//  the battle sim and any preview never create competing WebGL contexts.
//  Screens call setScene(scene,camera) to choose what's drawn and onFrame(fn)
//  to register a per-frame update; both are cleared on screen switch.
// ============================================================================
import * as THREE from 'three';

let renderer = null, canvas = null;
let curScene = null, curCamera = null;
const frameCbs = new Set();
let running = false, last = 0;

export function initEngine(canvasEl){
  canvas = canvasEl || document.getElementById('gl');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;
  // PCF (not PCFSoft): the soft variant taps the shadow map many more times PER LIT PIXEL —
  // in VR (two eyes, high-res panels) that's a large hidden fill cost for a barely-visible change.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Filmic tone mapping: rolls off highlights and enriches mids like a camera instead of
  // hard-clipping to white — the single cheapest step toward photographic realism.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.28;   // ACES crushes mids; the palettes were tuned pre-filmic
  renderer.xr.enabled = true;                       // WebXR: lets a screen enter immersive VR
  addEventListener('resize', resize);
  resize();
  start();
  return renderer;
}
export function getRenderer(){ return renderer; }
export function getCanvas(){ return canvas; }
export function isPresenting(){ return !!(renderer && renderer.xr && renderer.xr.isPresenting); }

export function resize(){
  if (!renderer) return;
  renderer.setSize(innerWidth, innerHeight, false);
  if (curCamera && curCamera.isPerspectiveCamera){ curCamera.aspect = innerWidth / innerHeight; curCamera.updateProjectionMatrix(); }
  for (const fn of frameCbs) if (fn._onResize) fn._onResize();
}

export function setScene(scene, camera){
  curScene = scene; curCamera = camera;
  if (camera && camera.isPerspectiveCamera){ camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
}

// register update(dt) called every frame; returns an unsubscribe fn
export function onFrame(fn){ frameCbs.add(fn); return () => frameCbs.delete(fn); }
export function clearFrame(){ frameCbs.clear(); }

// fully reset the render target when leaving a screen
export function resetView(){ clearFrame(); curScene = null; curCamera = null; if (renderer) renderer.clear(); }

// WebXR REQUIRES the renderer's own animation loop (rAF doesn't fire in an
// immersive session). setAnimationLoop drives both the flat desktop view and
// the headset; the callback gets (timeMs, xrFrame).
export function start(){ if (running || !renderer) return; running = true; last = performance.now(); renderer.setAnimationLoop(loop); }
export function stop(){ running = false; if (renderer) renderer.setAnimationLoop(null); }

const _vrFrameCbs = new Set();
// per-frame callback that also receives the live XRFrame (for controllers/poses)
export function onVRFrame(fn){ _vrFrameCbs.add(fn); return () => _vrFrameCbs.delete(fn); }

function loop(now, xrFrame){
  if (!running) return;
  now = now || performance.now();
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1;                 // clamp after tab-switches
  if (dt < 0) dt = 0;
  for (const fn of frameCbs){ try { fn(dt); } catch (e){ console.error('frame cb', e); } }
  for (const fn of _vrFrameCbs){ try { fn(dt, xrFrame); } catch (e){ console.error('vr frame cb', e); } }
  if (renderer && curScene && curCamera) renderer.render(curScene, curCamera);
}

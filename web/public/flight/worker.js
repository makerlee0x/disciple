/* DISCIPLE flight — render worker. Runs the unmodified engine.js (simulation + Canvas2D rendering) on an
 * OffscreenCanvas so React, wallet popups and main-thread GC can't stall frames.
 * The engine is written against window/document; this file provides a minimal shim of exactly what it
 * touches, and bridges events / DOM writes / trades to the main thread (lib/flight/workerBridge.ts).
 *
 * main → worker: init, ev (CustomEvent), key, ptr, size, vis, glob, orbClick, tradeAvail, tradeRes, decal, call, blur
 * worker → main: ready, evt, dom, ls, trade, snap (≤10 Hz), err
 */
'use strict';
const post = (m, t) => self.postMessage(m, t || []);
const nativeDispatch = EventTarget.prototype.dispatchEvent.bind(self);
const OUT = /^(disciple:|apflight|twfilled)/;   // engine → React events
let INBOUND = false;
// engine's bare dispatchEvent() → local listeners + forwarded to the page
self.dispatchEvent = function (ev) {
  const r = nativeDispatch(ev);
  if (!INBOUND && OUT.test(ev.type)) post({ k: 'evt', type: ev.type, detail: ev.detail === undefined ? null : ev.detail, custom: 'detail' in ev });
  return r;
};
function inbound(ev) { INBOUND = true; try { nativeDispatch(ev); } finally { INBOUND = false; } }

/* ---------- shims ---------- */
self.window = self;
const NATIVE_RAF = typeof self.requestAnimationFrame === 'function';
if (!NATIVE_RAF) {           // e.g. Safari: no rAF in workers
  let lastT = 0;
  self.requestAnimationFrame = (cb) => { const now = performance.now(), wait = Math.max(0, 16.667 - (now - lastT)); return setTimeout(() => { lastT = performance.now(); cb(lastT); }, wait); };
  self.cancelAnimationFrame = (id) => clearTimeout(id);
}
const LS = {};
self.localStorage = {
  getItem: (k) => (k in LS ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v); post({ k: 'ls', key: k, v: String(v) }); },
  removeItem: (k) => { delete LS[k]; post({ k: 'ls', key: k, v: null }); },
};
class ImageShim {   // decoded with createImageBitmap; engine swaps IMG[n] to .bitmap in onload
  constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.onload = null; this.onerror = null; this.bad = false; }
  set src(url) { this._src = url;
    fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); }).then((b) => createImageBitmap(b)).then((bm) => {
      bm.complete = true; bm.naturalWidth = bm.width; bm.naturalHeight = bm.height; this.bitmap = bm;
      this.complete = true; this.naturalWidth = bm.width; this.naturalHeight = bm.height; this.onload && this.onload();
    }).catch(() => { this.bad = true; this.onerror && this.onerror(); }); }
  get src() { return this._src; }
}
self.Image = ImageShim;
const domPost = (id, op, a, b) => post({ k: 'dom', id, op, a, b });
const styleProxy = (id) => new Proxy({}, { set(o, p, v) { o[p] = v; if (id) domPost(id, 'style', p, v); return true; } });
let canvas = null, RECT = { left: 0, top: 0, width: 1, height: 1 }, WRAP = { clientWidth: 1280, clientHeight: 720 }, HIDDEN = false;
const docListeners = {};
const orbBtn = { _t: '', listeners: [], set textContent(v) { this._t = v; domPost('orbBtn', 'text', v); }, get textContent() { return this._t; },
  classList: { toggle: (c, on) => domPost('orbBtn', 'class', c, on) }, addEventListener(t, f) { if (t === 'click') this.listeners.push(f); }, blur() {} };
const launchFade = { style: styleProxy('launchFade') };
self.document = {
  get hidden() { return HIDDEN; },
  getElementById(id) { return id === 'c' ? canvas : id === 'wrap' ? WRAP : id === 'orbBtn' ? orbBtn : id === 'launchFade' ? launchFade : null; },
  createElement(tag) { if (tag !== 'canvas') throw new Error('worker shim: createElement(' + tag + ')'); return new OffscreenCanvas(300, 150); },
  addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
  removeEventListener() {},
};
const mkEvent = (type, props) => { const e = new Event(type, { cancelable: true }); for (const k in props) Object.defineProperty(e, k, { value: props[k] }); return e; };

/* ---------- trades: window.__discipleTrade proxied to the page's wallet bridge ---------- */
let tradeAvail = false, tradeSeq = 0; const tradeWait = new Map();
const tradeProxy = (side, usd, o) => new Promise((res) => { const id = ++tradeSeq; tradeWait.set(id, res); post({ k: 'trade', id, side, usd, o: o || null }); });
Object.defineProperty(self, '__discipleTrade', { get: () => (tradeAvail ? tradeProxy : undefined), configurable: true });

/* ---------- HUD / tooling snapshot (≤10 Hz) ---------- */
const SNAP_KEYS = ['graduated', 'phoneHolderTags', 'gradBadge', 'tierNeedText', 'phoneTierLabel', 'x', 'fight', 'flare', 'momV', 'mode', 'aimDisp', 'heading', 'camPx', 'camAlt', 'ry', 'anch', 'bgScrollX', 'fwd', 'vyS', 'simF', 'simT', 'displayAlt', 'balance', 'orbsOn', 'bombsOn', 'score', 'ammoTier', 'volEma', 'buyEma', 'sellEma'];
function snapshot() {
  const F = self.__flight; if (!F || !F.S) return;
  const S = F.S, o = { confirmed: { mcap: S.confirmed.mcap, block: S.confirmed.block } };
  for (const k of SNAP_KEYS) o[k] = S[k];
  o.mom = self.__flightMom ? self.__flightMom() : null;
  o.feed = (S.feed || []).slice(0, 6).map((f) => ({ txt: f.txt }));   // HUD tooling: recent feed lines
  // screenYToMcap samples (main interpolates in log space between them)
  const H = WRAP.clientHeight, ys = [];
  if (F.screenYToMcap && S.displayAlt != null) for (let i = 0; i <= 16; i++) { const y = H * i / 16; ys.push([y, F.screenYToMcap(y)]); }
  const P = self.__flightPerf || {};
  post({ k: 'snap', S: o, supply: F.source && F.source.supply, ys, perf: { n: P.n, long25: P.long25, long50: P.long50, max: P.max, sum: P.sum } });
}

self.onmessage = async (m) => {
  const d = m.data;
  switch (d.k) {
    case 'init': {
      try {
        canvas = d.canvas; canvas.style = styleProxy('c');
        canvas.getBoundingClientRect = () => RECT;
        Object.assign(LS, d.ls || {}); RECT = d.rect; WRAP.clientWidth = d.w; WRAP.clientHeight = d.h; HIDDEN = d.hidden;
        self.devicePixelRatio = d.dpr; self.innerWidth = d.w; self.innerHeight = d.h;
        Object.assign(self, d.globals || {});
        tradeAvail = !!d.tradeAvail;
        const src = await (await fetch(d.engineUrl)).text();
        const loc = { search: d.search, href: d.href, pathname: d.pathname };
        // `location` is read-only in workers → shadow it for the engine only
        new Function('location', src)(loc);
        if (!self.__flight) throw new Error('engine did not start');
        setInterval(snapshot, 100);
        post({ k: 'ready', raf: NATIVE_RAF });
      } catch (e) { post({ k: 'err', msg: String((e && e.stack) || e) }); }
      break;
    }
    case 'ev': inbound(d.custom ? new CustomEvent(d.type, { detail: d.detail }) : new Event(d.type)); break;
    case 'key': inbound(mkEvent(d.type, { code: d.code, key: d.key, repeat: d.repeat, ctrlKey: d.ctrlKey, metaKey: d.metaKey, shiftKey: d.shiftKey })); break;
    case 'blur': inbound(new Event('blur')); break;
    case 'ptr': if (canvas) canvas.dispatchEvent(mkEvent(d.type, { clientX: d.x, clientY: d.y, pointerId: d.id, pointerType: d.pt })); break;
    case 'size': RECT = d.rect; WRAP.clientWidth = d.w; WRAP.clientHeight = d.h; self.devicePixelRatio = d.dpr; self.innerWidth = d.w; self.innerHeight = d.h; inbound(new Event('resize')); break;
    case 'vis': HIDDEN = d.hidden; for (const f of docListeners.visibilitychange || []) f(new Event('visibilitychange')); break;
    case 'glob': self[d.name] = d.value; break;
    case 'orbClick': for (const f of orbBtn.listeners) f({ currentTarget: orbBtn }); break;
    case 'tradeAvail': tradeAvail = d.on; break;
    case 'tradeRes': { const r = tradeWait.get(d.id); if (r) { tradeWait.delete(d.id); r(d.result); } break; }
    case 'decal': self.__rocketDecal = { canvas: d.bitmap, t0: performance.now(), fallback: d.fallback }; break;
    case 'call': { try { const F = self.__flight, path = d.name.split('.'); let o = F; for (let i = 0; i < path.length - 1; i++) o = o[path[i]]; o[path.at(-1)](...(d.args || [])); } catch (e) { console.warn('call', d.name, e); } break; }
    case 'perfReset': self.__flightPerf && self.__flightPerf.reset(); break;
    case 'stop': try { self.__flight && self.__flight.source && self.__flight.source.stop && self.__flight.source.stop(); } catch (_) {} self.close(); break;
  }
};

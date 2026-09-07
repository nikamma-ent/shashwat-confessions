import { QUESTIONS } from './questions.js';

// ─── SETUP ──────────────────────────────────────────────────────────
// TEST_MODE runs entirely on localStorage — no Firebase project needed —
// so this can be opened and clicked around locally before any backend
// exists. Placements only sync across tabs on the same browser (via the
// storage event), not across real visitors. Once firebaseConfig below
// is filled in (see README.md) and firestore.rules is deployed, flip
// this to false to go live for real.
const TEST_MODE = false;

// Firebase Console → Project settings → General → Your apps → SDK setup
const firebaseConfig = {
    apiKey: 'AIzaSyACyUNAGxChh3PBIgJGcu257290bICfCF8',
    authDomain: 'pinocchio-canvas.firebaseapp.com',
    projectId: 'pinocchio-canvas',
    storageBucket: 'pinocchio-canvas.firebasestorage.app',
    messagingSenderId: '694631376178',
    appId: '1:694631376178:web:32176bc8c64503564b632b'
};

// Grid is GRID_SIZE × GRID_SIZE cells. Firestore documents cap out around
// 1MB, so a grid this size can't live in one doc if fully painted — it's
// split into CHUNK_SIZE × CHUNK_SIZE tiles, each its own document (see
// makeFirestoreBackend below and firestore.rules). Bumping GRID_SIZE just
// creates more chunk documents, not bigger ones, so it scales freely;
// CHUNK_SIZE rarely needs to change.
const GRID_SIZE = 256;
const CHUNK_SIZE = 32;
const CHUNKS_PER_SIDE = GRID_SIZE / CHUNK_SIZE;

const MAX_ZOOM = 28;  // on-screen px per cell, at max zoom-in
const MIN_ZOOM = 0.5; // on-screen px per cell, at max zoom-out — purely a
                       // performance floor (how many tiled copies get drawn
                       // per frame), not a boundary; the board itself wraps
                       // seamlessly and has no edge to restrict panning at

// Endesga 32 — a free, widely-used 32-color pixel art palette. Wide hue
// and shade range, still small enough to keep pixel data compact (one
// small index per cell) and the whole canvas' palette visually cohesive.
const PALETTE = [
    '#be4a2f', '#d77643', '#ead4aa', '#e4a672',
    '#b86f50', '#733e39', '#3e2731', '#a22633',
    '#e43b44', '#f77622', '#feae34', '#fee761',
    '#63c74d', '#3e8948', '#265c42', '#193c3e',
    '#124e89', '#0099db', '#2ce8f5', '#ffffff',
    '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466',
    '#262b44', '#181425', '#ff0044', '#68386c',
    '#b55088', '#f6757a', '#e8b796', '#c28569'
];

// ─── ELEMENTS (the page is one always-present app shell now — no more
// separate hub vs. canvas pages) ─────────────────────────────────────
const appEl = document.getElementById('app');
const viewEl = document.getElementById('pixelCanvas');
const vctx = viewEl.getContext('2d');
const statusEl = document.getElementById('canvasStatus');
const placeStatusEl = document.getElementById('placeStatus');
const statsEl = document.getElementById('stats');
const paletteEl = document.getElementById('palette');
const selectEl = document.getElementById('questionSelect');

// Offscreen 1px-per-cell buffer — the source of truth for what's drawn.
// Updated cell-by-cell as pixels arrive; the visible canvas just scales
// a rect of this via drawImage every frame, which is cheap regardless of
// zoom level or grid size (a handful of fillRect calls on every *data*
// change, one drawImage on every *camera* change).
const gridCanvas = document.createElement('canvas');
gridCanvas.width = GRID_SIZE;
gridCanvas.height = GRID_SIZE;
const gctx = gridCanvas.getContext('2d');
window.__pinocchioGrid = gridCanvas; // devtools escape hatch — see README "Getting a snapshot"

const knownPixels = new Set();
let activeColor = 0;
let currentSlug = null;
let unsubscribeCurrent = null;

// 'paint' (default) makes the primary drag (left mouse / one finger)
// paint a stroke; 'move' makes it pan instead. Right-click-drag and
// two-finger-drag always pan regardless of this — the toggle is only
// about what the *primary* input does, for people who'd rather not
// remember a secondary gesture.
let inputMode = 'paint';

const camera = { x: 0, y: 0, zoom: 1 };

// ─── palette UI (built once — color choice persists across question
// switches, same as a real toolbox) ──────────────────────────────────
PALETTE.forEach((hex, i) => {
    const btn = document.createElement('button');
    btn.className = 'swatch' + (i === 0 ? ' is-active' : '');
    btn.style.background = hex;
    btn.type = 'button';
    btn.setAttribute('aria-label', `Color ${i + 1}`);
    btn.addEventListener('click', () => {
        activeColor = i;
        paletteEl.querySelectorAll('.swatch').forEach(s => s.classList.remove('is-active'));
        btn.classList.add('is-active');
    });
    paletteEl.appendChild(btn);
});

// ─── mode toggle: move vs. paint ─────────────────────────────────────
const modeMoveBtn = document.getElementById('modeMove');
const modePaintBtn = document.getElementById('modePaint');

function setMode(mode) {
    inputMode = mode;
    modeMoveBtn.classList.toggle('is-active', mode === 'move');
    modeMoveBtn.setAttribute('aria-checked', String(mode === 'move'));
    modePaintBtn.classList.toggle('is-active', mode === 'paint');
    modePaintBtn.setAttribute('aria-checked', String(mode === 'paint'));
    viewEl.style.cursor = mode === 'move' ? 'grab' : 'crosshair';
}

modeMoveBtn.addEventListener('click', () => setMode('move'));
modePaintBtn.addEventListener('click', () => setMode('paint'));

// ─── question dropdown ──────────────────────────────────────────────
Object.values(QUESTIONS).forEach((q) => {
    const opt = document.createElement('option');
    opt.value = q.slug;
    opt.textContent = q.enabled ? q.title : `${q.title} — coming soon`;
    opt.disabled = !q.enabled;
    selectEl.appendChild(opt);
});
selectEl.addEventListener('change', () => loadQuestion(selectEl.value));

// ─── camera / viewport (the canvas fills the whole window now) ──────
// window.innerWidth/innerHeight can legitimately be 0 momentarily — a
// hidden/not-yet-composited view, a detached iframe, etc. Committing a
// fit against a zero-size viewport would divide by zero and permanently
// wedge camera.zoom at 0 (nothing recovers from that on its own), so
// every size-dependent function bails out instead of trusting a 0×0 read.
function resizeViewport() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    viewEl.width = w * dpr;
    viewEl.height = h * dpr;
    viewEl.style.width = `${w}px`;
    viewEl.style.height = `${h}px`;
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    vctx.imageSmoothingEnabled = false;
}

function fitToScreen() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === 0 || h === 0) return;
    const zoom = (Math.min(w, h) / GRID_SIZE) * 0.9;
    camera.zoom = zoom;
    camera.x = (w - GRID_SIZE * zoom) / 2;
    camera.y = (h - GRID_SIZE * zoom) / 2;
}

// The board has no edges — panning past one side brings the other side
// back into view, like a world map wrapping at the antimeridian. camera.x
// and camera.y are left completely unclamped (pan forever, either
// direction); wrapping only happens where it actually matters: mapping a
// screen point back to a cell (screenToWorld) and tiling the grid texture
// across the viewport for rendering (draw/drawGridLines). period() finds
// the on-screen position of the tile copy nearest to (at or before) 0,
// for a given repeat length in screen px — the starting point for tiling.
function wrap(value, size) { return ((value % size) + size) % size; }
function period(originPx, lengthPx) { return originPx - Math.floor(originPx / lengthPx) * lengthPx - lengthPx; }

function screenToWorld(sx, sy) {
    return {
        x: wrap((sx - camera.x) / camera.zoom, GRID_SIZE),
        y: wrap((sy - camera.y) / camera.zoom, GRID_SIZE)
    };
}

function zoomAt(sx, sy, factor) {
    const before = screenToWorld(sx, sy);
    camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
    camera.x = sx - before.x * camera.zoom;
    camera.y = sy - before.y * camera.zoom;
    scheduleDraw();
}

let redrawScheduled = false;
function scheduleDraw() {
    if (redrawScheduled) return;
    redrawScheduled = true;
    requestAnimationFrame(() => { redrawScheduled = false; draw(); });
}

function draw() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    vctx.clearRect(0, 0, w, h);
    vctx.fillStyle = '#2a0000';
    vctx.fillRect(0, 0, w, h);

    const tile = GRID_SIZE * camera.zoom;
    const originX = period(camera.x, tile);
    const originY = period(camera.y, tile);
    const cols = Math.ceil((w - originX) / tile) + 1;
    const rows = Math.ceil((h - originY) / tile) + 1;

    for (let ry = 0; ry < rows; ry++) {
        for (let rx = 0; rx < cols; rx++) {
            vctx.drawImage(
                gridCanvas, 0, 0, GRID_SIZE, GRID_SIZE,
                originX + rx * tile, originY + ry * tile, tile, tile
            );
        }
    }

    drawGridLines(w, h);
}

// Cell borders — only worth showing once a cell is big enough on screen
// to actually paint precisely into; at fit-to-screen zoom (a handful of
// px per cell) hundreds of lines would just be moiré noise. Fades in
// over a small zoom range instead of popping in suddenly.
const GRID_LINE_FADE_START = 6;  // px/cell — lines start appearing
const GRID_LINE_FADE_END = 12;   // px/cell — lines fully opaque

function drawGridLines(w, h) {
    const zoom = camera.zoom;
    if (zoom < GRID_LINE_FADE_START) return;
    const alpha = Math.min(1, (zoom - GRID_LINE_FADE_START) / (GRID_LINE_FADE_END - GRID_LINE_FADE_START));

    // Cell boundaries repeat every `zoom` px — same tiling idea as draw(),
    // just at the per-cell period instead of the per-grid one, and drawn
    // as plain lines across the whole viewport rather than per-copy.
    const originX = period(camera.x, zoom);
    const originY = period(camera.y, zoom);

    vctx.strokeStyle = `rgba(0, 0, 0, ${0.25 * alpha})`;
    vctx.lineWidth = 1;
    vctx.beginPath();
    for (let x = originX; x <= w; x += zoom) {
        vctx.moveTo(x, 0);
        vctx.lineTo(x, h);
    }
    for (let y = originY; y <= h; y += zoom) {
        vctx.moveTo(0, y);
        vctx.lineTo(w, y);
    }
    vctx.stroke();
}

// ─── momentum panning — release a drag and it glides to a stop, instead
// of dead-stopping the instant the pointer lifts. Same feel as flicking
// a real map. Velocity is a decaying blend of recent per-move deltas
// (not just the last one), so a jittery final frame right before release
// doesn't wreck the throw. ───────────────────────────────────────────────
const PAN_FRICTION = 0.94;          // velocity multiplier applied every animation frame
const PAN_MOMENTUM_STOP = 0.05;     // px/frame below which the glide ends
const PAN_MOMENTUM_MAX = 60;        // px/frame cap, so a huge delta (e.g. a laggy frame) can't launch a wild throw

let panVelX = 0;
let panVelY = 0;
let lastPanMoveTime = 0;
let momentumId = null;

function stopMomentum() {
    if (momentumId) {
        cancelAnimationFrame(momentumId);
        momentumId = null;
    }
}

function panBegin() {
    stopMomentum();
    panVelX = 0;
    panVelY = 0;
    lastPanMoveTime = performance.now();
}

function panMove(dx, dy) {
    camera.x += dx;
    camera.y += dy;
    const now = performance.now();
    const dt = Math.max(1, now - lastPanMoveTime); // ms
    const instVelX = (dx / dt) * 16.67; // normalize to px/frame @ 60fps
    const instVelY = (dy / dt) * 16.67;
    panVelX = panVelX * 0.7 + instVelX * 0.3;
    panVelY = panVelY * 0.7 + instVelY * 0.3;
    lastPanMoveTime = now;
    scheduleDraw();
}

function panEnd() {
    let vx = Math.max(-PAN_MOMENTUM_MAX, Math.min(PAN_MOMENTUM_MAX, panVelX));
    let vy = Math.max(-PAN_MOMENTUM_MAX, Math.min(PAN_MOMENTUM_MAX, panVelY));
    if (Math.hypot(vx, vy) < PAN_MOMENTUM_STOP) return;
    function frame() {
        camera.x += vx;
        camera.y += vy;
        vx *= PAN_FRICTION;
        vy *= PAN_FRICTION;
        scheduleDraw();
        momentumId = Math.hypot(vx, vy) > PAN_MOMENTUM_STOP ? requestAnimationFrame(frame) : null;
    }
    momentumId = requestAnimationFrame(frame);
}

// ─── eased zoom — the +/−/fit controls animate to their target instead
// of snapping, same as clicking a map app's zoom buttons. Wheel/pinch
// stay immediate since they already update continuously per input event.
const ZOOM_ANIM_MS = 220;

function animate(durationMs, onFrame) {
    const start = performance.now();
    function step(now) {
        const raw = Math.min(1, (now - start) / durationMs);
        const eased = 1 - Math.pow(1 - raw, 3); // ease-out cubic
        onFrame(eased);
        if (raw < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

function smoothZoomAt(sx, sy, factor) {
    stopMomentum();
    const startZoom = camera.zoom;
    const targetZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, startZoom * factor));
    const before = screenToWorld(sx, sy);
    animate(ZOOM_ANIM_MS, (t) => {
        camera.zoom = startZoom + (targetZoom - startZoom) * t;
        camera.x = sx - before.x * camera.zoom;
        camera.y = sy - before.y * camera.zoom;
        scheduleDraw();
    });
}

function smoothFitToScreen() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === 0 || h === 0) return;
    stopMomentum();
    const targetZoom = (Math.min(w, h) / GRID_SIZE) * 0.9;
    const targetX = (w - GRID_SIZE * targetZoom) / 2;
    const targetY = (h - GRID_SIZE * targetZoom) / 2;

    // The board wraps and pans are unclamped, so after a long session
    // camera.x/y could be numerically far from the target while looking
    // visually identical to a much closer position. Re-anchor to the
    // nearest wrapped equivalent first so the animation travels a short,
    // clean distance instead of visibly racing across many tile copies.
    const tile = GRID_SIZE * camera.zoom;
    const startX = camera.x + Math.round((targetX - camera.x) / tile) * tile;
    const startY = camera.y + Math.round((targetY - camera.y) / tile) * tile;
    const startZoom = camera.zoom;

    animate(ZOOM_ANIM_MS, (t) => {
        camera.zoom = startZoom + (targetZoom - startZoom) * t;
        camera.x = startX + (targetX - startX) * t;
        camera.y = startY + (targetY - startY) * t;
        scheduleDraw();
    });
}

// ─── painting ──────────────────────────────────────────────────────────
// A drag paints every cell it crosses, not just where it started — like
// a brush, not a stamp. lastPaintedCell dedupes so holding still (or
// moving within the same cell) doesn't refire the same write over and
// over as the pointer jitters by sub-pixel amounts.
let lastPaintedCell = null;

function paintAt(clientX, clientY) {
    if (!currentSlug) return;
    const world = screenToWorld(clientX, clientY);
    const x = Math.floor(world.x);
    const y = Math.floor(world.y);
    if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return;
    if (lastPaintedCell && lastPaintedCell[0] === x && lastPaintedCell[1] === y) return;
    lastPaintedCell = [x, y];

    const slugAtPaint = currentSlug;
    currentBackend.placePixel(x, y, activeColor).catch((err) => {
        if (slugAtPaint !== currentSlug) return; // switched away before it failed
        console.error(err);
        placeStatusEl.textContent = 'could not place pixel — try again';
        placeStatusEl.classList.add('is-error');
        setTimeout(() => placeStatusEl.classList.remove('is-error'), 3000);
    });
}

// ─── input: wheel zoom ─────────────────────────────────────────────────
viewEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.pow(1.0015, -e.deltaY);
    zoomAt(e.clientX, e.clientY, factor);
}, { passive: false });

// ─── input: mouse — primary (left) button follows the move/paint
// toggle; right button always pans regardless of it, as a fixed
// power-user shortcut for people who don't want to touch the toggle ───
viewEl.addEventListener('contextmenu', (e) => e.preventDefault());

let painting = false;
let panning = false;
let lastX = 0;
let lastY = 0;

function startPan(x, y) {
    panning = true;
    lastX = x;
    lastY = y;
    panBegin();
    viewEl.classList.add('is-grabbing');
}

viewEl.addEventListener('mousedown', (e) => {
    if (e.button === 2 || (e.button === 0 && inputMode === 'move')) {
        startPan(e.clientX, e.clientY);
    } else if (e.button === 0) {
        stopMomentum();
        painting = true;
        lastPaintedCell = null;
        paintAt(e.clientX, e.clientY);
    }
});
window.addEventListener('mousemove', (e) => {
    if (panning) {
        panMove(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
    } else if (painting) {
        paintAt(e.clientX, e.clientY);
    }
});
window.addEventListener('mouseup', () => {
    if (panning) {
        panning = false;
        viewEl.classList.remove('is-grabbing');
        panEnd();
    }
    painting = false;
    lastPaintedCell = null;
});

// Double-click zooms in on the clicked point, animated — same shortcut
// as most map apps. Only in Move mode: in Paint mode a quick double-click
// is a normal way to touch up two pixels, and shouldn't also yank the view.
viewEl.addEventListener('dblclick', (e) => {
    if (inputMode === 'move') smoothZoomAt(e.clientX, e.clientY, 1.8);
});

// ─── input: touch — one finger follows the move/paint toggle; two
// fingers always pan and pinch-zoom together (same combined gesture as
// a map app), regardless of the toggle ─────────────────────────────────
function touchDist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
function touchMid(a, b) { return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }

let touchState = null;
viewEl.addEventListener('touchstart', (e) => {
    stopMomentum();
    if (e.touches.length === 1) {
        const t = e.touches[0];
        if (inputMode === 'move') {
            touchState = { mode: 'pan1', lastX: t.clientX, lastY: t.clientY };
            panBegin();
        } else {
            lastPaintedCell = null;
            paintAt(t.clientX, t.clientY);
            touchState = { mode: 'paint' };
        }
    } else if (e.touches.length === 2) {
        const [a, b] = e.touches;
        const mid = touchMid(a, b);
        touchState = {
            mode: 'pan-zoom',
            startDist: touchDist(a, b),
            startZoom: camera.zoom,
            anchorWorld: screenToWorld(mid.x, mid.y)
        };
    }
}, { passive: true });

viewEl.addEventListener('touchmove', (e) => {
    if (!touchState) return;
    e.preventDefault();
    if (touchState.mode === 'paint' && e.touches.length === 1) {
        const t = e.touches[0];
        paintAt(t.clientX, t.clientY);
    } else if (touchState.mode === 'pan1' && e.touches.length === 1) {
        const t = e.touches[0];
        panMove(t.clientX - touchState.lastX, t.clientY - touchState.lastY);
        touchState.lastX = t.clientX;
        touchState.lastY = t.clientY;
    } else if (touchState.mode === 'pan-zoom' && e.touches.length === 2) {
        const [a, b] = e.touches;
        const mid = touchMid(a, b);
        const factor = touchDist(a, b) / touchState.startDist;
        camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, touchState.startZoom * factor));
        camera.x = mid.x - touchState.anchorWorld.x * camera.zoom;
        camera.y = mid.y - touchState.anchorWorld.y * camera.zoom;
        scheduleDraw();
    }
}, { passive: false });

viewEl.addEventListener('touchend', () => {
    if (touchState && touchState.mode === 'pan1') panEnd();
    touchState = null;
    lastPaintedCell = null;
});

// ─── zoom buttons ─────────────────────────────────────────────────────
document.getElementById('zoomIn').addEventListener('click', () => {
    smoothZoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.5);
});
document.getElementById('zoomOut').addEventListener('click', () => {
    smoothZoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.5);
});
document.getElementById('zoomReset').addEventListener('click', smoothFitToScreen);

// Handles both real window resizes and the viewport going from 0×0 (not
// yet composited/visible) to a real size without ever firing a 'resize'
// event — ResizeObserver catches that transition; 'resize' is kept too
// since it fires for cases ResizeObserver on body sometimes misses (e.g.
// zoom-level changes in some browsers).
let hasFitOnce = false;
function handleViewportChange() {
    if (window.innerWidth === 0 || window.innerHeight === 0) return;
    resizeViewport();
    if (!hasFitOnce) {
        hasFitOnce = true;
        fitToScreen();
    }
    scheduleDraw();
}

window.addEventListener('resize', handleViewportChange);
new ResizeObserver(handleViewportChange).observe(document.body);

// ─── switching questions ──────────────────────────────────────────────
// Each question is its own canvas (own Firestore chunks / localStorage
// key). Switching tears down the previous backend's listeners, wipes the
// offscreen grid buffer, and re-fits the camera — like opening a
// different board, while the color you had selected carries over.
let currentBackend = null;

async function loadQuestion(slug) {
    const question = QUESTIONS[slug];
    if (!question || !question.enabled) return;

    currentSlug = slug;
    selectEl.value = slug;
    document.title = `Pinocchio — ${question.title}`;
    history.replaceState(null, '', `?q=${slug}`);

    if (unsubscribeCurrent) { unsubscribeCurrent(); unsubscribeCurrent = null; }

    knownPixels.clear();
    gctx.fillStyle = '#2a0000';
    gctx.fillRect(0, 0, GRID_SIZE, GRID_SIZE);
    statsEl.textContent = '';
    placeStatusEl.textContent = 'drag to paint, or switch to move · right-click drag (or two fingers) always pans';
    placeStatusEl.classList.remove('is-error');

    appEl.classList.add('is-loading');
    appEl.classList.remove('has-error');
    statusEl.textContent = 'loading canvas...';

    fitToScreen();
    scheduleDraw();

    currentBackend = TEST_MODE ? makeLocalBackend(slug) : makeFirestoreBackend(slug);

    unsubscribeCurrent = await currentBackend.subscribe(
        (x, y, colorIndex) => {
            if (slug !== currentSlug) return; // stray callback from a canvas we've left
            gctx.fillStyle = PALETTE[colorIndex] || '#000000';
            gctx.fillRect(x, y, 1, 1);
            knownPixels.add(`${x}_${y}`);
            statsEl.textContent = `${knownPixels.size} pixel${knownPixels.size === 1 ? '' : 's'} placed`;
            appEl.classList.remove('is-loading', 'has-error');
            scheduleDraw();
        },
        (err) => {
            if (slug !== currentSlug) return;
            console.error(err);
            appEl.classList.add('has-error');
            appEl.classList.remove('is-loading');
            statusEl.textContent = 'could not load canvas.';
        }
    );

    // Empty canvases never fire a pixel callback — clear the loading
    // state once the initial subscribe pass has had a moment to resolve.
    setTimeout(() => { if (slug === currentSlug) appEl.classList.remove('is-loading'); }, 1200);
}

// ─── boot ──────────────────────────────────────────────────────────────
setMode('paint');
resizeViewport();

const requested = new URLSearchParams(location.search).get('q');
const initialSlug = (requested && QUESTIONS[requested]?.enabled)
    ? requested
    : Object.values(QUESTIONS).find(q => q.enabled)?.slug;

if (initialSlug) {
    loadQuestion(initialSlug);
} else {
    statusEl.textContent = 'no questions available yet.';
}

// ─── TEST_MODE backend: localStorage, flat "x_y" map. Cross-tab sync
// via the native 'storage' event; same-tab writes call the subscriber
// directly since 'storage' never fires in the tab that wrote it.
function makeLocalBackend(canvasSlug) {
    const key = `pinocchio_canvas_data_${canvasSlug}`;
    let onPixel = null;
    let seenKeys = new Set();
    let handler = null;

    function read() {
        try {
            return JSON.parse(localStorage.getItem(key)) || {};
        } catch {
            return {};
        }
    }

    function emitAll(data) {
        for (const k in data) {
            if (seenKeys.has(k)) continue;
            seenKeys.add(k);
            const [x, y] = k.split('_').map(Number);
            onPixel(x, y, data[k]);
        }
    }

    return {
        async subscribe(cb) {
            onPixel = cb;
            emitAll(read());
            handler = (e) => { if (e.key === key) emitAll(read()); };
            window.addEventListener('storage', handler);
            return () => window.removeEventListener('storage', handler);
        },
        async placePixel(x, y, colorIndex) {
            const data = read();
            const k = `${x}_${y}`;
            data[k] = colorIndex;
            localStorage.setItem(key, JSON.stringify(data));
            seenKeys.delete(k); // force re-emit even for a repaint
            if (onPixel) emitAll(data);
        }
    };
}

// ─── Live backend: Firebase Firestore, chunked ─────────────────────
// One document per CHUNK_SIZE×CHUNK_SIZE tile, at
// canvases/{slug}/chunks/{cx}_{cy}, shape { pixels: { "lx_ly": colorIndex } }
// (lx/ly are local to the chunk). Placing a pixel touches exactly one
// chunk doc via a dot-path merge, so two people painting different tiles
// — or different cells of the same tile — never collide. The whole
// canvas subscribes to all CHUNKS_PER_SIDE² chunks up front; fine at
// this project's traffic scale, and far simpler than viewport-based
// subscription management.
function makeFirestoreBackend(canvasSlug) {
    const ready = (async () => {
        const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js');
        const { getFirestore, doc, onSnapshot, setDoc } =
            await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js');

        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        return { db, doc, onSnapshot, setDoc };
    })();

    return {
        async subscribe(onPixel, onError) {
            const { db, doc, onSnapshot } = await ready;
            const unsubs = [];
            for (let cx = 0; cx < CHUNKS_PER_SIDE; cx++) {
                for (let cy = 0; cy < CHUNKS_PER_SIDE; cy++) {
                    const ref = doc(db, 'canvases', canvasSlug, 'chunks', `${cx}_${cy}`);
                    unsubs.push(onSnapshot(ref, (snap) => {
                        const pixels = (snap.exists() ? snap.data().pixels : null) || {};
                        for (const key in pixels) {
                            const [lx, ly] = key.split('_').map(Number);
                            onPixel(cx * CHUNK_SIZE + lx, cy * CHUNK_SIZE + ly, pixels[key]);
                        }
                    }, onError));
                }
            }
            return () => unsubs.forEach(u => u());
        },
        async placePixel(x, y, colorIndex) {
            const { db, doc, setDoc } = await ready;
            const cx = Math.floor(x / CHUNK_SIZE);
            const cy = Math.floor(y / CHUNK_SIZE);
            const lx = x - cx * CHUNK_SIZE;
            const ly = y - cy * CHUNK_SIZE;
            const ref = doc(db, 'canvases', canvasSlug, 'chunks', `${cx}_${cy}`);
            await setDoc(ref, { pixels: { [`${lx}_${ly}`]: colorIndex } }, { merge: true });
        }
    };
}

/* ============================================================
   PEN — the wobbly, tapered pen and the marker box shared by
   every sheet (faces, figures, animals, tattoo).
   Everything is built from one trick: never draw a straight,
   confident line. Every stroke is chopped into short pieces and
   each piece is nudged a little, like a wobbly pen; each piece's
   thickness swells and thins like a dip pen; colour is washed on
   underneath, a little off register, as flat marker or crayon.

   Classic script (no modules, so the sheets open from file://): it shares
   its functions and the `pen` state object with sheet.js and the sheets.
   ============================================================ */

/* ─── Constants: colours come from the CSS tokens so there is one source of truth ─── */
const css = getComputedStyle(document.documentElement);
const tok = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
const toks = (prefix, n) => Array.from({ length: n }, (_, i) => tok(`${prefix}-${i + 1}`, '#888'));
const INK = tok('--ink', '#211E1A');        // edulab ink
const PAPER = tok('--canvas', '#FFFFFF');   // the drawing paper: plain white, no grain
const INKS = [INK, INK, INK, INK, tok('--ink-sepia', INK), tok('--ink-blue', INK)];

/* ─── State: the pen in hand. One object holds everything the drawing code shares ─── */
const pen = {
  ctx: null,       // the canvas being drawn on: the sheet, or the viewer's while a drawing is enlarged
  R: null,         // seeded random fn for the drawing in progress (use rf/ri/pick/chance/wpick)
  ink: INK,        // ink colour, picked per drawing
  base: PAPER,     // the light inside the lines: the paper on the sheet, near-white on a transparent export
  /* per-drawing multipliers; a sheet resets them before every drawing it makes:
     w        stroke width boost (fat nib vs fine)          wob      wobble boost
     minTaper strokes thinner than this are drawn plain     scribble crayon-scribble stride & width
     stipple  dot size boost */
  w: 1, wob: 1, minTaper: 0, scribble: 1, stipple: 1,
  /* the user's hand on the pen (sheet controls; not touched by reset): line weight, wobble,
     drawing zoom, color punch and fill messiness of the washes */
  user: { w: 1, wob: 1, zoom: 1, color: 0, fill: 0 },   // color: 0 natural … 1 vibrant · fill: 0 accurate … 1 messy
  seed(s) { this.R = mulberry32(s); },
  reset() { Object.assign(this, { ink: INK, w: 1, wob: 1, minTaper: 0, scribble: 1, stipple: 1 }); },
};

/* ---------- seedable random ---------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rf  = (a, b) => a + pen.R() * (b - a);          // float in [a,b)
const ri  = (a, b) => Math.floor(rf(a, b + 1));   // int in [a,b]
const pick   = arr => arr[Math.floor(pen.R() * arr.length)];
const chance = p => pen.R() < p;
/* weighted pick: wpick({ a: 3, b: 1 }) returns 'a' three times as often */
function wpick(table) {
  const keys = Object.keys(table).filter(k => table[k] > 0);
  let total = 0; for (const k of keys) total += table[k];
  let r = pen.R() * total;
  for (const k of keys) { r -= table[k]; if (r < 0) return k; }
  return keys[keys.length - 1];
}

/* ---------- the wobbly pen ---------- */
function penStyle(w, color) {
  const c = color || pen.ink;
  pen.ctx.strokeStyle = c;
  pen.ctx.fillStyle = c;
  pen.ctx.lineWidth = w * pen.w * pen.user.w;
  pen.ctx.lineCap = 'round';
  pen.ctx.lineJoin = 'round';
}

/* subdivide a polyline and jitter every intermediate point.
   The user's wobble (pen.user.wob, 1 = as drawn): below 1 a steadier hand calms the jitter; above 1
   it does not simply scale it (that only makes every line uniformly hairy) — it adds noise to the
   contour: a slow wander of the whole line off its path, and stretches that shake more than others.
   Both are carved out of the random numbers the jitter already draws, so the same seed keeps the
   same drawing at any setting, and at 1 the points are exactly the ones they always were. */
function wobblePts(pts, wob, closed) {
  const hand = pen.user.wob;
  wob *= pen.wob * Math.min(hand, 1);
  const loose = Math.max(0, hand - 1);                     // how far past "as drawn" the slider sits
  const amp = 2 * loose * Math.min(wob, 1.6);              // wander amplitude: with the stroke, but capped (washes are rough already)
  const out = [], drift = [];
  let dx = 0, dy = 0, m = 0.5;                             // the wander (mean-reverting walk) and the shakiness level
  const n = pts.length + (closed ? 0 : -1);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(2, Math.round(len / 9));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const j = (s === 0 && !closed && i === 0) ? 0 : 1;   // pin the very start
      let jx = rf(-wob, wob), jy = rf(-wob, wob);
      if (loose > 0) {
        const u = wob ? jx / wob : 0, v = wob ? jy / wob : 0;                 // the same two rolls, as unit noise
        const h = (Math.sin(u * 12.9898 + v * 78.233) * 43758.5453) % 1;     // a third channel hashed from them
        m = m * 0.75 + (0.5 + h) * 0.25;                                     // slow-moving shakiness, about 0.5
        const shake = 1 + loose * (Math.min(1, Math.max(0, 0.5 + (m - 0.5) * 3)) * 1.6 - 0.5);
        jx *= shake; jy *= shake;
        dx = dx * 0.82 + u * amp; dy = dy * 0.82 + v * amp;                  // the line wanders, then drifts back
      }
      out.push([a[0] + (b[0] - a[0]) * t + jx * j, a[1] + (b[1] - a[1]) * t + jy * j]);
      drift.push([dx * j, dy * j]);
    }
  }
  if (loose > 0 && out.length > 1) {
    /* ease the wander out so the line lands on its end (and a closed contour meets itself) */
    const k = out.length - 1, ex = drift[k][0], ey = drift[k][1];
    for (let i = 0; i <= k; i++) { const r = i / k; out[i][0] += drift[i][0] - ex * r; out[i][1] += drift[i][1] - ey * r; }
  }
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}

/* trace jittered points as a smooth-ish path (midpoint quadratics) */
function tracePath(pts, closed) {
  pen.ctx.beginPath();
  pen.ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    pen.ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  pen.ctx.lineTo(last[0], last[1]);
  if (closed) pen.ctx.closePath();
}

/* stroke a jittered polyline piece by piece, the pen pressing harder and
   lighter as it goes — canvas cannot vary width along one path, so each
   midpoint-to-midpoint quadratic is its own stroke */
function strokeTapered(p, closed, base) {
  const n = p.length;
  const ph = pen.R() * 6.28, f = rf(0.18, 0.45);
  const mid = i => [(p[i % n][0] + p[(i + 1) % n][0]) / 2, (p[i % n][1] + p[(i + 1) % n][1]) / 2];
  const seg = (a, c, b, i) => {
    pen.ctx.lineWidth = base * (0.6 + 0.75 * (0.5 + 0.5 * Math.sin(i * f + ph)) + rf(-0.08, 0.08));
    pen.ctx.beginPath(); pen.ctx.moveTo(a[0], a[1]); pen.ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]); pen.ctx.stroke();
  };
  if (closed) { for (let i = 0; i < n; i++) seg(mid(i - 1 + n), p[i], mid(i), i); return; }
  pen.ctx.lineWidth = base; pen.ctx.beginPath(); pen.ctx.moveTo(p[0][0], p[0][1]); const m0 = mid(0); pen.ctx.lineTo(m0[0], m0[1]); pen.ctx.stroke();
  for (let i = 1; i < n - 1; i++) seg(mid(i - 1), p[i], mid(i), i);
  const last = p[n - 1], ml = mid(n - 2);
  pen.ctx.beginPath(); pen.ctx.moveTo(ml[0], ml[1]); pen.ctx.lineTo(last[0], last[1]); pen.ctx.stroke();
}

/* sketch a polyline; fill:true fills with ink, fillColor overrides (e.g. BASE to hide
   what is behind); wash lays rough colour under the line; taper:false gives a plain stroke */
function sketch(pts, { wob = 1.4, width = 2.2, closed = false, fill = false, color, fillColor, wash, taper = true } = {}) {
  const w = wobblePts(pts, wob, closed);
  penStyle(width, color);
  if (fill) { tracePath(w, closed); pen.ctx.fillStyle = fillColor || color || pen.ink; pen.ctx.fill(); }
  if (wash) washPts(pts, typeof wash === 'string' ? { color: wash } : wash);
  penStyle(width, color);
  if (!taper || w.length < 4 || width < pen.minTaper) { tracePath(w, closed); pen.ctx.stroke(); return; }
  strokeTapered(w, closed, pen.ctx.lineWidth);
}

/* ---------- color punch of the washes (pen.user.color) ---------- */
const TINT_CACHE = new Map();
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}
/* pen.user.color: 0 = as the sheet chose … 1 = fully vibrant */
function tint(hex) {
  const t = pen.user.color;
  if (!(t > 0) || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const key = t + hex;
  if (TINT_CACHE.has(key)) return TINT_CACHE.get(key);
  let [h, s, l] = hexToHsl(hex);
  s += (Math.min(1, s * 1.6 + 0.1) - s) * t; l += (0.5 - l) * 0.25 * t;
  const out = hslToHex(h, s, l);
  TINT_CACHE.set(key, out);
  return out;
}

/* ---------- the marker box ----------
   colour goes on under the ink, a little off register and a little
   the wrong size, as flat marker or as a crayon scribble.
   WASH is how loosely every sheet lays its colour: a quick, translucent
   marker that wanders off the line rather than a careful fill. */
const WASH = {
  alpha: 0.72,      // multiplies the alpha a sheet asks for: marker, not paint
  wob: [4, 7],      // how roughly the wash edge follows the shape
  dx: 8, dy: 6,     // how far off register it may land
  grow: [0.95, 1.07] // and how much the wrong size
};
function washPts(pts, { color, alpha = 0.75, mode = 'flat', grow = 1, dx, dy, wob } = {}) {
  if (!color) return;
  color = tint(color);
  let cxm = 0, cym = 0; for (const q of pts) { cxm += q[0]; cym += q[1]; } cxm /= pts.length; cym /= pts.length;
  let ox = dx ?? rf(-WASH.dx, WASH.dx), oy = dy ?? rf(-WASH.dy, WASH.dy);
  let gx = grow * rf(WASH.grow[0], WASH.grow[1]), gy = gx;
  const messy = pen.user.fill;                   // 0 = careful … 1 = a careless hand: stops short of the line, or runs well past it, unevenly
  if (messy > 0) {
    const under = chance(0.5), lerp = (a, b) => a + (b - a) * messy;
    gx = grow * lerp(1, under ? rf(0.55, 0.85) : rf(1.1, 1.4)); gy = grow * lerp(1, under ? rf(0.55, 0.85) : rf(1.1, 1.4));
    ox += rf(-1, 1) * WASH.dx * 1.2 * messy; oy += rf(-1, 1) * WASH.dy * 1.2 * messy;
    wob = (wob ?? rf(WASH.wob[0], WASH.wob[1])) * lerp(1, rf(1.4, 2.2));
  }
  const q = pts.map(([x, y]) => [cxm + (x - cxm) * gx + ox, cym + (y - cym) * gy + oy]);
  const wp = wobblePts(q, wob ?? rf(WASH.wob[0], WASH.wob[1]), true);
  pen.ctx.save();
  pen.ctx.globalCompositeOperation = 'multiply';
  pen.ctx.globalAlpha = alpha * WASH.alpha;
  tracePath(wp, true);
  if (mode === 'scribble') {
    pen.ctx.clip();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of wp) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, diag = Math.hypot(x1 - x0, y1 - y0) / 2 + 6;
    const ang = rf(-1.0, -0.4), ux = Math.cos(ang), uy = Math.sin(ang), px = -uy, py = ux;
    const step = rf(6, 9) * pen.scribble, lw = rf(3.5, 6.5) * pen.scribble;
    pen.ctx.strokeStyle = color; pen.ctx.lineCap = 'round';
    for (let d = -diag; d <= diag; d += step) {
      const a = [mx + px * d - ux * diag, my + py * d - uy * diag], b = [mx + px * d + ux * diag, my + py * d + uy * diag];
      pen.ctx.lineWidth = lw * rf(0.7, 1.3);
      tracePath(wobblePts([a, b], 2, false), false); pen.ctx.stroke();
    }
  } else {
    pen.ctx.fillStyle = color; pen.ctx.fill();
  }
  pen.ctx.restore();
}

/* a shaky straight line */
function line(x1, y1, x2, y2, opt = {}) { sketch([[x1, y1], [x2, y2]], opt); }

/* a shaky arc, as a polyline of angles */
function arc(cx, cy, r, a0, a1, opt = {}) {
  const pts = [];
  const steps = Math.max(4, Math.round(Math.abs(a1 - a0) * r / 8));
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * i / steps;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  sketch(pts, opt);
}

/* a lumpy closed blob (used for the head, buns, big hair) */
function blobPts(cx, cy, rx, ry, lump = 0.07, n = 16) {
  const pts = [];
  const bumps = [];                       // low-frequency lumpiness
  for (let i = 0; i < 4; i++) bumps.push(rf(-lump, lump));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    let v = 1;
    for (let k = 0; k < 4; k++) v += bumps[k] * Math.sin((k + 1) * a + k * 2.1);
    pts.push([cx + Math.cos(a) * rx * v, cy + Math.sin(a) * ry * v]);
  }
  return pts;
}

/* a lumpy open arc of an ellipse from angle a0 to a1 (domes of hats, crowns of hair) */
function arcPts(cx, cy, rx, ry, a0, a1, lump = 0.05, n = 12) {
  const pts = [];
  const bumps = [rf(-lump, lump), rf(-lump, lump), rf(-lump, lump)];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n;
    let v = 1;
    for (let k = 0; k < 3; k++) v += bumps[k] * Math.sin((k + 1) * a * 2 + k * 1.7);
    pts.push([cx + Math.cos(a) * rx * v, cy + Math.sin(a) * ry * v]);
  }
  return pts;
}

/* dots — for stubble, tweed caps, freckles */
function stipple(cx, cy, rx, ry, count, size = 1.2, color) {
  penStyle(1, color);
  for (let i = 0; i < count; i++) {
    const a = pen.R() * Math.PI * 2, d = Math.sqrt(pen.R());
    const x = cx + Math.cos(a) * rx * d, y = cy + Math.sin(a) * ry * d;
    pen.ctx.beginPath();
    pen.ctx.arc(x, y, rf(0.5, size) * pen.stipple, 0, 7);
    pen.ctx.fill();
  }
}

/* short hatch strokes inside a box — for scribbled hair, grey beards */
function hatch(x0, y0, x1, y1, count, ang, len, color) {
  for (let i = 0; i < count; i++) {
    const x = rf(x0, x1), y = rf(y0, y1);
    const a = ang + rf(-0.25, 0.25), l = len * rf(0.6, 1.3);
    line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, { wob: 1, width: rf(1.2, 2), color });
  }
}

/* a filled dot */
function dot(x, y, r, color) {
  penStyle(1, color);
  pen.ctx.beginPath(); pen.ctx.arc(x, y, r, 0, 7); pen.ctx.fill();
}

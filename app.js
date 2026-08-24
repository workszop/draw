/* ============================================================
   APP – Likeness Evolver UI. Classic script (no modules).
   Drives a plain state object; every UI change re-renders from state.
   Task 4 scope: shell, grid, state machine skeleton, DOM contract.
   The full GA run loop (judging, elitism, mutation wiring) lands in Task 5;
   Pause/Resume/Stop here are minimal placeholders so the state machine and
   DOM contract are exercisable before that loop exists.

   Wrapped in an IIFE so the 25+ helper/constant names below stay private;
   only window.App is meant to escape this scope.
   ============================================================ */
(function () {
  'use strict';

// ─── Constants ───

var MAX_PHOTO_DIM = 512;
var PHOTO_JPEG_QUALITY = 0.8;
var MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB – generous guard against pathological uploads
var CELL_W = 200, CELL_H = 250;          // on-screen grid cell canvas size
var COMPOSITE_CELL_W = 300, COMPOSITE_CELL_H = 375; // buildGridJpeg() cell size (~300px per spec)
var TOTAL_GENERATIONS = 10;

// ─── State ───

var App = {
  state: {
    state: 'idle',        // idle | ready | running | done
    phase: null,           // null | drawing | judging | reviewing | paused
    provider: 'gemini',    // placeholder until Task 6 settings panel
    generation: 0,
    population: null,      // array of 9 genomes, current generation
    winner: null,           // 1-9 or null
    winnerSource: null,     // 'ai' | 'manual' | null
    log: [],
    error: null,
    photo: null,             // { previewUrl, jpegDataUrl, width, height } | null
  },
  population: null,          // mirrors state.population for the DOM contract (§7)
  debug: {
    renderGenome: function (genome, canvas) {
      window.Genome.renderGenome(canvas, genome);
    },
  },
  set: function (patch) {
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        App.state[key] = patch[key];
      }
    }
    App.population = App.state.population;
    render();
  },
};

// ─── DOM refs ───

var appEl = document.getElementById('app');
var probesEl = document.getElementById('probes');

// ─── Helpers ───

/* colour tokens are read via pen.js's own global `tok(name, fallback)` /
   `toks(prefix, n)` (declared `const` at top level in pen.js) – app.js must
   not redeclare `tok`, that collides as a duplicate lexical binding. */

function clearEl(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
  }
  if (children) {
    for (var i = 0; i < children.length; i++) {
      if (children[i]) node.appendChild(children[i]);
    }
  }
  return node;
}

/* readPhotoFile(file) -> Promise<{previewUrl, jpegDataUrl, width, height}>
   Decodes via createImageBitmap (EXIF orientation respected by the browser),
   downscales so max dimension = MAX_PHOTO_DIM, exports a JPEG. Rejects with
   a short user-facing message on broken/oversized/non-image files. */
function readPhotoFile(file) {
  return new Promise(function (resolve, reject) {
    if (!file) { reject(new Error('No file selected.')); return; }
    if (file.type && file.type.indexOf('image/') !== 0) {
      reject(new Error('That is not an image file.'));
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      reject(new Error('Image is too large (max 20 MB).'));
      return;
    }
    createImageBitmap(file).then(function (bitmap) {
      var scale = Math.min(1, MAX_PHOTO_DIM / Math.max(bitmap.width, bitmap.height));
      var w = Math.max(1, Math.round(bitmap.width * scale));
      var h = Math.max(1, Math.round(bitmap.height * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      var jpegDataUrl = canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY);
      resolve({ previewUrl: jpegDataUrl, jpegDataUrl: jpegDataUrl, width: w, height: h });
    }).catch(function () {
      reject(new Error('Could not read that image – it may be corrupt or unsupported.'));
    });
  });
}

/* buildGridJpeg(population) -> JPEG data URL. 3x3 composite of the current
   population, each cell ~300px, a big "1"-"9" corner badge, colours read
   live from the CSS tokens (never hardcoded). Sent to vision APIs in a
   later task. */
function buildGridJpeg(population) {
  var paper = tok('--paper');
  var ink = tok('--ink');
  var line = tok('--line-2');

  var composite = document.createElement('canvas');
  composite.width = COMPOSITE_CELL_W * 3;
  composite.height = COMPOSITE_CELL_H * 3;
  var ctx = composite.getContext('2d');
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, composite.width, composite.height);

  var cellCanvas = document.createElement('canvas');
  cellCanvas.width = COMPOSITE_CELL_W;
  cellCanvas.height = COMPOSITE_CELL_H;

  for (var i = 0; i < population.length; i++) {
    var row = Math.floor(i / 3), col = i % 3;
    var x = col * COMPOSITE_CELL_W, y = row * COMPOSITE_CELL_H;
    window.Genome.renderGenome(cellCanvas, population[i]);
    ctx.drawImage(cellCanvas, x, y);

    // corner badge: paper-filled circle, ink border and number
    var badgeR = COMPOSITE_CELL_W * 0.09;
    var bx = x + badgeR + 10, by = y + badgeR + 10;
    ctx.beginPath();
    ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
    ctx.fillStyle = paper;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ink;
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = 'bold ' + Math.round(badgeR * 1.15) + 'px ' + (tok('--font-mono') || 'monospace');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), bx, by + 1);

    // cell border for legibility in the composite
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, COMPOSITE_CELL_W - 1, COMPOSITE_CELL_H - 1);
  }

  return composite.toDataURL('image/jpeg', 0.85);
}

function appendLog(gen, best, source, detail) {
  var entry = { gen: gen, best: best, source: source, detail: detail || '' };
  App.set({ log: App.state.log.concat([entry]) });
}

// ─── Render ───

function render() {
  var s = App.state;
  appEl.setAttribute('data-state', s.state);
  appEl.setAttribute('data-phase', s.phase || '');
  appEl.setAttribute('data-provider', s.provider);

  clearEl(appEl);
  appEl.appendChild(renderLeftColumn(s));
  appEl.appendChild(renderCenterColumn(s));
  appEl.appendChild(renderRightColumn(s));
}

function renderLeftColumn(s) {
  var col = el('div', { class: 'col-left' });

  // ── upload zone ──
  var panel = el('div', { class: 'panel' });
  panel.appendChild(el('h2', { text: 'Photo' }));

  var zone = el('div', {
    class: 'dropzone',
    tabindex: '0',
    role: 'button',
    'aria-label': 'Upload a photo: click, drag a file here, or paste',
  });
  zone.textContent = 'Click, drag a photo here, or paste (Ctrl/Cmd+V)';
  var fileInput = el('input', { type: 'file', accept: 'image/*' });
  zone.appendChild(fileInput);

  zone.addEventListener('click', function () { fileInput.click(); });
  zone.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); }
  });
  zone.addEventListener('dragover', function (ev) { ev.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', function () { zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', function (ev) {
    ev.preventDefault();
    zone.classList.remove('drag-over');
    var file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (file) handlePhotoFile(file);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) handlePhotoFile(fileInput.files[0]);
  });

  panel.appendChild(zone);

  if (s.error) {
    panel.appendChild(el('p', { class: 'dropzone-error', text: s.error }));
  }

  if (s.photo) {
    var preview = el('div', { class: 'photo-preview' });
    var img = el('img', { alt: 'Uploaded photo preview' });
    img.src = s.photo.previewUrl;
    preview.appendChild(img);
    panel.appendChild(preview);
  }

  col.appendChild(panel);

  // ── settings panel (placeholder; real settings land in Task 6) ──
  var settings = el('div', { class: 'panel' });
  settings.appendChild(el('h2', { text: 'Settings' }));
  settings.appendChild(el('p', {
    class: 'settings-placeholder',
    text: 'Provider: ' + s.provider + ' (selector and API keys arrive in a later task).',
  }));
  col.appendChild(settings);

  return col;
}

function renderCenterColumn(s) {
  var col = el('div', { class: 'col-center' });

  // ── controls bar ──
  var bar = el('div', { class: 'controls-bar panel' });

  var startBtn = el('button', { class: 'edu-btn', type: 'button', text: 'Start' });
  startBtn.disabled = s.state !== 'ready';
  startBtn.addEventListener('click', onStartClick);

  var pauseLabel = s.phase === 'paused' ? 'Resume' : 'Pause';
  var pauseBtn = el('button', { class: 'edu-btn ghost', type: 'button', text: pauseLabel });
  pauseBtn.disabled = s.state !== 'running' || (s.phase !== 'reviewing' && s.phase !== 'paused');
  pauseBtn.addEventListener('click', onPauseResumeClick);

  var stopBtn = el('button', { class: 'edu-btn ghost', type: 'button', text: 'Stop' });
  stopBtn.disabled = s.state !== 'running';
  stopBtn.addEventListener('click', onStopClick);

  var progress = el('span', {
    class: 'progress-placeholder',
    text: 'Generation ' + (s.generation || 0) + ' / ' + TOTAL_GENERATIONS,
  });

  bar.appendChild(startBtn);
  bar.appendChild(pauseBtn);
  bar.appendChild(stopBtn);
  bar.appendChild(progress);
  col.appendChild(bar);

  // ── grid ──
  var gridPanel = el('div', { class: 'panel' });
  var grid = el('div', { id: 'grid' });
  grid.setAttribute('data-generation', String(s.generation || 0));
  grid.setAttribute('data-winner', s.winner ? String(s.winner) : '');
  grid.setAttribute('data-winner-source', s.winnerSource || '');

  if (s.population) {
    for (var i = 0; i < s.population.length; i++) {
      grid.appendChild(renderCell(s, i));
    }
  } else {
    grid.appendChild(el('p', { text: 'Upload a photo and press Start to generate the first candidates.' }));
  }
  gridPanel.appendChild(grid);
  col.appendChild(gridPanel);

  return col;
}

function renderCell(s, i) {
  var index = i + 1;
  var genome = s.population[i];
  var hash = window.Genome.genomeHash(genome);
  var cell = el('div', {
    class: 'cell' + (s.winner === index ? ' is-winner' : ''),
    'data-index': String(index),
    'data-genome-hash': hash,
    tabindex: '0',
    role: 'button',
    'aria-label': 'Candidate ' + index,
  });
  var canvas = document.createElement('canvas');
  canvas.width = CELL_W; canvas.height = CELL_H;
  window.Genome.renderGenome(canvas, genome);
  cell.appendChild(canvas);
  cell.appendChild(el('span', { class: 'cell-badge', text: String(index) }));

  cell.addEventListener('click', function () { onCellPick(index); });
  cell.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onCellPick(index); }
  });

  return cell;
}

function renderRightColumn(s) {
  var col = el('div', { class: 'col-right' });
  var panel = el('div', { class: 'panel' });
  panel.appendChild(el('h2', { text: 'Log' }));
  var log = el('div', { id: 'log', 'aria-live': 'polite' });
  s.log.forEach(function (entry) {
    var line = el('div', {
      class: 'log-entry',
      'data-gen': String(entry.gen),
      'data-best': String(entry.best),
      'data-source': entry.source,
    });
    line.textContent = 'Gen ' + entry.gen + ' – best ' + entry.best + ' (' + entry.source + ')' +
      (entry.detail ? ' – ' + entry.detail : '');
    log.appendChild(line);
  });
  panel.appendChild(log);
  col.appendChild(panel);
  return col;
}

// ─── Listeners (event handlers referenced above) ───

function handlePhotoFile(file) {
  readPhotoFile(file).then(function (photo) {
    App.set({ state: 'ready', error: null, photo: photo });
  }).catch(function (err) {
    App.set({ error: err.message, state: 'idle', photo: null });
  });
}

function onStartClick() {
  if (App.state.state !== 'ready') return;
  var population = window.Genome.initialPopulation(Math.random);
  App.set({
    state: 'running',
    phase: 'reviewing',
    generation: 1,
    population: population,
    winner: null,
    winnerSource: null,
  });
}

function onPauseResumeClick() {
  var s = App.state;
  if (s.state !== 'running') return;
  if (s.phase === 'paused') App.set({ phase: 'reviewing' });
  else if (s.phase === 'reviewing') App.set({ phase: 'paused' });
}

function onStopClick() {
  if (App.state.state !== 'running') return;
  // Task 4 skeleton: Stop aborts the run and returns to ready. The full
  // "finish now with current best" -> done transition lands in Task 5.
  App.set({ state: 'ready', phase: null, population: null, generation: 0, winner: null, winnerSource: null });
}

function onCellPick(index) {
  var s = App.state;
  if (s.state !== 'running' || s.phase !== 'reviewing') return;
  App.set({ winner: index, winnerSource: 'manual' });
  appendLog(s.generation, index, 'manual', 'override');
}

// ─── Init ───

(function init() {
  // global paste intake: works anywhere on the page, not only when the
  // dropzone has focus (§5 idle: file input + drag-drop + paste)
  window.addEventListener('paste', function (ev) {
    if (App.state.state === 'running' || App.state.state === 'done') return;
    var items = (ev.clipboardData && ev.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        handlePhotoFile(items[i].getAsFile());
        break;
      }
    }
  });

  if (/[?&]debug=1\b/.test(window.location.search)) {
    var script = document.createElement('script');
    script.src = 'probes.js';
    script.onload = function () {
      var results = window.Probes.run();
      probesEl.style.display = '';
      clearEl(probesEl);
      var heading = el('h2', { text: 'Probes' });
      var list = el('div', { class: 'probe-list' });
      results.forEach(function (r) {
        var row = el('div', { class: 'probe-row', 'data-pass': r.pass ? 'true' : 'false' });
        row.textContent = (r.pass ? 'PASS' : 'FAIL') + ' – ' + r.name + ' – ' + r.detail;
        list.appendChild(row);
      });
      probesEl.appendChild(heading);
      probesEl.appendChild(list);
      probesEl.setAttribute('data-pass', results.every(function (r) { return r.pass; }) ? 'true' : 'false');
    };
    document.body.appendChild(script);
  }

  render();
})();

// ─── Namespace ───

window.App = App; // the one intentional escape from this IIFE's scope

})();

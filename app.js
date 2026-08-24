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
var MAX_GENERATIONS = 10;
var REVIEW_MS = 3500;                    // reviewing phase: auto-advance once a winner exists
var COMPOSITE_GAP = 24;                  // px gap between photo and portrait in the done composite

// ─── Constants: AI judge (Task 6, spec §4) ───

var PROVIDERS = ['gemini', 'openai', 'claude'];
var PROVIDER_LABELS = { gemini: 'Gemini', openai: 'OpenAI', claude: 'Claude' };
var MODELS = { gemini: 'gemini-2.5-flash', openai: 'gpt-4o', claude: 'claude-sonnet-5' };
var JUDGE_RETRY_MS = 1500;               // judge failure path (spec §6): retry once after this delay
var MAX_HINTS_REQUESTED = 4;             // prompt-side cap; the sanitizer itself does not truncate the list

/* trait vocabulary the prompt hands the model, read straight off Genome.HINT_MAP's
   keys so the prompt, the sanitizer (genome.js) and hintsToGenes() can never drift apart. */
var TRAIT_LIST = Object.keys(window.Genome.HINT_MAP);

var JUDGE_PROMPT = 'You are comparing a reference photo (the first image) to a 3x3 grid of 9 ' +
  'hand-drawn sketch portraits (the second image; each cell has a number 1-9 in a badge in its ' +
  'corner). Pick the single sketch whose age, gender presentation, hair, glasses, facial hair and ' +
  'overall vibe best match the person in the photo. Then give at most ' + MAX_HINTS_REQUESTED +
  ' hints for how the next generation of sketches could look more like the person, using ONLY ' +
  'these trait names: ' + TRAIT_LIST.join(', ') + '. ' +
  'Respond with ONLY this JSON object and nothing else - no markdown fencing, no commentary: ' +
  '{ "best": <integer 1-9>, "hints": [ { "trait": "<one of the trait names above>", ' +
  '"suggestion": "<short phrase>" } ] }';

// ─── State ───

var initialSettings = loadSettings(); // localStorage['draw.settings'] + ['draw.keys'], sane defaults on any failure

var App = {
  state: {
    state: 'idle',        // idle | ready | running | done
    phase: null,           // null | drawing | judging | reviewing | paused
    provider: initialSettings.provider,   // 'gemini' | 'openai' | 'claude'
    models: initialSettings.models,       // { gemini, openai, claude } model name text
    keys: initialSettings.keys,           // { gemini, openai, claude } API key text – never logged
    settingsHighlight: false,             // true right after a blocked Start (missing key)
    settingsError: null,                  // message shown in the settings panel
    runError: null,                       // judge-failure message shown while phase === 'paused'
    generation: 0,
    population: null,      // array of 9 genomes, current generation
    winner: null,           // 1-9 or null
    winnerSource: null,     // 'ai' | 'manual' | null
    winnerHints: [],         // [{trait, suggestion}] from the AI judge that picked winner (kept across a manual override)
    log: [],
    error: null,
    photo: null,             // { previewUrl, jpegDataUrl, width, height } | null
    doneGenome: null,        // final winner genome, set on state 'done'
    portraitDataUrl: null,   // 2x-rendered final portrait PNG, set on state 'done'
    compositeDataUrl: null,  // photo+portrait side-by-side PNG, built async on state 'done'
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

/* review timer bookkeeping – runtime-only, not part of App.state (nothing here is
   meant to be serializable or rendered from); kept as plain closure vars so the
   timer can never leak across an App.set() re-render. */
var reviewTimerId = null;
var reviewDeadline = null;     // Date.now() timestamp the timer will fire at, or null
var reviewRemainingMs = null;  // ms left when Pause froze a running timer, or null

/* judge retry timer (spec §6) – same "runtime-only, not App.state" reasoning as the
   review timer above: a plain closure var so it can never leak across a re-render,
   and is explicitly cleared by finishRun() so Stop can never let a stale retry fire. */
var judgeRetryTimerId = null;

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

// ─── Helpers: settings persistence (spec §4.4) ───

/* loadSettings() -> { provider, models, keys }, read from localStorage['draw.settings']
   (provider + models) and localStorage['draw.keys'] (JSON object of key strings per
   provider). Tolerant of missing/corrupt storage or a disabled localStorage – always
   returns a complete, valid object built from MODELS defaults. Never throws, never logs
   the key values it finds. */
function loadSettings() {
  var provider = 'gemini';
  var models = { gemini: MODELS.gemini, openai: MODELS.openai, claude: MODELS.claude };
  var keys = { gemini: '', openai: '', claude: '' };
  try {
    var rawSettings = window.localStorage.getItem('draw.settings');
    if (rawSettings) {
      var parsedSettings = JSON.parse(rawSettings);
      if (parsedSettings && typeof parsedSettings === 'object') {
        if (PROVIDERS.indexOf(parsedSettings.provider) >= 0) provider = parsedSettings.provider;
        if (parsedSettings.models && typeof parsedSettings.models === 'object') {
          PROVIDERS.forEach(function (p) {
            if (typeof parsedSettings.models[p] === 'string' && parsedSettings.models[p]) {
              models[p] = parsedSettings.models[p];
            }
          });
        }
      }
    }
    var rawKeys = window.localStorage.getItem('draw.keys');
    if (rawKeys) {
      var parsedKeys = JSON.parse(rawKeys);
      if (parsedKeys && typeof parsedKeys === 'object') {
        PROVIDERS.forEach(function (p) {
          if (typeof parsedKeys[p] === 'string') keys[p] = parsedKeys[p];
        });
      }
    }
  } catch (e) {
    // corrupt JSON or localStorage unavailable – fall back to the defaults above
  }
  return { provider: provider, models: models, keys: keys };
}

function saveSettings() {
  try {
    window.localStorage.setItem('draw.settings', JSON.stringify({
      provider: App.state.provider,
      models: App.state.models,
    }));
  } catch (e) {
    // storage full/unavailable – settings just won't persist across reload
  }
}

function saveKeys() {
  try {
    window.localStorage.setItem('draw.keys', JSON.stringify(App.state.keys));
  } catch (e) {
    // storage full/unavailable – keys just won't persist across reload
  }
}

function hasKey(provider) {
  var key = App.state.keys[provider];
  return typeof key === 'string' && key.trim().length > 0;
}

// ─── Helpers: AI judge adapters (spec §4.4) ───

function dataUrlToBase64(dataUrl) {
  var i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

/* judge(provider, model, key, photoDataUrl, gridDataUrl) -> Promise<string> (raw model
   text). One adapter per provider behind this single interface; every adapter rejects
   with a short, non-key-leaking Error on a non-2xx response or an unreadable body. */
function judge(provider, model, key, photoDataUrl, gridDataUrl) {
  if (provider === 'gemini') return judgeGemini(model, key, photoDataUrl, gridDataUrl);
  if (provider === 'openai') return judgeOpenAI(model, key, photoDataUrl, gridDataUrl);
  if (provider === 'claude') return judgeClaude(model, key, photoDataUrl, gridDataUrl);
  return Promise.reject(new Error('Unknown provider: ' + provider));
}

function judgeGemini(model, key, photoDataUrl, gridDataUrl) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent';
  var body = {
    contents: [{
      parts: [
        { text: JUDGE_PROMPT },
        { inline_data: { mime_type: 'image/jpeg', data: dataUrlToBase64(photoDataUrl) } },
        { inline_data: { mime_type: 'image/jpeg', data: dataUrlToBase64(gridDataUrl) } },
      ],
    }],
  };
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) {
        throw new Error('Gemini request failed (' + res.status + '): ' + t.slice(0, 200));
      });
    }
    return res.json();
  }).then(function (data) {
    var parts = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts;
    var text = parts && parts[0] && parts[0].text;
    if (typeof text !== 'string') throw new Error('Gemini reply had no text.');
    return text;
  });
}

function judgeOpenAI(model, key, photoDataUrl, gridDataUrl) {
  var url = 'https://api.openai.com/v1/chat/completions';
  var body = {
    model: model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: JUDGE_PROMPT },
        { type: 'image_url', image_url: { url: photoDataUrl } },
        { type: 'image_url', image_url: { url: gridDataUrl } },
      ],
    }],
  };
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body),
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) {
        throw new Error('OpenAI request failed (' + res.status + '): ' + t.slice(0, 200));
      });
    }
    return res.json();
  }).then(function (data) {
    var text = data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content;
    if (typeof text !== 'string') throw new Error('OpenAI reply had no text.');
    return text;
  });
}

function judgeClaude(model, key, photoDataUrl, gridDataUrl) {
  var url = 'https://api.anthropic.com/v1/messages';
  var body = {
    model: model,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: JUDGE_PROMPT },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrlToBase64(photoDataUrl) } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrlToBase64(gridDataUrl) } },
      ],
    }],
  };
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) {
        throw new Error('Claude request failed (' + res.status + '): ' + t.slice(0, 200));
      });
    }
    return res.json();
  }).then(function (data) {
    var text = data && data.content && data.content[0] && data.content[0].text;
    if (typeof text !== 'string') throw new Error('Claude reply had no text.');
    return text;
  });
}

/* makeLogEntry(gen, best, source, hints, detail) – pure, does not touch state; callers
   combine the returned entry into the same App.set() that also advances the run, so a
   generation's log line and its state transition land in a single re-render. */
function makeLogEntry(gen, best, source, hints, detail) {
  return { gen: gen, best: best, source: source, hints: hints || [], detail: detail || '' };
}

// ─── Helpers: review timer (drives REVIEW_MS auto-advance; Pause/Resume freezes it) ───

function clearReviewTimer() {
  if (reviewTimerId !== null) { window.clearTimeout(reviewTimerId); reviewTimerId = null; }
  reviewDeadline = null;
}

/* startReviewTimer(ms) – (re)starts the auto-advance countdown from `ms` (defaults to
   the full REVIEW_MS window). Called whenever a winner is (re)picked, and by Resume
   with whatever time Pause had left. */
function startReviewTimer(ms) {
  clearReviewTimer();
  var wait = ms === undefined ? REVIEW_MS : ms;
  reviewDeadline = Date.now() + wait;
  reviewTimerId = window.setTimeout(advanceGeneration, wait);
}

// ─── Helpers: judge retry timer (spec §6) ───

function clearJudgeRetryTimer() {
  if (judgeRetryTimerId !== null) { window.clearTimeout(judgeRetryTimerId); judgeRetryTimerId = null; }
}

// ─── Helpers: GA loop ───

/* beginJudging() – enters phase 'judging' for the population already in state and
   fires the first judge attempt. Called right after Start builds generation 1, and
   again by advanceGeneration() after building each following generation. */
function beginJudging() {
  App.set({ phase: 'judging', runError: null });
  runJudge(0);
}

/* runJudge(attempt) – calls the configured provider's adapter, sanitizes the reply,
   and on success sets the AI's pick (source 'ai') with its hints, then starts the
   review timer. attempt is 0 for the first try, 1 for the single retry (spec §6).
   Every branch re-checks App.state.phase === 'judging' before touching state, so a
   Stop/Pause/New-photo that raced ahead of a slow network response is a silent no-op
   instead of clobbering whatever the user already moved on to. */
function runJudge(attempt) {
  var s = App.state;
  var provider = s.provider;
  var model = s.models[provider];
  var key = s.keys[provider];
  var gridJpeg = buildGridJpeg(s.population);
  var photoJpeg = s.photo.jpegDataUrl;

  judge(provider, model, key, photoJpeg, gridJpeg).then(function (text) {
    if (App.state.phase !== 'judging') return; // raced by Stop/Pause/reset – drop it
    var parsed = window.Genome.sanitizeJudgeReply(text);
    if (!parsed) {
      handleJudgeFailure(attempt, 'The judge reply could not be understood.');
      return;
    }
    App.set({
      winner: parsed.best,
      winnerSource: 'ai',
      winnerHints: parsed.hints,
      phase: 'reviewing',
      runError: null,
    });
    startReviewTimer();
  }).catch(function (err) {
    if (App.state.phase !== 'judging') return; // raced by Stop/Pause/reset – drop it
    handleJudgeFailure(attempt, (err && err.message) ? err.message : 'The judge request failed.');
  });
}

/* handleJudgeFailure(attempt, message) (spec §6): attempt 0 schedules the single
   retry after JUDGE_RETRY_MS; attempt 1 (the retry itself failed too) enters
   'paused' with the message so the run keeps going manually. */
function handleJudgeFailure(attempt, message) {
  if (attempt === 0) {
    judgeRetryTimerId = window.setTimeout(function () {
      judgeRetryTimerId = null;
      if (App.state.phase === 'judging') runJudge(1);
    }, JUDGE_RETRY_MS);
    return;
  }
  App.set({ phase: 'paused', runError: message + ' Pick manually to continue.' });
}

/* buildPortraitCanvas(genome) -> canvas rendered at 2x cell resolution. renderGenome
   scales its strokes to the canvas it is given, so a bigger canvas re-renders sharper
   strokes rather than upscaling pixels of a smaller render. */
function buildPortraitCanvas(genome) {
  var canvas = document.createElement('canvas');
  canvas.width = CELL_W * 2;
  canvas.height = CELL_H * 2;
  window.Genome.renderGenome(canvas, genome);
  return canvas;
}

/* buildComposite(photo, portraitCanvas, callback) – async (Image decode): photo left,
   portrait right, equal heights, paper background from tokens read at call time.
   callback(dataUrl) fires once, with null if the stored photo data URL fails to decode
   (the portrait download still works on its own in that case). */
function buildComposite(photo, portraitCanvas, callback) {
  var paper = tok('--paper');
  var img = new Image();
  img.onload = function () {
    var targetH = portraitCanvas.height;
    var photoW = Math.max(1, Math.round(img.width * (targetH / img.height)));
    var composite = document.createElement('canvas');
    composite.width = photoW + COMPOSITE_GAP + portraitCanvas.width;
    composite.height = targetH;
    var ctx = composite.getContext('2d');
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, composite.width, composite.height);
    ctx.drawImage(img, 0, 0, photoW, targetH);
    ctx.drawImage(portraitCanvas, photoW + COMPOSITE_GAP, 0);
    callback(composite.toDataURL('image/png'));
  };
  img.onerror = function () { callback(null); };
  img.src = photo.jpegDataUrl;
}

/* finishRun(winnerIndex, entry) – common end of the run for both "gen 10 done" and
   "Stop pressed early": clears the timer, renders the 2x portrait, appends the final
   log entry, flips state to 'done', then builds the side-by-side composite async. */
function finishRun(winnerIndex, entry) {
  clearReviewTimer();
  clearJudgeRetryTimer(); // a judge retry must never fire after the run has already ended
  var s = App.state;
  var genome = s.population[winnerIndex - 1];
  var portraitCanvas = buildPortraitCanvas(genome);
  var portraitDataUrl = portraitCanvas.toDataURL('image/png');

  App.set({
    state: 'done',
    phase: null,
    winner: winnerIndex,
    winnerSource: entry.source,
    doneGenome: genome,
    portraitDataUrl: portraitDataUrl,
    compositeDataUrl: null,
    runError: null,
    log: s.log.concat([entry]),
  });

  buildComposite(App.state.photo, portraitCanvas, function (compositeDataUrl) {
    if (App.state.state !== 'done') return; // Start over / New photo raced ahead – drop it
    App.set({ compositeDataUrl: compositeDataUrl });
  });
}

/* advanceGeneration() – the winner becomes cell 1 (exact elite copy) of generation g+1;
   cells 2-9 are Genome._internal.nextPopulation's mutants. Fires on REVIEW_MS timeout
   or an immediate 'enter'. At MAX_GENERATIONS the run ends instead of building g+1. */
function advanceGeneration() {
  var s = App.state;
  if (s.state !== 'running' || s.phase !== 'reviewing' || !s.winner) return;
  clearReviewTimer();

  var winnerIndex = s.winner;
  var winnerGenome = s.population[winnerIndex - 1];
  var hints = s.winnerHints || [];
  var entry = makeLogEntry(s.generation, winnerIndex, s.winnerSource || 'manual', hints);

  if (s.generation >= MAX_GENERATIONS) {
    finishRun(winnerIndex, entry);
    return;
  }

  var nextGen = s.generation + 1;
  var hintedGenes = window.Genome.hintsToGenes(hints); // §4.2: winner's hints boost these genes in the mutants below
  var nextPopulation = window.Genome._internal.nextPopulation(winnerGenome, nextGen, hintedGenes, Math.random);
  App.set({
    generation: nextGen,
    population: nextPopulation,
    winner: null,
    winnerSource: null,
    winnerHints: [],
    phase: 'drawing',
    log: s.log.concat([entry]),
  });
  beginJudging();
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

  col.appendChild(renderSettingsPanel(s));

  return col;
}

/* renderSettingsPanel(s) – provider select, that provider's model + key inputs
   (prefilled from MODELS / localStorage), a "keys stay in this browser" note, and
   (when Start was just blocked for a missing key) a highlighted border + message. */
function renderSettingsPanel(s) {
  var panel = el('div', {
    class: 'panel settings-panel' + (s.settingsHighlight ? ' is-highlighted' : ''),
  });
  panel.appendChild(el('h2', { text: 'Settings' }));

  var providerRow = el('div', { class: 'settings-row' });
  providerRow.appendChild(el('label', { for: 'settings-provider', text: 'Provider' }));
  var select = el('select', { id: 'settings-provider' });
  PROVIDERS.forEach(function (p) {
    var opt = el('option', { value: p, text: PROVIDER_LABELS[p] });
    if (p === s.provider) opt.setAttribute('selected', 'selected');
    select.appendChild(opt);
  });
  select.addEventListener('change', function () { onProviderChange(select.value); });
  providerRow.appendChild(select);
  panel.appendChild(providerRow);

  var modelRow = el('div', { class: 'settings-row' });
  modelRow.appendChild(el('label', { for: 'settings-model', text: 'Model' }));
  var modelInput = el('input', { id: 'settings-model', type: 'text', autocomplete: 'off' });
  modelInput.value = s.models[s.provider];
  modelInput.addEventListener('change', function () { onModelChange(modelInput.value); });
  modelRow.appendChild(modelInput);
  panel.appendChild(modelRow);

  var keyRow = el('div', { class: 'settings-row' });
  keyRow.appendChild(el('label', { for: 'settings-key', text: PROVIDER_LABELS[s.provider] + ' API key' }));
  var keyInput = el('input', {
    id: 'settings-key', type: 'password', autocomplete: 'off', spellcheck: 'false',
  });
  keyInput.value = s.keys[s.provider];
  keyInput.addEventListener('change', function () { onKeyChange(keyInput.value); });
  keyRow.appendChild(keyInput);
  panel.appendChild(keyRow);

  panel.appendChild(el('p', {
    class: 'settings-note',
    text: 'Keys stay in this browser (saved to localStorage) and are sent only to the selected provider.',
  }));

  if (s.settingsError) {
    panel.appendChild(el('p', { class: 'settings-error', text: s.settingsError }));
  }

  return panel;
}

function renderCenterColumn(s) {
  if (s.state === 'done') return renderDoneCenter(s);

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
    text: 'Generation ' + (s.generation || 0) + ' / ' + MAX_GENERATIONS,
  });

  var status = el('span', { class: 'review-status' });
  if (s.state === 'running') {
    if (s.phase === 'judging') {
      status.appendChild(el('span', { class: 'judging-indicator', 'aria-hidden': 'true' }));
      status.appendChild(document.createTextNode('Judge is looking at the grid…'));
    } else if (s.phase === 'paused') {
      status.textContent = s.runError ? s.runError : (s.winner ? 'Paused – press Resume to continue' : 'Paused – pick a candidate, then Resume');
    } else if (s.winner) {
      status.textContent = 'Winner picked' + (s.winnerSource === 'ai' ? ' by the judge' : '') +
        ' – advancing soon (press Enter now)';
    } else {
      status.textContent = 'Pick a candidate: click a cell or press 1-9';
    }
  }

  bar.appendChild(startBtn);
  bar.appendChild(pauseBtn);
  bar.appendChild(stopBtn);
  bar.appendChild(progress);
  bar.appendChild(status);
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

/* renderDoneCenter(s) – the done screen: 2x final portrait, side-by-side composite
   (photo left, portrait right, equal heights, paper background), both PNG downloads,
   Start over (same photo, fresh gen 1) and New photo (back to idle). */
function renderDoneCenter(s) {
  var col = el('div', { class: 'col-center' });
  var panel = el('div', { class: 'panel done-panel' });
  panel.appendChild(el('h2', { text: 'Done – generation ' + s.generation + ' of ' + MAX_GENERATIONS }));

  var portraitFig = el('figure', { class: 'done-portrait' });
  var portraitImg = el('img', { alt: 'Final evolved portrait' });
  portraitImg.src = s.portraitDataUrl;
  portraitFig.appendChild(portraitImg);
  portraitFig.appendChild(el('figcaption', { text: 'Final portrait (2x)' }));
  panel.appendChild(portraitFig);

  var compFig = el('figure', { class: 'done-composite' });
  if (s.compositeDataUrl) {
    var compImg = el('img', { alt: 'Photo and final portrait side by side' });
    compImg.src = s.compositeDataUrl;
    compFig.appendChild(compImg);
    compFig.appendChild(el('figcaption', { text: 'Photo vs. portrait' }));
  } else {
    compFig.appendChild(el('p', { class: 'done-status', text: 'Building side-by-side composite…' }));
  }
  panel.appendChild(compFig);

  var actions = el('div', { class: 'done-actions' });

  var portraitLink = el('a', {
    class: 'edu-btn', download: 'likeness-portrait.png', text: 'Download portrait PNG',
  });
  portraitLink.href = s.portraitDataUrl;
  actions.appendChild(portraitLink);

  var compositeLink = el('a', {
    class: 'edu-btn ghost', download: 'likeness-side-by-side.png', text: 'Download side-by-side PNG',
  });
  if (s.compositeDataUrl) {
    compositeLink.href = s.compositeDataUrl;
  } else {
    compositeLink.classList.add('is-disabled');
    compositeLink.setAttribute('aria-disabled', 'true');
  }
  actions.appendChild(compositeLink);

  var startOverBtn = el('button', { class: 'edu-btn ghost', type: 'button', text: 'Start over' });
  startOverBtn.addEventListener('click', onStartOverClick);
  actions.appendChild(startOverBtn);

  var newPhotoBtn = el('button', { class: 'edu-btn ghost', type: 'button', text: 'New photo' });
  newPhotoBtn.addEventListener('click', onNewPhotoClick);
  actions.appendChild(newPhotoBtn);

  panel.appendChild(actions);
  col.appendChild(panel);
  return col;
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
      'data-hints': String((entry.hints || []).length),
    });
    var hintsText = entry.hints && entry.hints.length
      ? entry.hints.map(function (h) { return h.trait + ': ' + h.suggestion; }).join(', ')
      : 'none';
    /* textContent only – never innerHTML – so a malformed/adversarial hint suggestion
       (already truncated + trait-filtered by the sanitizer) can never inject markup. */
    line.textContent = 'Gen ' + entry.gen + ' – best ' + entry.best + ' (' + entry.source + ')' +
      ' – hints: ' + hintsText + (entry.detail ? ' – ' + entry.detail : '');
    log.appendChild(line);
  });
  panel.appendChild(log);
  col.appendChild(panel);
  return col;
}

// ─── Listeners (event handlers referenced above) ───

function handlePhotoFile(file) {
  // photo intake is only meaningful before/between runs – ignore accidental
  // drops/pastes/clicks on the (still-present) upload zone mid-run or on the done screen
  if (App.state.state === 'running' || App.state.state === 'done') return;
  readPhotoFile(file).then(function (photo) {
    App.set({ state: 'ready', error: null, photo: photo });
  }).catch(function (err) {
    App.set({ error: err.message, state: 'idle', photo: null });
  });
}

function onStartClick() {
  if (App.state.state !== 'ready') return;
  var provider = App.state.provider;
  if (!hasKey(provider)) {
    App.set({
      settingsHighlight: true,
      settingsError: 'Add an API key for ' + PROVIDER_LABELS[provider] + ' to start a run.',
    });
    return;
  }
  var population = window.Genome.initialPopulation(Math.random);
  App.set({
    state: 'running',
    phase: 'drawing',
    generation: 1,
    population: population,
    winner: null,
    winnerSource: null,
    winnerHints: [],
    runError: null,
    settingsHighlight: false,
    settingsError: null,
  });
  beginJudging();
}

function onPauseResumeClick() {
  var s = App.state;
  if (s.state !== 'running') return;
  if (s.phase === 'paused') {
    var resumeMs = reviewRemainingMs;
    reviewRemainingMs = null;
    if (s.winner) startReviewTimer(resumeMs === null ? undefined : resumeMs);
    App.set({ phase: 'reviewing', runError: null });
  } else if (s.phase === 'reviewing') {
    if (s.winner && reviewTimerId !== null) {
      reviewRemainingMs = Math.max(0, reviewDeadline - Date.now());
      clearReviewTimer();
    }
    App.set({ phase: 'paused' });
  }
}

function onStopClick() {
  var s = App.state;
  if (s.state !== 'running') return;
  var winnerIndex = s.winner || 1; // no pick yet: fall back to cell 1 as "current best"
  var source = s.winner ? (s.winnerSource || 'manual') : 'manual';
  var hints = s.winner ? (s.winnerHints || []) : [];
  var entry = makeLogEntry(s.generation, winnerIndex, source, hints,
    s.winner ? 'stopped' : 'stopped before a pick – used cell 1');
  finishRun(winnerIndex, entry);
}

function onCellPick(index) {
  var s = App.state;
  // pickable while actively reviewing an AI/manual pick, and while paused (spec §6:
  // a judge failure pauses the run and waits for exactly this manual pick + Resume)
  if (s.state !== 'running' || (s.phase !== 'reviewing' && s.phase !== 'paused')) return;
  if (!s.population || index < 1 || index > s.population.length) return;
  // overriding a pick keeps whatever hints the AI already produced this generation –
  // only the winner + its source change, winnerHints is left untouched
  App.set({ winner: index, winnerSource: 'manual' });
  if (s.phase === 'reviewing') startReviewTimer(); // (re)start the full REVIEW_MS window on every pick, including overrides
}

function onStartOverClick() {
  // same photo, fresh gen 1: reuse the photo already in state, drop everything else,
  // then run the exact Start path so gen 1 gets a brand-new initialPopulation()
  clearReviewTimer();
  clearJudgeRetryTimer();
  reviewRemainingMs = null;
  App.set({
    state: 'ready', phase: null, population: null, generation: 0,
    winner: null, winnerSource: null, winnerHints: [], runError: null, log: [], error: null,
    doneGenome: null, portraitDataUrl: null, compositeDataUrl: null,
  });
  onStartClick();
}

function onNewPhotoClick() {
  clearReviewTimer();
  clearJudgeRetryTimer();
  reviewRemainingMs = null;
  App.set({
    state: 'idle', phase: null, population: null, generation: 0,
    winner: null, winnerSource: null, winnerHints: [], runError: null, log: [], error: null, photo: null,
    doneGenome: null, portraitDataUrl: null, compositeDataUrl: null,
  });
}

// ─── Listeners: settings panel ───

function onProviderChange(provider) {
  if (PROVIDERS.indexOf(provider) < 0) return;
  App.set({ provider: provider, settingsHighlight: false, settingsError: null });
  saveSettings();
}

function onModelChange(value) {
  var s = App.state;
  var models = {};
  for (var k in s.models) if (Object.prototype.hasOwnProperty.call(s.models, k)) models[k] = s.models[k];
  models[s.provider] = value;
  App.set({ models: models });
  saveSettings();
}

function onKeyChange(value) {
  var s = App.state;
  var keys = {};
  for (var k in s.keys) if (Object.prototype.hasOwnProperty.call(s.keys, k)) keys[k] = s.keys[k];
  keys[s.provider] = value;
  App.set({ keys: keys, settingsHighlight: false, settingsError: null });
  saveKeys(); // never logged – written straight to localStorage
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

  // keyboard: 1-9 pick a candidate, enter advances the review immediately once a
  // winner exists. Bound once here (not per-render) so listeners never pile up.
  window.addEventListener('keydown', function (ev) {
    var tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var s = App.state;
    if (s.state !== 'running' || (s.phase !== 'reviewing' && s.phase !== 'paused')) return;
    if (ev.key >= '1' && ev.key <= '9') {
      var idx = parseInt(ev.key, 10);
      if (s.population && idx <= s.population.length) {
        ev.preventDefault();
        onCellPick(idx);
      }
    } else if (ev.key === 'Enter') {
      if (s.winner) { ev.preventDefault(); advanceGeneration(); }
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

/* ============================================================
   APP – DrawMe UI. Classic script (no modules).
   Drives a plain state object; every UI change re-renders from state.
   Runs the full app: photo intake, the grid/state machine, the GA run loop
   (AI judging with retry/failure handling, elitism, mutation), the review
   countdown with Pause/Resume/Stop, run logging, and the done screen.

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

/* PROVIDERS/PROVIDER_LABELS are derived from ai-models.js's AI_MODEL_CATALOG
   (Task 9) so the provider list, labels, curated model lists, key metadata and
   discovery endpoint shape all live in one place. */
var PROVIDERS = Object.keys(window.AI_MODEL_CATALOG.providers);
var PROVIDER_LABELS = {};
PROVIDERS.forEach(function (p) { PROVIDER_LABELS[p] = window.AI_MODEL_CATALOG.providers[p].label; });
var JUDGE_RETRY_MS = 1500;               // judge failure path (spec §6): retry once after this delay

/* providerMap(valueFactory) -> { [providerId]: valueFactory() } for every provider in
   the catalog. Used to build per-provider bookkeeping objects (discovered models,
   discovery latch) without hardcoding the provider names a second time – they
   already live in PROVIDERS, itself derived from AI_MODEL_CATALOG. */
function providerMap(valueFactory) {
  var m = {};
  PROVIDERS.forEach(function (p) { m[p] = valueFactory(); });
  return m;
}
var MAX_HINTS_REQUESTED = 4;             // prompt-side cap; genome.js's sanitizer also truncates to this (MAX_SANITIZED_HINTS)

// ─── Constants: log thumbnails (Task 9) ───

var LOG_THUMB_W = 64, LOG_THUMB_H = 80;  // css px; backing canvas is device-pixel-ratio scaled

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

/* Task 13 auto-heal (point 1 of 3): a key stored under the wrong provider's slot
   (e.g. a Gemini key left under openai after a storage wipe + the new openai
   default) is moved to its matching slot – and the selected provider switched to
   match – BEFORE App.state is built, so the very first render and the Start gate
   both already see the corrected shape. window.AI_MODEL_CATALOG.healKeys is pure
   (see ai-models.js); persisting the result (if it actually healed something)
   happens once App/saveSettings/saveKeys exist, right below the App object. */
var initialHeal = window.AI_MODEL_CATALOG.healKeys(initialSettings);
initialSettings = initialHeal.settings;
/* Task 13 review fix: the load-time heal above used to happen silently – the
   provider select could flip to a different provider on page load with no
   explanation. Reuse settingsKeyNote (already rendered by renderSettingsPanel
   for the paste-time heal) so this one is explained too. PROVIDER_LABELS isn't
   built yet at this point in the file (it's derived from PROVIDERS below), so
   read the label straight off the catalog. */
var initialHealNote = initialHeal.healed ?
  'Moved your ' + window.AI_MODEL_CATALOG.providers[initialHeal.healed.to].label + ' key and switched provider.' :
  null;

var App = {
  state: {
    state: 'idle',        // idle | ready | running | done
    phase: null,           // null | drawing | judging | reviewing | paused
    provider: initialSettings.provider,   // 'gemini' | 'openai' | 'claude'
    models: initialSettings.models,       // { gemini, openai, claude } model name text
    keys: initialSettings.keys,           // { gemini, openai, claude } API key text – never logged
    discovered: providerMap(function () { return []; }), // Task 9: extra model IDs discovered per provider (non-curated only), runtime-only
    settingsModelCustomMode: false,       // Task 9 (review fix): true once the user has picked "Custom…" in the
                                           // model select, until a concrete model is chosen or the provider changes –
                                           // kept in state (not derived from s.models) so an unrelated re-render
                                           // (e.g. discovery resolving) can never silently snap the select back to
                                           // a curated value and hide the custom row out from under the user
    settingsHighlight: false,             // true right after a blocked Start (missing key)
    settingsError: null,                  // message shown in the settings panel
    settingsKeyNote: initialHealNote,     // Task 13: info note shown after a paste- or load-time auto-heal moved a key
    runError: null,                       // judge-failure message shown while phase === 'paused'
    generation: 0,
    population: null,      // array of 9 genomes, current generation
    winner: null,           // 1-9 or null
    winnerSource: null,     // 'ai' | 'manual' | null
    winnerHints: [],         // [{trait, suggestion}] from the AI judge that picked winner (kept across a manual override)
    currentBestGenome: null, // Phase 10: previous generation's picked winner genome; no grid cell is guaranteed to equal
                              // it any more (no exact elite), so this is the Stop-before-pick fallback (see onStopClick)
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

/* Task 13 auto-heal, persisted: if healKeys() above actually moved a key, write
   the corrected settings/keys back to localStorage immediately (before the first
   render) so the fix survives without the user having to touch anything, and a
   reload doesn't repeat work loadSettings()+healKeys() already made idempotent. */
if (initialHeal.healed) {
  saveSettings();
  saveKeys();
}

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

/* judgeEpoch – bumped every time judging begins for a (new or advanced) generation.
   A judge Promise/retry captures the epoch it was fired under; if judgeEpoch has moved
   on by the time it settles (Stop, New photo, Start-over, or a later generation already
   under way) the callback drops its result instead of writing a stale winner/hints into
   a run it no longer belongs to. The phase === 'judging' check alone isn't enough: Stop
   followed by a fresh Start also re-enters phase 'judging', which an epoch-less guard
   would let a straggling promise from the OLD run sail right through. */
var judgeEpoch = 0;

/* lastStartKeyWarning (Task 13, auto-heal point 3 of 3) – { provider, key } | null,
   the last mismatched-key combo Start already warned about and refused to start
   with. Runtime-only, not App.state (same reasoning as judgeEpoch above): it exists
   purely so a SECOND Start press with the exact same unchanged key proceeds anyway
   (patterns are heuristics, not proof – see onStartClick), and must never survive a
   reload or leak across an unrelated provider/key change, both of which reset it. */
var lastStartKeyWarning = null;

/* lastDiscoveryKey – per-provider bookkeeping for model discovery (Task 9), same
   "runtime-only, not App.state" reasoning as judgeEpoch above: a plain closure var
   so a repeated trigger (provider-change, key-change, init) never re-fires discovery
   for a key it has already fired for while that fetch is in flight or has already
   landed something no better than curated. Maps provider -> the exact key string
   discovery was last kicked off with (or null). The latch is cleared back to null
   (not left set) whenever the in-flight fetch's result turns out stale (provider/key
   moved on before it resolved) or doesn't improve on the curated list (a network
   failure included, since discoverProviderModels never rejects – see its own
   comment) – review fix: leaving it set in either case would permanently disable
   discovery for that provider until the key string itself changed, even after a
   transient failure. When discoverProviderModels resolves, the result is only
   applied if App.state.provider and App.state.keys[provider] still match what the
   fetch was fired for – the same stale-guard shape as judgeEpoch, just keyed on
   (provider, key) instead of an incrementing counter. */
var lastDiscoveryKey = providerMap(function () { return null; });

// ─── DOM refs ───

var appEl = document.getElementById('app');
var headerControlsEl = document.getElementById('header-controls');
var probesEl = document.getElementById('probes');
var liveEl = document.getElementById('live-announcer'); // sr-only aria-live region, outside #app so re-render never touches it

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

/* defaultModelFor(provider) -> that provider's catalog defaultModel if set, else its
   curated list's first entry. Used everywhere a default model is chosen: a fresh
   visitor's initial settings, the stored-settings migration target, and provider
   switch (see onProviderChange's initialization of a provider's model on first
   visit to it, via loadSettings' models map). */
function defaultModelFor(provider) {
  var info = window.AI_MODEL_CATALOG.providers[provider];
  return info.defaultModel ?? info.models[0];
}

/* RETIRED_MODELS (Task 12) – pre-catalog stored model values that predate the current
   curated lists. A stored per-provider model exactly matching its provider's entry
   here is a migration candidate (see loadSettings below), not a genuine custom model;
   any other non-curated stored value is left alone as a real custom entry. */
var RETIRED_MODELS = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o',
  claude: 'claude-opus-4-8',
};

/* loadSettings() -> { provider, models, keys }, read from localStorage['draw.settings']
   (provider + models) and localStorage['draw.keys'] (JSON object of key strings per
   provider). Tolerant of missing/corrupt storage or a disabled localStorage – always
   returns a complete, valid object built from MODELS defaults. Never throws, never logs
   the key values it finds.

   Task 12: also migrates a stored per-provider model that equals that provider's
   RETIRED_MODELS entry (a pre-catalog default that no longer exists in the curated
   list) to defaultModelFor(provider), and persists the migrated value back to
   localStorage so the migration only has to run once. Runs once per load, is
   idempotent (a second load of the same already-migrated value is not a RETIRED_MODELS
   match any more, so it's a no-op), and never touches the 'draw.keys' entry. Any other
   non-curated stored value is a genuine custom model and is left untouched. */
function loadSettings() {
  var provider = window.AI_MODEL_CATALOG.defaultProvider;
  var models = {};
  PROVIDERS.forEach(function (p) { models[p] = defaultModelFor(p); });
  var keys = { gemini: '', openai: '', claude: '' };
  var migrated = false;
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
    PROVIDERS.forEach(function (p) {
      if (models[p] === RETIRED_MODELS[p]) {
        models[p] = defaultModelFor(p);
        migrated = true;
      }
    });
    if (migrated) {
      window.localStorage.setItem('draw.settings', JSON.stringify({ provider: provider, models: models }));
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

// ─── Helpers: AI model discovery (Task 9, adapted from slidegen/pure.js) ───

/* providerModelIds(providerId, payload) -> string[] of model IDs read out of a
   discovery endpoint's JSON body, per that provider's catalog listPath/listStrip.
   Tolerant of a missing/malformed payload (returns []). Never throws. */
function providerModelIds(providerId, payload) {
  var info = window.AI_MODEL_CATALOG.providers[providerId];
  if (!info || !info.listPath) return [];
  var rows = payload && payload[info.listPath];
  if (!Array.isArray(rows)) return [];
  var strip = info.listStrip instanceof RegExp ? info.listStrip : null;
  return rows
    .map(function (row) { return String((row && (row.id != null ? row.id : row.name)) || ''); })
    .map(function (id) { return strip ? id.replace(strip, '') : id; })
    .map(function (id) { return id.trim(); })
    .filter(function (id) { return id && !/\s/.test(id); });
}

/* discoverProviderModels(providerId, key, {timeoutMs}) -> Promise<string[]>.
   Best-effort: any failure (no key, offline, non-2xx, non-JSON, timeout) resolves
   with the curated list unchanged rather than rejecting, so callers never need a
   .catch(). Curated order always leads; live extras the catalog doesn't know yet
   are deduplicated and appended. The key is used only in the provider's documented
   list-auth shape (query key for Gemini, Bearer for OpenAI, anthropic headers for
   Claude) and is never logged. */
function discoverProviderModels(providerId, key, options) {
  options = options || {};
  var timeoutMs = options.timeoutMs === undefined ? 15000 : options.timeoutMs;
  var info = window.AI_MODEL_CATALOG.providers[providerId];
  var curated = (info && info.models) || [];
  if (!info || !info.listUrl || !key) return Promise.resolve(curated.slice());

  var url = info.listUrl;
  var headers = {};
  if (info.listAuth === 'query-key') {
    url += (url.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(key);
  } else if (info.listAuth === 'bearer') {
    headers.Authorization = 'Bearer ' + key;
  } else if (info.listAuth === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  var controller = new AbortController();
  var timeoutId = window.setTimeout(function () { controller.abort(); }, timeoutMs);

  return fetch(url, { headers: headers, signal: controller.signal }).then(function (res) {
    if (!res.ok) return curated.slice();
    return res.json().catch(function () { return null; }).then(function (payload) {
      var live = providerModelIds(providerId, payload);
      var seen = {}, extra = [];
      live.forEach(function (id) {
        if (curated.indexOf(id) < 0 && !seen[id]) { seen[id] = true; extra.push(id); }
      });
      return curated.concat(extra);
    });
  }).catch(function () {
    return curated.slice();
  }).then(function (result) {
    // this .then only ever sees a fulfillment: every failure branch above already
    // recovers into a resolved curated.slice(), so there is no rejection left to
    // handle here (an onRejected callback here would be unreachable dead code).
    window.clearTimeout(timeoutId);
    return result;
  });
}

/* maybeDiscoverModels(provider) – kicks off discoverProviderModels for `provider`'s
   currently saved key. Called only from listeners (onProviderChange, onKeyChange)
   and once at init – deliberately NOT from render() (review fix: firing network
   traffic as a side effect of renderSettingsPanel broke render purity), so the only
   things that can trigger a fetch are the user actually changing something and the
   app's own startup.

   Fires at most once per distinct (provider, key) pair while that pair's attempt
   hasn't yet been established as unproductive (tracked in lastDiscoveryKey, a plain
   closure var – see its declaration above). On resolution the result is applied,
   and the latch cleared for a future retry, in three cases: the provider/key moved
   on before the fetch settled (stale), or the fetch landed nothing better than the
   curated list (covers both an actual failure – discoverProviderModels never
   rejects – and a provider that simply has no live extras right now). Only a
   genuine improvement over curated keeps the latch set, so the same (provider, key)
   pair is never re-fetched pointlessly, while every other outcome leaves the door
   open for the next trigger (another key edit, a provider round-trip, reopening the
   app) to try again. */
function maybeDiscoverModels(provider) {
  var key = App.state.keys[provider];
  if (!key || !key.trim()) return;
  if (lastDiscoveryKey[provider] === key) return; // already discovered (or discovering) for this exact key
  lastDiscoveryKey[provider] = key;
  var curated = window.AI_MODEL_CATALOG.providers[provider].models;
  discoverProviderModels(provider, key).then(function (list) {
    if (App.state.provider !== provider || App.state.keys[provider] !== key) {
      lastDiscoveryKey[provider] = null; // stale – provider/key moved on; let a later trigger retry
      return;
    }
    var extra = list.filter(function (m) { return curated.indexOf(m) < 0; });
    if (!extra.length) {
      lastDiscoveryKey[provider] = null; // no improvement over curated (failure or genuinely nothing new) – allow a retry
      return;
    }
    var discovered = providerMap(function () { return []; });
    for (var k in App.state.discovered) {
      if (Object.prototype.hasOwnProperty.call(App.state.discovered, k)) discovered[k] = App.state.discovered[k];
    }
    discovered[provider] = extra;
    App.set({ discovered: discovered });
  });
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

/* extractErrorMessage(label, status, rawBody) (Task 13, point 2): OpenAI/Gemini/
   Claude all wrap a failed request's body in JSON shaped roughly like
   { error: { message: '...' } } (Gemini) or { error: '...' }; when rawBody parses
   as JSON and carries that field, surface only that message (truncated to 200
   chars) instead of the raw JSON fragment the three adapters used to dump
   straight into the paused status. Falls back to the raw body (still truncated)
   when it isn't JSON or has no message field, so a non-JSON error page still
   produces something readable. The API key is NOT guaranteed absent from this
   text – OpenAI's 401 body echoes the submitted key back partially masked
   (e.g. "Incorrect API key provided: AIzaSyD8***...WxYz..."), so the extracted
   detail is run through window.AI_MODEL_CATALOG.redactKeys() before it's ever
   returned, swapping any token that looks like a key for '<key>'. */
function extractErrorMessage(label, status, rawBody) {
  var detail = rawBody;
  try {
    var parsed = JSON.parse(rawBody);
    var msg = null;
    if (parsed && parsed.error) {
      if (typeof parsed.error.message === 'string') msg = parsed.error.message;
      else if (typeof parsed.error === 'string') msg = parsed.error;
    } else if (parsed && typeof parsed.message === 'string') {
      msg = parsed.message;
    }
    if (msg) detail = msg;
  } catch (e) {
    // not JSON – fall back to the raw body below
  }
  detail = window.AI_MODEL_CATALOG.redactKeys(String(detail));
  var truncated = detail.length > 200;
  var shown = detail.slice(0, 200) + (truncated ? '…' : '');
  return label + ' request failed (' + status + '): ' + shown;
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
        throw new Error(extractErrorMessage('Gemini', res.status, t));
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
        throw new Error(extractErrorMessage('OpenAI', res.status, t));
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
        throw new Error(extractErrorMessage('Claude', res.status, t));
      });
    }
    return res.json();
  }).then(function (data) {
    var text = data && data.content && data.content[0] && data.content[0].text;
    if (typeof text !== 'string') throw new Error('Claude reply had no text.');
    return text;
  });
}

/* makeLogEntry(gen, best, source, hints, detail, genome) – pure, does not touch
   state; callers combine the returned entry into the same App.set() that also
   advances the run, so a generation's log line and its state transition land in a
   single re-render. genome (Task 9) is the winning candidate's genome, kept on the
   entry (not a pre-rendered canvas/data URL) so renderRightColumn can rebuild the
   thumbnail from it on every re-render – determinism (Genome.renderGenome renders
   the same genome identically every time) guarantees that rebuild always matches
   the picked cell, even after the population has since moved on. hash is
   precomputed here so it lands on data-winner-hash without re-hashing on every
   render. */
function makeLogEntry(gen, best, source, hints, detail, genome) {
  return {
    gen: gen, best: best, source: source, hints: hints || [], detail: detail || '',
    genome: genome || null,
    hash: genome ? window.Genome.genomeHash(genome) : null,
  };
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
   fires the first judge attempt under a freshly bumped judgeEpoch. Called right after
   Start builds generation 1, and again by advanceGeneration() after building each
   following generation. */
function beginJudging() {
  judgeEpoch++;
  var epoch = judgeEpoch;
  App.set({ phase: 'judging', runError: null });
  runJudge(0, epoch);
}

/* runJudge(attempt, epoch) – calls the configured provider's adapter, sanitizes the
   reply, and on success sets the AI's pick (source 'ai') with its hints, then starts
   the review timer. attempt is 0 for the first try, 1 for the single retry (spec §6).
   epoch is the judgeEpoch captured when this attempt's generation started judging.
   Every branch re-checks BOTH epoch === judgeEpoch and App.state.phase === 'judging'
   before touching state: the phase check alone isn't enough because Stop followed by
   a fresh Start re-enters phase 'judging' too, which would let a straggling promise
   from the OLD run sail through and hijack the new one; the epoch check closes that
   gap. Building the grid is wrapped in try/catch so a canvas failure routes through
   handleJudgeFailure like any other judge error instead of stranding the run in
   'judging' forever. */
function runJudge(attempt, epoch) {
  var s = App.state;
  var provider = s.provider;
  var model = s.models[provider];
  var key = s.keys[provider];
  var photoJpeg = s.photo.jpegDataUrl;

  var gridJpeg;
  try {
    gridJpeg = buildGridJpeg(s.population);
  } catch (err) {
    handleJudgeFailure(attempt, epoch, (err && err.message) ? err.message : 'Could not build the comparison grid.');
    return;
  }

  judge(provider, model, key, photoJpeg, gridJpeg).then(function (text) {
    if (epoch !== judgeEpoch || App.state.phase !== 'judging') return; // stale – a newer run/generation moved on
    var parsed = window.Genome.sanitizeJudgeReply(text);
    if (!parsed) {
      handleJudgeFailure(attempt, epoch, 'The judge reply could not be understood.');
      return;
    }
    startReviewTimer();
    App.set({
      winner: parsed.best,
      winnerSource: 'ai',
      winnerHints: parsed.hints,
      phase: 'reviewing',
      runError: null,
    });
  }).catch(function (err) {
    if (epoch !== judgeEpoch || App.state.phase !== 'judging') return; // stale – a newer run/generation moved on
    handleJudgeFailure(attempt, epoch, (err && err.message) ? err.message : 'The judge request failed.');
  });
}

/* handleJudgeFailure(attempt, epoch, message) (spec §6): attempt 0 schedules the
   single retry after JUDGE_RETRY_MS; attempt 1 (the retry itself failed too) enters
   'paused' with the message so the run keeps going manually. Both branches re-check
   epoch === judgeEpoch before acting, so a retry whose run was stopped/restarted in
   the meantime is a silent no-op. */
function handleJudgeFailure(attempt, epoch, message) {
  if (attempt === 0) {
    judgeRetryTimerId = window.setTimeout(function () {
      judgeRetryTimerId = null;
      if (epoch === judgeEpoch && App.state.phase === 'judging') runJudge(1, epoch);
    }, JUDGE_RETRY_MS);
    return;
  }
  if (epoch !== judgeEpoch) return; // stale – the run this retry belonged to has already moved on
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

/* buildLogThumbCanvas(genome) (Task 9) -> a small canvas (LOG_THUMB_W x
   LOG_THUMB_H css px, device-pixel-ratio aware) rendered from a winner's genome
   for the log entry. Called fresh on every render() of the log, never cached, so
   determinism (same genome -> identical render) is what keeps a re-render's
   thumbnail matching the cell that was actually picked. */
function buildLogThumbCanvas(genome) {
  var dpr = window.devicePixelRatio || 1;
  var canvas = document.createElement('canvas');
  canvas.width = Math.round(LOG_THUMB_W * dpr);
  canvas.height = Math.round(LOG_THUMB_H * dpr);
  canvas.style.width = LOG_THUMB_W + 'px';
  canvas.style.height = LOG_THUMB_H + 'px';
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
  judgeEpoch++; // invalidate any judge Promise still in flight (Stop mid-'judging')
  var s = App.state;
  // entry.genome is authoritative (Phase 10: onStopClick's before-a-pick fallback
  // genome may not live in s.population[winnerIndex - 1] at all any more); fall back
  // to the population lookup only if a caller somehow omitted it.
  var genome = entry.genome || s.population[winnerIndex - 1];
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

/* advanceGeneration() – the winner seeds generation g+1's population via
   Genome._internal.nextPopulation: 6 guaranteed-different mutants of the winner + 3
   random immigrants, shuffled, with NO exact copy of the winner in the grid (Phase 10 –
   the old exact-elite cell 1 stagnated the judge into re-picking the identical image).
   The winner genome itself is kept as currentBestGenome, the Stop-before-pick fallback
   (see onStopClick). Fires on REVIEW_MS timeout or an immediate 'enter'. At
   MAX_GENERATIONS the run ends instead of building g+1. */
function advanceGeneration() {
  var s = App.state;
  if (s.state !== 'running' || s.phase !== 'reviewing' || !s.winner) return;
  clearReviewTimer();

  var winnerIndex = s.winner;
  var winnerGenome = s.population[winnerIndex - 1];
  var hints = s.winnerHints || [];
  var entry = makeLogEntry(s.generation, winnerIndex, s.winnerSource || 'manual', hints, undefined, winnerGenome);

  if (s.generation >= MAX_GENERATIONS) {
    finishRun(winnerIndex, entry);
    return;
  }

  var nextGen = s.generation + 1;
  var hintedGenes = window.Genome.hintsToGenes(hints); // §4.2: winner's hints boost these genes in the mutants below
  var built = window.Genome._internal.nextPopulation(winnerGenome, nextGen, hintedGenes, Math.random);
  App.set({
    generation: nextGen,
    population: built.population,
    currentBestGenome: winnerGenome, // Stop-before-pick fallback (onStopClick) – no grid cell is guaranteed to match it any more
    winner: null,
    winnerSource: null,
    winnerHints: [],
    phase: 'drawing',
    log: s.log.concat([entry]),
  });
  beginJudging();
}

// ─── Render ───

/* computeLiveAnnouncement(s) (Task 7): the exact sentence the sr-only #live-announcer
   region should read out right now. A winner (AI or manual) is the generation's
   "result"; the done screen gets its own one-line wrap-up. Empty string means "leave
   the region as it was" is not attempted here – render() always overwrites it, so an
   empty string here means nothing new to announce (drawing/judging phases). */
function computeLiveAnnouncement(s) {
  if (s.state === 'done') {
    return 'Run finished after generation ' + s.generation + '. Final portrait ready.';
  }
  if (s.state === 'running' && s.winner) {
    var who = s.winnerSource === 'ai' ? 'AI' : 'you';
    return 'Generation ' + s.generation + ': face ' + s.winner + ' selected by ' + who + '.';
  }
  return '';
}

function render() {
  var s = App.state;
  appEl.setAttribute('data-state', s.state);
  appEl.setAttribute('data-phase', s.phase || '');
  appEl.setAttribute('data-provider', s.provider);

  clearEl(appEl);
  appEl.appendChild(renderLeftColumn(s));
  appEl.appendChild(renderCenterColumn(s));
  appEl.appendChild(renderRightColumn(s));

  if (headerControlsEl) {
    clearEl(headerControlsEl);
    // review fix: no run controls (Start/Pause/Stop + progress) on the done screen
    // (matches the pre-Task-9 behavior, where the old center-column controls-bar
    // simply wasn't rendered there) rather than showing three permanently-disabled
    // buttons. The Restart/New photo group renders on every state though, done
    // included – renderHeaderControls handles that split internally.
    headerControlsEl.appendChild(renderHeaderControls(s));
  }

  if (liveEl) liveEl.textContent = computeLiveAnnouncement(s);
}

/* renderProgressBar(s) (Task 7) -> "generation g / 10" bar, visible only while a run
   is actually under way (state 'running'). role="progressbar" + aria-value* so the
   number is exposed to assistive tech as well as read visually. */
function renderProgressBar(s) {
  if (s.state !== 'running') return null;
  var gen = s.generation || 0;
  var wrap = el('div', {
    class: 'progress-bar',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': String(MAX_GENERATIONS),
    'aria-valuenow': String(gen),
    'aria-label': 'Generation ' + gen + ' of ' + MAX_GENERATIONS,
  });
  var track = el('div', { class: 'progress-bar-fill-track' });
  var fill = el('div', { class: 'progress-bar-fill' });
  fill.style.width = (Math.min(1, gen / MAX_GENERATIONS) * 100) + '%';
  track.appendChild(fill);
  wrap.appendChild(track);
  var label = el('span', { class: 'progress-bar-label', 'aria-hidden': 'true', text: 'Gen ' + gen + ' / ' + MAX_GENERATIONS });
  wrap.appendChild(label);
  return wrap;
}

/* renderReviewBar(s) (Task 7, deferred item a) -> a thin bar draining over the
   REVIEW_MS auto-advance window while phase === 'reviewing', frozen (no animation)
   at its current position while phase === 'paused'. Reads reviewDeadline /
   reviewRemainingMs directly – they're plain closure vars in this same file, kept
   outside App.state on purpose (see the comment above their declaration), and render()
   already re-runs on every timer-relevant App.set() (pick, pause, resume). The
   width-then-rAF-then-zero dance is the standard CSS-transition trick: setting the
   starting width and the finishing width in the same tick would just jump, so the
   finishing width is deferred one frame to force the browser to animate between them.
   prefers-reduced-motion is handled globally in style.css (transition-duration
   collapsed to ~0), not here. */
function renderReviewBar(s) {
  if (s.state !== 'running' || !s.winner || (s.phase !== 'reviewing' && s.phase !== 'paused')) return null;
  var wrap = el('div', { class: 'review-bar', 'aria-hidden': 'true' });
  var fill = el('div', { class: 'review-bar-fill' });

  if (s.phase === 'reviewing' && reviewDeadline !== null) {
    var remaining = Math.max(0, reviewDeadline - Date.now());
    var pct = Math.min(100, (remaining / REVIEW_MS) * 100);
    fill.style.transitionDuration = '0ms';
    fill.style.width = pct + '%';
    window.requestAnimationFrame(function () {
      fill.style.transitionDuration = remaining + 'ms';
      fill.style.width = '0%';
    });
  } else {
    // paused: frozen at whatever was left when Pause froze the timer (or full, if
    // paused before a timer ever started – e.g. straight into a judge-failure pause)
    var frozenMs = reviewRemainingMs !== null ? reviewRemainingMs : REVIEW_MS;
    var pctPaused = Math.min(100, (frozenMs / REVIEW_MS) * 100);
    fill.style.transitionDuration = '0ms';
    fill.style.width = pctPaused + '%';
  }

  wrap.appendChild(fill);
  return wrap;
}

/* renderHeaderControls(s) (Task 9): Start/Pause-Resume/Stop + the "Gen g / 10"
   progress bar, rendered into the header's #header-controls slot on every render()
   (moved out of the center column's old controls-bar, per the brief). Same
   enabled/disabled rules and same click handlers as before – only where they render
   changed, not what they do, so every keyboard shortcut (which calls these same
   handlers directly, not via DOM lookups) keeps working unchanged. */
function renderHeaderControls(s) {
  var wrap = el('div', { class: 'header-controls-inner' });
  var hasRunControls = s.state !== 'done';
  if (hasRunControls) wrap.classList.add('has-run-controls');

  // review fix: run controls (Start/Pause/Stop + progress) hidden on the done
  // screen; the Restart/New photo group renders regardless of state, and sits
  // BEFORE the run controls (user request: Restart to the left of Start).
  wrap.appendChild(renderHeaderPhotoActions(s));

  if (hasRunControls) {
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

    wrap.appendChild(startBtn);
    wrap.appendChild(pauseBtn);
    wrap.appendChild(stopBtn);

    var progress = renderProgressBar(s);
    if (progress) wrap.appendChild(progress);
  }

  return wrap;
}

/* renderHeaderPhotoActions(s): Restart (same photo, fresh gen 1 - reuses
   onStartOverClick) and New photo (back to idle - reuses onNewPhotoClick), grouped
   apart from the run controls with a thin separator (see .header-photo-actions in
   style.css). Restart is enabled mid-run on purpose - that's the point of the
   request, letting a slow/bad run be restarted without waiting for it to finish.
   In 'ready' it would just duplicate Start, so it stays disabled there. New photo
   is enabled anywhere a photo already exists (ready/running/done), disabled only
   in 'idle' where there's no photo to clear yet. */
function renderHeaderPhotoActions(s) {
  var group = el('div', { class: 'header-photo-actions' });

  var restartBtn = el('button', {
    class: 'edu-btn ghost', type: 'button', text: 'Restart',
    'aria-label': 'Restart drawing from generation 1, keeping the current photo',
  });
  restartBtn.disabled = s.state !== 'running' && s.state !== 'done';
  restartBtn.addEventListener('click', onStartOverClick);

  var newPhotoBtn = el('button', {
    class: 'edu-btn ghost', type: 'button', text: 'New photo',
    'aria-label': 'Clear the current photo and return to upload',
  });
  newPhotoBtn.disabled = s.state === 'idle';
  newPhotoBtn.addEventListener('click', onNewPhotoClick);

  group.appendChild(restartBtn);
  group.appendChild(newPhotoBtn);
  return group;
}

/* renderRunStatus(s) – the one-line phase status ("Judge is looking at the
   grid…", "Paused – …", "Pick a candidate…") that used to sit inline in the old
   center-column controls bar; kept with the grid (per the brief: "the review
   countdown bar stays with the grid") since both describe the current phase of
   the run that's on screen right below. Returns null when there's nothing to say
   (not currently running). */
function renderRunStatus(s) {
  if (s.state !== 'running') return null;
  var status = el('div', { class: 'review-status' });
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
  return status;
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

/* renderSettingsPanel(s) (Task 9) – provider select; that provider's model select
   (curated models from AI_MODEL_CATALOG, discovered extras tagged "(discovered)",
   plus a "Custom…" option revealing a text input – a stored non-curated model
   shows as that custom value); a key input using the catalog's keyPlaceholder plus
   a "Get a key" link (keyUrl); a "keys stay in this browser" note; and (when Start
   was just blocked for a missing key) a highlighted border + message. Also kicks
   off model discovery for the current provider/key (best-effort, see
   maybeDiscoverModels). */
function renderSettingsPanel(s) {
  var panel = el('div', {
    class: 'panel settings-panel' + (s.settingsHighlight ? ' is-highlighted' : ''),
  });
  panel.appendChild(el('h2', { text: 'Settings' }));

  var catalogProvider = window.AI_MODEL_CATALOG.providers[s.provider];

  var providerRow = el('div', { class: 'settings-row' });
  providerRow.appendChild(el('label', { for: 'settings-provider', text: 'Provider' }));
  var providerSelect = el('select', { id: 'settings-provider' });
  PROVIDERS.forEach(function (p) {
    var opt = el('option', { value: p, text: PROVIDER_LABELS[p] });
    if (p === s.provider) opt.setAttribute('selected', 'selected');
    providerSelect.appendChild(opt);
  });
  providerSelect.addEventListener('change', function () { onProviderChange(providerSelect.value); });
  providerRow.appendChild(providerSelect);
  panel.appendChild(providerRow);

  var CUSTOM_VALUE = '__custom__';
  var curatedModels = catalogProvider.models;
  var discoveredExtra = (s.discovered && s.discovered[s.provider]) || [];
  var combinedModels = curatedModels.concat(discoveredExtra.filter(function (m) { return curatedModels.indexOf(m) < 0; }));
  var currentModel = s.models[s.provider];
  var isCurrentKnown = combinedModels.indexOf(currentModel) >= 0;
  /* showCustom (review fix): a stored non-curated model always shows as custom
     (isCurrentKnown false), OR the user has explicitly picked "Custom…" this
     session (s.settingsModelCustomMode, held in App.state) – reading the flag from
     state rather than re-deriving it purely from currentModel means an unrelated
     re-render (discovery resolving, a key edit on this same render pass, etc.) can
     never silently snap the select back to a curated value and hide the row the
     user is actively using. */
  var showCustom = s.settingsModelCustomMode || !isCurrentKnown;

  var modelRow = el('div', { class: 'settings-row' });
  modelRow.appendChild(el('label', { for: 'settings-model', text: 'Model' }));
  var modelSelect = el('select', { id: 'settings-model' });
  combinedModels.forEach(function (m) {
    var label = curatedModels.indexOf(m) >= 0 ? m : m + ' (discovered)';
    var opt = el('option', { value: m, text: label });
    modelSelect.appendChild(opt);
  });
  modelSelect.appendChild(el('option', { value: CUSTOM_VALUE, text: 'Custom…' }));
  modelSelect.value = showCustom ? CUSTOM_VALUE : currentModel;
  modelRow.appendChild(modelSelect);
  panel.appendChild(modelRow);

  var customModelRow = el('div', { class: 'settings-row settings-row-custom-model' });
  if (!showCustom) customModelRow.style.display = 'none';
  customModelRow.appendChild(el('label', { for: 'settings-model-custom', text: 'Custom model ID' }));
  var customModelInput = el('input', { id: 'settings-model-custom', type: 'text', autocomplete: 'off' });
  customModelInput.value = isCurrentKnown ? '' : currentModel;
  customModelRow.appendChild(customModelInput);
  panel.appendChild(customModelRow);

  modelSelect.addEventListener('change', function () {
    if (modelSelect.value === CUSTOM_VALUE) {
      App.set({ settingsModelCustomMode: true });
    } else {
      App.set({ settingsModelCustomMode: false });
      onModelChange(modelSelect.value);
    }
  });
  customModelInput.addEventListener('change', function () {
    var v = customModelInput.value.trim();
    if (v) onModelChange(v);
  });

  var keyRow = el('div', { class: 'settings-row' });
  keyRow.appendChild(el('label', { for: 'settings-key', text: PROVIDER_LABELS[s.provider] + ' API key' }));
  var keyInput = el('input', {
    id: 'settings-key', type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: catalogProvider.keyPlaceholder || '',
  });
  keyInput.value = s.keys[s.provider];
  keyInput.addEventListener('change', function () { onKeyChange(keyInput.value); });
  keyRow.appendChild(keyInput);
  if (catalogProvider.keyUrl) {
    keyRow.appendChild(el('a', {
      class: 'settings-key-link', href: catalogProvider.keyUrl, target: '_blank', rel: 'noopener', text: 'Get a key',
    }));
  }
  panel.appendChild(keyRow);

  /* Task 13, item 1 (key-shape guard): live-derived from the current key + provider
     on every render – not stored in state – so it can never go stale relative to
     what's actually in the input. Shown only for an UNAMBIGUOUS match to a
     different provider's pattern; a key matching no pattern at all (garbage, or a
     format the catalog doesn't know yet) is left alone, since patterns are
     heuristics, not proof. textContent only, no key value is ever included. */
  var currentKey = s.keys[s.provider];
  var likelyProvider = currentKey ? window.AI_MODEL_CATALOG.keyLooksLike(currentKey) : null;
  if (likelyProvider && likelyProvider !== s.provider) {
    panel.appendChild(el('p', {
      class: 'settings-key-warning',
      text: 'This looks like a ' + PROVIDER_LABELS[likelyProvider] + ' key, but ' +
        PROVIDER_LABELS[s.provider] + ' is selected.',
    }));
  }

  panel.appendChild(el('p', {
    class: 'settings-note',
    text: 'Keys stay in this browser (saved to localStorage) and are sent only to the selected provider.',
  }));

  // model discovery (Task 9) is triggered from the provider-change/key-change
  // listeners and once at init – never from render() – so it stays a listener/init
  // side effect, not a render-path one (review fix, see maybeDiscoverModels' comment)

  // Task 13, item 1b: info note left by a paste-time auto-heal (onKeyChange) –
  // distinct from settingsError (which blocks Start) since this one reports a fix
  // already applied, not a problem still blocking anything.
  if (s.settingsKeyNote) {
    panel.appendChild(el('p', { class: 'settings-key-note', text: s.settingsKeyNote }));
  }

  if (s.settingsError) {
    panel.appendChild(el('p', { class: 'settings-error', text: s.settingsError }));
  }

  return panel;
}

function renderCenterColumn(s) {
  if (s.state === 'done') return renderDoneCenter(s);

  var col = el('div', { class: 'col-center' });

  // ── run status (Task 9: Start/Pause/Stop + Gen g/10 moved to the header;
  // this one-line phase status stays with the grid, right above the review bar) ──
  var status = renderRunStatus(s);
  if (status) col.appendChild(status);

  // ── review countdown bar (Task 7, deferred item a): thin bar draining over the
  // REVIEW_MS auto-advance window; frozen (not animating) while paused. Reads the
  // review-timer closure vars directly, since it's defined in the same scope. ──
  var reviewBar = renderReviewBar(s);
  if (reviewBar) col.appendChild(reviewBar);

  // ── grid ──
  var gridPanel = el('div', { class: 'panel' });
  var grid = el('div', {
    id: 'grid',
    role: 'group',
    'aria-label': 'Candidate portraits, generation ' + (s.generation || 0),
  });
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
  var isWinner = s.winner === index;
  var label = 'Candidate ' + index +
    (isWinner ? ', selected' + (s.winnerSource === 'ai' ? ' by AI' : ' by you') : '');
  var cell = el('div', {
    class: 'cell' + (isWinner ? ' is-winner' : ''),
    'data-index': String(index),
    'data-genome-hash': hash,
    tabindex: '0',
    role: 'button',
    'aria-label': label,
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
   (photo left, portrait right, equal heights, paper background), both PNG downloads.
   Restart/New photo live in the header (renderHeaderPhotoActions), not here. */
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
    class: 'edu-btn', download: 'drawme-portrait.png', text: 'Download portrait PNG',
  });
  portraitLink.href = s.portraitDataUrl;
  actions.appendChild(portraitLink);

  var compositeLink = el('a', {
    class: 'edu-btn ghost', download: 'drawme-side-by-side.png', text: 'Download side-by-side PNG',
  });
  if (s.compositeDataUrl) {
    compositeLink.href = s.compositeDataUrl;
  } else {
    compositeLink.classList.add('is-disabled');
    compositeLink.setAttribute('aria-disabled', 'true');
  }
  actions.appendChild(compositeLink);

  // Restart / New photo now live in the header (renderHeaderPhotoActions), grouped
  // apart from these downloads and visible on every state including 'done'.
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
      'data-winner-hash': entry.hash || '', // Task 9: DOM contract gains this attribute, never loses one
    });

    /* winner thumbnail (Task 9): rebuilt fresh from entry.genome on every render –
       never cached/stored as a data URL – so determinism keeps it matching the
       cell that was actually picked even long after the population moved on. A
       plain <canvas role="img"> (canvas has no native alt) with an aria-label
       carries the accessible name; the final "done" entry's genome is the same
       one that produced the final portrait, so it shows the same face. */
    if (entry.genome) {
      var thumbCanvas = buildLogThumbCanvas(entry.genome);
      thumbCanvas.className = 'log-thumb';
      thumbCanvas.setAttribute('role', 'img');
      thumbCanvas.setAttribute('aria-label', 'Generation ' + entry.gen + ' winner');
      line.appendChild(thumbCanvas);
    }

    var text = el('div', { class: 'log-entry-text' });
    var hintsText = entry.hints && entry.hints.length
      ? entry.hints.map(function (h) { return h.trait + ': ' + h.suggestion; }).join(', ')
      : 'none';
    /* textContent only – never innerHTML – so a malformed/adversarial hint suggestion
       (already truncated + trait-filtered by the sanitizer) can never inject markup. */
    text.textContent = 'Gen ' + entry.gen + ' – best ' + entry.best + ' (' + entry.source + ')' +
      ' – hints: ' + hintsText + (entry.detail ? ' – ' + entry.detail : '');
    line.appendChild(text);

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
    // a failed re-upload must not clobber an already-valid photo/state (Task 7): only
    // fall back to idle/no-photo when there was no valid photo to keep in the first place
    var hadPhoto = !!App.state.photo;
    App.set({
      error: err.message,
      state: hadPhoto ? App.state.state : 'idle',
      photo: hadPhoto ? App.state.photo : null,
    });
  });
}

/* onStartClick() – Task 13, auto-heal point 3 of 3: before the existing "no key at
   all" gate, check whether the SELECTED provider's key is shaped for a different
   provider. If the mismatch is unambiguous AND that other provider's slot is
   empty, heal it silently (move + switch provider + persist) and start with the
   corrected provider – no extra click needed. If the mismatch can't be healed
   cleanly (destination already occupied, or the key matches no known pattern at
   all), show settingsError and refuse to start – UNLESS this is a second Start
   press with that exact same (provider, key) pair already warned about, in which
   case it proceeds: patterns are heuristics, not proof, and the user gets the
   final say once they've seen the warning. */
function onStartClick() {
  if (App.state.state !== 'ready') return;
  var s = App.state;
  var provider = s.provider;
  var key = s.keys[provider];

  if (key) {
    var ownPattern = window.AI_MODEL_CATALOG.providers[provider].keyPattern;
    if (ownPattern && !ownPattern.test(key)) {
      var likely = window.AI_MODEL_CATALOG.keyLooksLike(key);
      if (likely) {
        if (!s.keys[likely]) {
          // unambiguous match, empty destination – heal silently and proceed
          var keys = {};
          for (var k in s.keys) if (Object.prototype.hasOwnProperty.call(s.keys, k)) keys[k] = s.keys[k];
          keys[likely] = key;
          keys[provider] = '';
          provider = likely;
          App.set({
            provider: provider, keys: keys,
            settingsKeyNote: 'That looks like a ' + PROVIDER_LABELS[likely] + ' key - stored it for ' +
              PROVIDER_LABELS[likely] + ' and switched provider.',
          });
          saveSettings();
          saveKeys();
          lastStartKeyWarning = null;
        } else {
          // destination occupied – can't heal cleanly; warn once, let a second
          // press with the same unchanged key through
          var alreadyWarned = lastStartKeyWarning && lastStartKeyWarning.provider === provider &&
            lastStartKeyWarning.key === key;
          if (!alreadyWarned) {
            lastStartKeyWarning = { provider: provider, key: key };
            App.set({
              settingsHighlight: true,
              settingsError: 'This looks like a ' + PROVIDER_LABELS[likely] + ' key, but ' +
                PROVIDER_LABELS[provider] + ' is selected. Press Start again to use it anyway.',
            });
            return;
          }
          lastStartKeyWarning = null; // proceeding with it – reset so the next paste is checked fresh
        }
      }
      // likely === null (garbage/unrecognized format): no evidence either way,
      // proceed normally – patterns are heuristics, not proof.
    }
  }

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
    currentBestGenome: null,
    runError: null,
    settingsHighlight: false,
    settingsError: null,
    settingsKeyNote: null,
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
  var picked = !!s.winner;
  /* Phase 10 (no exact elite): the grid no longer guarantees any cell equals the
     previous winner, so "no pick yet" can't fall back to cell 1 any more – it falls
     back to currentBestGenome (the previous generation's picked winner, kept in App
     state). At generation 1 there is no previous winner yet, so this still falls
     back to cell 1 (matches the pre-Phase-10 behavior for that one edge case, and
     winnerIndex 0 signals "not a real grid cell" rather than reusing a misleading 1). */
  var winnerIndex = picked ? s.winner : 0;
  var source = picked ? (s.winnerSource || 'manual') : 'manual';
  var hints = picked ? (s.winnerHints || []) : [];
  var genome = picked ? s.population[s.winner - 1] : (s.currentBestGenome || (s.population && s.population[0]));
  var entry = makeLogEntry(s.generation, winnerIndex, source, hints,
    picked ? 'stopped' : 'stopped before a pick – used the previous winner', genome);
  finishRun(winnerIndex, entry);
}

/* triggerPortraitDownload() (Task 7): what the "s" keyboard shortcut does on the done
   screen – the same download the visible "Download portrait PNG" link performs, fired
   programmatically since that link is rebuilt fresh on every render and has no stable
   ref to click(). A no-op if there is no portrait yet (state !== 'done' is already
   checked by the caller, but the data URL is checked again here as a hard guard). */
function triggerPortraitDownload() {
  var s = App.state;
  if (!s.portraitDataUrl) return;
  var link = document.createElement('a');
  link.href = s.portraitDataUrl;
  link.download = 'drawme-portrait.png';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function onCellPick(index) {
  var s = App.state;
  // pickable while actively reviewing an AI/manual pick, and while paused (spec §6:
  // a judge failure pauses the run and waits for exactly this manual pick + Resume)
  if (s.state !== 'running' || (s.phase !== 'reviewing' && s.phase !== 'paused')) return;
  if (!s.population || index < 1 || index > s.population.length) return;
  // overriding a pick keeps whatever hints the AI already produced this generation –
  // only the winner + its source change, winnerHints is left untouched. A pick made
  // while paused (spec §6 manual-continue) also clears the judge-failure message,
  // since the user has now done exactly what it asked for.
  if (s.phase === 'reviewing') startReviewTimer(); // (re)start the full REVIEW_MS window on every pick, including overrides
  App.set({
    winner: index,
    winnerSource: 'manual',
    runError: s.phase === 'paused' ? null : s.runError,
  });
}

function onStartOverClick() {
  // same photo, fresh gen 1: reuse the photo already in state, drop everything else,
  // then run the exact Start path so gen 1 gets a brand-new initialPopulation()
  clearReviewTimer();
  clearJudgeRetryTimer();
  judgeEpoch++; // invalidate any judge Promise still in flight
  reviewRemainingMs = null;
  App.set({
    state: 'ready', phase: null, population: null, generation: 0,
    winner: null, winnerSource: null, winnerHints: [], currentBestGenome: null, runError: null, log: [], error: null,
    doneGenome: null, portraitDataUrl: null, compositeDataUrl: null,
  });
  onStartClick();
}

function onNewPhotoClick() {
  clearReviewTimer();
  clearJudgeRetryTimer();
  judgeEpoch++; // invalidate any judge Promise still in flight
  reviewRemainingMs = null;
  App.set({
    state: 'idle', phase: null, population: null, generation: 0,
    winner: null, winnerSource: null, winnerHints: [], currentBestGenome: null, runError: null, log: [], error: null, photo: null,
    doneGenome: null, portraitDataUrl: null, compositeDataUrl: null,
  });
}

// ─── Listeners: settings panel ───

function onProviderChange(provider) {
  if (PROVIDERS.indexOf(provider) < 0) return;
  // Task 13: clear settingsError/settingsKeyNote here too, same as settingsHighlight
  // already did – otherwise a stale mismatch warning or auto-heal note from the
  // previous provider would stick around under an unrelated provider's key field.
  App.set({
    provider: provider, settingsHighlight: false, settingsError: null, settingsKeyNote: null,
    settingsModelCustomMode: false,
  });
  saveSettings();
  lastStartKeyWarning = null; // switching providers manually invalidates any pending "second press proceeds" state
  maybeDiscoverModels(provider); // Task 9 (review fix): triggered from this listener, not from render()
}

function onModelChange(value) {
  var s = App.state;
  var models = {};
  for (var k in s.models) if (Object.prototype.hasOwnProperty.call(s.models, k)) models[k] = s.models[k];
  models[s.provider] = value;
  App.set({ models: models });
  saveSettings();
}

/* onKeyChange(value) (Task 13, auto-heal point 2 of 3): the key just pasted/typed
   into the CURRENTLY SELECTED provider's field. If it unambiguously matches a
   DIFFERENT provider's pattern and that provider's slot is empty, don't honor the
   literal slot the user typed into – store it under the matching provider instead,
   switch the selected provider there, and leave a status note explaining what
   happened. If the matching slot is already occupied, this does NOT silently
   drop what the user typed: it's kept exactly where they put it, and the plain
   inline warning (item 1, rendered live in renderSettingsPanel) covers it instead. */
function onKeyChange(value) {
  var s = App.state;
  var provider = s.provider;
  var keys = {};
  for (var k in s.keys) if (Object.prototype.hasOwnProperty.call(s.keys, k)) keys[k] = s.keys[k];
  keys[provider] = value;

  var note = null;
  if (value) {
    var likely = window.AI_MODEL_CATALOG.keyLooksLike(value);
    if (likely && likely !== provider && !keys[likely]) {
      var originalProviderLabel = PROVIDER_LABELS[provider];
      keys[likely] = value;
      keys[provider] = '';
      provider = likely;
      note = 'That looks like a ' + PROVIDER_LABELS[likely] + ' key - stored it for ' +
        PROVIDER_LABELS[likely] + ' and switched provider. Paste it again here to keep it under ' +
        originalProviderLabel + '.';
    }
  }

  App.set({
    provider: provider, keys: keys, settingsHighlight: false, settingsError: null, settingsKeyNote: note,
  });
  saveSettings(); // provider may have changed as part of the heal above
  saveKeys(); // never logged – written straight to localStorage
  lastStartKeyWarning = null; // a fresh paste invalidates any pending "second press proceeds" state
  maybeDiscoverModels(provider); // Task 9 (review fix): triggered from this listener, not from render()
}

// ─── Init ───

(function init() {
  // Task 9 (review fix): model discovery for the initial provider's saved key (if
  // any – e.g. restored from a previous session's localStorage), fired once here
  // rather than from render() so a fresh load behaves the same as any other
  // discovery trigger: a listener/init side effect, not a render-path one.
  maybeDiscoverModels(App.state.provider);

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

  /* keyboard (spec §5, Task 7): 1-9 pick a candidate, space pauses/resumes, enter
     advances the review immediately once a winner exists, s saves the portrait once
     done. Bound once here (not per-render) so listeners never pile up.

     Two guards keep this from double-firing or hijacking normal typing/interaction:
     - text inputs/selects are skipped outright, so typing a provider model name or
       pasting a key never triggers a shortcut.
     - a focused <button>/<a>/grid cell already has its own native or explicit
       space/enter handling (native click-activation for buttons/links, the per-cell
       keydown listener for cells); letting this global listener also act on the same
       keystroke would either double-fire (e.g. Space on the Pause button toggling
       twice) or steal Space away from "pick this focused candidate". Those two keys
       are skipped whenever an interactive control already owns them; digits and s
       don't have that conflict since nothing else binds them. */
  window.addEventListener('keydown', function (ev) {
    var target = ev.target;
    var tag = (target && target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var ownedByFocusedControl = tag === 'BUTTON' || tag === 'A' ||
      (target && target.classList && target.classList.contains('cell'));
    var s = App.state;

    if (ev.key === ' ' || ev.code === 'Space') {
      if (ownedByFocusedControl) return; // let the focused button/cell handle its own Space
      if (s.state === 'running') { ev.preventDefault(); onPauseResumeClick(); }
      return;
    }

    if (ev.key === 's' || ev.key === 'S') {
      if (s.state === 'done') { ev.preventDefault(); triggerPortraitDownload(); }
      return;
    }

    if (s.state !== 'running' || (s.phase !== 'reviewing' && s.phase !== 'paused')) return;

    if (ev.key >= '1' && ev.key <= '9') {
      var idx = parseInt(ev.key, 10);
      if (s.population && idx <= s.population.length) {
        ev.preventDefault();
        onCellPick(idx);
      }
    } else if (ev.key === 'Enter') {
      if (ownedByFocusedControl) return; // the focused button/cell already handles its own Enter
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

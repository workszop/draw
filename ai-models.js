/* AI provider catalog for DrawMe.
   Curated model lists + provider metadata (key placeholder/URL, discovery
   endpoint shape). Adapted from ~/git-claude/slidegen/ai-models.js – same
   dual module.exports / global export pattern, global name AI_MODEL_CATALOG. */
(function (root, factory) {
  var catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  else root.AI_MODEL_CATALOG = catalog;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var AI_MODEL_CATALOG = {
    defaultProvider: 'openai',
    providers: {
      gemini: {
        label: 'Gemini',
        models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite-preview'],
        keyPlaceholder: 'AIza…',
        keyUrl: 'https://aistudio.google.com/apikey',
        // Task 13 (key-shape guard): what a Gemini key looks like, used to warn/auto-heal
        // when a key is pasted into or stored under the wrong provider's slot.
        keyPattern: /^AIza/,
        // Model discovery: GET {listUrl}?key=<apiKey> returns {models:[{name}]}.
        // Names arrive as "models/gemini-…"; listStrip removes the prefix.
        listUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
        listAuth: 'query-key',
        listPath: 'models',
        listStrip: /^models\//,
      },
      openai: {
        label: 'OpenAI',
        // Most-capable-first order (sol, terra, luna); the default model is
        // GPT Luna via defaultModel below, not by reordering this list.
        models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        defaultModel: 'gpt-5.6-luna',
        keyPlaceholder: 'sk-…',
        keyUrl: 'https://platform.openai.com/api-keys',
        // negative lookahead excludes Claude's sk-ant- keys, which otherwise share the sk- prefix
        keyPattern: /^sk-(?!ant-)/,
        // Model discovery: GET {listUrl} with a Bearer token returns {data:[{id}]}.
        listUrl: 'https://api.openai.com/v1/models',
        listAuth: 'bearer',
        listPath: 'data',
      },
      claude: {
        label: 'Claude',
        models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
        keyPlaceholder: 'sk-ant-…',
        keyUrl: 'https://console.anthropic.com/settings/keys',
        keyPattern: /^sk-ant-/,
        // Model discovery: GET {listUrl} with x-api-key + version returns {data:[{id}]}.
        listUrl: 'https://api.anthropic.com/v1/models',
        listAuth: 'anthropic',
        listPath: 'data',
      },
    },
  };

  /* keyLooksLike(key) -> providerId|null (Task 13, pure, Node-testable via require).
     Tests key against every provider's keyPattern and returns the id of the one
     that matches, or null if none do (an unrecognized/garbage key – patterns are
     heuristics, not proof, so "no match" is a legitimate outcome, not an error).
     The three patterns above are mutually exclusive by construction (the openai
     pattern's negative lookahead excludes sk-ant- keys), so at most one provider
     ever matches. Never logs or echoes the key itself. */
  AI_MODEL_CATALOG.keyLooksLike = function keyLooksLike(key) {
    if (typeof key !== 'string') return null;
    var trimmed = key.trim(); // Task 13 fix: leading/trailing whitespace must not dodge the guard
    if (!trimmed) return null;
    var providerIds = Object.keys(AI_MODEL_CATALOG.providers);
    for (var i = 0; i < providerIds.length; i++) {
      var p = providerIds[i];
      var pattern = AI_MODEL_CATALOG.providers[p].keyPattern;
      if (pattern && pattern.test(trimmed)) return p;
    }
    return null;
  };

  /* redactKeys(text) -> text with any whitespace-delimited token that
     keyLooksLike() recognizes as an API key replaced by '<key>' (Task 13 review
     fix: OpenAI's 401 body echoes the submitted key partially masked, e.g.
     "Incorrect API key provided: AIzaSyD8***...WxYz...", so a provider error
     detail can carry a key fragment even though the key itself is never a
     labeled field in the JSON). Pure, Node-testable, defensive – it runs over
     provider error text before that text is ever shown to the user. Splits on
     whitespace only (keys never contain spaces), tests each token against every
     provider's keyPattern via keyLooksLike, and swaps matches for '<key>'.
     Ordinary words never match a keyPattern, so normal sentences pass through
     unchanged. */
  AI_MODEL_CATALOG.redactKeys = function redactKeys(text) {
    if (typeof text !== 'string' || !text) return text;
    return text.split(/(\s+)/).map(function (token) {
      return AI_MODEL_CATALOG.keyLooksLike(token) ? '<key>' : token;
    }).join('');
  };

  /* healKeys(settings) -> { settings, healed } (Task 13, pure, Node-testable via
     require – no localStorage/window touched). settings is { provider, models, keys }
     shaped like loadSettings()'s return value. Walks the provider slots in catalog
     order; the first slot whose key mismatches its OWN provider's pattern but
     unambiguously matches a DIFFERENT provider's pattern, whose slot is empty, gets
     moved there (never overwrites a non-empty destination, never deletes a key with
     no match). Repeats this scan until a full pass makes no further move, so a
     double-misplacement (e.g. a Gemini key under openai AND a Claude key under
     gemini, both true destinations empty) heals every slot it can in one call
     instead of just the first – each move can only ever free up the slot it
     vacates, never touch a still-occupied one, so the loop always terminates (at
     most one heal per provider slot). If the originally selected provider is left
     keyless and the LAST move's destination now has a key, the selected provider
     switches there too. Idempotent: a second call on the now-healed settings is a
     no-op, since every healed key now matches its new slot's own pattern. Never
     logs a key value. */
  AI_MODEL_CATALOG.healKeys = function healKeys(settings) {
    var providerIds = Object.keys(AI_MODEL_CATALOG.providers);
    var keys = {};
    providerIds.forEach(function (p) {
      keys[p] = (settings && settings.keys && typeof settings.keys[p] === 'string') ? settings.keys[p] : '';
    });
    var provider = settings && settings.provider;
    var lastHeal = null;
    var movedAny = true;
    while (movedAny) {
      movedAny = false;
      for (var i = 0; i < providerIds.length; i++) {
        var p = providerIds[i];
        var key = keys[p];
        if (!key) continue;
        var ownPattern = AI_MODEL_CATALOG.providers[p].keyPattern;
        if (ownPattern && ownPattern.test(key)) continue; // fits its own slot already – nothing to heal
        var target = AI_MODEL_CATALOG.keyLooksLike(key);
        if (!target || target === p) continue; // no unambiguous match elsewhere (garbage key) – leave it alone
        if (keys[target]) continue; // destination occupied – never overwrite a non-empty slot
        keys[target] = key;
        keys[p] = '';
        lastHeal = { from: p, to: target };
        movedAny = true;
        break; // restart the scan from the top so ordering never masks a second heal
      }
    }
    if (lastHeal && !keys[provider] && keys[lastHeal.to]) provider = lastHeal.to;
    return {
      settings: { provider: provider, models: settings && settings.models, keys: keys },
      healed: lastHeal,
    };
  };

  return AI_MODEL_CATALOG;
});

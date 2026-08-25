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
    if (typeof key !== 'string' || !key) return null;
    var providerIds = Object.keys(AI_MODEL_CATALOG.providers);
    for (var i = 0; i < providerIds.length; i++) {
      var p = providerIds[i];
      var pattern = AI_MODEL_CATALOG.providers[p].keyPattern;
      if (pattern && pattern.test(key)) return p;
    }
    return null;
  };

  /* healKeys(settings) -> { settings, healed } (Task 13, pure, Node-testable via
     require – no localStorage/window touched). settings is { provider, models, keys }
     shaped like loadSettings()'s return value. Walks the provider slots in catalog
     order; the first slot whose key mismatches its OWN provider's pattern but
     unambiguously matches a DIFFERENT provider's pattern, whose slot is empty, gets
     moved there (never overwrites a non-empty destination, never deletes a key with
     no match). If the originally selected provider is left keyless by the move and
     the destination now has a key, the selected provider switches too. At most one
     heal per call, so a second call on the now-healed settings is a no-op (idempotent
     by construction: the healed key now matches its new slot's own pattern, so no
     slot is "mismatched" any more). Never logs a key value. */
  AI_MODEL_CATALOG.healKeys = function healKeys(settings) {
    var providerIds = Object.keys(AI_MODEL_CATALOG.providers);
    var keys = {};
    providerIds.forEach(function (p) {
      keys[p] = (settings && settings.keys && typeof settings.keys[p] === 'string') ? settings.keys[p] : '';
    });
    var provider = settings && settings.provider;
    var healed = null;
    providerIds.forEach(function (p) {
      if (healed) return; // only one heal per call
      var key = keys[p];
      if (!key) return;
      var ownPattern = AI_MODEL_CATALOG.providers[p].keyPattern;
      if (ownPattern && ownPattern.test(key)) return; // fits its own slot already – nothing to heal
      var target = AI_MODEL_CATALOG.keyLooksLike(key);
      if (!target || target === p) return; // no unambiguous match elsewhere (garbage key) – leave it alone
      if (keys[target]) return; // destination occupied – never overwrite a non-empty slot
      keys[target] = key;
      keys[p] = '';
      healed = { from: p, to: target };
    });
    if (healed && !keys[provider] && keys[healed.to]) provider = healed.to;
    return {
      settings: { provider: provider, models: settings && settings.models, keys: keys },
      healed: healed,
    };
  };

  return AI_MODEL_CATALOG;
});

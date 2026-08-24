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
        // Model discovery: GET {listUrl} with x-api-key + version returns {data:[{id}]}.
        listUrl: 'https://api.anthropic.com/v1/models',
        listAuth: 'anthropic',
        listPath: 'data',
      },
    },
  };

  return AI_MODEL_CATALOG;
});

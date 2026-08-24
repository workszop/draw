/* ============================================================
   GENOME – the genome domains, RNG, and drawing/rendering logic
   for DrawMe. Classic script (no modules).

   Node-testability: everything except drawFace/renderGenome must
   run in Node without a DOM – no touching pen/document/window at
   load or call time. A local mulberry32-style RNG helper is used
   instead of relying on pen.js's seeded RNG.

   The drawing code below is adapted from ~/git-claude/faces/faces.js:
   every trait a person would recognise is lifted into the genome,
   everything else (stroke wobble, strand placement, collars, blush,
   freckles, age lines …) stays driven by genome.wobbleSeed.
   ============================================================ */

(function () {
  'use strict';

  // ─── Constants: gene domains ───

  var AGES = ['child', 'young', 'adult', 'old'];
  var GENDERS = ['masc', 'fem', 'neutral'];
  var EXPRS = ['neutral', 'happy', 'surprised', 'sleepy', 'grumpy', 'sly'];
  var HAIR_STYLES = ['bowl', 'bangs', 'sidepart', 'long', 'bob', 'bun', 'afro', 'pigtails',
    'ponytail', 'braids', 'spiky', 'shaggy', 'curly', 'buzz', 'comb', 'bald', 'wisps',
    'mohawk', 'band', 'cap', 'beanie', 'fedora', 'beret', 'headscarf'];
  var HAT_STYLES = ['cap', 'beanie', 'fedora', 'beret', 'headscarf'];
  var NO_BOW_STYLES = ['bald', 'wisps', 'buzz', 'mohawk', 'band'];
  var WASH_MODES = ['flat', 'scribble'];
  var LOOKS = [-1, -0.5, 0, 0.5, 1];
  var EYE_KINDS = ['ring', 'big', 'dot', 'mix'];
  var BROW_KINDS = ['none', 'arc', 'thick'];
  var NOSE_KINDS = ['hook', 'button', 'straight', 'big'];
  var MOUTH_KINDS = ['flat', 'smile', 'lips', 'open', 'frown', 'pout', 'grin'];
  var STACHES = ['none', 'thin', 'bushy', 'handlebar', 'walrus'];
  var BEARDS = ['none', 'stubble', 'goatee', 'full'];
  var EYEWEARS = ['none', 'round', 'square', 'shades', 'halfmoon', 'pince', 'monocle', 'cateye'];
  var EARRINGS = ['none', 'stud', 'hoop', 'drop'];

  /* the hair table from faces.js, parameterised by age and the soft/rough weights.
     Validity per age = every style with weight > 0 when both weights are 1. */
  function hairTable(age, soft, rough) {
    var t = {};
    var isChild = age === 'child', isOld = age === 'old';
    function add(k, w) { if (w > 0) t[k] = (t[k] || 0) + w; }
    add('curly', 1.5); add('afro', 0.7); add('cap', 0.7); add('beanie', 0.7); add('shaggy', 0.8);
    if (isChild) {
      add('bowl', 3); add('spiky', 2); add('bangs', 2.5); add('buzz', 0.8); add('mohawk', 0.3);
      add('pigtails', 3 * soft); add('bob', 2 * soft); add('braids', 1.5 * soft); add('ponytail', 1.5 * soft); add('long', 1 * soft);
    } else if (isOld) {
      add('bald', 3 * rough); add('comb', 2 * rough); add('wisps', 2); add('fedora', 1); add('beret', 0.5); add('cap', 0.6);
      add('bun', 3 * soft); add('bob', 1.5 * soft); add('headscarf', 1.5 * soft); add('long', 0.6 * soft); add('curly', 1.5 * soft);
    } else {
      add('bowl', 1.2); add('spiky', 1.5); add('buzz', 1); add('comb', 1); add('sidepart', 1.5); add('band', 0.7);
      add('mohawk', 0.35); add('fedora', 0.5); add('beret', 0.5); add('bald', 0.8 * rough);
      add('long', 3 * soft); add('bob', 2.5 * soft); add('bun', 1.5 * soft); add('ponytail', 2 * soft);
      add('braids', 1.5 * soft); add('pigtails', 0.3 * soft); add('headscarf', 0.8 * soft); add('bangs', 1 * soft);
    }
    return t;
  }

  var HAIR_VALID = {};
  AGES.forEach(function (age) { HAIR_VALID[age] = Object.keys(hairTable(age, 1, 1)); });

  /* hair_length hint (spec §4.2): the subsets mutate() re-picks from for "longer"/"shorter" */
  var HAIR_LONG = ['long', 'bob', 'afro', 'pigtails', 'ponytail', 'braids', 'shaggy', 'curly'];
  var HAIR_SHORT = ['buzz', 'spiky', 'bowl', 'comb', 'sidepart', 'bald', 'wisps'];

  /* stratification archetype (spec §3.5) for initialPopulation: every hairStyle falls
     into exactly one of three coverage buckets, distinct from the hint subsets above. */
  var HAIR_ARCHETYPE_LONG = ['long', 'bob', 'bun', 'afro', 'pigtails', 'ponytail', 'braids', 'shaggy', 'curly'];
  var HAIR_ARCHETYPE_HAT = ['bald', 'wisps', 'mohawk', 'band', 'cap', 'beanie', 'fedora', 'beret', 'headscarf'];
  function hairArchetype(style) {
    if (inList(style, HAIR_ARCHETYPE_LONG)) return 'long';
    if (inList(style, HAIR_ARCHETYPE_HAT)) return 'noneOrHat';
    return 'short';
  }

  function headWRange(age) {
    return age === 'child' ? [46, 60] : age === 'old' ? [54, 74] : [56, 76];
  }
  function headRatioRange(age) {
    return age === 'child' ? [0.92, 1.1] : [0.92, 1.3];
  }

  /* GENES: one descriptor per gene, so mutate/hints (later tasks) can walk the table. */
  var GENES = {
    age:         { type: 'cat', values: AGES, ordered: true },
    gender:      { type: 'cat', values: GENDERS },
    expr:        { type: 'cat', values: EXPRS },
    hairStyle:   { type: 'cat', values: HAIR_STYLES, validFor: function (age) { return HAIR_VALID[age] || HAIR_VALID.adult; } },
    hairDark:    { type: 'bool' },
    hairFillIdx: { type: 'idx', n: 4, ordered: true },
    hairTintIdx: { type: 'idx', n: 4, nullable: true, ordered: true },
    skinIdx:     { type: 'idx', n: 7, nullable: true, ordered: true },
    washMode:    { type: 'cat', values: WASH_MODES },
    hatWashIdx:  { type: 'idx', n: 5, nullable: true, ordered: true },
    accentIdx:   { type: 'idx', n: 3, ordered: true },
    inkIdx:      { type: 'idx', n: 6, ordered: true },
    penW:        { type: 'num', range: function () { return [0.75, 1.45]; } },
    headW:       { type: 'num', range: function (age) { return headWRange(age); } },
    headRatio:   { type: 'num', range: function (age) { return headRatioRange(age); } },
    tilt:        { type: 'num', range: function () { return [-0.09, 0.09]; } },
    look:        { type: 'cat', values: LOOKS, ordered: true },
    eyeKind:     { type: 'cat', values: EYE_KINDS },
    browKind:    { type: 'cat', values: BROW_KINDS, ordered: true },
    noseKind:    { type: 'cat', values: NOSE_KINDS },
    mouthKind:   { type: 'cat', values: MOUTH_KINDS },
    stache:      { type: 'cat', values: STACHES },
    beard:       { type: 'cat', values: BEARDS },
    eyewear:     { type: 'cat', values: EYEWEARS },
    bow:         { type: 'bool' },
    earrings:    { type: 'cat', values: EARRINGS },
    wobbleSeed:  { type: 'int32' },
  };
  var GENE_NAMES = Object.keys(GENES);

  // ─── State ───
  // No module-level mutable state beyond the lazily-resolved colour tokens; genomes are plain objects.

  var COLORS = null;   // resolved from the CSS tokens on the first draw, not at load

  // ─── Helpers: RNG, domain maths ───

  /* mulberry32, local so repair/randomGenome never reach for pen.R */
  function mulberry32Local(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rfR(rand, a, b) { return a + rand() * (b - a); }
  function riR(rand, a, b) { return Math.floor(rfR(rand, a, b + 1)); }
  function pickR(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }
  function chanceR(rand, p) { return rand() < p; }
  function wpickR(rand, table) {
    var keys = Object.keys(table).filter(function (k) { return table[k] > 0; });
    var total = 0, i;
    for (i = 0; i < keys.length; i++) total += table[keys[i]];
    var r = rand() * total;
    for (i = 0; i < keys.length; i++) { r -= table[keys[i]]; if (r < 0) return keys[i]; }
    return keys[keys.length - 1];
  }

  function softOf(gender) { return gender === 'fem' ? 1 : gender === 'masc' ? 0 : 0.5; }
  function roughOf(gender) { return gender === 'masc' ? 1 : gender === 'fem' ? 0 : 0.5; }

  function clampNum(v, lo, hi, fallback) {
    if (typeof v !== 'number' || !isFinite(v)) return fallback;
    return v < lo ? lo : v > hi ? hi : v;
  }
  function snapTo(v, values) {
    var best = values[0], bd = Infinity;
    for (var i = 0; i < values.length; i++) {
      var d = Math.abs(values[i] - v);
      if (d < bd) { bd = d; best = values[i]; }
    }
    return best;
  }
  function inList(v, list) { return list.indexOf(v) >= 0; }
  function idxOk(v, n) { return typeof v === 'number' && v === Math.floor(v) && v >= 0 && v < n; }

  // ─── Helpers: repair ───

  /* repair(genome) – deterministic and idempotent. Never touches pen or the DOM;
     any re-pick it has to make is seeded from wobbleSeed. */
  function repair(input) {
    var g = {};
    for (var i = 0; i < GENE_NAMES.length; i++) g[GENE_NAMES[i]] = input[GENE_NAMES[i]];

    g.wobbleSeed = (typeof g.wobbleSeed === 'number' && isFinite(g.wobbleSeed)) ? (g.wobbleSeed | 0) : 0;
    var rand = mulberry32Local(g.wobbleSeed);

    /* categorical genes snap back into their domains before any rule reads them */
    if (!inList(g.age, AGES)) g.age = pickR(rand, AGES);
    if (!inList(g.gender, GENDERS)) g.gender = pickR(rand, GENDERS);
    if (!inList(g.expr, EXPRS)) g.expr = pickR(rand, EXPRS);
    if (!inList(g.washMode, WASH_MODES)) g.washMode = pickR(rand, WASH_MODES);
    if (!inList(g.eyeKind, EYE_KINDS)) g.eyeKind = pickR(rand, EYE_KINDS);
    if (!inList(g.browKind, BROW_KINDS)) g.browKind = pickR(rand, BROW_KINDS);
    if (!inList(g.noseKind, NOSE_KINDS)) g.noseKind = pickR(rand, NOSE_KINDS);
    if (!inList(g.mouthKind, MOUTH_KINDS)) g.mouthKind = pickR(rand, MOUTH_KINDS);
    if (!inList(g.stache, STACHES)) g.stache = pickR(rand, STACHES);
    if (!inList(g.beard, BEARDS)) g.beard = pickR(rand, BEARDS);
    if (!inList(g.eyewear, EYEWEARS)) g.eyewear = pickR(rand, EYEWEARS);
    if (!inList(g.earrings, EARRINGS)) g.earrings = pickR(rand, EARRINGS);
    g.hairDark = !!g.hairDark;
    g.bow = !!g.bow;

    var isChild = g.age === 'child', isOld = g.age === 'old';
    var soft = softOf(g.gender);

    /* index genes: null stays null, anything else has to land inside the token array */
    if (g.hairTintIdx === undefined) g.hairTintIdx = null;   // an omitted nullable index means "no wash"
    if (g.skinIdx === undefined) g.skinIdx = null;
    if (g.hatWashIdx === undefined) g.hatWashIdx = null;
    if (!idxOk(g.hairFillIdx, 4)) g.hairFillIdx = riR(rand, 0, 3);
    if (g.hairTintIdx !== null && !idxOk(g.hairTintIdx, 4)) g.hairTintIdx = riR(rand, 0, 3);
    if (g.skinIdx !== null && !idxOk(g.skinIdx, 7)) g.skinIdx = riR(rand, 0, 6);
    if (g.hatWashIdx !== null && !idxOk(g.hatWashIdx, 5)) g.hatWashIdx = riR(rand, 0, 4);
    if (!idxOk(g.accentIdx, 3)) g.accentIdx = riR(rand, 0, 2);
    if (!idxOk(g.inkIdx, 6)) g.inkIdx = riR(rand, 0, 5);

    /* hair style has to be valid for the age (the child set included) */
    var valid = HAIR_VALID[g.age];
    if (!inList(g.hairStyle, valid)) g.hairStyle = pickR(rand, valid);

    /* children have no facial hair */
    if (isChild) { g.stache = 'none'; g.beard = 'none'; }

    /* a big nose belongs to an old face */
    if (g.noseKind === 'big' && !isOld) g.noseKind = 'hook';

    /* the bow needs hair to sit in, and a child or a soft persona to wear it */
    if (g.bow && (inList(g.hairStyle, HAT_STYLES) || inList(g.hairStyle, NO_BOW_STYLES))) g.bow = false;
    if (g.bow && !(isChild || soft > 0)) g.bow = false;

    /* earrings: soft personas only */
    if (g.earrings !== 'none' && g.gender === 'masc') g.earrings = 'none';

    /* numbers into their (age-dependent) ranges, gaze onto its five stops */
    var hw = headWRange(g.age), hr = headRatioRange(g.age);
    g.penW = clampNum(g.penW, 0.75, 1.45, 1);
    g.headW = clampNum(g.headW, hw[0], hw[1], (hw[0] + hw[1]) / 2);
    g.headRatio = clampNum(g.headRatio, hr[0], hr[1], (hr[0] + hr[1]) / 2);
    g.tilt = clampNum(g.tilt, -0.09, 0.09, 0);
    g.look = snapTo(clampNum(g.look, -1, 1, 0), LOOKS);

    return g;
  }

  // ─── Helpers: randomGenome ───

  /* randomGenome(rand) – rand is any () => [0,1). Weights follow faces.js so a
     sheet of random genomes keeps the original's balance. Always returns repaired. */
  function randomGenome(rand) {
    var age = wpickR(rand, { child: 1.2, young: 2.5, adult: 3, old: 2 });
    var gender = wpickR(rand, { masc: 1, fem: 1, neutral: 0.35 });
    var isChild = age === 'child', isOld = age === 'old';
    var soft = softOf(gender), rough = roughOf(gender);
    var expr = wpickR(rand, { neutral: 3, happy: 2.2, surprised: 0.7, sleepy: 0.7, grumpy: isChild ? 0.4 : 1, sly: 0.5 });

    var hairStyle = wpickR(rand, hairTable(age, soft, rough));
    var hairDark = chanceR(rand, isOld ? 0.2 : 0.55);

    var coloured = chanceR(rand, 0.62);
    var skinIdx = coloured && chanceR(rand, 0.85) ? riR(rand, 0, 6) : null;
    var washMode = chanceR(rand, 0.32) ? 'scribble' : 'flat';
    var hairFillIdx = riR(rand, 0, 3);
    var hairTintIdx = (coloured || chanceR(rand, 0.3)) && chanceR(rand, 0.7) ? riR(rand, 0, 3) : null;
    var hatWashIdx = (coloured || chanceR(rand, 0.35)) ? riR(rand, 0, 4) : null;

    var g = {
      age: age,
      gender: gender,
      expr: expr,
      hairStyle: hairStyle,
      hairDark: hairDark,
      hairFillIdx: hairFillIdx,
      hairTintIdx: hairTintIdx,
      skinIdx: skinIdx,
      washMode: washMode,
      hatWashIdx: hatWashIdx,
      accentIdx: riR(rand, 0, 2),
      inkIdx: riR(rand, 0, 5),
      penW: rfR(rand, 0.75, 1.45),
      headW: rfR(rand, headWRange(age)[0], headWRange(age)[1]),
      headRatio: isChild ? rfR(rand, 0.92, 1.1) : rfR(rand, 1.0, 1.3),
      tilt: rfR(rand, -0.09, 0.09),
      look: pickR(rand, [-1, -0.5, 0, 0, 0.5, 1]),
      eyeKind: wpickR(rand, { ring: 3, big: isChild ? 3 : 1, dot: isOld ? 2 : 1, mix: 0.6 }),
      browKind: wpickR(rand, { none: isChild ? 2 : 1.2, arc: 3, thick: 0.4 + 2.2 * rough }),
      noseKind: wpickR(rand, { hook: 3, button: isChild ? 3 : 0.3 + 1.5 * soft, straight: 1, big: isOld ? 1.5 * rough : 0 }),
      mouthKind: wpickR(rand, { flat: 2, smile: 1.5, lips: 1, open: 0.7, frown: 0.7, pout: 1.2 * soft, grin: isChild ? 1 : 0.4 }),
      stache: (!isChild && chanceR(rand, 0.45 * rough))
        ? wpickR(rand, { thin: 1, bushy: 1, handlebar: 0.6, walrus: isOld ? 1 : 0.2 }) : 'none',
      beard: (!isChild && chanceR(rand, 0.4 * rough))
        ? wpickR(rand, { stubble: 1.2, goatee: 1, full: 1 }) : 'none',
      eyewear: wpickR(rand, isChild ? { none: 7, round: 1, square: 0.3 }
        : isOld ? { none: 2.5, round: 2, square: 1.2, halfmoon: 2, pince: 0.4, monocle: 0.4 }
          : { none: 5, round: 1, square: 1, shades: 0.8, monocle: 0.25, pince: 0.25, cateye: soft }),
      bow: !inList(hairStyle, HAT_STYLES) && !inList(hairStyle, NO_BOW_STYLES)
        && (isChild || soft > 0) && chanceR(rand, 0.12 + 0.12 * soft),
      earrings: (soft > 0 && chanceR(rand, 0.45 * soft + 0.1))
        ? wpickR(rand, { stud: 1, hoop: 1, drop: 1 }) : 'none',
      wobbleSeed: (rand() * 4294967296) | 0,
    };
    return repair(g);
  }

  // ─── Helpers: hashing ───

  /* genomeHash(genome) – 8 hex chars of FNV-1a over the genome with sorted keys */
  function genomeHash(g) {
    var keys = Object.keys(g).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) parts.push(JSON.stringify(keys[i]) + ':' + JSON.stringify(g[keys[i]]));
    var s = '{' + parts.join(',') + '}';
    var h = 0x811c9dc5;
    for (var j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  // ─── Helpers: mutation ───

  /* p_base(generation) (spec §3.4): linear decay 0.35 at gen 2 down to 0.10 at gen 10,
     clamped outside that range so a stray generation number never explodes the rate. */
  function pBaseForGeneration(generation) {
    var g = (typeof generation === 'number' && isFinite(generation)) ? generation : 2;
    var p = 0.35 + (0.10 - 0.35) * (g - 2) / (10 - 2);
    return p < 0.10 ? 0.10 : p > 0.35 ? 0.35 : p;
  }

  /* pick a value from arr other than current; falls back to current if arr has nothing else */
  function pickOtherR(rand, arr, current) {
    var choices = arr.filter(function (v) { return v !== current; });
    return choices.length ? pickR(rand, choices) : current;
  }
  function pickNonNoneR(rand, arr) {
    var choices = arr.filter(function (v) { return v !== 'none'; });
    return choices.length ? pickR(rand, choices) : 'none';
  }
  /* uniform re-pick among 0..n-1 excluding current (non-nullable idx genes) */
  function idxOtherR(rand, n, current) {
    if (n <= 1) return 0;
    var choices = [];
    for (var i = 0; i < n; i++) if (i !== current) choices.push(i);
    return pickR(rand, choices);
  }
  /* uniform re-pick among {null, 0..n-1} excluding current (nullable idx genes) */
  function idxNullableOtherR(rand, n, current) {
    var choices = [null];
    for (var i = 0; i < n; i++) choices.push(i);
    choices = choices.filter(function (v) { return v !== current; });
    return choices.length ? pickR(rand, choices) : current;
  }
  /* step an idx gene 1-2 slots toward the hinted end (sign +1 = "darker"/higher index).
     A null current (uncoloured) starts from the middle of the array before stepping.
     Used for hairFillIdx/hairTintIdx only – hair-1..4 / tint-1..4 are stylistic
     variation tokens (not a lightness ramp), so "darker" is just a judgment-call
     convention (increasing raw index = darker), documented here for consistency
     with skinIdx below. skinIdx itself is NOT raw-index-ordered (see
     SKIN_DARKNESS_ORDER + stepSkinIdxToward) because the --skin-1..7 tokens are not
     in luminance order. */
  function stepIdxToward(rand, current, n, sign) {
    var base = (current === null || current === undefined) ? Math.floor((n - 1) / 2) : current;
    var step = riR(rand, 1, 2) * sign;
    var next = base + step;
    return next < 0 ? 0 : next > n - 1 ? n - 1 : next;
  }

  /* --skin-1..7 (style.css) are NOT in lightest->darkest order by raw index. Measured
     luminance (0.299R + 0.587G + 0.114B) of the current values:
       skin-1 #e9c2a6 -> 202.5   skin-2 #dca884 -> 179.4   skin-3 #caa07a -> 168.2
       skin-4 #b9855e -> 144.1   skin-5 #e6b9b0 -> 197.4   skin-6 #a36d4b -> 121.3
       skin-7 #7f5236 -> 92.3
     skin-5 (raw index 4) is nearly as light as skin-1, so a raw-index step from
     index 3 toward "darker" would land on a visibly lighter tone. SKIN_DARKNESS_ORDER
     lists raw indices sorted by that luminance, lightest first; stepSkinIdxToward
     steps 1-2 positions along THIS order, not along the raw index. The gene value
     stored on the genome stays the raw index (drawing code indexes SKINS directly).
     Maintenance note: if the --skin-N token values in style.css ever change, this
     order must be re-derived from their new luminance. */
  var SKIN_DARKNESS_ORDER = [0, 4, 1, 2, 3, 5, 6];
  function stepSkinIdxToward(rand, current, sign) {
    var order = SKIN_DARKNESS_ORDER, n = order.length;
    var pos = (current === null || current === undefined) ? Math.floor((n - 1) / 2) : order.indexOf(current);
    if (pos < 0) pos = Math.floor((n - 1) / 2);      // defensive: an out-of-table index falls back to the middle
    var step = riR(rand, 1, 2) * sign;
    var nextPos = pos + step;
    nextPos = nextPos < 0 ? 0 : nextPos > n - 1 ? n - 1 : nextPos;
    return order[nextPos];
  }

  /* mutateOneGene(g, name, direction, rand) – mutates g[name] in place. `direction` is
     the hinted direction string or null (non-hinted, or hinted with no direction word). */
  function mutateOneGene(g, name, direction, rand) {
    var desc = GENES[name];
    switch (name) {
      case 'age': {
        if (direction === 'older' || direction === 'younger') {
          var idx = AGES.indexOf(g.age);
          idx += direction === 'older' ? 1 : -1;
          g.age = AGES[idx < 0 ? 0 : idx > AGES.length - 1 ? AGES.length - 1 : idx];
        } else {
          g.age = pickOtherR(rand, AGES, g.age);
        }
        return;
      }
      case 'skinIdx': {
        if (direction === 'darker' || direction === 'lighter') {
          g.skinIdx = stepSkinIdxToward(rand, g.skinIdx, direction === 'darker' ? 1 : -1);
        } else {
          g.skinIdx = idxNullableOtherR(rand, desc.n, g.skinIdx);
        }
        return;
      }
      case 'hairFillIdx': case 'hairTintIdx': {
        var n = desc.n;
        if (direction === 'darker' || direction === 'lighter') {
          g[name] = stepIdxToward(rand, g[name], n, direction === 'darker' ? 1 : -1);
        } else if (desc.nullable) {
          g[name] = idxNullableOtherR(rand, n, g[name]);
        } else {
          g[name] = idxOtherR(rand, n, g[name]);
        }
        return;
      }
      case 'hairDark': {
        if (direction === 'darker') g.hairDark = true;
        else if (direction === 'lighter') g.hairDark = false;
        else g.hairDark = !g.hairDark;
        return;
      }
      case 'headW': {
        if (direction === 'wider') g.headW = g.headW * 1.10;
        else if (direction === 'narrower') g.headW = g.headW * 0.90;
        else { var rw = desc.range(g.age); g.headW = rfR(rand, rw[0], rw[1]); }
        return;
      }
      case 'headRatio': {
        if (direction === 'longer') g.headRatio = g.headRatio * 1.08;
        else if (direction === 'rounder') g.headRatio = g.headRatio * 0.92;
        else { var rr = desc.range(g.age); g.headRatio = rfR(rand, rr[0], rr[1]); }
        return;
      }
      case 'eyewear': {
        if (direction === 'add') g.eyewear = pickNonNoneR(rand, EYEWEARS);
        else if (direction === 'remove') g.eyewear = 'none';
        else g.eyewear = pickOtherR(rand, EYEWEARS, g.eyewear);
        return;
      }
      case 'stache': case 'beard': {
        /* "more"/"less" step along STACHES/BEARDS in their declared array order
           (none < thin < bushy < handlebar < walrus; none < stubble < goatee < full) –
           a judgment call for "amount of facial hair", same spirit as the skinIdx/
           hairFillIdx darker/lighter conventions documented above. */
        var domain = name === 'stache' ? STACHES : BEARDS;
        if (direction === 'add') g[name] = pickNonNoneR(rand, domain);
        else if (direction === 'remove') g[name] = 'none';
        else if (direction === 'more' || direction === 'less') {
          var di = domain.indexOf(g[name]);
          if (di < 0) di = 0;
          di += direction === 'more' ? 1 : -1;
          g[name] = domain[di < 0 ? 0 : di > domain.length - 1 ? domain.length - 1 : di];
        } else {
          g[name] = pickOtherR(rand, domain, g[name]);
        }
        return;
      }
      case 'hairStyle': {
        if (direction === 'longer' || direction === 'shorter') {
          var subset = direction === 'longer' ? HAIR_LONG : HAIR_SHORT;
          var valid = HAIR_VALID[g.age] || HAIR_VALID.adult;
          var pool = subset.filter(function (s) { return inList(s, valid); });
          if (!pool.length) pool = subset;
          g.hairStyle = pickOtherR(rand, pool, g.hairStyle);
        } else {
          g.hairStyle = pickOtherR(rand, HAIR_STYLES, g.hairStyle);
        }
        return;
      }
      default: {
        if (desc.type === 'cat') {
          g[name] = pickOtherR(rand, desc.values, g[name]);
        } else if (desc.type === 'bool') {
          g[name] = !g[name];
        } else if (desc.type === 'idx') {
          g[name] = desc.nullable ? idxNullableOtherR(rand, desc.n, g[name]) : idxOtherR(rand, desc.n, g[name]);
        } else if (desc.type === 'num') {
          var rg = desc.range(g.age);
          g[name] = rfR(rand, rg[0], rg[1]);
        }
        return;
      }
    }
  }

  /* mutate(genome, generation, hintedGenes, rand) (spec §3.4). hintedGenes is a
     Map(geneName -> direction-or-null); rand defaults to Math.random so callers can
     inject a seeded RNG for tests. Never mutates its input; always emits all gene
     keys (copies every GENE_NAMES key before touching anything, and returns a
     repair()-ed object, which itself rebuilds every key from scratch). */
  function mutate(genome, generation, hintedGenes, rand) {
    rand = rand || Math.random;
    hintedGenes = hintedGenes instanceof Map ? hintedGenes : new Map();
    var pBase = pBaseForGeneration(generation);
    var g = {};
    for (var i = 0; i < GENE_NAMES.length; i++) g[GENE_NAMES[i]] = genome[GENE_NAMES[i]];

    for (i = 0; i < GENE_NAMES.length; i++) {
      var name = GENE_NAMES[i];
      if (name === 'wobbleSeed') continue;             // handled separately below
      var hinted = hintedGenes.has(name);
      var p = hinted ? 0.8 : pBase;
      if (!chanceR(rand, p)) continue;
      mutateOneGene(g, name, hinted ? hintedGenes.get(name) : null, rand);
    }

    /* wobbleSeed re-rolls with p = 0.3 regardless of hints/decay (texture variety) */
    if (chanceR(rand, 0.3)) g.wobbleSeed = (rand() * 4294967296) | 0;

    return repair(g);
  }

  // ─── Helpers: AI hint mapping ───

  /* HINT_MAP (spec §4.2): trait -> the genes that hint boosts to p = 0.8 */
  var HINT_MAP = {
    age: ['age'],
    gender: ['gender'],
    expression: ['expr', 'mouthKind'],
    hair_style: ['hairStyle'],
    hair_length: ['hairStyle'],
    hair_color: ['hairDark', 'hairFillIdx', 'hairTintIdx'],
    skin_tone: ['skinIdx'],
    face_shape: ['headW', 'headRatio'],
    glasses: ['eyewear'],
    facial_hair: ['stache', 'beard'],
    eyes: ['eyeKind'],
    eyebrows: ['browKind'],
    nose: ['noseKind'],
    mouth: ['mouthKind'],
    gaze: ['look'],
    accessories: ['bow', 'earrings', 'hatWashIdx'],
  };

  var DIRECTION_WORDS = ['darker', 'lighter', 'older', 'younger', 'longer', 'shorter',
    'wider', 'narrower', 'rounder', 'add', 'remove', 'more', 'less'];

  /* hintsToGenes(hints) -> Map(geneName -> direction|null). `hints` is expected to be
     an array of {trait, suggestion} (spec §4.1); tolerant of garbage – a non-array
     input, a null/non-object entry, a non-string suggestion, or an unknown trait are
     all handled without throwing (the sanitizer proper is Task 6; this just maps). */
  function hintsToGenes(hints) {
    var map = new Map();
    if (!Array.isArray(hints)) return map;
    for (var i = 0; i < hints.length; i++) {
      var h = hints[i];
      if (!h || typeof h !== 'object') continue;
      var genes = HINT_MAP[h.trait];
      if (!genes) continue;                           // unknown trait: dropped
      var suggestion = (typeof h.suggestion === 'string') ? h.suggestion.toLowerCase() : '';
      var direction = null;
      for (var d = 0; d < DIRECTION_WORDS.length; d++) {
        if (suggestion.indexOf(DIRECTION_WORDS[d]) >= 0) { direction = DIRECTION_WORDS[d]; break; }
      }
      for (var j = 0; j < genes.length; j++) map.set(genes[j], direction);
    }
    return map;
  }

  // ─── Helpers: judge reply sanitizer (spec §4.3, Task 6) ───

  var MAX_HINT_SUGGESTION_CHARS = 80;
  var MAX_SANITIZED_HINTS = 4;      // matches the prompt's "at most 4 hints" contract (spec §4.1)

  /* extractFirstJsonObject(text) -> the substring of the first balanced {...} block,
     or null if text isn't a string or has no balanced brace pair. A balanced-brace
     scan (not a greedy regex) so a reply like `{"a":{"b":1}} trailing junk` still
     extracts exactly the outer object and stops at its matching close brace. The scan
     is string-aware (tracks JSON string spans and their \ escapes) so a stray brace
     inside a quoted suggestion – e.g. a suggestion value like `smile :}` – can never
     be mistaken for real object structure and reject an otherwise-valid reply. */
  function extractFirstJsonObject(text) {
    if (typeof text !== 'string') return null;
    var start = text.indexOf('{');
    while (start !== -1) {
      var depth = 0, inString = false, escaped = false;
      for (var i = start; i < text.length; i++) {
        var ch = text.charAt(i);
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
      start = text.indexOf('{', start + 1);           // this '{' never closed – try the next one
    }
    return null;
  }

  /* sanitizeJudgeReply(text) (spec §4.3) -> { best, hints } | null. Pure, Node-testable,
     exposed on the Genome namespace (not just app.js) so probes and Node tests reach it
     without a DOM. `best` must be an integer 1-9 or the WHOLE reply is rejected (null).
     `hints` is filtered to the known HINT_MAP trait vocabulary, every suggestion is
     coerced to a string and truncated to 80 chars, and the list itself is capped at
     MAX_SANITIZED_HINTS (4), matching the prompt's "at most 4 hints" contract. Never
     eval's anything; callers must still render hints via textContent only, never
     innerHTML. */
  function sanitizeJudgeReply(text) {
    var block = extractFirstJsonObject(text);
    if (!block) return null;
    var obj;
    try { obj = JSON.parse(block); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;

    var best = obj.best;
    if (typeof best !== 'number' || !isFinite(best) || Math.floor(best) !== best || best < 1 || best > 9) {
      return null;
    }

    var hints = [];
    if (Array.isArray(obj.hints)) {
      for (var i = 0; i < obj.hints.length; i++) {
        var h = obj.hints[i];
        if (!h || typeof h !== 'object') continue;
        if (typeof h.trait !== 'string' || !Object.prototype.hasOwnProperty.call(HINT_MAP, h.trait)) continue;
        var suggestion;
        if (typeof h.suggestion === 'string') suggestion = h.suggestion;
        else if (h.suggestion === null || h.suggestion === undefined) suggestion = '';
        else suggestion = String(h.suggestion);
        hints.push({ trait: h.trait, suggestion: suggestion.slice(0, MAX_HINT_SUGGESTION_CHARS) });
      }
    }

    return { best: best, hints: hints.slice(0, MAX_SANITIZED_HINTS) };
  }

  // ─── Helpers: generation 1 ───

  function checkStratification(pop) {
    var ages = {}, genders = {}, arches = {}, hasEw = false, hasNoEw = false;
    for (var i = 0; i < pop.length; i++) {
      var g = pop[i];
      ages[g.age] = true; genders[g.gender] = true; arches[hairArchetype(g.hairStyle)] = true;
      if (g.eyewear !== 'none') hasEw = true; else hasNoEw = true;
    }
    return AGES.every(function (a) { return ages[a]; })
      && genders.masc && genders.fem
      && Object.keys(arches).length >= 3
      && hasEw && hasNoEw;
  }

  /* initialPopulation(rand) (spec §3.5): 9 stratified repaired genomes, via bounded
     rejection sampling over randomGenome(), then a deterministic patch if rejection
     didn't converge (keeps the function fast and always-terminating). */
  function initialPopulation(rand) {
    rand = rand || Math.random;
    var pop, attempt;
    for (attempt = 0; attempt < 60; attempt++) {
      pop = [];
      for (var i = 0; i < 9; i++) pop.push(randomGenome(rand));
      if (checkStratification(pop)) return pop;
    }

    /* deterministic patch: force slots 0-3 across the four ages, 4-5 across the two
       required genders, 6-8 across the three hair archetypes, then plug any
       remaining eyewear gap. Every forced gene goes back through repair(). */
    for (i = 0; i < AGES.length; i++) pop[i] = repair(mergeGene(pop[i], 'age', AGES[i]));
    pop[4] = repair(mergeGene(pop[4], 'gender', 'masc'));
    pop[5] = repair(mergeGene(pop[5], 'gender', 'fem'));

    var archOrder = ['short', 'long', 'noneOrHat'];
    var archFallback = { short: 'bowl', long: 'long', noneOrHat: 'bald' };
    for (i = 0; i < archOrder.length; i++) {
      var slot = 6 + i, arch = archOrder[i];
      var valid = HAIR_VALID[pop[slot].age] || HAIR_VALID.adult;
      var candidates = valid.filter(function (s) { return hairArchetype(s) === arch; });
      var style = candidates.length ? candidates[0] : archFallback[arch];
      pop[slot] = repair(mergeGene(pop[slot], 'hairStyle', style));
    }

    var hasEw = false, hasNoEw = false;
    pop.forEach(function (g) { if (g.eyewear !== 'none') hasEw = true; else hasNoEw = true; });
    if (!hasEw) pop[0] = repair(mergeGene(pop[0], 'eyewear', 'round'));
    if (!hasNoEw) pop[1] = repair(mergeGene(pop[1], 'eyewear', 'none'));

    return pop;
  }
  function mergeGene(genome, key, value) {
    var out = {};
    for (var i = 0; i < GENE_NAMES.length; i++) out[GENE_NAMES[i]] = genome[GENE_NAMES[i]];
    out[key] = value;
    return out;
  }

  // ─── Helpers: generation loop step (Phase 10: population diversity) ───

  /* differsFromWinner(g, winner) -> true iff at least one NON-wobbleSeed gene differs.
     Deliberately a gene-by-gene comparison, not a genomeHash compare: genomeHash
     folds in wobbleSeed, and a wobbleSeed-only difference must NOT count as
     "differs" (spec §13/Task 11) since it never changes what the portrait looks like. */
  function differsFromWinner(g, winner) {
    for (var i = 0; i < GENE_NAMES.length; i++) {
      var name = GENE_NAMES[i];
      if (name === 'wobbleSeed') continue;
      if (g[name] !== winner[name]) return true;
    }
    return false;
  }

  var MUTANT_RETRY_ATTEMPTS = 5; // bounded re-mutate attempts before forcing a visible gene change

  /* makeDifferentMutant(winner, generation, hintedGenes, rand) -> a mutate() result
     GUARANTEED to differ from winner in >=1 non-wobbleSeed gene (spec §13/Task 11).
     Three bounded stages, so this always terminates:
       1. up to MUTANT_RETRY_ATTEMPTS plain mutate() calls – almost always enough.
       2. one forced single-gene change on top of the last attempt: the mutateOneGene
          helpers are themselves built to differ from "current" (pickOtherR/idxOtherR/
          bool-flip/etc.), so this succeeds even when stage 1 kept rolling no-ops.
          Prefers a hinted gene (the AI's suggested direction) so a forced change still
          reads as a "reasonable" mutation; falls back to a random non-wobbleSeed gene.
       3. defensive only, for the one gene (hairStyle) whose forced change can still be
          repair()-ed back to the original value: walk every remaining non-wobbleSeed
          gene name once, forcing each in turn, until one sticks. Bounded at
          GENE_NAMES.length iterations, so even this worst case always terminates. */
  function makeDifferentMutant(winner, generation, hintedGenes, rand) {
    var m;
    for (var attempt = 0; attempt < MUTANT_RETRY_ATTEMPTS; attempt++) {
      m = mutate(winner, generation, hintedGenes, rand);
      if (differsFromWinner(m, winner)) return m;
    }

    var hintedNames = [];
    if (hintedGenes instanceof Map) {
      hintedGenes.forEach(function (direction, name) {
        if (name !== 'wobbleSeed') hintedNames.push(name);
      });
    }
    var forceName = hintedNames.length ? pickR(rand, hintedNames)
      : GENE_NAMES.filter(function (n) { return n !== 'wobbleSeed'; })[Math.floor(rand() * (GENE_NAMES.length - 1))];
    var direction = (hintedGenes instanceof Map && hintedGenes.has(forceName)) ? hintedGenes.get(forceName) : null;
    mutateOneGene(m, forceName, direction, rand);
    m = repair(m);
    if (differsFromWinner(m, winner)) return m;

    for (var i = 0; i < GENE_NAMES.length; i++) {
      var name = GENE_NAMES[i];
      if (name === 'wobbleSeed') continue;
      var candidate = {};
      for (var k = 0; k < GENE_NAMES.length; k++) candidate[GENE_NAMES[k]] = m[GENE_NAMES[k]];
      mutateOneGene(candidate, name, null, rand);
      candidate = repair(candidate);
      if (differsFromWinner(candidate, winner)) return candidate;
    }
    return m; // exhausted every gene; return the last attempt rather than loop forever
  }

  /* shuffleParallelR(rand, a, b) – Fisher-Yates over `a`, applying the identical swap
     sequence to `b` so a population array and its parallel provenance-meta array stay
     aligned. Unbiased (every permutation equally likely), rand-driven so it's
     deterministic under a seeded rand and reproducible in Node tests. */
  function shuffleParallelR(rand, a, b) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var ta = a[i]; a[i] = a[j]; a[j] = ta;
      var tb = b[i]; b[i] = b[j]; b[j] = tb;
    }
  }

  /* nextPopulation(winner, generation, hintedGenes, rand) (spec §13/Task 11, supersedes
     the old §3.4 exact-elite scheme): returns 9 genomes with NO exact copy of the
     winner – 6 guaranteed-different mutants of the winner (see makeDifferentMutant
     above) + 3 fresh randomGenome() immigrants – positions shuffled so mutants and
     immigrants aren't distinguishable by placement. Pure – no DOM, no window/document
     – so both the app's real loop and the diversity probe (dev.html, no app.js) share
     this one code path.

     Provenance: returns { population, meta } rather than a companion
     Genome._internal.lastPopulationMeta – a return value keeps nextPopulation free of
     shared mutable state (no stale meta left over from a previous call, safe to call
     concurrently/in tests), matching the rest of this file's pure-function style. */
  function nextPopulation(winner, generation, hintedGenes, rand) {
    rand = rand || Math.random;
    var population = [], meta = [];
    for (var i = 0; i < 6; i++) {
      population.push(makeDifferentMutant(winner, generation, hintedGenes, rand));
      meta.push('mutant');
    }
    for (i = 0; i < 3; i++) {
      population.push(randomGenome(rand));
      meta.push('random');
    }
    shuffleParallelR(rand, population, meta);
    return { population: population, meta: meta };
  }

  // ─── Render: the marker box, resolved lazily so genome.js loads without a DOM ───

  function C() {
    if (!COLORS) {
      COLORS = {
        SKINS: toks('--skin', 7),
        HAIR_DARK: toks('--hair', 4),
        HAIR_TINT: toks('--tint', 4),
        HATS: toks('--hat', 5),
        ACCENTS: toks('--accent', 3),
        BLUSH: tok('--blush'),
        PAPER: tok('--canvas'),
      };
    }
    return COLORS;
  }

  // ─── Render: one face (adapted from faces.js, decisions lifted into the genome) ───

  /* helper: clip everything that follows to the inside of the head */
  function clipHead(F, fn) {
    var head = F.head;
    pen.ctx.save();
    tracePath(wobblePts(head, 1, true), true);
    pen.ctx.clip();
    fn();
    pen.ctx.restore();
  }

  /* curtain of hair behind the head, bottom at cy + ry*bottomK */
  function hairCurtain(F, bottomK) {
    var cx = F.cx, cy = F.cy, dark = F.dark, hairFill = F.hairFill, hairTint = F.hairTint, rx = F.rx, ry = F.ry;
    var wide = rx * rf(1.12, 1.3), bottom = cy + ry * bottomK;
    var pts = [[cx - wide, bottom], [cx - wide * 0.98, cy - ry * 0.15]];
    pts.push.apply(pts, arcPts(cx, cy - ry * 0.05, wide * 0.98, ry * 1.06, Math.PI, Math.PI * 2, 0.03, 12));
    pts.push([cx + wide * 0.98, cy - ry * 0.15], [cx + wide, bottom]);
    for (var i = 1; i < 6; i++) pts.push([cx + wide - wide * 2 * i / 6, bottom + rf(-6, 8)]);
    sketch(pts, { closed: true, fill: dark, fillColor: hairFill, wash: dark ? null : hairTint, wob: 1.6, width: 2.2 });
    for (var k = 0, n = ri(4, 9); k < n; k++) {           // loose strands down the sides
      var s = pick([-1, 1]), x0 = cx + s * rf(rx * 1.03, wide - 3);
      line(x0, cy - ry * rf(0, 0.5), x0 + s * rf(-2, 6), bottom - rf(6, 24), { wob: 1.6, width: 1.3, color: dark ? pen.base : pen.ink });
    }
  }

  /* a tapered hank of hair from (x0,y0) to (x1,y1), tied at the start */
  function tail(F, x0, y0, x1, y1, w) {
    var dark = F.dark, hairFill = F.hairFill, hairTint = F.hairTint;
    var dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
    var pts = [
      [x0 - nx * w * 0.5, y0 - ny * w * 0.5], [x0 + nx * w * 0.5, y0 + ny * w * 0.5],
      [x0 + dx * 0.5 + nx * w * 0.7, y0 + dy * 0.5 + ny * w * 0.7], [x1 + nx * w * 0.2, y1 + ny * w * 0.2],
      [x1 - nx * w * 0.3, y1 - ny * w * 0.3], [x0 + dx * 0.5 - nx * w * 0.6, y0 + dy * 0.5 - ny * w * 0.6]
    ];
    sketch(pts, { closed: true, fill: dark, fillColor: hairFill, wash: dark ? null : hairTint, wob: 1.4, width: 2 });
    for (var i = 0; i < 3; i++) {
      var t0 = rf(0.08, 0.3), t1 = rf(0.6, 0.95), off = rf(-w * 0.3, w * 0.3);
      line(x0 + dx * t0 + nx * off, y0 + dy * t0 + ny * off, x0 + dx * t1 + nx * off * 0.6, y0 + dy * t1 + ny * off * 0.6,
        { wob: 1.4, width: 1.3, color: dark ? pen.base : pen.ink });
    }
    line(x0 + dx * 0.06 - nx * w * 0.55, y0 + dy * 0.06 - ny * w * 0.55,
      x0 + dx * 0.06 + nx * w * 0.55, y0 + dy * 0.06 + ny * w * 0.55, { width: 2.6, wob: 0.6 });
  }

  /* a plait: two edges with a zigzag between, tied with a tuft at the end */
  function braid(F, x0, y0, x1, y1) {
    var dark = F.dark, hairFill = F.hairFill, hairTint = F.hairTint;
    var dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
    var n = Math.max(4, Math.round(L / 9));
    var strip = [[x0 + nx * 7, y0 + ny * 7], [x1 + nx * 4, y1 + ny * 4], [x1 - nx * 4, y1 - ny * 4], [x0 - nx * 7, y0 - ny * 7]];
    if (dark) sketch(strip, { closed: true, fill: true, fillColor: hairFill, wob: 1, width: 1.6 });
    else {
      if (hairTint) washPts(strip, hairTint);
      line(x0 + nx * 7, y0 + ny * 7, x1 + nx * 4, y1 + ny * 4, { width: 1.6 });
      line(x0 - nx * 7, y0 - ny * 7, x1 - nx * 4, y1 - ny * 4, { width: 1.6 });
    }
    var zig = [];
    for (var i = 0; i <= n; i++) { var t = i / n, s = i % 2 ? 1 : -1; zig.push([x0 + dx * t + nx * s * 4.5, y0 + dy * t + ny * s * 4.5]); }
    sketch(zig, { wob: 0.7, width: 1.6, color: dark ? pen.base : pen.ink });
    line(x1 - nx * 6, y1 - ny * 6, x1 + nx * 6, y1 + ny * 6, { width: 2.6, wob: 0.6 });
    for (var k = -1; k <= 1; k++) line(x1, y1, x1 + dx / L * 12 + nx * k * 5, y1 + dy / L * 12 + ny * k * 5, { width: 1.4 });
  }

  /* hair on the forehead: yAt(t) gives the hairline for t in [-1,1] across the head */
  function fringe(F, yAt, filled, sweep) {
    sweep = sweep || 0;
    var cx = F.cx, cy = F.cy, hairFill = F.hairFill, hairTint = F.hairTint, rx = F.rx, ry = F.ry;
    clipHead(F, function () {
      var edge = [];
      for (var i = 0; i <= 8; i++) { var t = -1 + i / 4; edge.push([cx + t * rx * 1.25, yAt(t) + rf(-3, 3)]); }
      if (filled && chance(0.35)) {               // scribbled dark hair: two directions of dense hatch
        var closedEdge = edge.concat([[cx + rx * 1.3, cy - ry * 1.6], [cx - rx * 1.3, cy - ry * 1.6]]);
        washPts(closedEdge, { color: hairFill, alpha: rf(0.25, 0.45), mode: 'flat', grow: 1 });
        sketch(edge, { wob: 1.5, width: 2.2 });
        var top = cy - ry * 1.05, bot = yAt(0) - 4, a1 = rf(0.5, 0.9), a2 = a1 + rf(1.2, 1.8);
        hatch(cx - rx, top, cx + rx, bot, ri(24, 40), a1, 20);
        hatch(cx - rx, top, cx + rx, bot, ri(18, 30), a2, 18);
      } else if (filled) {
        edge.push([cx + rx * 1.3, cy - ry * 1.6], [cx - rx * 1.3, cy - ry * 1.6]);
        sketch(edge, { closed: true, fill: true, fillColor: hairFill, wob: 1.5, width: 2 });
        if (chance(0.5))                          // shine lines in the black
          for (var j = 0; j < 3; j++) {
            var x = cx + rf(-rx * 0.5, rx * 0.5);
            line(x, cy - ry * 0.95, x + rf(-4, 4), yAt(0) - rf(8, 16), { wob: 0.6, width: 1.4, color: pen.base });
          }
      } else {
        if (hairTint) washPts(edge.concat([[cx + rx * 1.3, cy - ry * 1.6], [cx - rx * 1.3, cy - ry * 1.6]]), hairTint);
        sketch(edge, { wob: 1.5, width: 2 });
        hatch(cx - rx, cy - ry * 1.05, cx + rx, yAt(0) - 8, ri(14, 26), -Math.PI / 2 + sweep, 16);
      }
    });
  }

  function drawBow(F) {
    var accent = F.accent, cx = F.cx, hairTop = F.hairTop, rx = F.rx, ry = F.ry;
    var s = pick([-1, 1]), bx = cx + s * rx * 0.55, by = hairTop - ry * 0.1;
    var filled = chance(0.5);
    var bowWash = !filled && chance(0.7) ? accent : null;
    [-1, 1].forEach(function (d) {
      sketch([[bx, by], [bx + d * 13, by - 8], [bx + d * 12, by + 7]], { closed: true, fill: filled, wash: bowWash, wob: 1, width: 1.8 });
    });
    dot(bx, by, 3);
  }

  /* ----- back hair: drawn before the head, so the face covers it ----- */
  function faceBackHair(F) {
    var cx = F.cx, cy = F.cy, dark = F.dark, hairFill = F.hairFill, hairTint = F.hairTint, rx = F.rx, ry = F.ry, style = F.style;
    if (style === 'long') hairCurtain(F, rf(1.1, 1.4));
    else if (style === 'bob') hairCurtain(F, rf(0.55, 0.85));
    else if (style === 'afro') {
      var fro = blobPts(cx, cy - ry * 0.2, rx * 1.38, ry * 1.3, 0.05, 22);
      sketch(fro, { closed: true, fill: dark, fillColor: hairFill, wash: dark ? null : hairTint, wob: 2.2, width: 2.2 });
      penStyle(1.6, dark ? pen.base : pen.ink);
      fro.filter(function (_, i) { return !dark || i % 2 === 0; }).forEach(function (p) {   // curls along the rim
        var ix = p[0] + (cx - p[0]) * 0.06, iy = p[1] + (cy - ry * 0.2 - p[1]) * 0.06;
        pen.ctx.beginPath(); pen.ctx.arc(ix + rf(-3, 3), iy + rf(-3, 3), rf(3, 6), rf(0, 3), rf(4, 8)); pen.ctx.stroke();
      });
      if (!dark) stipple(cx, cy - ry * 0.3, rx * 1.25, ry * 1.1, ri(150, 300), 1.1);
    }
    else if (style === 'pigtails') [-1, 1].forEach(function (s) { tail(F, cx + s * rx * 0.92, cy - ry * 0.05, cx + s * rx * rf(1.15, 1.3), cy + ry * rf(0.7, 1.0), rf(14, 20)); });
    else if (style === 'ponytail') { var s2 = pick([-1, 1]); tail(F, cx + s2 * rx * 0.8, cy - ry * 0.7, cx + s2 * rx * rf(1.2, 1.35), cy + ry * rf(0.5, 1.0), rf(16, 22)); }
    else if (style === 'braids') [-1, 1].forEach(function (s) { braid(F, cx + s * rx * 0.9, cy - ry * 0.05, cx + s * rx * rf(1.1, 1.25), cy + ry * rf(1.0, 1.3)); });
  }

  /* ----- head (filled with paper so back hair stays behind it) ----- */
  function faceHead(F) {
    sketch(F.head, { closed: true, fill: true, fillColor: pen.base, wash: F.skinWash, wob: 1.2, width: rf(2.2, 3.4) });
    if (chance(0.35)) sketch(F.head, { closed: true, wob: 2, width: rf(0.9, 1.5) });   // a second, searching line
  }

  /* ----- neck, shoulders, collar ----- */
  function faceNeck(F) {
    var accent = F.accent, cx = F.cx, cy = F.cy, isChild = F.isChild, isOld = F.isOld, masc = F.masc,
      rough = F.rough, rx = F.rx, ry = F.ry, soft = F.soft, style = F.style;
    var hairBelowChin = ['long', 'pigtails', 'braids'].indexOf(style) >= 0;
    if (!hairBelowChin && chance(0.4)) {
      var chinY = cy + ry * 0.98, nW = rx * (isChild ? 0.25 : masc ? 0.38 : 0.3);
      var ny2 = chinY + ry * rf(0.12, 0.2), shW = rx * rf(1.15, 1.3);
      [-1, 1].forEach(function (s) {
        line(cx + s * nW, chinY - 4, cx + s * nW, ny2, { width: 2 });
        sketch([[cx + s * nW, ny2], [cx + s * (nW + 10), ny2 + 4], [cx + s * shW, ny2 + 16]], { width: 2.2, wob: 1.2 });
      });
      if (isOld && chance(0.6)) for (var i = 0; i < 2; i++) { var y = chinY + 6 + i * 7; line(cx - nW + 3, y, cx + nW - 3, y + rf(-1, 2), { width: 1.1, wob: 0.8 }); }
      var collar = wpick({ none: 1.5, vneck: 1, crew: 1, tie: isChild ? 0.1 : rough, bowtie: 0.5, necklace: 1.2 * soft });
      if (collar === 'vneck') [-1, 1].forEach(function (s) { line(cx + s * (nW + 4), ny2, cx, ny2 + 18, { width: 2 }); });
      else if (collar === 'crew') arc(cx, ny2 - 2, nW + 4, 0.1, Math.PI - 0.1, { width: 2 });
      else if (collar === 'tie') {
        [-1, 1].forEach(function (s) { line(cx + s * (nW + 4), ny2, cx + s * 5, ny2 + 6, { width: 2 }); });
        sketch([[cx - 4, ny2 + 4], [cx + 4, ny2 + 4], [cx + 5, ny2 + 24], [cx, ny2 + 30], [cx - 5, ny2 + 24]], { closed: true, fill: chance(0.4), wash: chance(0.7) ? accent : null, width: 1.8, wob: 0.8 });
      } else if (collar === 'bowtie') {
        var f = chance(0.4), w = !f && chance(0.7) ? accent : null;
        [-1, 1].forEach(function (d) { sketch([[cx, ny2 + 5], [cx + d * 12, ny2 - 1], [cx + d * 12, ny2 + 11]], { closed: true, fill: f, wash: w, wob: 0.8, width: 1.8 }); });
        dot(cx, ny2 + 5, 2.5);
      } else if (collar === 'necklace') {
        for (var a = 0.15; a < Math.PI - 0.1; a += 0.18) dot(cx + Math.cos(a) * (nW + 10), ny2 - 4 + Math.sin(a) * 16, 1.6);
        if (chance(0.5)) dot(cx, ny2 + 14, 3);
      }
    }
  }

  /* ----- front hair & headwear ----- */
  function faceFrontHair(F) {
    var accent = F.accent, bangsLine = F.bangsLine, bow = F.bow, cx = F.cx, cy = F.cy, dark = F.dark,
      eyeY = F.eyeY, flatLine = F.flatLine, hairFill = F.hairFill, hairTint = F.hairTint, hairTop = F.hairTop,
      hatWash = F.hatWash, isOld = F.isOld, look = F.look, middlePart = F.middlePart, partDir = F.partDir,
      rx = F.rx, ry = F.ry, sidePart = F.sidePart, soft = F.soft, style = F.style;
    var i, n, t, x, y;
    if (style === 'bowl') fringe(F, flatLine, true);
    else if (style === 'bangs') fringe(F, bangsLine, dark);
    else if (style === 'sidepart') fringe(F, sidePart, dark, partDir * 0.5);
    else if (style === 'long' || style === 'bob') fringe(F, pick([middlePart, bangsLine, sidePart]), dark, chance(0.5) ? partDir * 0.4 : 0);
    else if (style === 'ponytail' || style === 'braids') fringe(F, pick([middlePart, sidePart]), dark, partDir * 0.3);
    else if (style === 'pigtails') fringe(F, pick([bangsLine, middlePart]), dark);
    else if (style === 'bun') {
      fringe(F, pick([middlePart, sidePart, flatLine]), dark);
      var bx = cx + rf(-0.35, 0.35) * rx, by = cy - ry * 1.08, br = rx * rf(0.26, 0.36);
      sketch(blobPts(bx, by, br, br * 0.85, 0.1, 12), { closed: true, fill: true, fillColor: dark ? hairFill : pen.base, wash: dark ? null : hairTint, wob: 1.5, width: 2 });
      if (!dark) for (i = 0; i < 4; i++) arc(bx + rf(-3, 3), by + rf(-3, 3), br * rf(0.3, 0.7), rf(0, 3), rf(3, 6), { width: 1.3 });
      if (isOld) for (i = 0; i < 4; i++) { var sb = pick([-1, 1]); line(bx + sb * br * 0.8, by + rf(-4, 4), bx + sb * (br + rf(6, 14)), by + rf(-10, 8), { width: 1.2 }); }
    }
    else if (style === 'afro') {
      if (dark) fringe(F, flatLine, true);
      else { penStyle(1.6); for (i = 0; i < 10; i++) { t = -1 + i / 4.5; pen.ctx.beginPath(); pen.ctx.arc(cx + t * rx * 0.9, hairTop + rf(-3, 3), rf(3, 5.5), rf(0, 3), rf(4, 8)); pen.ctx.stroke(); } }
    }
    else if (style === 'spiky' || style === 'shaggy') {
      n = ri(14, 24);
      var sweep = rf(-0.5, 0.5);
      for (i = 0; i < n; i++) {
        t = i / n;
        var a = Math.PI + t * Math.PI;   // across the crown
        x = cx + Math.cos(a) * rx * 0.95; y = cy + Math.sin(a) * ry * 0.9;
        var l = rf(10, style === 'shaggy' ? 34 : 22);
        line(x, y, x + Math.cos(a + sweep) * l * 0.6, y + Math.sin(a) * l, { wob: 1, width: rf(1.2, 2) });
      }
      if (style === 'shaggy') hatch(cx - rx * 0.8, cy - ry, cx + rx * 0.8, hairTop, ri(10, 20), rf(-0.4, 0.4) - Math.PI / 2, 16);
    }
    else if (style === 'curly') {
      n = ri(12, 22);
      penStyle(1.6);
      for (i = 0; i < n; i++) {
        var ac = Math.PI + (i / n) * Math.PI + rf(-0.1, 0.1);
        x = cx + Math.cos(ac) * rx * rf(0.8, 1.02);
        y = cy + Math.sin(ac) * ry * rf(0.8, 1.02);
        pen.ctx.beginPath(); pen.ctx.arc(x, y, rf(3, 6.5), rf(0, 3), rf(4, 8)); pen.ctx.stroke();
      }
      if (soft > 0 && chance(0.5)) clipHead(F, function () { for (var i2 = 0; i2 < 8; i2++) { var t2 = -1 + i2 / 3.5; pen.ctx.beginPath(); pen.ctx.arc(cx + t2 * rx * 0.85, hairTop + rf(-4, 4), rf(3, 5), rf(0, 3), rf(4, 8)); pen.ctx.stroke(); } });
    }
    else if (style === 'buzz') {
      clipHead(F, function () { stipple(cx, hairTop - ry * 0.28, rx * 0.95, ry * 0.4, ri(120, 260), 1); });
      arc(cx, hairTop + 2, rx * 0.9, Math.PI * 1.05, Math.PI * 1.95, { width: 1.6, wob: 1 });
    }
    else if (style === 'comb') {
      clipHead(F, function () {
        var dir = pick([-1, 1]);
        for (var i2 = 0, n2 = ri(8, 14); i2 < n2; i2++) {
          var y2 = cy - ry + rf(0, ry * 0.55);
          line(cx - dir * rx, y2 + rf(-3, 3), cx + dir * rx * 0.9, y2 + rf(6, 18), { wob: 1.6, width: rf(1.2, 2) });
        }
      });
    }
    else if (style === 'bald') {
      if (chance(0.6)) hatch(cx - rx * 0.5, cy - ry * 1.05, cx + rx * 0.5, cy - ry * 0.8, ri(3, 7), -Math.PI / 2, 10);
      if (isOld && chance(0.7))                      // grey fuzz round the sides
        [-1, 1].forEach(function (s) {
          for (var i2 = 0, n2 = ri(4, 8); i2 < n2; i2++) {
            var y2 = rf(cy - ry * 0.35, cy + ry * 0.15);
            var x2 = cx + s * Math.sqrt(Math.max(0, 1 - Math.pow((y2 - cy) / ry, 2))) * rx;
            line(x2 - s * 4, y2, x2 + s * rf(6, 14), y2 + rf(2, 10), { width: 1.3, wob: 1.2 });
          }
        });
    }
    else if (style === 'wisps') {                 // thin hair at the temples, bare on top
      [-1, 1].forEach(function (s) {
        for (var i2 = 0, n2 = ri(5, 10); i2 < n2; i2++) {
          var y2 = rf(hairTop, cy + ry * 0.15);
          var x2 = cx + s * Math.sqrt(Math.max(0, 1 - Math.pow((y2 - cy) / ry, 2))) * rx;
          line(x2 - s * rf(0, 6), y2, x2 + s * rf(8, 20), y2 + rf(4, 14), { width: rf(1.2, 1.8), wob: 1.4 });
        }
      });
      if (chance(0.6)) for (i = 0, n = ri(2, 5); i < n; i++) { x = cx + rf(-rx * 0.4, rx * 0.4); line(x, cy - ry * 0.98, x + rf(-6, 6), cy - ry - rf(8, 18), { width: 1.3, wob: 1.2 }); }
    }
    else if (style === 'mohawk') {
      clipHead(F, function () { [-1, 1].forEach(function (s) { stipple(cx + s * rx * 0.6, cy - ry * 0.55, rx * 0.45, ry * 0.4, ri(50, 90), 1); }); });
      for (i = 0, n = ri(10, 16); i < n; i++) {
        t = -1 + 2 * i / n; x = cx + t * rx * 0.32;
        var yTop = cy - Math.sqrt(Math.max(0, 1 - Math.pow(t * 0.32, 2))) * ry;
        line(x, yTop + 2, x + rf(-4, 4), yTop - rf(18, 34), { width: rf(1.5, 2.4), wob: 1 });
      }
    }
    else if (style === 'cap') {                   // flat tweed cap
      var capY = Math.min(hairTop, eyeY - 26) - rf(0, 8);   // sit above the brows
      var crown = arcPts(cx, capY - ry * 0.25, rx * 1.08, ry * 0.55, Math.PI * 0.9, Math.PI * 2.1, 0.06, 14);
      crown.push([cx + rx * 1.15, capY + 4], [cx - rx * 1.15, capY + 4]);
      sketch(crown, { closed: true, fill: true, fillColor: pen.base, wash: hatWash, wob: 1.4, width: 2.2 });
      stipple(cx, capY - ry * 0.3, rx * 0.85, ry * 0.32, ri(80, 160), 0.9);
      var dirC = look >= 0 ? 1 : -1;             // brim toward gaze
      sketch([[cx + dirC * rx * 0.2, capY + 3], [cx + dirC * rx * 1.15, capY + rf(0, 6)], [cx + dirC * rx * 0.9, capY + rf(10, 14)], [cx + dirC * rx * 0.1, capY + 8]],
        { closed: true, fill: true, fillColor: pen.base, wash: hatWash && Object.assign({}, hatWash, { mode: 'flat' }), width: 2.2 });
    }
    else if (style === 'beanie') {
      var byB = hairTop + rf(-4, 6);
      var dome = arcPts(cx, byB - 6, rx * 1.02, ry * 0.72, Math.PI, Math.PI * 2, 0.05, 14);
      dome.push([cx + rx * 1.02, byB], [cx - rx * 1.02, byB]);
      sketch(dome, { closed: true, fill: true, fillColor: pen.base, wash: hatWash, wob: 1.4, width: 2.2 });
      if (chance(0.5)) stipple(cx, byB - ry * 0.35, rx * 0.8, ry * 0.3, ri(60, 120), 0.9);
      else hatch(cx - rx * 0.8, byB - ry * 0.65, cx + rx * 0.8, byB - 4, ri(15, 30), rf(0.5, 1.1), 12);
      /* ribbed band */
      sketch([[cx - rx * 1.02, byB], [cx + rx * 1.02, byB]], { width: 2.4, wob: 1.6 });
      sketch([[cx - rx * 1.05, byB + 14], [cx + rx * 1.05, byB + 14]], { width: 2.4, wob: 1.6 });
      for (x = cx - rx * 0.95; x < cx + rx * 0.95; x += rf(6, 10)) line(x, byB + 1, x + rf(-2, 2), byB + 13, { wob: 0.8, width: 1.4 });
      if (chance(0.4)) { var py = byB - 6 - ry * 0.72; sketch(blobPts(cx, py, 9, 8, 0.12, 10), { closed: true, fill: true, fillColor: pen.base, width: 1.8 }); stipple(cx, py, 7, 6, 18, 0.8); }
    }
    else if (style === 'band') {                  // headband + dark hair above
      var byH = hairTop + rf(0, 8);
      clipHead(F, function () { sketch([[cx - rx * 1.2, byH - 10], [cx + rx * 1.2, byH - 10], [cx + rx * 1.2, cy - ry * 1.5], [cx - rx * 1.2, cy - ry * 1.5]], { closed: true, fill: true, fillColor: hairFill, wob: 1.5, width: 2 }); });
      sketch([[cx - rx * 1.02, byH - 10], [cx + rx * 1.02, byH - 10], [cx + rx * 1.02, byH], [cx - rx * 1.02, byH]], { closed: true, taper: false, width: 0.1, wash: hatWash && accent });
      sketch([[cx - rx * 1.02, byH], [cx + rx * 1.02, byH - rf(0, 4)]], { width: 3, wob: 1.6 });
      sketch([[cx - rx * 1.02, byH - 10], [cx + rx * 1.02, byH - 12]], { width: 3, wob: 1.6 });
    }
    else if (style === 'fedora') {
      var byF = Math.min(hairTop, eyeY - 28) - rf(2, 8);   // brim clear of the brows
      var crownF = arcPts(cx, byF, rx * 0.95, ry * 0.78, Math.PI, Math.PI * 2, 0.04, 12);
      crownF.push([cx + rx * 0.95, byF + 2], [cx - rx * 0.95, byF + 2]);
      sketch(crownF, { closed: true, fill: true, fillColor: pen.base, wash: hatWash, wob: 1.3, width: 2.2 });
      arc(cx, byF - ry * 0.72, rx * 0.22, Math.PI * 0.15, Math.PI * 0.85, { width: 1.6 });   // pinch
      line(cx - rx * 0.95, byF - 10, cx + rx * 0.95, byF - 12, { width: 3 });                  // band
      sketch([[cx - rx * 1.5, byF + rf(-4, 2)], [cx, byF - 5], [cx + rx * 1.5, byF + rf(-4, 2)], [cx, byF + 9]],
        { closed: true, fill: true, fillColor: pen.base, wash: hatWash && Object.assign({}, hatWash, { mode: 'flat' }), wob: 1.4, width: 2.2 });
    }
    else if (style === 'beret') {
      if (chance(0.6)) fringe(F, flatLine, dark);
      var sBe = pick([-1, 1]), bxBe = cx + sBe * rx * 0.15, byBe = hairTop - ry * 0.38;
      sketch(blobPts(bxBe, byBe, rx * 1.22, ry * 0.45, 0.07, 16), { closed: true, fill: true, fillColor: pen.base, wash: hatWash, wob: 1.5, width: 2.2 });
      line(bxBe, byBe - ry * 0.44, bxBe + 2, byBe - ry * 0.44 - 8, { width: 2 });
    }
    else if (style === 'headscarf') {
      var outer = arcPts(cx, cy - ry * 0.05, rx * 1.22, ry * 1.22, Math.PI * 0.85, Math.PI * 2.15, 0.03, 16);
      var inner = [[cx + rx * 1.0, cy + ry * 0.35], [cx + rx * 0.97, cy - ry * 0.3], [cx + rx * 0.55, hairTop - 8], [cx, hairTop - 14],
        [cx - rx * 0.55, hairTop - 8], [cx - rx * 0.97, cy - ry * 0.3], [cx - rx * 1.0, cy + ry * 0.35]];
      sketch(outer.concat(inner), { closed: true, fill: true, fillColor: pen.base, wash: hatWash, wob: 1.4, width: 2.2 });
      if (chance(0.6)) for (i = 0; i < 70; i++) {       // polka dots on the band
        var aH = rf(Math.PI * 0.85, Math.PI * 2.15), d = rf(0, 1);
        x = cx + Math.cos(aH) * rx * 1.18 * d; y = cy - ry * 0.05 + Math.sin(aH) * ry * 1.18 * d;
        var onFace = Math.pow((x - cx) / rx, 2) + Math.pow((y - cy) / ry, 2) < 1 && y > hairTop - 14;
        if (!onFace) dot(x, y, 1.3);
      }
      var ky = cy + ry * 1.02;                              // knot under the chin
      arc(cx - 7, ky + 5, 6, 0, Math.PI * 2, { width: 1.8, wob: 0.8 });
      arc(cx + 7, ky + 5, 6, 0, Math.PI * 2, { width: 1.8, wob: 0.8 });
      line(cx - 4, ky + 9, cx - 12, ky + 24, { width: 1.8 });
      line(cx + 4, ky + 9, cx + 12, ky + 24, { width: 1.8 });
    }
    if (bow) drawBow(F);
  }

  /* ----- ears : little "C" marks on the cheeks ----- */
  function faceEars(F) {
    var cx = F.cx, cy = F.cy, isChild = F.isChild, look = F.look, rx = F.rx, ry = F.ry,
      shift = F.shift, skinWash = F.skinWash, style = F.style;
    var earY = cy + ry * rf(-0.05, 0.12);
    var earR = isChild ? rf(6, 9) : rf(6, 11);
    var hideEars = ['long', 'bob', 'afro', 'headscarf'].indexOf(style) >= 0 && chance(0.85);
    /* the ear on the side the face turns toward slips out of view */
    var leftEar = !hideEars && look >= -0.5 && (look < 0.5 || chance(0.8));
    var rightEar = !hideEars && look <= 0.5 && (look > -0.5 || chance(0.8));
    /* two kinds of ear: the quick "C" on the cheek, or a real ear sticking
       out of the head's silhouette (paper-filled, washed like the skin) */
    var earOut = !hideEars && chance(0.55);
    var earPos = {};                            // where each ear ends up, for the earrings
    [[leftEar, -1], [rightEar, 1]].forEach(function (pair) {
      var on = pair[0], s = pair[1];
      if (!on) return;
      if (earOut) {
        var r = earR * 1.25;
        /* the head's edge at ear height, then the ear hangs off it */
        var edgeX = cx + s * rx * Math.sqrt(Math.max(0.2, 1 - Math.pow((earY - cy) / ry, 2))) + shift * 0.25;
        var ex = edgeX + s * r * 0.55;
        var ear = blobPts(ex, earY, r * 0.75, r * 1.05, 0.1, 10);
        sketch(ear, { closed: true, fill: true, fillColor: pen.base, wash: skinWash && Object.assign({}, skinWash, { grow: 1, dx: s * 2, dy: 1, mode: 'flat' }), width: rf(1.8, 2.4), wob: 0.9 });
        arc(ex + s * r * 0.1, earY + r * 0.1, r * 0.45, s > 0 ? -Math.PI * 0.6 : Math.PI * 0.4, s > 0 ? Math.PI * 0.5 : Math.PI * 1.6, { width: 1.3, wob: 0.6 });   // the inner fold
        earPos[s] = [ex, earY + r * 1.05];
      } else {
        var x = cx + s * rx * 0.55 + shift * 0.4;
        if (s < 0) arc(x, earY, earR, Math.PI * 0.6, Math.PI * 1.5, { width: 1.8, wob: 0.8 });
        else arc(x, earY, earR, -Math.PI * 0.5, Math.PI * 0.45, { width: 1.8, wob: 0.8 });
        earPos[s] = [x, earY + earR];
      }
    });
    if (F.earrings !== 'none') {                 // earrings: the kind is a gene
      var kind = F.earrings;
      [[leftEar, -1], [rightEar, 1]].forEach(function (pair) {
        var on = pair[0], s = pair[1];
        if (!on) return;
        var p = earPos[s], x = p[0], y = p[1];
        if (kind === 'stud') dot(x, y, 2.2);
        else if (kind === 'hoop') arc(x, y + 4, rf(3, 5), 0, Math.PI * 2, { width: 1.6, wob: 0.6 });
        else { line(x, y, x + rf(-2, 2), y + rf(8, 14), { width: 1.3 }); dot(x, y + 14, 2.5); }
      });
    }
  }

  /* ----- eyes ----- */
  function faceEyes(F) {
    var exL = F.exL, exR = F.exR, expr = F.expr, eyeY = F.eyeY, isChild = F.isChild, isOld = F.isOld,
      look = F.look, soft = F.soft;
    var eyeKind = F.eyeKind;                     // gene; the expr ladder still applies on top
    if (expr === 'happy' && chance(0.45)) eyeKind = 'wink2';
    if (expr === 'surprised') eyeKind = 'big';
    if (expr === 'sleepy') eyeKind = 'closed';
    if (expr === 'sly') eyeKind = 'wink';
    if (isOld && eyeKind === 'big') eyeKind = 'ring';
    var lashes = chance(0.85 * soft);

    function eye(x, kind, s, side) {
      if (kind === 'dot') { dot(x, eyeY, rf(2, 3.2) * (isChild ? 1.3 : 1)); return; }
      if (kind === 'wink') { arc(x, eyeY, rf(5, 8), 0.15, Math.PI - 0.15, { width: 2 }); return; }
      var r;
      if (kind === 'closed') {
        r = rf(5, 8);
        arc(x, eyeY, r, Math.PI + 0.15, Math.PI * 2 - 0.15, { width: 2 });
      } else {
        r = (kind === 'big' ? rf(10, 16) : rf(5.5, 9)) * s * (isOld ? 0.85 : 1);
        arc(x, eyeY, r, 0, Math.PI * 2, { width: 1.8, wob: 0.9 });
        var px = x + look * r * 0.35 + rf(-1, 1), py = eyeY + rf(-1, 2);
        dot(px, py, Math.max(1.6, r * (isChild ? rf(0.35, 0.5) : rf(0.22, 0.4))));
        if (isChild && kind === 'big' && chance(0.5)) dot(px - r * 0.15, py - r * 0.15, Math.max(0.8, r * 0.09), pen.base);  // sparkle
      }
      if (lashes) {                                 // three ticks on the outer upper rim
        var base = side < 0 ? Math.PI * 1.12 : Math.PI * 1.58;
        for (var k = 0; k < 3; k++) {
          var a = base + k * 0.15;
          line(x + Math.cos(a) * r, eyeY + Math.sin(a) * r, x + Math.cos(a) * (r + 5), eyeY + Math.sin(a) * (r + 5), { width: 1.4, wob: 0.5 });
        }
      }
      if (isOld) {
        if (chance(0.6)) arc(x, eyeY + 1, r + 3.5, Math.PI * 1.1, Math.PI * 1.9, { width: 1.3, wob: 0.8 });   // heavy lid
        if (chance(0.5)) arc(x, eyeY + 2, r + 4.5, Math.PI * 0.2, Math.PI * 0.8, { width: 1.1, wob: 0.8 });   // bag
      }
    }
    if (eyeKind === 'mix') { eye(exL, 'ring', rf(0.7, 1), -1); eye(exR, pick(['big', 'dot', 'wink']), 1, 1); }
    else if (eyeKind === 'wink') { eye(exL, 'wink', 1, -1); eye(exR, 'ring', 1, 1); }
    else if (eyeKind === 'wink2') { eye(exL, 'wink', 1, -1); eye(exR, 'wink', 1, 1); }
    else { var s2 = rf(0.75, 1.3); eye(exL, eyeKind, 1, -1); eye(exR, eyeKind, s2, 1); }
  }

  /* ----- eyebrows ----- */
  function faceBrows(F) {
    var exL = F.exL, exR = F.exR, expr = F.expr, eyeY = F.eyeY, isOld = F.isOld, soft = F.soft;
    var browKind = F.browKind;                   // gene; the expr ladder still applies on top
    if (expr === 'grumpy') browKind = 'angry';
    if (expr === 'surprised') browKind = 'raised';
    if (isOld && browKind !== 'none' && chance(0.45)) browKind = 'bushy';
    if (browKind !== 'none') {
      var lift = browKind === 'raised' ? 8 : soft > 0.5 ? 3 : 0;
      var by = eyeY - rf(11, 18) - lift;
      var bw = browKind === 'thick' || browKind === 'bushy' ? rf(3, 5) : soft > 0.5 ? 1.6 : 2;
      [[exL, -1], [exR, 1]].forEach(function (pair) {
        var ex = pair[0], s = pair[1];
        if (browKind !== 'angry' && !chance(0.8)) return;
        if (browKind === 'angry') line(ex - s * 9, by + 8, ex + s * 9, by + 1, { width: 2.6 });
        else arc(ex, by + 4, rf(8, 12) * (browKind === 'raised' ? 1.2 : 1), Math.PI * 1.15, Math.PI * 1.85, { width: bw });
        if (browKind === 'bushy') hatch(ex - 9, by - 8, ex + 9, by + 2, ri(5, 9), -Math.PI / 2 + s * 0.5, 7);
      });
    }
  }

  /* ----- nose ----- */
  function faceNose(F) {
    var cx = F.cx, eyeY = F.eyeY, isChild = F.isChild, look = F.look, ry = F.ry, shift = F.shift;
    var noseKind = F.noseKind;                   // gene (repair keeps 'big' for old faces only)
    var nx = cx + shift * 1.4, nTop = eyeY + rf(2, 8);
    var nLen = ry * (isChild ? rf(0.14, 0.24) : rf(0.22, 0.4)) * (noseKind === 'big' ? 1.2 : 1);
    var hookDir = pick([-1, 1]);
    var hook = hookDir * rf(4, 12) * (noseKind === 'big' ? 1.5 : 1) + look * 6;
    if (noseKind === 'button') {
      arc(nx + look * 3, nTop + nLen * 0.8, rf(3.5, 5.5), Math.PI * 0.15, Math.PI * 0.85, { width: 1.8 });
      if (chance(0.4)) line(nx + look * 3, nTop, nx + look * 3 + hookDir * 2, nTop + nLen * 0.6, { width: 1.4 });
    } else if (noseKind === 'straight') {
      line(nx, nTop, nx + look * 4, nTop + nLen, { width: 2, wob: 0.8 });
      line(nx + look * 4, nTop + nLen, nx + look * 4 + hookDir * 7, nTop + nLen + 1, { width: 2, wob: 0.8 });
    } else {
      sketch([[nx + rf(-2, 2), nTop], [nx + hook * 0.3, nTop + nLen * 0.7], [nx + hook, nTop + nLen]], { width: noseKind === 'big' ? 2.4 : 2, wob: 1 });
      if (chance(0.5)) arc(nx + hook * 0.4, nTop + nLen + 1, 3, 0, Math.PI, { width: 1.6 });  // nostril curl
      if (noseKind === 'big') arc(nx - hook * 0.4, nTop + nLen + 1, 3, 0, Math.PI, { width: 1.6 });
    }
    Object.assign(F, { nLen: nLen, nTop: nTop, nx: nx });
  }

  /* ----- mouth & facial hair ----- */
  function faceMouth(F) {
    var cx = F.cx, cy = F.cy, expr = F.expr, isChild = F.isChild, isOld = F.isOld, nLen = F.nLen,
      nTop = F.nTop, rx = F.rx, ry = F.ry, shift = F.shift, soft = F.soft;
    var mY = nTop + nLen + rf(12, 20) * (isChild ? 0.85 : 1);
    var mx = cx + shift;
    var mS = isChild ? 0.75 : 1;                 // mouth scale
    var mouthKind = F.mouthKind;                 // gene; the expr ladder still applies on top
    if (expr === 'happy') mouthKind = chance(0.7) ? 'smile' : 'grin';
    if (expr === 'surprised') mouthKind = 'open';
    if (expr === 'sleepy') mouthKind = 'flat';
    if (expr === 'grumpy') mouthKind = 'frown';
    if (expr === 'sly') mouthKind = 'smile';
    var stache = F.stache;                       // gene (repair keeps children clean-shaven)
    var beard = F.beard;                         // gene
    var grey = isOld && chance(0.75);

    if (stache === 'bushy') {
      sketch([[mx - rf(14, 20), mY - 4], [mx, mY - rf(8, 11)], [mx + rf(14, 20), mY - 4], [mx, mY - 2]], { closed: true, fill: !grey, width: 2, wob: 1 });
      if (grey) hatch(mx - 14, mY - 9, mx + 14, mY - 3, 14, Math.PI / 2, 5);
    } else if (stache === 'thin') {
      arc(mx - 7, mY - 4, 7, Math.PI * 1.1, Math.PI * 1.9, { width: 1.6 });
      arc(mx + 7, mY - 4, 7, Math.PI * 1.1, Math.PI * 1.9, { width: 1.6 });
    } else if (stache === 'handlebar') {
      arc(mx - 10, mY - 6, 9, Math.PI * 0.9, Math.PI * 1.9, { width: 2.4 });
      arc(mx + 10, mY - 6, 9, Math.PI * 1.1, Math.PI * 2.1, { width: 2.4 });
    } else if (stache === 'walrus') {
      sketch([[mx - 22, mY + 2], [mx, mY - 9], [mx + 22, mY + 2], [mx + 14, mY + 7], [mx, mY + 2], [mx - 14, mY + 7]], { closed: true, fill: !grey, width: 2, wob: 1.2 });
      if (grey) hatch(mx - 18, mY - 7, mx + 18, mY + 4, 24, Math.PI / 2 + rf(-0.2, 0.2), 7);
    }

    if (mouthKind === 'open') {
      sketch(blobPts(mx, mY + 4, rf(6, 10) * mS, rf(4, 7) * mS, 0.1, 10), { closed: true, fill: true, width: 1.5 });
    } else if (mouthKind === 'lips') {
      if (soft > 0 && chance(0.5)) washPts([[mx - 10 * mS, mY + 2], [mx, mY - 2], [mx + 10 * mS, mY + 2], [mx, mY + 7]], { color: C().ACCENTS[0], alpha: 0.8, dx: rf(-2, 2), dy: rf(-1, 1) });
      sketch([[mx - 10 * mS, mY + 2], [mx - 4 * mS, mY - 1], [mx, mY + 1], [mx + 4 * mS, mY - 1], [mx + 10 * mS, mY + 2]], { width: 1.8, wob: 0.8 });
      sketch([[mx - 8 * mS, mY + 2], [mx, mY + rf(4, 6)], [mx + 8 * mS, mY + 2]], { width: 1.8, wob: 0.8 });
    } else if (mouthKind === 'pout') {
      var lipRed = chance(0.6);
      sketch([[mx - 9, mY], [mx - 4, mY - 3], [mx, mY - 1], [mx + 4, mY - 3], [mx + 9, mY], [mx, mY + 5]],
        { closed: true, fill: !lipRed, wash: lipRed ? { color: C().ACCENTS[0], alpha: 0.9, grow: 1.2, dx: rf(-2, 2), dy: rf(-1, 1) } : null, width: 1.6, wob: 0.7 });
      line(mx - 7, mY + 0.5, mx + 7, mY + 0.5, { width: 1, wob: 0.4, color: pen.base });
    } else if (mouthKind === 'smile') {
      arc(mx, mY - 2, rf(8, 14) * mS, 0.25, Math.PI - 0.25, { width: 2 });
    } else if (mouthKind === 'grin') {
      var r = rf(9, 14) * mS, pts = [[mx - r, mY]];
      for (var i = 0; i <= 8; i++) { var a = 0.1 + (Math.PI - 0.2) * i / 8; pts.push([mx + Math.cos(a) * r, mY + Math.sin(a) * r * 0.8]); }
      sketch(pts, { closed: true, fill: true, fillColor: pen.base, width: 1.8, wob: 0.8 });
      [-0.5, 0, 0.5].forEach(function (k) { line(mx + k * r, mY, mx + k * r, mY + 4, { width: 1.2, wob: 0.4 }); });
      if (isChild && chance(0.4)) { var gx = mx + pick([-0.25, 0.25]) * r; penStyle(1); pen.ctx.fillRect(gx - 3, mY + 0.5, 6, 4.5); }   // missing tooth
    } else if (mouthKind === 'frown') {
      arc(mx, mY + 8, rf(8, 12) * mS, Math.PI * 1.2, Math.PI * 1.8, { width: 2 });
    } else {
      line(mx - rf(6, 12) * mS, mY + rf(-2, 2), mx + rf(6, 12) * mS, mY + rf(-2, 2), { width: 2 });
    }

    if (beard === 'stubble') {
      clipHead(F, function () { stipple(cx + shift * 0.5, cy + ry * 0.62, rx * 0.8, ry * 0.42, ri(120, 240), 0.9); });
    } else if (beard === 'goatee') {
      sketch(blobPts(mx, mY + rf(12, 16), rf(7, 11), rf(5, 9), 0.1, 10), { closed: true, fill: !grey, width: 1.5 });
      if (grey) hatch(mx - 6, mY + 8, mx + 6, mY + 20, 10, Math.PI / 2, 6);
    } else if (beard === 'full') {
      var top = mY - 6;
      clipHead(F, function () {
        if (grey) {
          sketch(arcPts(cx, cy, rx * 1.02, ry * 1.02, Math.PI * 0.1, Math.PI * 0.9, 0.04, 14), { wob: 2, width: 2 });
          hatch(cx - rx, top, cx + rx, cy + ry * 1.05, ri(60, 110), Math.PI / 2 + rf(-0.3, 0.3), 10);
        } else {
          sketch([[cx - rx * 1.2, top], [cx + rx * 1.2, top], [cx + rx * 1.2, cy + ry * 1.5], [cx - rx * 1.2, cy + ry * 1.5]], { closed: true, fill: true, wob: 2, width: 2 });
          /* redraw the mouth on top of the beard in paper colour */
          line(mx - 8, mY + 2, mx + 8, mY + 2, { width: 2.4, wob: 0.6, color: pen.base });
        }
      });
    }
    Object.assign(F, { mY: mY, mx: mx });
  }

  /* ----- age lines ----- */
  function faceAge(F) {
    var age = F.age, beard = F.beard, cx = F.cx, cy = F.cy, exL = F.exL, exR = F.exR, eyeY = F.eyeY,
      hairTop = F.hairTop, isOld = F.isOld, mY = F.mY, mx = F.mx, nLen = F.nLen, nTop = F.nTop,
      nx = F.nx, rx = F.rx, ry = F.ry, shift = F.shift;
    var fine = { width: 1.2, wob: 0.9 };
    if (isOld) {
      if (chance(0.8)) for (var i = 0, n = ri(2, 4); i < n; i++) {      // forehead
        var y = hairTop + 8 + (eyeY - 24 - hairTop - 8) * (i + 0.5) / n, w = rx * rf(0.35, 0.55);
        sketch([[cx + shift * 0.6 - w, y + 2], [cx + shift * 0.6 - w / 2, y - 1], [cx + shift * 0.6, y - 2], [cx + shift * 0.6 + w / 2, y - 1], [cx + shift * 0.6 + w, y + 2]], fine);
      }
      if (chance(0.7)) [[exL, -1], [exR, 1]].forEach(function (pair) {  // crow's feet
        var ex = pair[0], s = pair[1];
        for (var k = -1; k <= 1; k++) { var ox = ex + s * 11; line(ox, eyeY + k * 3, ox + s * 8, eyeY + k * 7, fine); }
      });
      if (chance(0.7)) [-1, 1].forEach(function (s) {                    // nasolabial folds
        sketch([[nx + s * 8, nTop + nLen - 2], [nx + s * 14, nTop + nLen + 10], [mx + s * 16, mY + 6]], fine);
      });
      if (chance(0.5)) [-1, 1].forEach(function (s) {                    // hollow cheeks
        sketch([[cx + s * rx * 0.62 + shift * 0.5, cy + ry * 0.25], [cx + s * rx * 0.66 + shift * 0.5, cy + ry * 0.45], [cx + s * rx * 0.58 + shift * 0.5, cy + ry * 0.62]], fine);
      });
      if (chance(0.4) && beard === 'none') arc(mx, mY + 24, 8, Math.PI * 1.2, Math.PI * 1.8, fine);   // chin crease
    } else if (age === 'adult' && chance(0.25)) {
      [-1, 1].forEach(function (s) { sketch([[nx + s * 9, nTop + nLen + 2], [mx + s * 14, mY + 2]], fine); });
    }
  }

  /* ----- cheeks: freckles, blush ----- */
  function faceCheeks(F) {
    var exL = F.exL, exR = F.exR, eyeY = F.eyeY, isChild = F.isChild, mY = F.mY, soft = F.soft;
    if (chance(isChild ? 0.35 : 0.12)) { stipple(exL - 6, mY - 14, 9, 6, ri(4, 8), 0.8); stipple(exR + 6, mY - 14, 9, 6, ri(4, 8), 0.8); }
    if ((isChild || soft > 0) && chance(0.45)) {
      var cyk = eyeY + (mY - eyeY) * 0.55;
      if (chance(0.6)) {                            // a dab of marker on each cheek
        washPts(blobPts(exL - 9, cyk + 1, 9, 6, 0.1, 10), { color: C().BLUSH, alpha: rf(0.35, 0.6), grow: 1 });
        washPts(blobPts(exR + 9, cyk + 1, 9, 6, 0.1, 10), { color: C().BLUSH, alpha: rf(0.35, 0.6), grow: 1 });
      } else {
        hatch(exL - 14, cyk - 3, exL - 6, cyk + 5, 4, 0.7, 7);
        hatch(exR + 6, cyk - 3, exR + 14, cyk + 5, 4, 0.7, 7);
      }
    }
  }

  /* ----- eyewear (on top of everything) ----- */
  function faceEyewear(F) {
    var cx = F.cx, exL = F.exL, exR = F.exR, eyeY = F.eyeY, gap = F.gap, rx = F.rx, shift = F.shift;
    var specs = F.eyewear;                       // gene
    var lensR = gap * rf(0.5, 0.65);
    var temple = function (x, y, s) { line(x, y, cx + s * rx * 0.98 + shift * 0.3, y - 3, { width: 1.6 }); };
    if (specs === 'round' || specs === 'pince') {
      arc(exL, eyeY, lensR, 0, Math.PI * 2, { width: 2, wob: 1 });
      arc(exR, eyeY, lensR, 0, Math.PI * 2, { width: 2, wob: 1 });
      if (specs === 'round') {
        line(exL + lensR, eyeY, exR - lensR, eyeY, { width: 1.8 });
        temple(exL - lensR, eyeY, -1); temple(exR + lensR, eyeY, 1);
      } else {
        arc(cx + shift, eyeY - lensR * 0.4, lensR * 0.5, Math.PI * 1.1, Math.PI * 1.9, { width: 1.8 });
      }
    } else if (specs === 'square' || specs === 'shades') {
      var w2 = lensR * 1.1, h2 = lensR * 0.85;
      [exL, exR].forEach(function (ex) {
        sketch([[ex - w2, eyeY - h2], [ex + w2, eyeY - h2], [ex + w2, eyeY + h2], [ex - w2, eyeY + h2]],
          { closed: true, width: 2.2, wob: 1, fill: specs === 'shades' || chance(0.4) });
      });
      line(exL + w2, eyeY - h2 * 0.5, exR - w2, eyeY - h2 * 0.5, { width: 2 });
      temple(exL - w2, eyeY, -1); temple(exR + w2, eyeY, 1);
    } else if (specs === 'cateye') {
      var cw2 = lensR * 1.1, ch2 = lensR * 0.8;
      [[exL, -1], [exR, 1]].forEach(function (pair) {
        var ex = pair[0], s = pair[1];
        sketch([[ex - s * cw2, eyeY - ch2 * 0.5], [ex, eyeY - ch2], [ex + s * cw2 * 1.05, eyeY - ch2 * 1.35], [ex + s * cw2, eyeY + ch2 * 0.6], [ex - s * cw2 * 0.9, eyeY + ch2 * 0.8]],
          { closed: true, width: 2.2, wob: 0.9 });
      });
      line(exL + cw2, eyeY - ch2 * 0.3, exR - cw2, eyeY - ch2 * 0.3, { width: 2 });
      temple(exL - cw2, eyeY - ch2 * 0.8, -1); temple(exR + cw2, eyeY - ch2 * 0.8, 1);
    } else if (specs === 'halfmoon') {
      var r = lensR * 0.78, y = eyeY + 3;
      [exL, exR].forEach(function (ex) { arc(ex, y, r, 0.05, Math.PI - 0.05, { width: 2, wob: 0.8 }); line(ex - r, y, ex + r, y, { width: 1.8, wob: 0.6 }); });
      line(exL + r, y, exR - r, y, { width: 1.8 });
      temple(exL - r, y, -1); temple(exR + r, y, 1);
    } else if (specs === 'monocle') {
      var mex = pick([exL, exR]);
      sketch([[mex - lensR, eyeY - lensR], [mex + lensR, eyeY - lensR], [mex + lensR, eyeY + lensR], [mex - lensR, eyeY + lensR]], { closed: true, width: 2.2, wob: 1 });
      line(mex, eyeY + lensR, mex + 4, eyeY + lensR + 12, { width: 1.4 });
    }
  }

  /* drawFace(ctx, cx, cy, genome) – every §3.1 gene comes from the genome;
     everything else is rolled from pen.R, seeded by genome.wobbleSeed. */
  function drawFace(ctx, cx, cy, genome) {
    var g = genome, col = C();
    pen.ctx = ctx;
    pen.reset();
    pen.seed(g.wobbleSeed | 0);

    /* ----- who is this? ----- */
    var age = g.age, gender = g.gender, expr = g.expr;
    var isChild = age === 'child', isOld = age === 'old';
    var fem = gender === 'fem', masc = gender === 'masc';
    var soft = softOf(gender);                   // feminine styling weight
    var rough = roughOf(gender);                 // masculine styling weight
    var dark = g.hairDark;                       // ink-filled hair vs light/grey hatched hair

    /* ----- the pen and the marker box for this face ----- */
    pen.ink = INKS[g.inkIdx];
    pen.w = g.penW;                              // some faces are drawn with a fat nib, some fine
    var washMode = g.washMode;
    var skinWash = g.skinIdx === null ? null : { color: col.SKINS[g.skinIdx], alpha: rf(0.5, 0.85), mode: washMode, grow: rf(0.94, 1.1) };
    var hairFill = col.HAIR_DARK[g.hairFillIdx]; // ink-filled hair takes a near-black colour
    var hairTint = g.hairTintIdx === null ? null : { color: col.HAIR_TINT[g.hairTintIdx], alpha: rf(0.4, 0.7), mode: washMode };
    var hatWash = g.hatWashIdx === null ? null : { color: col.HATS[g.hatWashIdx], alpha: rf(0.55, 0.85), mode: washMode };
    var accent = { color: col.ACCENTS[g.accentIdx], alpha: 0.8 };

    /* ----- geometry ----- */
    var rx = g.headW;                            // head half-width
    var ry = rx * g.headRatio;                   // heads are a bit tall
    var tilt = g.tilt;                           // whole head leans
    var look = g.look;                           // gaze: -1 left … 1 right
    var shift = look * rx * 0.18;                // features slide toward gaze
    var hairTop = cy - ry * (isOld && masc ? rf(0.45, 0.7) : isChild ? rf(0.3, 0.5) : rf(0.25, 0.45));
    var eyeY = cy - ry * (isChild ? rf(-0.08, 0.04) : rf(0.02, 0.14));   // children carry their eyes lower
    var gap = rx * (isChild ? rf(0.4, 0.52) : rf(0.34, 0.5));
    var exL = cx - gap + shift, exR = cx + gap + shift;
    var partDir = pick([-1, 1]);
    var style = g.hairStyle;

    pen.ctx.save();
    pen.ctx.translate(cx, cy);
    pen.ctx.rotate(tilt);
    pen.ctx.translate(-cx, -cy);

    var head = blobPts(cx, cy, rx, ry, rf(0.04, 0.09));

    /* hairlines: yAt(t) gives the hair's edge on the forehead for t in [-1,1] across the head */
    var bangsY = eyeY - rf(16, 24);
    var flatLine = function () { return hairTop; };
    var bangsLine = function () { return bangsY; };
    var middlePart = function (t) { return hairTop + 12 * Math.abs(t); };
    var sidePart = function (t) { return hairTop + 7 + 9 * t * partDir; };

    // everything the parts need to know
    var F = {
      cx: cx, cy: cy, age: age, gender: gender, isChild: isChild, isOld: isOld, fem: fem, masc: masc,
      soft: soft, rough: rough, expr: expr, dark: dark, skinWash: skinWash, hairFill: hairFill,
      hairTint: hairTint, hatWash: hatWash, accent: accent, rx: rx, ry: ry, look: look, shift: shift,
      hairTop: hairTop, eyeY: eyeY, gap: gap, exL: exL, exR: exR, partDir: partDir, style: style,
      bow: g.bow, head: head, flatLine: flatLine, bangsLine: bangsLine, middlePart: middlePart, sidePart: sidePart,
      /* the part-level genes the drawing used to roll for itself */
      eyeKind: g.eyeKind, browKind: g.browKind, noseKind: g.noseKind, mouthKind: g.mouthKind,
      stache: g.stache, beard: g.beard, eyewear: g.eyewear, earrings: g.earrings,
    };
    faceBackHair(F);
    faceHead(F);
    faceNeck(F);
    faceFrontHair(F);
    faceEars(F);
    faceEyes(F);
    faceBrows(F);
    faceNose(F);
    faceMouth(F);
    faceAge(F);
    faceCheeks(F);
    faceEyewear(F);

    pen.ctx.restore();
  }

  /* renderGenome(canvas, genome, scale) – clear to the paper colour and draw the
     face centred, scaled so head + hair margin fits the canvas. */
  function renderGenome(canvas, genome, scale) {
    scale = scale === undefined ? 1 : scale;
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var rx = genome.headW, ry = rx * genome.headRatio;
    var halfW = rx * 1.55, halfH = ry * 1.6;     // head plus the hair/hat margin around it
    var k = Math.min(w / (2 * halfW), h / (2 * halfH)) * scale;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C().PAPER;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(k, k);
    drawFace(ctx, 0, 0, genome);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ─── Namespace ───

  var Genome = {
    GENES: GENES,
    randomGenome: randomGenome,
    repair: repair,
    drawFace: drawFace,
    renderGenome: renderGenome,
    genomeHash: genomeHash,
    mutate: mutate,
    HINT_MAP: HINT_MAP,
    hintsToGenes: hintsToGenes,
    sanitizeJudgeReply: sanitizeJudgeReply,
    initialPopulation: initialPopulation,
    /* the one member outside the namespace contract: shared utilities the dev pages,
       the probes and the Node checks may lean on. Not part of the app's public surface. */
    _internal: {
      GENE_NAMES: GENE_NAMES,
      HAIR_VALID: HAIR_VALID,
      HAT_STYLES: HAT_STYLES,
      NO_BOW_STYLES: NO_BOW_STYLES,
      HAIR_LONG: HAIR_LONG,
      HAIR_SHORT: HAIR_SHORT,
      hairArchetype: hairArchetype,
      hairTable: hairTable,
      mulberry32: mulberry32Local,
      nextPopulation: nextPopulation,
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Genome;
  }
  if (typeof window !== 'undefined') {
    window.Genome = Genome;
  }
})();

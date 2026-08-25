/* ============================================================
   PROBES – dev-harness self-checks for DrawMe.
   Exposes window.Probes = { run() } returning [{name, pass, detail}].
   ============================================================ */

(function () {
  'use strict';

  // ─── Constants ───

  /* the genome probe 1 renders twice; hand-built so the probe never depends on randomGenome */
  var PROBE_GENOME = {
    age: 'adult', gender: 'fem', expr: 'neutral',
    hairStyle: 'bob', hairDark: true, hairFillIdx: 0, hairTintIdx: null,
    skinIdx: 1, washMode: 'flat', hatWashIdx: null, accentIdx: 0, inkIdx: 0,
    penW: 1.05, headW: 64, headRatio: 1.15, tilt: 0.03, look: 0.5,
    eyeKind: 'ring', browKind: 'arc', noseKind: 'straight', mouthKind: 'smile',
    stache: 'none', beard: 'none', eyewear: 'round', bow: false, earrings: 'stud',
    wobbleSeed: 20260824,
  };

  var PROBE_W = 220, PROBE_H = 280;

  // ─── Helpers ───

  function probeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // ─── Run ───

  /* probe 1 (§7): rendering one genome twice must give byte-identical pixels */
  function determinism() {
    var g = window.Genome.repair(PROBE_GENOME);
    var a = probeCanvas(PROBE_W, PROBE_H);
    var b = probeCanvas(PROBE_W, PROBE_H);
    window.Genome.renderGenome(a, g);
    window.Genome.renderGenome(b, g);
    var da = a.toDataURL(), db = b.toDataURL();
    return {
      pass: da === db,
      detail: da === db
        ? 'identical dataURL (' + da.length + ' chars), genome ' + window.Genome.genomeHash(g)
        : 'dataURLs differ (' + da.length + ' vs ' + db.length + ' chars)',
    };
  }

  /* probe 2 (§7): 500 random mutate() results all satisfy repair() and repair is a
     no-op on them (hash-compared, since genomeHash sorts keys). Also checks that
     mutate never omits a gene key. */
  function repairValidity() {
    var Genome = window.Genome;
    var rand = Genome._internal.mulberry32(0xC0FFEE);
    var geneNames = Genome._internal.GENE_NAMES;
    /* every direction word the hint mapper can produce, straight off the source list so
       a new one (Phase 9 added bigger/smaller/closer) is exercised here automatically */
    var DIRS = [null].concat(Genome._internal.DIRECTION_WORDS);
    var total = 500, fails = 0, missingKeys = 0, examples = [];
    for (var i = 0; i < total; i++) {
      var base = Genome.randomGenome(rand);
      var generation = 2 + Math.floor(rand() * 9);
      var hinted = new Map();
      var hintCount = Math.floor(rand() * 4);
      for (var h = 0; h < hintCount; h++) {
        var gn = geneNames[Math.floor(rand() * geneNames.length)];
        if (gn === 'wobbleSeed') continue;
        hinted.set(gn, DIRS[Math.floor(rand() * DIRS.length)]);
      }
      var mutated = Genome.mutate(base, generation, hinted, rand);
      for (var k = 0; k < geneNames.length; k++) {
        if (!(geneNames[k] in mutated)) missingKeys++;
      }
      var repaired = Genome.repair(mutated);
      if (Genome.genomeHash(mutated) !== Genome.genomeHash(repaired)) {
        fails++;
        if (examples.length < 3) examples.push(Genome.genomeHash(mutated));
      }
    }
    var pass = fails === 0 && missingKeys === 0;
    return {
      pass: pass,
      detail: pass
        ? 'all ' + total + ' mutations were repair no-ops with all keys present'
        : fails + '/' + total + ' not repair-idempotent, ' + missingKeys + ' missing keys (e.g. ' + examples.join(', ') + ')',
    };
  }

  /* probe 3 (§7): 50 initialPopulation() calls all satisfy the §3.5 stratification
     rules (all 4 ages, both masc/fem, >=3 hair archetypes, an eyewear split), and
     every genome in each population is itself a repair no-op. */
  function stratification() {
    var Genome = window.Genome;
    var rand = Genome._internal.mulberry32(0xFACADE);
    var AGE_NAMES = ['child', 'young', 'adult', 'old'];
    var runs = 50, fails = [];
    for (var i = 0; i < runs; i++) {
      var pop = Genome.initialPopulation(rand);
      if (!Array.isArray(pop) || pop.length !== 9) { fails.push('run ' + i + ': not 9 genomes'); continue; }
      var ages = {}, genders = {}, arches = {}, hasEw = false, hasNoEw = false;
      pop.forEach(function (g) {
        ages[g.age] = true; genders[g.gender] = true;
        arches[Genome._internal.hairArchetype(g.hairStyle)] = true;
        if (g.eyewear !== 'none') hasEw = true; else hasNoEw = true;
        if (Genome.genomeHash(g) !== Genome.genomeHash(Genome.repair(g))) fails.push('run ' + i + ': genome not repaired');
      });
      var missingAge = AGE_NAMES.filter(function (a) { return !ages[a]; });
      if (missingAge.length) fails.push('run ' + i + ': missing ages ' + missingAge.join(','));
      if (!genders.masc || !genders.fem) fails.push('run ' + i + ': missing masc/fem');
      if (Object.keys(arches).length < 3) fails.push('run ' + i + ': only ' + Object.keys(arches).length + ' hair archetypes');
      if (!hasEw || !hasNoEw) fails.push('run ' + i + ': missing eyewear split');
    }
    return {
      pass: fails.length === 0,
      detail: fails.length === 0
        ? 'all ' + runs + ' initialPopulation() calls satisfied stratification'
        : fails.slice(0, 5).join(' | ') + (fails.length > 5 ? ' …(+' + (fails.length - 5) + ' more)' : ''),
    };
  }

  /* probe 4 (§13/Task 11): diversity. Supersedes the old elitism probe – the exact-elite
     scheme it checked for is gone. A simulated 3-generation run over the pure
     Genome._internal.nextPopulation(winner, generation, hintedGenes, rand) – the same
     helper app.js's real loop calls, returning { population, meta } (the provenance
     mechanism this task picked over a companion _internal field) – must each step:
       - return a population of length 9;
       - contain NO member whose non-wobbleSeed genes all equal the base winner's
         (checked via gene comparison, not genomeHash, since genomeHash folds in
         wobbleSeed and a wobbleSeed-only difference doesn't count as "differs");
       - have exactly 6 'mutant' + 3 'random' entries in meta, aligned with population;
       - have at least 5 of the 6 mutants differ from the winner in a non-wobbleSeed
         gene (a looser bound than "all 6", so the probe never flakes on the
         once-in-a-blue-moon bounded-retry edge case makeDifferentMutant's own tests
         cover more thoroughly in Node).
     Each step's chosen "winner" for the next step is population[0] (arbitrary – no
     cell is privileged any more), so a single diversity violation anywhere in the
     chain fails the probe. Runs headless in dev.html without app.js, per the brief. */
  function diversity() {
    var Genome = window.Genome;
    var rand = Genome._internal.mulberry32(0xE1173D);
    var winner = Genome.randomGenome(rand);
    var geneNames = Genome._internal.GENE_NAMES;
    function differs(g, base) {
      for (var i = 0; i < geneNames.length; i++) {
        var name = geneNames[i];
        if (name === 'wobbleSeed') continue;
        if (g[name] !== base[name]) return true;
      }
      return false;
    }
    var fails = [];
    for (var gen = 2; gen <= 4; gen++) {
      var built = Genome._internal.nextPopulation(winner, gen, new Map(), rand);
      var pop = built && built.population, meta = built && built.meta;
      if (!Array.isArray(pop) || pop.length !== 9) {
        fails.push('gen ' + gen + ': population was not 9 genomes');
        break;
      }
      if (!Array.isArray(meta) || meta.length !== 9) {
        fails.push('gen ' + gen + ': meta was not 9 entries');
        break;
      }
      var mutantCount = 0, randomCount = 0, winnerCopies = 0, mutantDiffers = 0;
      for (var i = 0; i < 9; i++) {
        if (meta[i] === 'mutant') mutantCount++;
        else if (meta[i] === 'random') randomCount++;
        if (!differs(pop[i], winner)) winnerCopies++;
        if (meta[i] === 'mutant' && differs(pop[i], winner)) mutantDiffers++;
      }
      if (winnerCopies > 0) fails.push('gen ' + gen + ': ' + winnerCopies + ' member(s) matched the winner in every non-wobbleSeed gene');
      if (mutantCount !== 6 || randomCount !== 3) fails.push('gen ' + gen + ': meta split was ' + mutantCount + ' mutant / ' + randomCount + ' random, expected 6/3');
      if (mutantDiffers < 5) fails.push('gen ' + gen + ': only ' + mutantDiffers + '/6 mutants differed from the winner in a non-wobbleSeed gene');
      winner = pop[0]; // arbitrary next base – no cell is the guaranteed winner any more
    }
    return {
      pass: fails.length === 0,
      detail: fails.length === 0
        ? '9-member population each of 3 simulated generations: no winner copies, 6/3 mutant/random split, >=5/6 mutants differ'
        : fails.join(' | '),
    };
  }

  /* probe 5 (§7.4, §4.3): sanitizeJudgeReply() fixtures – valid reply; garbage text;
     out-of-range best; unknown traits mixed with known; JSON embedded in prose; a
     brace inside a quoted suggestion string; an escaped quote followed by a brace
     inside a suggestion string; more than 4 hints. Each fixture's actual result is
     compared to its expected result by JSON.stringify. */
  function sanitizerFixtures() {
    var sanitize = window.Genome.sanitizeJudgeReply;
    var fixtures = [
      {
        name: 'valid reply',
        text: '{"best": 3, "hints": [{"trait": "hair_color", "suggestion": "darker"}]}',
        expected: { best: 3, hints: [{ trait: 'hair_color', suggestion: 'darker' }] },
      },
      {
        name: 'garbage text',
        text: 'this is not json at all',
        expected: null,
      },
      {
        name: 'best out of range (12)',
        text: '{"best": 12, "hints": []}',
        expected: null,
      },
      {
        name: 'unknown traits mixed with known',
        text: '{"best": 5, "hints": [{"trait":"hair_color","suggestion":"darker"},' +
          '{"trait":"bogus_trait","suggestion":"whatever"}]}',
        expected: { best: 5, hints: [{ trait: 'hair_color', suggestion: 'darker' }] },
      },
      {
        name: 'JSON embedded in prose',
        text: 'Sure! Here is my answer: {"best": 7, "hints": [{"trait":"glasses","suggestion":"add"}]} Hope that helps.',
        expected: { best: 7, hints: [{ trait: 'glasses', suggestion: 'add' }] },
      },
      {
        name: 'brace inside a quoted suggestion string',
        text: '{"best": 6, "hints": [{"trait":"mouth","suggestion":"smile :}"}]}',
        expected: { best: 6, hints: [{ trait: 'mouth', suggestion: 'smile :}' }] },
      },
      {
        /* Task 7: exercises the escape branch specifically – a backslash-escaped quote
           immediately followed by a brace inside the suggestion string. Without the
           `escaped` bookkeeping in extractFirstJsonObject's string-aware scan, the \"
           could be mis-read as closing the string one character early, making the
           following } look like real object structure and truncating/corrupting the
           extracted block. */
        name: 'escaped quote followed by a brace inside a suggestion string',
        text: '{"best": 4, "hints": [{"trait":"nose","suggestion":"say \\"hi}\\" now"}]}',
        expected: { best: 4, hints: [{ trait: 'nose', suggestion: 'say "hi}" now' }] },
      },
      {
        name: 'more than 4 hints gets capped at 4',
        text: '{"best": 2, "hints": [' +
          '{"trait":"age","suggestion":"older"},' +
          '{"trait":"gender","suggestion":"x"},' +
          '{"trait":"expression","suggestion":"x"},' +
          '{"trait":"hair_style","suggestion":"x"},' +
          '{"trait":"hair_length","suggestion":"x"}]}',
        expected: {
          best: 2,
          hints: [
            { trait: 'age', suggestion: 'older' },
            { trait: 'gender', suggestion: 'x' },
            { trait: 'expression', suggestion: 'x' },
            { trait: 'hair_style', suggestion: 'x' },
          ],
        },
      },
    ];
    var fails = [];
    for (var i = 0; i < fixtures.length; i++) {
      var f = fixtures[i];
      var actual = sanitize(f.text);
      if (JSON.stringify(actual) !== JSON.stringify(f.expected)) {
        fails.push(f.name + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(f.expected));
      }
    }
    return {
      pass: fails.length === 0,
      detail: fails.length === 0
        ? 'all ' + fixtures.length + ' sanitizer fixtures parsed to their expected result'
        : fails.join(' | '),
    };
  }

  /* probe 6 (elements branch): Genome.elementVariants() – the identikit contract, over
     all 8 ELEMENT_STEPS on 20 random bases each:
       - exactly 9 candidates, all of them repair no-ops;
       - candidate 1 deep-equals the base (the always-available "keep as is");
       - every candidate keeps the base's wobbleSeed (the determinism contract: it is
         what makes the 9 faces pixel-identical outside the step's element);
       - no candidate differs from the base in a gene outside the step's set, EXCEPT
         where repair() itself forces the change (a child face losing its beard, an age
         change pulling headW back into range). That exception is checked exactly, not
         waved through: re-merging the candidate's step genes onto the base and
         repairing must reproduce the candidate gene for gene, so every non-step
         difference is provably a repair consequence and nothing else;
       - the base object handed in is not mutated. */
  function elementVariantContract() {
    var Genome = window.Genome;
    var rand = Genome._internal.mulberry32(0x5E1EC7);
    var geneNames = Genome._internal.GENE_NAMES;
    var steps = Genome.ELEMENT_STEPS;
    var runs = 20, fails = [], candidates = 0;

    function hash(g) { return Genome.genomeHash(g); }
    function sameGenes(a, b) {
      for (var i = 0; i < geneNames.length; i++) {
        if (a[geneNames[i]] !== b[geneNames[i]]) return false;
      }
      return true;
    }

    for (var r = 0; r < runs; r++) {
      var base = Genome.randomGenome(rand);
      for (var si = 0; si < steps.length; si++) {
        var step = steps[si];
        var stepGenes = {};
        step.genes.forEach(function (n) { stepGenes[n] = true; });
        var beforeHash = hash(base);
        var variants = Genome.elementVariants(base, step, rand);
        var where = 'run ' + r + '/' + step.id + ': ';

        if (hash(base) !== beforeHash) fails.push(where + 'elementVariants mutated its input');
        if (!Array.isArray(variants) || variants.length !== 9) {
          fails.push(where + 'expected 9 candidates, got ' + (variants && variants.length));
          continue;
        }
        if (!sameGenes(variants[0], base)) fails.push(where + 'candidate 1 did not equal the base');

        for (var c = 0; c < variants.length; c++) {
          var g = variants[c];
          candidates++;
          if (hash(g) !== hash(Genome.repair(g))) fails.push(where + 'candidate ' + (c + 1) + ' is not repaired');
          if (g.wobbleSeed !== base.wobbleSeed) fails.push(where + 'candidate ' + (c + 1) + ' changed wobbleSeed');

          /* every non-step difference must be a repair consequence: rebuild the
             candidate from base + its own step genes and demand an exact match */
          var merged = {};
          for (var k = 0; k < geneNames.length; k++) merged[geneNames[k]] = base[geneNames[k]];
          step.genes.forEach(function (n) { merged[n] = g[n]; });
          if (!sameGenes(Genome.repair(merged), g)) {
            var offenders = geneNames.filter(function (n) {
              return !stepGenes[n] && g[n] !== base[n];
            });
            fails.push(where + 'candidate ' + (c + 1) + ' differs outside the step beyond repair (' +
              (offenders.join(',') || 'step genes themselves') + ')');
          }
        }
      }
    }
    return {
      pass: fails.length === 0,
      detail: fails.length === 0
        ? candidates + ' candidates over ' + steps.length + ' steps x ' + runs +
          ' bases: 9 per step, candidate 1 = base, wobbleSeed held, every non-step diff a repair consequence'
        : fails.slice(0, 5).join(' | ') + (fails.length > 5 ? ' …(+' + (fails.length - 5) + ' more)' : ''),
    };
  }

  /* every check carries its descriptive name, so a thrower still reports under it */
  var CHECKS = [
    { name: 'determinism: same genome renders identically', fn: determinism },
    { name: 'repair validity: 500 mutations all repair-idempotent', fn: repairValidity },
    { name: 'stratification: 50 initialPopulation() calls satisfy §3.5', fn: stratification },
    { name: 'diversity: 9 members, no winner copy, 6/3 split, >=5/6 mutants differ across 3 generations', fn: diversity },
    { name: 'sanitizer: 8 fixture replies parse to expected results', fn: sanitizerFixtures },
    { name: 'element variants: 9 per step, candidate 1 = base, same wobbleSeed, only the step\'s element varies', fn: elementVariantContract },
  ];

  var Probes = {
    run: function () {
      var results = [];
      for (var i = 0; i < CHECKS.length; i++) {
        try {
          var r = CHECKS[i].fn();
          results.push({ name: CHECKS[i].name, pass: r.pass, detail: r.detail });
        } catch (err) {
          results.push({ name: CHECKS[i].name, pass: false, detail: 'threw: ' + err.message });
        }
      }
      return results;
    },
  };

  if (typeof window !== 'undefined') {
    window.Probes = Probes;
  }
})();

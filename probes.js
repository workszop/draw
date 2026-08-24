/* ============================================================
   PROBES – dev-harness self-checks for Likeness Evolver.
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
    var DIRS = [null, 'darker', 'lighter', 'older', 'younger', 'longer', 'shorter',
      'wider', 'narrower', 'rounder', 'add', 'remove', 'more', 'less'];
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

  /* probe 4 (§7.3): elitism. A simulated 3-generation run over the pure
     Genome._internal.nextPopulation(winner, generation, hintedGenes, rand) – the same
     helper app.js's real loop calls – must always put an exact copy of the winner in
     cell 1 (hash-identical, never re-mutated). Each step's cell 1 becomes the next
     step's winner, so a single dropped elite anywhere in the chain fails the probe.
     Runs headless in dev.html without app.js, per the brief. */
  function elitism() {
    var Genome = window.Genome;
    var rand = Genome._internal.mulberry32(0xE1173D);
    var winner = Genome.randomGenome(rand);
    var fails = [];
    for (var gen = 2; gen <= 4; gen++) {
      var pop = Genome._internal.nextPopulation(winner, gen, new Map(), rand);
      if (!Array.isArray(pop) || pop.length !== 9) {
        fails.push('gen ' + gen + ': population was not 9 genomes');
        break;
      }
      var winnerHash = Genome.genomeHash(winner);
      var cell1Hash = Genome.genomeHash(pop[0]);
      if (cell1Hash !== winnerHash) {
        fails.push('gen ' + gen + ': cell 1 hash ' + cell1Hash + ' != winner hash ' + winnerHash);
      }
      winner = pop[0]; // simulate always picking the elite again, chaining the check
    }
    return {
      pass: fails.length === 0,
      detail: fails.length === 0
        ? 'elite genome hash preserved in cell 1 across 3 simulated generations'
        : fails.join(' | '),
    };
  }

  /* every check carries its descriptive name, so a thrower still reports under it */
  var CHECKS = [
    { name: 'determinism: same genome renders identically', fn: determinism },
    { name: 'repair validity: 500 mutations all repair-idempotent', fn: repairValidity },
    { name: 'stratification: 50 initialPopulation() calls satisfy §3.5', fn: stratification },
    { name: 'elitism: cell 1 hash equals previous winner across 3 generations', fn: elitism },
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

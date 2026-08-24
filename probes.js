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

  /* every check carries its descriptive name, so a thrower still reports under it */
  var CHECKS = [
    { name: 'determinism: same genome renders identically', fn: determinism },
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

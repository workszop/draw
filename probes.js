/* ============================================================
   PROBES – dev-harness self-checks for Likeness Evolver.
   Exposes window.Probes = { run() } returning [{name, pass, detail}].
   ============================================================ */

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
(function () {
  /* probe 1 (§7): rendering one genome twice must give byte-identical pixels */
  function determinism() {
    var g = window.Genome.repair(PROBE_GENOME);
    var a = probeCanvas(PROBE_W, PROBE_H);
    var b = probeCanvas(PROBE_W, PROBE_H);
    window.Genome.renderGenome(a, g);
    window.Genome.renderGenome(b, g);
    var da = a.toDataURL(), db = b.toDataURL();
    return {
      name: 'determinism: same genome renders identically',
      pass: da === db,
      detail: da === db
        ? 'identical dataURL (' + da.length + ' chars), genome ' + window.Genome.genomeHash(g)
        : 'dataURLs differ (' + da.length + ' vs ' + db.length + ' chars)',
    };
  }

  var Probes = {
    run: function () {
      var results = [];
      var checks = [determinism];
      for (var i = 0; i < checks.length; i++) {
        try {
          results.push(checks[i]());
        } catch (err) {
          results.push({ name: checks[i].name, pass: false, detail: 'threw: ' + err.message });
        }
      }
      return results;
    },
  };

  if (typeof window !== 'undefined') {
    window.Probes = Probes;
  }
})();

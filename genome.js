/* ============================================================
   GENOME – the genome domains, RNG, and drawing/rendering logic
   for Likeness Evolver. Classic script (no modules).

   Node-testability: everything except drawFace/renderGenome must
   run in Node without a DOM – no touching pen/document/window at
   load or call time. A local mulberry32-style RNG helper is used
   instead of relying on pen.js's seeded RNG.
   ============================================================ */

// ─── Constants ───
// GENES, domains, and other fixed tables land here task by task.

// ─── State ───
// No module-level mutable state beyond pure helpers; genomes are plain objects.

// ─── Helpers ───
// mulberry32-style RNG, randomGenome, repair, mutate, hints, sanitizer, genomeHash.

// ─── Render ───
// drawFace, renderGenome (DOM/canvas-touching; guarded so Node-safe code above never calls them at load).

(function () {
  var Genome = {
    GENES: {},
    randomGenome: function () { throw new Error('Genome.randomGenome not implemented yet'); },
    repair: function () { throw new Error('Genome.repair not implemented yet'); },
    drawFace: function () { throw new Error('Genome.drawFace not implemented yet'); },
    renderGenome: function () { throw new Error('Genome.renderGenome not implemented yet'); },
    mutate: function () { throw new Error('Genome.mutate not implemented yet'); },
    HINT_MAP: {},
    initialPopulation: function () { throw new Error('Genome.initialPopulation not implemented yet'); },
    genomeHash: function () { throw new Error('Genome.genomeHash not implemented yet'); },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Genome;
  }
  if (typeof window !== 'undefined') {
    window.Genome = Genome;
  }
})();

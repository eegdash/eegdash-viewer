// .lighthouserc.cjs
// Lighthouse CI config — runs against the local static server, gates
// on Web Vitals budgets.

module.exports = {
  ci: {
    collect: {
      url: [
        'http://localhost:8011/index.html?eeg=/test-data/edfplus-with-annotations.edf',
      ],
      startServerCommand: 'node scripts/serve.mjs 8011',
      startServerReadyPattern: 'Static server listening',
      numberOfRuns: 3,
    },
    assert: {
      assertions: {
        'categories:performance':  ['warn',  { minScore: 0.80 }],
        'categories:accessibility':['error', { minScore: 0.90 }],
        'categories:best-practices':['warn', { minScore: 0.85 }],
        // Specific Web Vitals:
        'largest-contentful-paint': ['warn',  { maxNumericValue: 2500 }],
        'cumulative-layout-shift':  ['error', { maxNumericValue: 0.10 }],
        'total-blocking-time':      ['warn',  { maxNumericValue: 300 }],
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
};

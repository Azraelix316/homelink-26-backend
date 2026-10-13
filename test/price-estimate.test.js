const { buildEstimate, inferHours } = require('../lib/lambdas/pricing/estimate.js');

describe('market price estimate', () => {
  test('uses marketplace rates and returns a bounded range', () => {
    const estimate = buildEstimate({
      trade: 'Plumbing',
      rates: [80, 100, 120, 140],
      durationHours: 2,
    });

    expect(estimate.source).toBe('marketplace');
    expect(estimate.sampleSize).toBe(4);
    expect(estimate.low).toBeGreaterThan(0);
    expect(estimate.high).toBeGreaterThan(estimate.low);
    expect(estimate.hours).toEqual({ low: 1.5, high: 3 });
  });

  test('uses a trade baseline when no marketplace rate exists', () => {
    const estimate = buildEstimate({ trade: 'Electrical', description: 'replace one switch' });

    expect(estimate.source).toBe('baseline');
    expect(estimate.sampleSize).toBe(0);
    expect(estimate.high).toBeGreaterThan(estimate.low);
  });

  test('infers larger work without claiming false precision', () => {
    expect(inferHours('rewire the entire house')).toBe(8);
    expect(inferHours('inspect a leaking tap')).toBe(1.5);
  });
});

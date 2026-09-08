/**
 * Framework policy the engine actually reads — US GAAP / ASPE layers, PSAS
 * optional discounting. IFRS remains the default single-rate chain.
 */

import { describe, expect, it } from 'vitest';
import { derive } from '../derive';
import { consumeLayers, frameworkPolicy, syncLayers } from '../framework';
import { assumptions, obligation, yearCurve } from './fixtures';
import type { Curve } from '../curve';

const closingCurve: Curve = {
  ...yearCurve,
  id: 'c-closing',
  points: yearCurve.points.map((p) => ({ ...p, rate: p.rate + 0.006 })),
};

describe('framework policy', () => {
  it('unknown ids fall back to IFRS', () => {
    expect(frameworkPolicy('nope').id).toBe('ifrs');
    expect(frameworkPolicy('usgaap').ratePerLayer).toBe(true);
    expect(frameworkPolicy('psas').discounting).toBe('optional');
  });
});

describe('PSAS optional discounting', () => {
  it('undiscounted measurement equals cost at current prices and drops inflation', () => {
    const o = obligation({
      costEstimateDate: '2025-12-31',
      settlementDate: '2032-12-31',
    });
    const d = derive(o, assumptions(), { curve: yearCurve, framework: 'psas', discount: false });
    expect(d.discounted).toBe(false);
    expect(d.rate).toBe(0);
    expect(d.pv).toBeCloseTo(d.cost, 8);
    expect(d.cce).toBeCloseTo(d.cost, 8);
    expect(d.fv).toBeCloseTo(d.cost, 8);
  });

  it('discounted PSAS matches IFRS on the same obligation', () => {
    const o = obligation();
    const ifrs = derive(o, assumptions(), { curve: yearCurve, framework: 'ifrs' });
    const psas = derive(o, assumptions(), { curve: yearCurve, framework: 'psas', discount: true });
    expect(psas.pv).toBeCloseTo(ifrs.pv, 8);
    expect(psas.ratePerLayer).toBe(false);
  });
});

describe('US GAAP / ASPE stored layers', () => {
  it('an upward revision is a second layer with its own locked rate', () => {
    const o = obligation({
      costEstimateDate: '2024-06-30',
      settlementDate: '2028-06-30',
      adj: [{ id: 'a1', kind: 'cost', amount: 200_000, date: '2025-12-31', reason: 'Scope increase' }],
    });
    const d = derive(o, assumptions(), { curve: yearCurve, framework: 'usgaap' });
    expect(d.ratePerLayer).toBe(true);
    expect(d.layers).toHaveLength(2);
    expect(d.layers[0].direct).toBeGreaterThan(0);
    expect(d.layers[1].direct).toBe(200_000);
    expect(d.layers[0].rate).not.toBe(d.layers[1].rate);
  });

  it('a later closing curve does not remeasure existing layers', () => {
    const o = obligation({
      adj: [{ id: 'a1', kind: 'cost', amount: 150_000, date: '2025-06-30', reason: 'Scope increase' }],
    });
    const before = derive(o, assumptions(), { curve: yearCurve, framework: 'usgaap' });
    const after = derive(
      { ...o, layers: before.layers },
      assumptions(),
      { curve: closingCurve, priorCurve: yearCurve, framework: 'usgaap' },
    );
    expect(after.bridge.rateEffect).toBe(0);
    expect(after.pv).toBeCloseTo(before.pv, 8);
    expect(after.layers.map((l) => l.rate)).toEqual(before.layers.map((l) => l.rate));
  });

  it('the four effects still sum to the movement', () => {
    const o = obligation({
      adj: [
        { id: 'a1', kind: 'cost', amount: 250_000, date: '2025-06-30', reason: 'Scope increase' },
        { id: 'a2', kind: 'term', to: '2034-12-31', date: '2025-09-30', reason: 'Licence extension' },
      ],
    });
    const d = derive(o, assumptions({ priorInflation: 0.020 }), {
      curve: closingCurve, priorCurve: yearCurve, framework: 'aspe',
    });
    const sum = d.bridge.costEffect + d.bridge.timingEffect + d.bridge.rateEffect + d.bridge.inflEffect;
    expect(sum).toBeCloseTo(d.bridge.movement, 8);
    expect(d.bridge.rateEffect).toBe(0);
  });

  it('LIFO consumes the newest layer first', () => {
    const layers = [
      { id: 'a', aroseOn: '2020-01-01', direct: 100, rate: 0.04, lifeYears: 10, method: 'interest-method' },
      { id: 'b', aroseOn: '2024-01-01', direct: 50, rate: 0.045, lifeYears: 6, method: 'interest-method' },
    ];
    const next = consumeLayers(layers, 40, 'LIFO');
    expect(next).toHaveLength(2);
    expect(next.find((l) => l.id === 'b')?.direct).toBeCloseTo(10, 8);
    expect(next.find((l) => l.id === 'a')?.direct).toBe(100);
  });

  it('a downward revision removes a fully consumed layer', () => {
    const o = obligation({
      lines: [{ id: 'l1', description: 'Rig', qty: 10, rate: 10_000 }],
      adj: [
        { id: 'up', kind: 'cost', amount: 40_000, date: '2025-03-31', reason: 'Scope increase' },
        { id: 'down', kind: 'cost', amount: -40_000, date: '2025-09-30', reason: 'Scope reduction' },
      ],
    });
    const d = derive(o, assumptions(), { curve: yearCurve, framework: 'usgaap', layerPolicy: 'LIFO' });
    expect(d.layers).toHaveLength(1);
    expect(d.layers[0].id).toContain('initial');
  });

  it('locked rates survive a later lookup on a different curve', () => {
    const o = obligation({
      adj: [{ id: 'a1', kind: 'cost', amount: 80_000, date: '2025-06-30', reason: 'Scope increase' }],
    });
    const first = derive(o, assumptions(), { curve: yearCurve, framework: 'usgaap' });
    const again = derive(
      { ...o, layers: first.layers },
      assumptions(),
      { curve: closingCurve, framework: 'usgaap' },
    );
    expect(again.layers[0].rate).toBe(first.layers[0].rate);
    expect(again.layers[1].rate).toBe(first.layers[1].rate);
  });
});

describe('syncLayers', () => {
  it('pro-rata reduces every layer in proportion', () => {
    const o = obligation({
      lines: [{ id: 'l1', description: 'Rig', qty: 1, rate: 80 }],
      adj: [{ id: 'd1', kind: 'cost', amount: -20, date: '2025-06-30', reason: 'Cut' }],
    });
    const layers = syncLayers(o, undefined, () => ({ rate: 0.04, lifeYears: 5 }), 'Pro-rata');
    expect(layers).toHaveLength(1);
    expect(layers[0].direct).toBeCloseTo(60, 8);
  });
});

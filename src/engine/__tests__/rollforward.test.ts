/**
 * ENGINE-SPEC §9.7 (roll-forward identity), §9.8 (settlement) and §9.9
 * (zero and degenerate cases).
 */

import { describe, expect, it } from 'vitest';
import {
  ObligationEvent,
  allocateAccretion,
  annualRollForward,
  rollForward,
  settle,
} from '../rollforward';
import { derive, price } from '../derive';
import { assumptions, obligation, yearCurve } from './fixtures';

const ev = (
  periodId: string,
  type: ObligationEvent['type'],
  amount: number,
  id = `${periodId}-${type}-${amount}`,
): ObligationEvent => ({
  id, obligationId: 'o-1', periodId, type, date: '2025-01-31', amount,
});

describe('roll-forward identity — INVARIANTS §1, ENGINE-SPEC §9.7', () => {
  it('opening + additions + accretion + revisions + settlements + FX = closing', () => {
    const events = [
      ev('P01', 'opening', 5_000_000),
      ev('P01', 'addition', 250_000),
      ev('P01', 'accretion', 18_000),
      ev('P01', 'revision', -75_000),
      ev('P01', 'settlement', -300_000),
      ev('P01', 'fx', 12_500),
    ];
    const rf = rollForward(events, 'P01', 4_905_500);
    expect(rf.closing).toBeCloseTo(4_905_500, 6);
    expect(rf.residual).toBeCloseTo(0, 6);
    expect(rf.foots).toBe(true);
  });

  it('does not foot when the measured closing disagrees, and says by how much', () => {
    const rf = rollForward([ev('P01', 'opening', 1_000)], 'P01', 1_010);
    expect(rf.foots).toBe(false);
    expect(rf.residual).toBeCloseTo(10, 6);
  });

  it('foots to the cent, not to the dollar', () => {
    const events = [ev('P01', 'opening', 1_000), ev('P01', 'accretion', 0.004)];
    expect(rollForward(events, 'P01', 1_000).foots).toBe(true);
    expect(rollForward([ev('P01', 'opening', 1_000)], 'P01', 1_000.02).foots).toBe(false);
  });

  it('the periods sum to the annual roll-forward', () => {
    const periods = ['P01', 'P02', 'P03'];
    const events: ObligationEvent[] = [
      ev('P01', 'opening', 5_000_000),
      ev('P01', 'accretion', 20_000),
      ev('P02', 'opening', 5_020_000),
      ev('P02', 'accretion', 20_100),
      ev('P02', 'addition', 400_000),
      ev('P03', 'opening', 5_440_100),
      ev('P03', 'accretion', 21_800),
      ev('P03', 'settlement', -150_000),
    ];
    const each = periods.map((p, i) =>
      rollForward(events, p, i === periods.length - 1 ? 5_311_900 : null),
    );
    each.forEach((rf) => expect(rf.closing).toBeGreaterThan(0));

    const annual = annualRollForward(each);
    expect(annual.opening).toBeCloseTo(5_000_000, 6);
    expect(annual.closing).toBeCloseTo(5_311_900, 6);
    expect(annual.foots).toBe(true);
  });

  it('an empty population rolls forward to nil rather than throwing', () => {
    const rf = rollForward([], 'P01', 0);
    expect(rf.closing).toBe(0);
    expect(rf.foots).toBe(true);
  });
});

describe('accretion allocation — ENGINE-SPEC §7', () => {
  it('weights by balance and by the rate in force for that period, and sums to the total exactly', () => {
    const slices = [
      { periodId: 'P10', balance: 5_000_000, rate: 0.040, yearFraction: 1 / 12 },
      { periodId: 'P11', balance: 5_016_667, rate: 0.040, yearFraction: 1 / 12 },
      // A rate table loaded in P11 governs the periods after it, so P12
      // accretes on the P11 table — here a higher rate.
      { periodId: 'P12', balance: 5_033_389, rate: 0.046, yearFraction: 1 / 12 },
    ];
    const out = allocateAccretion(60_000, slices);
    const total = [...out.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(60_000, 10);
    // P12 carries more than P10 on both a bigger balance and a higher rate.
    expect(out.get('P12')!).toBeGreaterThan(out.get('P10')!);
  });

  it('a nil population allocates nil rather than dividing by zero', () => {
    const out = allocateAccretion(1_000, [
      { periodId: 'P01', balance: 0, rate: 0, yearFraction: 1 / 12 },
    ]);
    expect(out.get('P01')).toBe(0);
  });
});

describe('settlement — ENGINE-SPEC §9.8', () => {
  it('released equals provision carried times the share', () => {
    const s = settle(1_000_000, 0.4, 380_000);
    expect(s.released).toBeCloseTo(400_000, 6);
    expect(s.remaining).toBeCloseTo(600_000, 6);
    expect(s.full).toBe(false);
  });

  it('an overrun goes to operating costs', () => {
    const s = settle(1_000_000, 1, 1_120_000);
    expect(s.overrun).toBeCloseTo(120_000, 6);
    expect(s.surplus).toBe(0);
  });

  it('a surplus is written back', () => {
    const s = settle(1_000_000, 1, 910_000);
    expect(s.surplus).toBeCloseTo(90_000, 6);
    expect(s.overrun).toBe(0);
  });

  it('a full settlement releases the whole provision and leaves nothing carried', () => {
    const s = settle(1_000_000, 1, 1_000_000);
    expect(s.full).toBe(true);
    expect(s.remaining).toBe(0);
    expect(s.overrun).toBe(0);
    expect(s.surplus).toBe(0);
  });
});

describe('zero and degenerate cases — ENGINE-SPEC §9.9', () => {
  it('a zero-term obligation — settlement on the year end — is not discounted', () => {
    const p = price({
      direct: 1_000_000, contingency: 0, costEstimateDate: '2025-12-31',
      settlementDate: '2025-12-31', fyEnd: '2025-12-31', inflation: 0.025,
      curve: yearCurve, termConvention: 'Round up to whole year (SAP)',
    });
    expect(p.tD).toBe(0);
    expect(p.pv).toBeCloseTo(1_000_000, 6);
  });

  it('a settlement date before the year end is not discounted either', () => {
    const p = price({
      direct: 1_000_000, contingency: 0, costEstimateDate: '2025-01-31',
      settlementDate: '2025-06-30', fyEnd: '2025-12-31', inflation: 0.025,
      curve: yearCurve, termConvention: 'Round up to whole year (SAP)',
    });
    expect(p.tD).toBeLessThan(0);
    expect(p.pv).toBeCloseTo(p.fv, 6);
  });

  it('nil materiality and an empty build-up derive to nil without throwing', () => {
    const o = obligation({ lines: [], adj: [] });
    const d = derive(o, assumptions({ materialityUsd: 0, materialityPct: 0 }), { curve: yearCurve });
    expect(d.direct).toBe(0);
    expect(d.pv).toBe(0);
    expect(Number.isNaN(d.pv)).toBe(false);
  });

  it('a malformed date in the register does not produce NaN', () => {
    const o = obligation({ costEstimateDate: '2025-1', settlementDate: '2032-06-30' });
    const d = derive(o, assumptions(), { curve: yearCurve });
    expect(Number.isFinite(d.pv)).toBe(true);
  });
});

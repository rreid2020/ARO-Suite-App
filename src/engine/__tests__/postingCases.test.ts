import { describe, expect, it } from 'vitest';
import { ENGINE_POSTING_CASES, planCaseEntries, selectPostingCase } from '../postingCases';

describe('engine posting cases', () => {
  it('covers every workbook economic case without departmental coding', () => {
    const refs = ENGINE_POSTING_CASES.flatMap((c) => c.refs);
    for (let n = 1; n <= 22; n++) {
      expect(refs).toContain(`ARO${n}`);
    }
    const blob = JSON.stringify(ENGINE_POSTING_CASES);
    expect(blob).not.toMatch(/FRA|GCCG|IFMS|F359|16112|24151/);
  });

  it('lists companion events on cases that post more than one journal', () => {
    const down = ENGINE_POSTING_CASES.find((c) => c.id === 'downward-revision-active')!;
    expect(down.companions?.map((l) => l.eventType)).toEqual(['depreciation', 'downward-excess']);
    expect(down.debitRole).toBe('ARO provision');
    expect(down.creditRole).toBe('Retirement cost asset');
    expect(down.companions?.[1]).toMatchObject({
      debitRole: 'ARO provision', creditRole: 'Accretion expense',
    });
  });

  it('capitalizes a new obligation while remaining life is positive', () => {
    const posted = selectPostingCase({
      kind: 'recognition', provisionDelta: 100_000, remainingUlYears: 12, assetNbv: 0,
    });
    expect(posted.id).toBe('initial-recognition');
    expect(planCaseEntries(posted, {
      kind: 'recognition', provisionDelta: 100_000, remainingUlYears: 12, assetNbv: 0,
    }).map((e) => e.eventType)).toEqual(['addition']);
  });

  it('catches up amortization when recognition is after the asset was placed in service', () => {
    const facts = {
      kind: 'recognition' as const,
      provisionDelta: 80_000,
      remainingUlYears: 16,
      expiredUlYears: 4,
      totalUlYears: 20,
      assetNbv: 0,
    };
    const posted = selectPostingCase(facts);
    expect(posted.id).toBe('catch-up-recognition');
    const planned = planCaseEntries(posted, facts);
    expect(planned[0]).toMatchObject({ eventType: 'addition', amount: 80_000 });
    expect(planned[1]).toMatchObject({ eventType: 'depreciation', amount: 16_000 });
  });

  it('charges a new obligation to expense when the related asset is fully amortized and not in use', () => {
    const facts = {
      kind: 'recognition' as const,
      provisionDelta: 50_000,
      remainingUlYears: 0,
      assetNbv: 0,
      inProductiveUse: false,
    };
    const posted = selectPostingCase(facts);
    expect(posted.id).toBe('expense-recognition');
    expect(posted.debitRole).toBe('Operating costs');
    expect(planCaseEntries(posted, facts).map((e) => e.eventType)).toEqual(['expense-recognition']);
  });

  it('uses the same upward-revision journal for cost, inflation, rate and term increases', () => {
    const facts = { kind: 'revision' as const, provisionDelta: 25_000, remainingUlYears: 8, assetNbv: 40_000 };
    expect(selectPostingCase(facts).refs).toEqual(expect.arrayContaining(['ARO2', 'ARO3', 'ARO4', 'ARO5']));
    expect(planCaseEntries(selectPostingCase(facts), facts).map((e) => e.eventType)).toEqual(['revision']);
  });

  it('routes revisions on unproductive ARO assets to operating expense', () => {
    const up = {
      kind: 'revision' as const,
      provisionDelta: 25_000,
      remainingUlYears: 8,
      assetNbv: 40_000,
      inProductiveUse: false,
    };
    const down = {
      kind: 'revision' as const,
      provisionDelta: -20_000,
      remainingUlYears: 6,
      assetNbv: 30_000,
      assetAccum: 12_000,
      inProductiveUse: false,
    };
    expect(selectPostingCase(up).id).toBe('revision-unproductive');
    expect(selectPostingCase(up).debitRole).toBe('Operating costs');
    expect(planCaseEntries(selectPostingCase(up), up).map((e) => [e.eventType, e.amount])).toEqual([
      ['revision-unproductive', 25_000],
    ]);
    expect(selectPostingCase(down).id).toBe('revision-unproductive');
    expect(planCaseEntries(selectPostingCase(down), down).map((e) => [e.eventType, e.amount])).toEqual([
      ['revision-unproductive', -20_000],
    ]);
  });

  it('reduces the asset and the provision on a downward revision that still leaves positive NBV', () => {
    const facts = {
      kind: 'revision' as const,
      provisionDelta: -20_000,
      remainingUlYears: 6,
      assetNbv: 30_000,
      assetAccum: 12_000,
    };
    const posted = selectPostingCase(facts);
    expect(posted.id).toBe('downward-revision-active');
    expect(planCaseEntries(posted, facts).map((e) => e.eventType)).toEqual(['revision']);
    expect(planCaseEntries(posted, facts)[0].amount).toBe(-20_000);
  });

  it('reverses accumulated amortization when a downward revision would take NBV below zero', () => {
    const facts = {
      kind: 'revision' as const,
      provisionDelta: -80_000,
      remainingUlYears: 6,
      assetNbv: 30_000,
      assetAccum: 50_000,
      assetGross: 80_000,
    };
    const planned = planCaseEntries(selectPostingCase(facts), facts);
    expect(planned.map((e) => [e.eventType, e.amount])).toEqual([
      ['revision', -80_000],
      ['depreciation', -50_000],
    ]);
  });

  it('credits accretion expense when accumulated amortization cannot restore NBV to zero', () => {
    const facts = {
      kind: 'revision' as const,
      provisionDelta: -100_000,
      remainingUlYears: 6,
      assetNbv: 30_000,
      assetAccum: 50_000,
      assetGross: 80_000,
    };
    const planned = planCaseEntries(selectPostingCase(facts), facts);
    expect(planned.map((e) => [e.eventType, e.amount])).toEqual([
      ['revision', -80_000],
      ['depreciation', -50_000],
      ['downward-excess', -20_000],
    ]);
  });

  it('capitalizes then immediately amortizes an upward revision with no remaining life', () => {
    const facts = { kind: 'revision' as const, provisionDelta: 15_000, remainingUlYears: 0, assetNbv: 0 };
    const posted = selectPostingCase(facts);
    expect(posted.id).toBe('upward-revision-fully-amortized');
    expect(planCaseEntries(posted, facts).map((e) => [e.eventType, e.amount])).toEqual([
      ['revision', 15_000],
      ['depreciation', 15_000],
    ]);
  });

  it('true-ups then consumes on settlement, and the two provision legs net to the old carrying amount', () => {
    const facts = {
      kind: 'settlement' as const,
      remainingUlYears: 10,
      assetNbv: 80_000,
      assetAccum: 20_000,
      assetGross: 100_000,
      settlement: { share: 1, actualCost: 120_000, provisionCarried: 100_000 },
    };
    const posted = selectPostingCase(facts);
    expect(posted.id).toBe('settlement-over-partial');
    const planned = planCaseEntries(posted, facts);
    const provision = planned
      .filter((e) => e.eventType === 'revision' || e.eventType === 'settlement')
      .reduce((s, e) => s + e.amount, 0);
    expect(provision).toBeCloseTo(-100_000, 6);
    expect(planned.map((e) => e.eventType)).toEqual(['revision', 'settlement']);
  });

  it('immediately amortizes an over-settlement true-up when remaining life is nil', () => {
    const facts = {
      kind: 'settlement' as const,
      remainingUlYears: 0,
      assetNbv: 0,
      assetAccum: 90_000,
      assetGross: 90_000,
      settlement: { share: 1, actualCost: 110_000, provisionCarried: 90_000 },
    };
    const posted = selectPostingCase(facts);
    expect(posted.id).toBe('settlement-over-full-amortized');
    expect(planCaseEntries(posted, facts).map((e) => e.eventType)).toEqual([
      'revision', 'depreciation', 'settlement',
    ]);
  });

  it('retires the ARO asset after a full settlement that disposes it', () => {
    const facts = {
      kind: 'settlement' as const,
      remainingUlYears: 4,
      assetNbv: 40_000,
      assetAccum: 60_000,
      assetGross: 100_000,
      settlement: { share: 1, actualCost: 80_000, provisionCarried: 90_000, disposeAsset: true },
    };
    const posted = selectPostingCase(facts);
    expect(posted.id).toBe('settlement-dispose-under');
    const types = planCaseEntries(posted, facts).map((e) => e.eventType);
    expect(types).toContain('asset-retirement');
    expect(types).toContain('depreciation');
    expect(types).toContain('settlement');
  });

  it('extinguishes the provision to gain on sale and retires the ARO asset, without a spend line', () => {
    const facts = {
      kind: 'sale' as const,
      remainingUlYears: 5,
      assetNbv: 25_000,
      assetAccum: 75_000,
      assetGross: 100_000,
      settlement: { share: 1, actualCost: 0, provisionCarried: 60_000, disposeAsset: true },
    };
    const posted = selectPostingCase(facts);
    expect(posted.id).toBe('sale');
    expect(posted.creditRole).toBe('Gain on disposal');
    const planned = planCaseEntries(posted, facts);
    expect(planned.map((e) => e.eventType)).toEqual(['disposal', 'depreciation', 'asset-retirement']);
    expect(planned.find((e) => e.eventType === 'disposal')?.amount).toBe(-60_000);
  });
});

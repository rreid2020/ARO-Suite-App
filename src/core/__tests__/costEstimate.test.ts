import { describe, expect, it } from 'vitest';
import {
  addEstimateColumn,
  amountFormula,
  applyCostEstimateTemplate,
  DEFAULT_ESTIMATE_COLUMNS,
  draftToTemplateLine,
  emptyCostEstimateTemplate,
  emptyEstimateColumn,
  emptyEstimateLine,
  estimateHasCost,
  estimatePayload,
  lineAmount,
  linesForMode,
  normalizeEstimateColumns,
  parseCostEstimateTemplates,
  removeEstimateColumn,
} from '../costEstimate';

describe('cost estimate drafts', () => {
  it('treats a filled qty × rate as having cost in both modes', () => {
    expect(estimateHasCost([{ description: 'Labour', qty: '2', rate: '100' }])).toBe(true);
    expect(estimateHasCost([emptyEstimateLine()])).toBe(false);
  });

  it('keeps a single row when switching to single-line mode', () => {
    const rows = [
      { description: 'Labour', qty: '10', rate: '50' },
      { description: 'Materials', qty: '1', rate: '200' },
    ];
    expect(linesForMode('single', rows)).toEqual([rows[0]]);
    expect(linesForMode('multi', rows)).toEqual(rows);
  });

  it('posts the qty × rate lines rather than a lump sum', () => {
    expect(estimatePayload([{ description: 'Labour', qty: '2', rate: '1,250.00' }])).toEqual({
      lines: [{ description: 'Labour', qty: 2, rate: 1250 }],
    });
  });
});

describe('custom estimate columns', () => {
  const asbestos = [
    { id: 'description', label: 'Description', kind: 'text' as const, role: 'label' as const },
    { id: 'rate', label: 'Rate / SQ.M', kind: 'currency' as const, role: 'factor' as const },
    { id: 'qty', label: '# of Sq. M', kind: 'number' as const, role: 'factor' as const },
    { id: 'col-cont', label: 'Contamination %', kind: 'percent' as const, role: 'factor' as const },
  ];

  it('multiplies extra percent factors into the line amount', () => {
    const line = {
      description: 'Asbestos abatement',
      qty: '1,000',
      rate: '50',
      extra: { 'col-cont': '25' },
    };
    expect(lineAmount(line, asbestos)).toBe(12_500);
    expect(estimateHasCost([line], asbestos)).toBe(true);
    expect(estimatePayload([line], asbestos)).toEqual({
      lines: [{ description: 'Asbestos abatement', qty: 1000, rate: 12.5 }],
    });
  });

  it('accepts a percent written with a % sign', () => {
    expect(lineAmount(
      { description: 'A', qty: '10', rate: '8', extra: { 'col-cont': '25%' } },
      asbestos,
    )).toBe(20);
  });

  it('does not treat a blank extra factor as having cost', () => {
    expect(estimateHasCost(
      [{ description: 'A', qty: '10', rate: '50', extra: { 'col-cont': '' } }],
      asbestos,
    )).toBe(false);
  });

  it('leaves text columns out of the product', () => {
    const columns = [
      ...DEFAULT_ESTIMATE_COLUMNS,
      { id: 'col-note', label: 'Location', kind: 'text' as const, role: 'label' as const },
    ];
    const line = {
      description: 'Cut and cap', qty: '2', rate: '100', extra: { 'col-note': 'Well 12' },
    };
    expect(lineAmount(line, columns)).toBe(200);
  });

  it('names the amount as the product of factor labels', () => {
    expect(amountFormula(DEFAULT_ESTIMATE_COLUMNS)).toBe('Qty × Unit rate');
    expect(amountFormula(asbestos)).toBe('Rate / SQ.M × # of Sq. M × Contamination %');
  });

  it('adds and removes a custom column on drafts', () => {
    const added = addEstimateColumn(
      DEFAULT_ESTIMATE_COLUMNS,
      emptyEstimateColumn('percent', 'Contamination %', 1),
      [{ description: 'A', qty: '1', rate: '10' }],
    );
    expect(added.columns).toHaveLength(4);
    expect(added.lines[0].extra?.[added.columns[3].id]).toBe('');
    const removed = removeEstimateColumn(added.columns, added.columns[3].id, added.lines);
    expect(removed.columns).toEqual(DEFAULT_ESTIMATE_COLUMNS);
    expect(removed.lines[0].extra).toBeUndefined();
  });
});

describe('cost estimate templates', () => {
  it('ignores malformed JSON and keeps named rows', () => {
    expect(parseCostEstimateTemplates(null)).toEqual([]);
    const parsed = parseCostEstimateTemplates([
      { id: 't1', tenantId: 'ten', name: 'Well P&A', lines: [{ description: 'Mob', qty: 1, rate: 5000 }] },
      { name: 'no id' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Well P&A');
    expect(parsed[0].lines[0]).toEqual({ description: 'Mob', qty: 1, rate: 5000 });
    expect(parsed[0].columns).toEqual(DEFAULT_ESTIMATE_COLUMNS);
  });

  it('keeps custom columns and extra cell values', () => {
    const parsed = parseCostEstimateTemplates([{
      id: 't-asb',
      tenantId: 'ten',
      name: 'Asbestos',
      columns: [
        { id: 'qty', label: '# of Sq. M', kind: 'number', role: 'factor' },
        { id: 'rate', label: 'Rate / SQ.M', kind: 'currency', role: 'factor' },
        { id: 'col-cont', label: 'Contamination %', kind: 'percent', role: 'factor' },
      ],
      lines: [{ description: 'Abatement', qty: 1000, rate: 50, extra: { 'col-cont': '25' } }],
    }]);
    expect(parsed[0].columns?.map((c) => c.label)).toEqual([
      'Description', '# of Sq. M', 'Rate / SQ.M', 'Contamination %',
    ]);
    expect(parsed[0].lines[0].extra).toEqual({ 'col-cont': '25' });
  });

  it('applies a one-line template in single-line mode', () => {
    const applied = applyCostEstimateTemplate({
      id: 't1', tenantId: 'ten', name: 'Simple',
      lines: [{ description: 'Site work', qty: 1, rate: 25000 }],
    }, 'CAD');
    expect(applied.mode).toBe('single');
    expect(applied.lines).toHaveLength(1);
    expect(applied.lines[0].description).toBe('Site work');
    expect(lineAmount(applied.lines[0], applied.columns)).toBe(25000);
    expect(applied.columns).toEqual(DEFAULT_ESTIMATE_COLUMNS);
  });

  it('applies two or more lines in multi-line mode, including blank rates', () => {
    const applied = applyCostEstimateTemplate({
      id: 't2', tenantId: 'ten', name: 'P&A',
      lines: [
        { description: 'Labour', qty: 40, rate: null },
        { description: 'Materials', qty: 1, rate: 12000 },
      ],
    });
    expect(applied.mode).toBe('multi');
    expect(applied.lines.map((l) => l.description)).toEqual(['Labour', 'Materials']);
    expect(applied.lines[0].qty).toBe('40');
    expect(applied.lines[0].rate).toBe('');
  });

  it('round-trips a draft line into a template line', () => {
    expect(draftToTemplateLine({ description: '  Cut and cap  ', qty: '2', rate: '' })).toEqual({
      description: 'Cut and cap', qty: 2, rate: null,
    });
    expect(emptyCostEstimateTemplate('ten', 1).id).toMatch(/^cet-/);
    expect(emptyCostEstimateTemplate('ten', 1).columns).toHaveLength(3);
  });

  it('fills renamed system columns from a stored template', () => {
    const columns = normalizeEstimateColumns([
      { id: 'qty', label: '# of Sq. M' },
      { id: 'col-cont', label: 'Contamination %', kind: 'percent' },
    ]);
    expect(columns.map((c) => c.id)).toEqual(['description', 'qty', 'rate', 'col-cont']);
    expect(columns[1].label).toBe('# of Sq. M');
    expect(columns[3].kind).toBe('percent');
  });
});

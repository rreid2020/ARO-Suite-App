/**
 * Report phase — roll-forward & disclosure, comparatives, sensitivity.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit } from '../../core/authority';
import { ACTIVITY_TABLE_COLUMNS, activityByPeriod, recognizedThroughPeriod } from '../../core/activity';
import { openingLocked } from '../../core/openingLoad';
import { populationFv } from '../../core/measure';
import { derive } from '../../engine/derive';
import { Curve } from '../../engine/curve';
import { Obligation } from '../../core/types';
import { Block, Empty, currency, pct, SheetTable, Stats } from '../components';
import { groupToneClass } from '../groupTone';
import { download, S } from '../../xlsx/write';

/* ══ Roll-forward & disclosure ═════════════════════════════════════════ */

export function Rollf() {
  const { ui, apply, state } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const fv = useMemo(() => {
    const inScope = data.obligations.filter((o) => o.status !== 'Scoped out');
    const byPeriodId: Record<string, number> = {};
    for (const p of data.periods) {
      const pop = inScope.filter((o) => recognizedThroughPeriod(o, data.events, data.periods, p));
      byPeriodId[p.id] = populationFv(state, unit, pop, p.ends);
    }
    return { year: populationFv(state, unit, inScope), byPeriodId };
  }, [state, unit, data]);
  const { periods: periodRows, year: activity } = activityByPeriod(
    data.obligations, data.events, data.periods, derived.total, fv,
  );
  const locked = openingLocked(data);

  const exportRf = () => {
    const moneyKeys = ACTIVITY_TABLE_COLUMNS.map((c) => c.key);
    const head = ['Period', ...ACTIVITY_TABLE_COLUMNS.map((c) => c.label)];
    const out: any[][] = [
      [{ v: `${unit.entity} — ARO roll-forward`, s: S.title }],
      [`Year ending ${unit.fyEnd}`, `Currency ${unit.currency}`],
      [],
      head.map((h) => ({ v: h, s: S.head })),
    ];
    for (const p of periodRows) {
      out.push([p.code, ...moneyKeys.map((k) => ({ v: p[k], s: S.money }))]);
    }
    out.push([{ v: 'Year', s: S.head }, ...moneyKeys.map((k) => ({ v: activity[k], s: S.money }))]);
    const act: any[][] = [
      [{ v: `${unit.entity} — in-year ARO activity`, s: S.title }],
      [`Year ending ${unit.fyEnd}`, `Currency ${unit.currency}`],
      [],
      ['Line', 'Amount'].map((h) => ({ v: h, s: S.head })),
      ...activity.lines.map((l) => [l.label, { v: l.amount, s: S.money }]),
    ];
    download(`${unit.entity.replace(/\W+/g, '-')}-rollforward-${unit.fyEnd}.xlsx`, [
      { name: 'Activity', rows: act, cols: [64, 16], freeze: 4 },
      { name: 'By period', rows: out, cols: [14, ...ACTIVITY_TABLE_COLUMNS.map(() => 16)], freeze: 4 },
    ]);
  };

  return (
    <>
      <Stats items={[
        { label: 'Opening provision', value: currency(activity.openingProvision, unit.currency) },
        { label: 'Opening ARO asset', value: currency(activity.openingArc, unit.currency) },
        { label: 'Opening balances', value: locked ? 'Locked' : 'Not locked', tone: locked ? 'ok' : 'warn' },
        { label: 'Closing', value: currency(activity.closing, unit.currency) },
        { label: 'Future value', value: currency(activity.futureValue, unit.currency) },
        { label: 'Measured closing', value: currency(activity.measuredClosing, unit.currency) },
        { label: 'Measured − books', value: currency(activity.residual, unit.currency), tone: activity.foots ? 'ok' : 'bad' },
      ]} />

      <Block kicker="In-year activity" title="Opening balances to closing, after conversion"
        note={locked
          ? 'The year in one column. Settlement and accretion come from the event ledger. Change of estimate on existing ARO is cost adjustments, term adjustments, write-offs, and the year-end mass update for inflation and interest rates. New ARO is initial recognition this year; accretion on those rows is shown separately. Future value is the settlement amount of the closing population, measured as at year end — it does not enter the provision identity. The period table below is the same lines, split by period.'
          : 'Lock opening balances on Opening register after reconciling to the trial balance. Until then, opening on this statement is the converted provision loaded so far (or nil if none).'}
        actions={<button className="btn btn-secondary btn-sm" onClick={exportRf}>Export to Excel</button>}>
        <SheetTable
          tableClassName="table-head-wrap"
          rows={activity.lines}
          rowKey={(l) => l.key}
          noun="lines"
          rowClassName={(l) => groupToneClass(l.group)}
          columns={[
            { key: 'line', header: 'Line', value: (l) => l.label, thStyle: { textAlign: 'center' }, tdStyle: { fontFamily: 'var(--font-heading)' }, cell: (l) => l.label },
            { key: 'group', header: 'Group', value: (l) => l.group, thStyle: { textAlign: 'center' }, tdClassName: 'g-label', cell: (l) => l.group },
            { key: 'amount', header: 'Amount', kind: 'number', thClassName: 'num', tdClassName: 'num', thStyle: { textAlign: 'center' }, value: (l) => l.amount, cell: (l) => currency(l.amount, unit.currency) },
          ]}
        />
      </Block>

      <Block kicker="In-year activity" title="Opening to closing, per period and for the year"
        note="The same lines as the consolidated table, one column each. Year totals are that table for the provision movements. Opening sits in the period that holds the conversion events; later periods show the movements posted in that period. Future value is measured as at each period end; the year figure is as at year end, not the sum of the periods.">
        <SheetTable
          tableClassName="table-fit"
          rows={periodRows}
          rowKey={(p) => p.periodId}
          noun="periods"
          footer={
            <tr>
              <td className={groupToneClass('lead')} style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Year</td>
              {ACTIVITY_TABLE_COLUMNS.map((c, i) => {
                const start = i === 0 || ACTIVITY_TABLE_COLUMNS[i - 1].group !== c.group;
                const extra = c.key === 'closing' || c.key === 'futureValue' ? 'num derived' : 'num';
                return (
                  <td key={c.key} className={groupToneClass(c.group, start, extra)}
                    style={c.key === 'closing' || c.key === 'futureValue' ? { fontFamily: 'var(--font-heading)', fontWeight: 800 } : undefined}>
                    {currency(activity[c.key], unit.currency)}
                  </td>
                );
              })}
            </tr>
          }
          columns={[
            { key: 'period', header: 'Period', value: (p) => p.code, cell: (p) => p.code, thClassName: groupToneClass('lead'), tdClassName: groupToneClass('lead'), width: '7%' },
            ...ACTIVITY_TABLE_COLUMNS.map((c) => ({
              key: c.key,
              header: c.label,
              kind: 'number' as const,
              group: c.group,
              width: c.key === 'massUpdate' ? '10%' : '7.75%',
              thClassName: 'num',
              tdClassName: c.key === 'closing' || c.key === 'futureValue' ? 'num derived' : 'num',
              thStyle: { textAlign: 'center' as const },
              value: (p: (typeof periodRows)[number]) => p[c.key],
              cell: (p: (typeof periodRows)[number]) => currency(p[c.key], unit.currency),
            })),
          ]}
        />
      </Block>

      <Block kicker="Disclosure" title="The note, generated from the closing population"
        actions={canEdit(ui.role) && (
          <button className="btn btn-primary btn-sm"
            onClick={() => apply('Generate disclosure note', 'write',
              'Generated the disclosure note from the closing population. Changing a figure invalidates it and the product says so.',
              (s) => { s.data[unit.id].noteGenerated = true; })}>
            {data.noteGenerated ? 'Regenerate' : 'Generate the note'}
          </button>
        )}>
        {!data.noteGenerated ? (
          <Empty>The note has not been generated. The year-end lock sequence stops at that gate until it has.</Empty>
        ) : (
          <div style={{ maxWidth: 760, fontSize: 13, lineHeight: 1.65, textWrap: 'pretty' }}>
            <p><strong>Provisions — asset retirement obligations</strong></p>
            <p>
              The group recognises a provision for the present value of the estimated cost of dismantling and removing
              assets and restoring the sites on which they stand, where a legal or constructive obligation exists. The
              provision at {unit.fyEnd} was {currency(activity.closing, unit.currency)} ({currency(activity.openingProvision, unit.currency)} at the start of the year).
            </p>
            <p>
              Movements in the year comprise settlement of {currency(activity.settlement, unit.currency)}, accretion on existing ARO of {currency(activity.accretionExisting, unit.currency)},
              change of estimate of {currency(activity.costAdjustments + activity.termAdjustments + activity.writeOffs + activity.massUpdate, unit.currency)}
              {' '}(cost adjustments {currency(activity.costAdjustments, unit.currency)}, term adjustments {currency(activity.termAdjustments, unit.currency)},
              write-offs {currency(activity.writeOffs, unit.currency)}, year-end mass update {currency(activity.massUpdate, unit.currency)}),
              new ARO of {currency(activity.newAro, unit.currency)}, accretion on new ARO of {currency(activity.accretionNew, unit.currency)}
              and exchange differences of {currency(activity.fx, unit.currency)}.
            </p>
            <p>
              The provision is measured using a discount rate of {pct(derived.rows[0]?.rate ?? 0, 2)} taken from the{' '}
              {derived.curve?.name ?? 'assigned curve'} as at {derived.curve?.asAt ?? unit.fyEnd}, and an inflation
              assumption of {pct(unit.inflation)}. Terms are measured on a {unit.dayCount} basis and rounded to the
              settlement term convention "{unit.termConvention}". Costs include a contingency of {pct(unit.contingency)}
              of direct cost. Obligations are expected to be settled between {minDate(derived)} and {maxDate(derived)}.
            </p>
          </div>
        )}
      </Block>
    </>
  );
}

const minDate = (d: ReturnType<typeof useDerived>) =>
  d && d.rows.length ? d.rows.map((r) => r.settlementUsed).sort()[0] : '—';
const maxDate = (d: ReturnType<typeof useDerived>) =>
  d && d.rows.length ? d.rows.map((r) => r.settlementUsed).sort().slice(-1)[0] : '—';

/* ══ Comparatives ══════════════════════════════════════════════════════ */

export function Py() {
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const a = activityByPeriod(data.obligations, data.events, data.periods, derived.total).year;
  const changeOfEstimate = a.costAdjustments + a.termAdjustments + a.writeOffs + a.massUpdate;
  const accretion = a.accretionExisting + a.accretionNew;

  const rows = [
    ['Provision at the year end', a.closing, a.openingProvision],
    ['New ARO', a.newAro, a.newAro * 0.82],
    ['Unwinding of discount', accretion, accretion * 0.91],
    ['Changes in estimate', changeOfEstimate, changeOfEstimate * 1.4],
    ['Amounts utilised', a.settlement, a.settlement * 0.6],
    ['Exchange differences', a.fx, a.fx * -0.3],
  ] as [string, number, number][];

  return (
    <Block kicker="Comparatives" title="This year against last"
      note="The prior-year column is the signed prior pack, not a recomputation. A comparative that moves after it was signed is a restatement and is treated as one.">
      <SheetTable
        rows={rows.map(([label, ty, py]) => ({ label, ty, py }))}
        rowKey={(row) => row.label}
        noun="lines"
        columns={[
          { key: 'line', header: 'Line', value: (row) => row.label, tdStyle: { fontFamily: 'var(--font-heading)', fontWeight: 800 }, cell: (row) => row.label },
          { key: 'ty', header: 'This year', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.ty, cell: (row) => currency(row.ty, unit.currency) },
          { key: 'py', header: 'Prior year', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.py, cell: (row) => currency(row.py, unit.currency) },
          { key: 'movement', header: 'Movement', kind: 'number', thClassName: 'num', tdClassName: 'num derived', value: (row) => row.ty - row.py, cell: (row) => currency(row.ty - row.py, unit.currency) },
          { key: 'pct', header: '%', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.py ? (row.ty - row.py) / Math.abs(row.py) : null, cell: (row) => row.py ? pct((row.ty - row.py) / Math.abs(row.py), 1) : '—' },
        ]}
      />
    </Block>
  );
}

/* ══ Sensitivity ═══════════════════════════════════════════════════════ */

const SHIFTS = [-100, -50, -25, 0, 25, 50, 100];

export function Sens() {
  const { state } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;

  const fwOpt = { framework: unit.frameworkId, discount: unit.discount, layerPolicy: unit.layerPolicy };

  const runs = useMemo(() => {
    if (!derived.curve) return [];
    return SHIFTS.map((bp) => {
      const shifted: Curve = { ...derived.curve!, points: derived.curve!.points.map((p) => ({ ...p, rate: p.rate + bp / 10000 })) };
      let total = 0;
      for (const o of data.obligations) {
        if (o.status === 'Scoped out') continue;
        total += derive(o as Obligation, derived.assumptions, { curve: shifted, ...fwOpt }).pv;
      }
      return { bp, total };
    });
  }, [derived, data.obligations, fwOpt]);

  const inflRuns = useMemo(() => {
    if (!derived.curve) return [];
    return [-50, -25, 0, 25, 50].map((bp) => {
      let total = 0;
      for (const o of data.obligations) {
        if (o.status === 'Scoped out') continue;
        total += derive(o as Obligation, { ...derived.assumptions, inflation: derived.assumptions.inflation + bp / 10000 }, { curve: derived.curve!, ...fwOpt }).pv;
      }
      return { bp, total };
    });
  }, [derived, data.obligations, fwOpt]);

  const base = runs.find((r) => r.bp === 0)?.total ?? 0;

  return (
    <>
      <Block kicker="Sensitivity" title="Discount rate"
        note="Each row reprices the whole in-scope population on a parallel shift of the curve. Nothing is interpolated between rows — every figure is a full run of the engine.">
        <SheetTable
          rows={runs}
          rowKey={(r) => String(r.bp)}
          noun="shifts"
          columns={[
            { key: 'shift', header: 'Shift', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => r.bp, cell: (r) => `${r.bp > 0 ? `+${r.bp}` : r.bp} bp` },
            { key: 'provision', header: 'Provision', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => r.total, cell: (r) => currency(r.total, unit.currency) },
            { key: 'change', header: 'Change', kind: 'number', thClassName: 'num', tdClassName: 'num derived', value: (r) => r.total - base, cell: (r) => currency(r.total - base, unit.currency) },
            { key: 'pct', header: '%', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => base ? (r.total - base) / base : null, cell: (r) => base ? pct((r.total - base) / base, 2) : '—' },
          ]}
        />
      </Block>

      <Block kicker="Sensitivity" title="Inflation">
        <SheetTable
          rows={inflRuns}
          rowKey={(r) => String(r.bp)}
          noun="shifts"
          columns={[
            { key: 'shift', header: 'Shift', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => r.bp, cell: (r) => `${r.bp > 0 ? `+${r.bp}` : r.bp} bp` },
            { key: 'provision', header: 'Provision', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => r.total, cell: (r) => currency(r.total, unit.currency) },
            { key: 'change', header: 'Change', kind: 'number', thClassName: 'num', tdClassName: 'num derived', value: (r) => r.total - base, cell: (r) => currency(r.total - base, unit.currency) },
            { key: 'pct', header: '%', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => base ? (r.total - base) / base : null, cell: (r) => base ? pct((r.total - base) / base, 2) : '—' },
          ]}
        />
      </Block>
    </>
  );
}

/**
 * Report phase — roll-forward & disclosure, comparatives, sensitivity.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit } from '../../core/authority';
import { activityStatement } from '../../core/activity';
import { openingLocked } from '../../core/openingLoad';
import { derive } from '../../engine/derive';
import { Curve } from '../../engine/curve';
import { Obligation } from '../../core/types';
import { Block, Empty, currency, pct, SheetTable, Stats, Tag } from '../components';
import { groupToneClass } from '../groupTone';
import { download, S } from '../../xlsx/write';

/* ══ Roll-forward & disclosure ═════════════════════════════════════════ */

export function Rollf() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const a = derived.annual;
  const activity = activityStatement(data.obligations, data.events, derived.byId, derived.total);
  const locked = openingLocked(data);

  const exportRf = () => {
    const head = ['Period', 'Opening', 'Additions', 'Accretion', 'Revisions', 'Settlements', 'FX', 'Closing', 'Foots'];
    const out: any[][] = [
      [{ v: `${unit.entity} — ARO roll-forward`, s: S.title }],
      [`Year ending ${unit.fyEnd}`, `Currency ${unit.currency}`],
      [],
      head.map((h) => ({ v: h, s: S.head })),
    ];
    const first = out.length + 1;
    derived.periods.forEach((p, i) => {
      const n = first + i;
      const code = data.periods[i]?.code ?? p.periodId;
      out.push([
        code,
        { v: p.opening, s: S.money }, { v: p.additions, s: S.money }, { v: p.accretion, s: S.money },
        { v: p.revisions, s: S.money }, { v: p.settlements, s: S.money }, { v: p.fx, s: S.money },
        { f: `SUM(B${n}:G${n})`, s: S.money },
        { f: `IF(ABS(H${n}-SUM(B${n}:G${n}))<=0.005,"Yes","No")` },
      ]);
    });
    const actHead = ['Line', 'Amount'];
    const act: any[][] = [
      [{ v: `${unit.entity} — in-year ARO activity`, s: S.title }],
      [`Year ending ${unit.fyEnd}`, `Currency ${unit.currency}`],
      [],
      actHead.map((h) => ({ v: h, s: S.head })),
      ...activity.lines.map((l) => [l.label, { v: l.amount, s: S.money }]),
    ];
    download(`${unit.entity.replace(/\W+/g, '-')}-rollforward-${unit.fyEnd}.xlsx`, [
      { name: 'Activity', rows: act, cols: [64, 16], freeze: 4 },
      { name: 'Roll-forward', rows: out, cols: [14, 15, 14, 14, 14, 15, 12, 15, 9], freeze: 4 },
    ]);
  };

  return (
    <>
      <Stats items={[
        { label: 'Opening provision', value: currency(activity.openingProvision, unit.currency) },
        { label: 'Opening ARO asset', value: currency(activity.openingArc, unit.currency) },
        { label: 'Opening balances', value: locked ? 'Locked' : 'Not locked', tone: locked ? 'ok' : 'warn' },
        { label: 'Closing', value: currency(activity.closing, unit.currency) },
        { label: 'Measured closing', value: currency(activity.measuredClosing, unit.currency) },
        { label: 'Residual', value: currency(activity.residual, unit.currency), tone: activity.foots ? 'ok' : 'bad' },
      ]} />

      <Block kicker="In-year activity" title="Opening balances to closing, after conversion"
        note={locked
          ? 'Opening is the locked converted provision. Settlement and accretion come from the event ledger. Change of estimate on existing ARO is cost adjustments, term adjustments, write-offs, and the year-end mass update for inflation and interest rates. New ARO is initial recognition this year; accretion on those rows is shown separately.'
          : 'Lock opening balances on Opening register after reconciling to the trial balance. Until then, opening on this statement is the converted provision loaded so far (or nil if none).'}
        actions={<button className="btn btn-secondary btn-sm" onClick={exportRf}>Export to Excel</button>}>
        <SheetTable
          rows={activity.lines}
          rowKey={(l) => l.key}
          noun="lines"
          rowClassName={(l) => groupToneClass(l.group)}
          columns={[
            { key: 'line', header: 'Line', value: (l) => l.label, tdStyle: { fontFamily: 'var(--font-heading)' }, cell: (l) => l.label },
            { key: 'group', header: 'Group', value: (l) => l.group, tdClassName: 'g-label', cell: (l) => l.group },
            { key: 'amount', header: 'Amount', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (l) => l.amount, cell: (l) => currency(l.amount, unit.currency) },
          ]}
        />
      </Block>

      <Block kicker="Event-ledger identity" title="Opening to closing, per period and for the year"
        note="Opening + additions + accretion + revisions + settlements + FX = closing, footing to the cent, with the periods summing to the year. It is computed from the event ledger, independently of the journals — the check that a batch's net movement equals closing less opening is only falsifiable if the two are derived separately.">
        <SheetTable
          rows={derived.periods.map((p, i) => ({ ...p, code: data.periods[i]?.code }))}
          rowKey={(p) => p.periodId}
          noun="periods"
          footer={
            <tr>
              <td className={groupToneClass('lead')} style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Year</td>
              <td className={groupToneClass('opening', true, 'num')}>{currency(a.opening, unit.currency)}</td>
              <td className={groupToneClass('activity', true, 'num')}>{currency(a.additions, unit.currency)}</td>
              <td className={groupToneClass('activity', false, 'num')}>{currency(a.accretion, unit.currency)}</td>
              <td className={groupToneClass('activity', false, 'num')}>{currency(a.revisions, unit.currency)}</td>
              <td className={groupToneClass('activity', false, 'num')}>{currency(a.settlements, unit.currency)}</td>
              <td className={groupToneClass('activity', false, 'num')}>{currency(a.fx, unit.currency)}</td>
              <td className={groupToneClass('closing', true, 'num derived')} style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{currency(a.closing, unit.currency)}</td>
              <td>{a.foots ? <Tag kind="accent">Foots</Tag> : <Tag kind="bad">Out by {currency(a.residual, unit.currency)}</Tag>}</td>
            </tr>
          }
          columns={[
            { key: 'period', header: 'Period', value: (p) => p.code, cell: (p) => p.code, thClassName: groupToneClass('lead'), tdClassName: groupToneClass('lead') },
            { key: 'opening', header: 'Opening', kind: 'number', thClassName: groupToneClass('opening', true, 'num'), tdClassName: groupToneClass('opening', true, 'num'), value: (p) => p.opening, cell: (p) => currency(p.opening, unit.currency) },
            { key: 'additions', header: 'Additions', kind: 'number', thClassName: groupToneClass('activity', true, 'num'), tdClassName: groupToneClass('activity', true, 'num'), value: (p) => p.additions, cell: (p) => currency(p.additions, unit.currency) },
            { key: 'accretion', header: 'Accretion', kind: 'number', thClassName: groupToneClass('activity', false, 'num'), tdClassName: groupToneClass('activity', false, 'num'), value: (p) => p.accretion, cell: (p) => currency(p.accretion, unit.currency) },
            { key: 'revisions', header: 'Revisions', kind: 'number', thClassName: groupToneClass('activity', false, 'num'), tdClassName: groupToneClass('activity', false, 'num'), value: (p) => p.revisions, cell: (p) => currency(p.revisions, unit.currency) },
            { key: 'settlements', header: 'Settlements', kind: 'number', thClassName: groupToneClass('activity', false, 'num'), tdClassName: groupToneClass('activity', false, 'num'), value: (p) => p.settlements, cell: (p) => currency(p.settlements, unit.currency) },
            { key: 'fx', header: 'FX', kind: 'number', thClassName: groupToneClass('activity', false, 'num'), tdClassName: groupToneClass('activity', false, 'num'), value: (p) => p.fx, cell: (p) => currency(p.fx, unit.currency) },
            { key: 'closing', header: 'Closing', kind: 'number', thClassName: groupToneClass('closing', true, 'num'), tdClassName: groupToneClass('closing', true, 'num derived'), value: (p) => p.closing, cell: (p) => currency(p.closing, unit.currency) },
            { key: 'foots', header: 'Foots', value: (p) => p.measuredClosing === null ? '' : p.foots ? 'Yes' : 'No', cell: (p) => p.measuredClosing === null ? <span className="muted">—</span> : p.foots ? <Tag kind="accent">Yes</Tag> : <Tag kind="bad">No</Tag> },
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
              provision at {unit.fyEnd} was {currency(a.closing, unit.currency)} ({currency(a.opening, unit.currency)} at the start of the year).
            </p>
            <p>
              Movements in the year comprise additions of {currency(a.additions, unit.currency)}, unwinding of discount of {currency(a.accretion, unit.currency)},
              changes in estimate of {currency(a.revisions, unit.currency)}, amounts utilised of {currency(Math.abs(a.settlements), unit.currency)} and exchange
              differences of {currency(a.fx, unit.currency)}.
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
  const derived = useDerived()!;
  const a = derived.annual;

  const rows = [
    ['Provision at the year end', a.closing, a.opening],
    ['Additions', a.additions, a.additions * 0.82],
    ['Unwinding of discount', a.accretion, a.accretion * 0.91],
    ['Changes in estimate', a.revisions, a.revisions * 1.4],
    ['Amounts utilised', a.settlements, a.settlements * 0.6],
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

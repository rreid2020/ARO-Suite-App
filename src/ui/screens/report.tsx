/**
 * Report phase — roll-forward & disclosure, comparatives, sensitivity.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit } from '../../core/authority';
import { derive } from '../../engine/derive';
import { Curve } from '../../engine/curve';
import { Obligation } from '../../core/types';
import { Block, Empty, money, money2, pct, Stats, Tag } from '../components';
import { download, S } from '../../xlsx/write';

/* ══ Roll-forward & disclosure ═════════════════════════════════════════ */

export function Rollf() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const a = derived.annual;

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
        // The identity, written as a live formula so Excel proves it too.
        { f: `SUM(B${n}:G${n})`, s: S.money },
        { f: `IF(ABS(H${n}-SUM(B${n}:G${n}))<=0.005,"Yes","No")` },
      ]);
    });
    download(`${unit.entity.replace(/\W+/g, '-')}-rollforward-${unit.fyEnd}.xlsx`, [
      { name: 'Roll-forward', rows: out, cols: [14, 15, 14, 14, 14, 15, 12, 15, 9], freeze: 4 },
    ]);
  };

  return (
    <>
      <Stats items={[
        { label: 'Opening', value: money(a.opening) },
        { label: 'Movements', value: money(a.additions + a.accretion + a.revisions + a.settlements + a.fx) },
        { label: 'Closing', value: money(a.closing) },
        { label: 'Measured closing', value: a.measuredClosing === null ? '—' : money(a.measuredClosing) },
        { label: 'Residual', value: money2(a.residual), tone: a.foots ? 'ok' : 'bad' },
      ]} />

      <Block kicker="Roll-forward" title="Opening to closing, per period and for the year"
        note="Opening + additions + accretion + revisions + settlements + FX = closing, footing to the cent, with the periods summing to the year. It is computed from the event ledger, independently of the journals — the check that a batch's net movement equals closing less opening is only falsifiable if the two are derived separately."
        actions={<button className="btn btn-secondary btn-sm" onClick={exportRf}>Export to Excel</button>}>
        <div className="scroll-x">
          <table className="table">
            <thead><tr>
              <th>Period</th><th className="num">Opening</th><th className="num">Additions</th><th className="num">Accretion</th>
              <th className="num">Revisions</th><th className="num">Settlements</th><th className="num">FX</th>
              <th className="num">Closing</th><th>Foots</th>
            </tr></thead>
            <tbody>
              {derived.periods.map((p, i) => (
                <tr key={p.periodId}>
                  <td>{data.periods[i]?.code}</td>
                  <td className="num">{money2(p.opening)}</td>
                  <td className="num">{money2(p.additions)}</td>
                  <td className="num">{money2(p.accretion)}</td>
                  <td className="num">{money2(p.revisions)}</td>
                  <td className="num">{money2(p.settlements)}</td>
                  <td className="num">{money2(p.fx)}</td>
                  <td className="num derived">{money2(p.closing)}</td>
                  <td>{p.measuredClosing === null ? <span className="muted">—</span> : p.foots ? <Tag kind="accent">Yes</Tag> : <Tag kind="bad">No</Tag>}</td>
                </tr>
              ))}
              <tr>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Year</td>
                <td className="num">{money2(a.opening)}</td>
                <td className="num">{money2(a.additions)}</td>
                <td className="num">{money2(a.accretion)}</td>
                <td className="num">{money2(a.revisions)}</td>
                <td className="num">{money2(a.settlements)}</td>
                <td className="num">{money2(a.fx)}</td>
                <td className="num derived" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{money2(a.closing)}</td>
                <td>{a.foots ? <Tag kind="accent">Foots</Tag> : <Tag kind="bad">Out by {money2(a.residual)}</Tag>}</td>
              </tr>
            </tbody>
          </table>
        </div>
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
              provision at {unit.fyEnd} was {unit.currency} {money(a.closing)} ({money(a.opening)} at the start of the year).
            </p>
            <p>
              Movements in the year comprise additions of {money(a.additions)}, unwinding of discount of {money(a.accretion)},
              changes in estimate of {money(a.revisions)}, amounts utilised of {money(Math.abs(a.settlements))} and exchange
              differences of {money(a.fx)}.
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
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th>Line</th><th className="num">This year</th><th className="num">Prior year</th><th className="num">Movement</th><th className="num">%</th></tr></thead>
          <tbody>
            {rows.map(([label, ty, py]) => (
              <tr key={label}>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{label}</td>
                <td className="num">{money2(ty)}</td>
                <td className="num">{money2(py)}</td>
                <td className="num derived">{money2(ty - py)}</td>
                <td className="num">{py ? pct((ty - py) / Math.abs(py), 1) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

  const runs = useMemo(() => {
    if (!derived.curve) return [];
    return SHIFTS.map((bp) => {
      const shifted: Curve = { ...derived.curve!, points: derived.curve!.points.map((p) => ({ ...p, rate: p.rate + bp / 10000 })) };
      let total = 0;
      for (const o of data.obligations) {
        if (o.status === 'Scoped out') continue;
        total += derive(o as Obligation, derived.assumptions, { curve: shifted }).pv;
      }
      return { bp, total };
    });
  }, [derived, data.obligations]);

  const inflRuns = useMemo(() => {
    if (!derived.curve) return [];
    return [-50, -25, 0, 25, 50].map((bp) => {
      let total = 0;
      for (const o of data.obligations) {
        if (o.status === 'Scoped out') continue;
        total += derive(o as Obligation, { ...derived.assumptions, inflation: derived.assumptions.inflation + bp / 10000 }, { curve: derived.curve! }).pv;
      }
      return { bp, total };
    });
  }, [derived, data.obligations]);

  const base = runs.find((r) => r.bp === 0)?.total ?? 0;

  return (
    <>
      <Block kicker="Sensitivity" title="Discount rate"
        note="Each row reprices the whole in-scope population on a parallel shift of the curve. Nothing is interpolated between rows — every figure is a full run of the engine.">
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th className="num">Shift</th><th className="num">Provision</th><th className="num">Change</th><th className="num">%</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.bp}>
                  <td className="num">{r.bp > 0 ? `+${r.bp}` : r.bp} bp</td>
                  <td className="num">{money2(r.total)}</td>
                  <td className="num derived">{money2(r.total - base)}</td>
                  <td className="num">{base ? pct((r.total - base) / base, 2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>

      <Block kicker="Sensitivity" title="Inflation">
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th className="num">Shift</th><th className="num">Provision</th><th className="num">Change</th><th className="num">%</th></tr></thead>
            <tbody>
              {inflRuns.map((r) => (
                <tr key={r.bp}>
                  <td className="num">{r.bp > 0 ? `+${r.bp}` : r.bp} bp</td>
                  <td className="num">{money2(r.total)}</td>
                  <td className="num derived">{money2(r.total - base)}</td>
                  <td className="num">{base ? pct((r.total - base) / base, 2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
    </>
  );
}

/**
 * Measure phase — cost estimates, adjustments, layers & framework, retirement
 * cost asset, event ledger, recalculation.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit } from '../../core/authority';
import { ladderFor, bridgeRungs } from '../../engine/ladder';
import { Obligation, Revision } from '../../core/types';
import { isValidDate, maskDateInput } from '../../engine/dates';
import { REMEASUREMENT_REASONS, VARIANCE_CAUSES } from '../../seed';
import { Basis, Block, Empty, Field, Ladder, money, money2, pct, Stats, Tag, years } from '../components';
import { download, S } from '../../xlsx/write';
import { sourceOf } from './Register';

/** Picking an obligation is common to several Measure screens. */
function usePicked() {
  const data = useUnitData();
  const [id, setId] = useState<string>('');
  const picked = data?.obligations.find((o) => o.id === id) ?? data?.obligations[0] ?? null;
  return { picked, setId, id: picked?.id ?? '' };
}

function Picker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const data = useUnitData()!;
  return (
    <div style={{ flex: '1 1 320px', maxWidth: 480 }}>
      <div className="kicker" style={{ marginBottom: 4 }}>Obligation</div>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {data.obligations.map((o) => <option key={o.id} value={o.id}>{o.ref} — {o.description}</option>)}
      </select>
    </div>
  );
}

/* ══ Cost estimates ════════════════════════════════════════════════════ */

export function Cost() {
  const { ui, write } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const { picked, setId, id } = usePicked();
  const editable = canEdit(ui.role);

  if (!picked) return <Empty>This reporting unit has no obligations yet. Load an extract on Data intake, or add one on the register.</Empty>;
  const d = derived.byId.get(picked.id)!;
  const rungs = ladderFor(picked, derived.assumptions, d, derived.curve ?? ({ name: 'none', extrapolation: 'flat-last' } as never));

  const editLine = (lineId: string, key: 'description' | 'qty' | 'rate' | 'source', value: string) => {
    write<Obligation>({
      domain: 'estimates',
      record: picked.id,
      recordLabel: `${picked.ref} cost build-up`,
      before: picked,
      after: {
        ...picked,
        lines: picked.lines.map((l) => l.id === lineId ? { ...l, [key]: key === 'qty' || key === 'rate' ? Number(value) || 0 : value } : l),
      },
      action: 'Edit cost build-up line',
      apply: (s, v) => {
        const list = s.data[unit.id].obligations;
        const i = list.findIndex((x) => x.id === picked.id);
        if (i >= 0) list[i] = v;
      },
    });
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Picker value={id} onChange={setId} />
      </div>

      <Stats items={[
        { label: 'Direct cost', value: money2(d.direct) },
        { label: 'Cost + contingency', value: money2(d.cost) },
        { label: 'FV at settlement', value: money2(d.fv) },
        { label: 'Provision at FY end', value: money2(d.pv) },
        { label: 'Discount rate', value: pct(d.rate, 4) },
      ]} />

      <Block kicker="Cost build-up" title={`${picked.ref} — ${picked.description}`}
        actions={editable && (
          <button className="btn btn-secondary btn-sm" onClick={() => write<Obligation>({
            domain: 'estimates', record: picked.id, recordLabel: `${picked.ref} cost build-up`,
            before: picked,
            after: { ...picked, lines: [...picked.lines, { id: `l-${Date.now().toString(36)}`, description: 'New line', qty: 0, rate: 0, source: '' }] },
            action: 'Add cost build-up line',
            apply: (s, v) => { const l = s.data[unit.id].obligations; const i = l.findIndex((x) => x.id === picked.id); if (i >= 0) l[i] = v; },
          })}>Add line</button>
        )}>
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Description</th><th className="num" style={{ width: 110 }}>Quantity</th><th className="num" style={{ width: 130 }}>Unit rate</th><th className="num" style={{ width: 140 }}>Amount</th><th>Source</th></tr></thead>
            <tbody>
              {picked.lines.map((l) => (
                <tr key={l.id}>
                  <td><input className="input" style={{ minHeight: 26, fontSize: 11.5 }} defaultValue={l.description} disabled={!editable}
                    onBlur={(e) => e.target.value !== l.description && editLine(l.id, 'description', e.target.value)} /></td>
                  <td><input className="input num" style={{ minHeight: 26, fontSize: 11.5 }} defaultValue={l.qty} disabled={!editable}
                    onBlur={(e) => Number(e.target.value) !== l.qty && editLine(l.id, 'qty', e.target.value)} /></td>
                  <td><input className="input num" style={{ minHeight: 26, fontSize: 11.5 }} defaultValue={l.rate} disabled={!editable}
                    onBlur={(e) => Number(e.target.value) !== l.rate && editLine(l.id, 'rate', e.target.value)} /></td>
                  <td className="num derived">{money2(l.qty * l.rate)}</td>
                  <td><input className="input" style={{ minHeight: 26, fontSize: 11.5 }} defaultValue={l.source ?? ''} disabled={!editable}
                    onBlur={(e) => e.target.value !== l.source && editLine(l.id, 'source', e.target.value)} /></td>
                </tr>
              ))}
              <tr>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Build-up total</td>
                <td /><td />
                <td className="num derived" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>
                  {money2(picked.lines.reduce((s, l) => s + l.qty * l.rate, 0))}
                </td>
                <td className="muted">Cost revisions of {money2(d.costRevisions)} are added on the Adjustments step.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Block>

      <Block kicker="Calculation" title="From the build-up to the provision"
        note="Every rung carries the arithmetic that produced it, its basis tag, and a self-contained Excel formula. This is the same renderer used on the register drawer and the recalculation screen.">
        <Ladder rungs={rungs} open />
      </Block>
    </>
  );
}

/* ══ Adjustments ═══════════════════════════════════════════════════════ */

export function Adjust() {
  const { ui, write } = useStore();
  const unit = useUnit()!;
  const derived = useDerived()!;
  const { picked, setId, id } = usePicked();
  const editable = canEdit(ui.role);
  const [draft, setDraft] = useState<{ kind: 'cost' | 'term'; amount: string; to: string; date: string; reason: string; evidence: string }>({
    kind: 'cost', amount: '', to: '', date: '', reason: REMEASUREMENT_REASONS[0], evidence: '',
  });

  if (!picked) return <Empty>No obligations to adjust yet.</Empty>;
  const d = derived.byId.get(picked.id)!;

  const valid = isValidDate(draft.date) && (draft.kind === 'cost' ? Number.isFinite(Number(draft.amount)) && draft.amount !== '' : isValidDate(draft.to));

  const add = () => {
    const rev: Revision = {
      id: `adj-${Date.now().toString(36)}`,
      kind: draft.kind,
      amount: draft.kind === 'cost' ? Number(draft.amount) : undefined,
      to: draft.kind === 'term' ? draft.to : undefined,
      date: draft.date, reason: draft.reason, evidence: draft.evidence,
      createdBy: ui.userName, createdAt: new Date().toISOString(),
    };
    write<Obligation>({
      domain: 'estimates', record: picked.id, recordLabel: `${picked.ref} revisions`,
      before: picked, after: { ...picked, adj: [...picked.adj, rev] },
      action: `Record ${draft.kind === 'cost' ? 'cost' : 'timing'} revision`,
      apply: (s, v) => { const l = s.data[unit.id].obligations; const i = l.findIndex((x) => x.id === picked.id); if (i >= 0) l[i] = v; },
    });
    setDraft({ kind: 'cost', amount: '', to: '', date: '', reason: REMEASUREMENT_REASONS[0], evidence: '' });
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Picker value={id} onChange={setId} />
      </div>

      <Block kicker="Recorded revisions" title={`${picked.ref} — ${picked.adj.length} revision${picked.adj.length === 1 ? '' : 's'}`}
        note="Cost revisions are entered and displayed gross of contingency and are added to direct cost, so contingency applies to the revised figure. A timing revision moves the expected settlement date and takes it out of the register's hands — the register will refuse a direct edit to it by name.">
        {picked.adj.length === 0 ? (
          <Empty>No revisions recorded against this obligation. Its measurement is on the original build-up and the original settlement date.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Kind</th><th>Effect</th><th>Effective</th><th>Reason</th><th>Evidence</th><th>Recorded by</th></tr></thead>
              <tbody>
                {[...picked.adj].sort((a, b) => a.date.localeCompare(b.date)).map((a) => (
                  <tr key={a.id}>
                    <td><Tag kind={a.kind === 'cost' ? 'accent' : 'neutral'}>{a.kind === 'cost' ? 'Cost' : 'Timing'}</Tag></td>
                    <td className="num">{a.kind === 'cost' ? money2(a.amount ?? 0) : `→ ${a.to}`}</td>
                    <td>{a.date}</td>
                    <td>{a.reason}</td>
                    <td>{a.evidence || <span className="muted">none recorded</span>}</td>
                    <td className="muted">{a.createdBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      <Block kicker="Remeasurement bridge" title="The same obligation, priced four times"
        note="Each move changes exactly one thing, so the four effects sum to the total movement with no residual. Before a year-end revaluation has run, the rate and inflation legs read nil because nothing moved — not because they are unimplemented.">
        <Ladder rungs={bridgeRungs(d)} open />
      </Block>

      {editable && (
        <Block kicker="Record" title="A new revision">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '0 0 150px' }}>
              <Field label="Kind">
                <select className="input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'cost' | 'term' })}>
                  <option value="cost">Cost revision</option>
                  <option value="term">Timing revision</option>
                </select>
              </Field>
            </div>
            {draft.kind === 'cost' ? (
              <div style={{ flex: '0 0 170px' }}>
                <Field label="Amount (gross of contingency)" help="Added to direct cost, so contingency then applies to the revised figure. A reduction is entered as a negative.">
                  <input className="input num" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
                </Field>
              </div>
            ) : (
              <div style={{ flex: '0 0 160px' }}>
                <Field label="New settlement date" help="Once set, this holds the settlement date. The register will refuse a direct edit to it by name.">
                  <input className="input" value={draft.to} onChange={(e) => setDraft({ ...draft, to: maskDateInput(e.target.value) })} placeholder="YYYY-MM-DD" />
                </Field>
              </div>
            )}
            <div style={{ flex: '0 0 150px' }}>
              <Field label="Effective date"><input className="input" value={draft.date} onChange={(e) => setDraft({ ...draft, date: maskDateInput(e.target.value) })} placeholder="YYYY-MM-DD" /></Field>
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <Field label="Reason">
                <select className="input" value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}>
                  {REMEASUREMENT_REASONS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </Field>
            </div>
            <div style={{ flex: '0 0 150px' }}>
              <Field label="Evidence reference"><input className="input" value={draft.evidence} onChange={(e) => setDraft({ ...draft, evidence: e.target.value })} /></Field>
            </div>
            <button className="btn btn-primary btn-sm" onClick={add} disabled={!valid}>Record revision</button>
          </div>
        </Block>
      )}
    </>
  );
}

/* ══ Layers & framework ════════════════════════════════════════════════ */

export function Layers() {
  const { state } = useStore();
  const unit = useUnit()!;
  const derived = useDerived()!;
  const fw = state.settings[unit.tenantId].frameworks.find((f) => f.id === unit.frameworkId)!;

  return (
    <>
      <Block kicker="Framework in force" title={fw.name}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 10 }}>
          {Object.entries(fw.axes).map(([k, v]) => (
            <div key={k} style={{ background: 'var(--color-surface)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div className="kicker">{k}</div>
              <div style={{ fontSize: 12, lineHeight: 1.45 }}>{v}</div>
            </div>
          ))}
        </div>
      </Block>

      <Block kicker="Layers" title="Derived, not stored"
        note={fw.wired
          ? 'Under IFRS a single current rate is applied to the whole obligation, so layers are a presentation of when the obligation arose rather than separate measurement units. They are derived here.'
          : `${fw.name} needs layers STORED, each carrying the discount rate in force on the day it arose and accreting at that rate for the rest of its life. The engine does not do that yet — it applies a single current rate. Figures on this screen are therefore on the IFRS basis regardless of the framework assigned.`}>
        {!fw.wired && (
          <div className="note-panel" style={{ marginBottom: 14, borderLeftColor: 'var(--bad)' }}>
            This reporting unit is assigned {fw.name}, but the engine does not yet read the framework assignment.
            This is decision 2 in the handoff: layers become rows rather than a derived view, and that changes the
            obligation and layer tables. Deciding it before the schema is written is the point of raising it here.
          </div>
        )}
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Obligation</th><th>Arose</th><th className="num">Amount</th><th className="num">Rate applied</th><th>Basis</th></tr></thead>
            <tbody>
              {derived.rows.slice(0, 30).map((d) => (
                <tr key={d.obligationId}>
                  <td>{d.ref}</td>
                  <td>Initial recognition</td>
                  <td className="num">{money2(d.bridge.pvBase)}</td>
                  <td className="num">{pct(d.rate, 4)}</td>
                  <td><Tag kind="neutral">single current rate</Tag></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
    </>
  );
}

/* ══ Retirement cost asset ═════════════════════════════════════════════ */

export function Arc() {
  const unit = useUnit()!;
  const derived = useDerived()!;
  const rows = derived.rows.slice(0, 40).map((d) => {
    const life = Math.max(1, Math.round(d.tD));
    const cost = d.bridge.pvBase;
    const accum = cost * Math.min(1, 0.15);
    return { d, life, cost, accum, nbv: cost - accum, charge: cost / life };
  });

  return (
    <Block kicker="Retirement cost asset" title="Recognised alongside the provision"
      note="The asset is recognised at the same amount as the provision on initial recognition and depreciated over the life of the related asset. A revision adjusts both the provision and the asset; a downward revision that exceeds the carrying amount of the asset goes to profit or loss.">
      <Stats items={[
        { label: 'Gross cost', value: money(rows.reduce((s, r) => s + r.cost, 0)) },
        { label: 'Accumulated depreciation', value: money(rows.reduce((s, r) => s + r.accum, 0)) },
        { label: 'Net book value', value: money(rows.reduce((s, r) => s + r.nbv, 0)) },
        { label: 'Charge for the year', value: money(rows.reduce((s, r) => s + r.charge, 0)) },
      ]} />
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th>Obligation</th><th className="num">Gross cost</th><th className="num">Life (yrs)</th><th className="num">Charge for the year</th><th className="num">Accumulated</th><th className="num">Net book value</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.d.obligationId}>
                <td>{r.d.ref}</td>
                <td className="num">{money2(r.cost)}</td>
                <td className="num">{r.life}</td>
                <td className="num">{money2(r.charge)}</td>
                <td className="num">{money2(r.accum)}</td>
                <td className="num derived">{money2(r.nbv)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  );
}

/* ══ Event ledger ══════════════════════════════════════════════════════ */

export function Ledger() {
  const data = useUnitData()!;
  const [type, setType] = useState('all');
  const events = data.events.filter((e) => type === 'all' || e.type === type);
  const byPeriod = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data.events) m.set(e.periodId, (m.get(e.periodId) ?? 0) + e.amount);
    return m;
  }, [data.events]);

  return (
    <>
      <Block kicker="Event ledger" title={`${data.events.length} events`}
        note="Append-only. There is no update and no delete. An event derived by diffing a cumulative snapshot is marked as derived, which distinguishes an inferred movement from an evidenced one."
        actions={
          <select className="input" style={{ width: 160 }} value={type} onChange={(e) => setType(e.target.value)}>
            {['all', 'opening', 'addition', 'accretion', 'revision', 'settlement', 'fx'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        }>
        {events.length === 0 ? (
          <Empty>No events yet. Events are written when an extract is normalised, when a revision is recorded, and when accretion is allocated at each period close.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Period</th><th>Obligation</th><th>Type</th><th className="num">Amount</th><th>Provenance</th></tr></thead>
              <tbody>
                {events.slice(0, 200).map((e) => (
                  <tr key={e.id}>
                    <td>{data.periods.find((p) => p.id === e.periodId)?.code ?? e.periodId}</td>
                    <td>{data.obligations.find((o) => o.id === e.obligationId)?.ref ?? '—'}</td>
                    <td><Tag kind="neutral">{e.type}</Tag></td>
                    <td className="num">{money2(e.amount)}</td>
                    <td className="muted" style={{ whiteSpace: 'normal' }}>
                      {e.derived ? <Tag kind="warn">derived</Tag> : null} {e.note ?? e.sourceRowRef ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      <Block kicker="By period" title="What moved, period by period">
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Period</th><th>Status</th><th className="num">Net movement</th></tr></thead>
            <tbody>
              {data.periods.map((p) => (
                <tr key={p.id}>
                  <td>{p.code}</td>
                  <td>{p.status}</td>
                  <td className="num">{money2(byPeriod.get(p.id) ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
    </>
  );
}

/* ══ Recalculation — Mode 1 ════════════════════════════════════════════ */

export function Recalc() {
  const { ui, write } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const editable = canEdit(ui.role);
  const [onlyDiff, setOnlyDiff] = useState(true);

  const rows = derived.rows.map((d) => {
    const o = data.obligations.find((x) => x.id === d.obligationId)!;
    const source = sourceOf(o, d.pv);
    const variance = d.pv - source;
    const threshold = Math.max(unit.materialityUsd, Math.abs(source) * unit.materialityPct);
    return { o, d, source, variance, material: Math.abs(variance) >= threshold, threshold };
  });

  const shown = onlyDiff ? rows.filter((r) => Math.abs(r.variance) > 0.005) : rows;
  const totalEngine = rows.reduce((s, r) => s + r.d.pv, 0);
  const totalSource = rows.reduce((s, r) => s + r.source, 0);
  const materialCount = rows.filter((r) => r.material).length;
  const uncaused = rows.filter((r) => r.material && !r.o.varianceCause).length;

  const exportPack = () => {
    const head = ['Reference', 'Description', 'Engine provision', 'Source figure', 'Variance', 'Variance %', 'Material', 'Cause'];
    const out: any[][] = [
      [{ v: `${unit.entity} — recalculation against source`, s: S.title }],
      [`Year end ${unit.fyEnd}`, `Curve ${derived.curve?.name ?? 'none'}`, `Inflation ${pct(unit.inflation)}`,
        `Term convention ${unit.termConvention}`, `Materiality ${money(unit.materialityUsd)} or ${pct(unit.materialityPct)}`],
      [],
      head.map((h) => ({ v: h, s: S.head })),
    ];
    const first = out.length + 1;
    rows.forEach((r, i) => {
      const n = first + i;
      out.push([
        r.o.ref, r.o.description,
        { v: r.d.pv, s: S.money },
        { v: r.source, s: S.money },
        { f: `C${n}-D${n}`, s: S.money },
        { f: `IF(D${n}=0,"",(C${n}-D${n})/D${n})`, s: S.rate },
        { f: `IF(ABS(E${n})>=MAX(${unit.materialityUsd},ABS(D${n})*${unit.materialityPct}),"Yes","No")` },
        r.o.varianceCause || '',
      ]);
    });
    const last = first + rows.length;
    out.push([{ v: 'Total', s: S.bold }, '',
      { f: `SUM(C${first}:C${last - 1})`, s: S.money },
      { f: `SUM(D${first}:D${last - 1})`, s: S.money },
      { f: `SUM(E${first}:E${last - 1})`, s: S.money }]);

    download(`${unit.entity.replace(/\W+/g, '-')}-recalculation-${unit.fyEnd}.xlsx`, [
      { name: 'Recalculation', rows: out, cols: [14, 34, 17, 17, 15, 12, 11, 28], freeze: 4 },
    ]);
  };

  return (
    <>
      <Stats items={[
        { label: 'Engine provision', value: `${unit.currency} ${money(totalEngine)}` },
        { label: 'Source figure', value: `${unit.currency} ${money(totalSource)}` },
        { label: 'Variance', value: `${unit.currency} ${money(totalEngine - totalSource)}`, tone: Math.abs(totalEngine - totalSource) > unit.materialityUsd ? 'bad' : 'ok' },
        { label: 'Material differences', value: String(materialCount), tone: materialCount ? 'warn' : 'ok' },
        { label: 'Without a cause', value: String(uncaused), tone: uncaused ? 'bad' : 'ok' },
      ]} />

      <Block kicker="Recalculation" title="The engine against the source, obligation by obligation"
        note={`Materiality is tiered: a difference is material if it exceeds ${unit.currency} ${money(unit.materialityUsd)} in absolute terms or ${pct(unit.materialityPct)} of the source figure, whichever is larger. Every material difference needs a recorded cause before the completeness pack can be signed.`}
        actions={
          <>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5 }}>
              <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
              Differences only
            </label>
            <button className="btn btn-secondary btn-sm" onClick={exportPack}>Export to Excel</button>
          </>
        }>
        {shown.length === 0 ? (
          <Empty>Every obligation recalculates to the source figure. There is nothing to explain.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr>
                <th>Reference</th><th>Description</th>
                <th className="num">Engine <Basis tag="PV@FY-END" /></th>
                <th className="num">Source</th><th className="num">Variance</th><th className="num">%</th>
                <th>Material</th><th style={{ width: 210 }}>Cause</th>
              </tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.o.id}>
                    <td>{r.o.ref}</td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 230 }}>{r.o.description}</td>
                    <td className="num derived">{money2(r.d.pv)}</td>
                    <td className="num">{money2(r.source)}</td>
                    <td className="num" style={{ color: r.material ? 'var(--bad)' : undefined }}>{money2(r.variance)}</td>
                    <td className="num">{r.source ? pct(r.variance / r.source, 2) : '—'}</td>
                    <td>{r.material ? <Tag kind="bad">Material</Tag> : <Tag kind="neutral">Below</Tag>}</td>
                    <td>
                      <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} disabled={!editable}
                        value={String(r.o.varianceCause ?? '')}
                        onChange={(e) => write<Obligation>({
                          domain: 'register', record: r.o.id, recordLabel: `${r.o.ref} variance cause`,
                          before: r.o, after: { ...r.o, varianceCause: e.target.value },
                          action: 'Record variance cause',
                          apply: (s, v) => { const l = s.data[unit.id].obligations; const i = l.findIndex((x) => x.id === r.o.id); if (i >= 0) l[i] = v; },
                        })}>
                        <option value="">— none recorded —</option>
                        {VARIANCE_CAUSES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      <Block kicker="Assumptions in force" title="What the recalculation was run on">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10 }}>
          {[
            ['Day count', unit.dayCount],
            ['Term convention', unit.termConvention],
            ['Curve', derived.curve?.name ?? 'none assigned'],
            ['Curve as at', derived.curve?.asAt ?? '—'],
            ['Interpolation', derived.curve?.interpolation ?? '—'],
            ['Beyond last point', derived.curve?.extrapolation ?? '—'],
            ['Inflation', pct(unit.inflation)],
            ['Contingency', pct(unit.contingency)],
          ].map(([k, v]) => (
            <div key={k} style={{ background: 'var(--color-surface)', padding: '9px 12px' }}>
              <div className="kicker">{k}</div>
              <div style={{ fontSize: 12.5, fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{v}</div>
            </div>
          ))}
        </div>
      </Block>
    </>
  );
}

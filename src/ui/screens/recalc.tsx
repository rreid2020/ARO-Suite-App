/**
 * Mode 1 — recalculation & completeness.
 *
 * Six screens over one register: import the source system's extracts,
 * inspect them as they were read, recalculate, compare, clear the exceptions
 * and conclude on the variance.
 *
 * The prototype hand-rolled a column-filter panel, a sort menu and a pager for
 * its register. None of that is ported: `SheetTable` already does all three,
 * and the handoff is explicit that layout and state should be rebuilt in the
 * target codebase's own patterns rather than lifted.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { canEdit, signLevel } from '../../core/authority';
import {
  BUILT_IN_CURVE,
  Exception,
  RecalcRegister,
  assumptionsOf,
  completeness,
  curveInForce,
  exceptions,
  mergeRep04,
  mergeRep06,
  portfolioTotals,
  withFile,
} from '../../core/recalc';
import {
  PREVIEW_FIELDS,
  StagedExtract,
  curveFromStage,
  pickVintage,
  previewRows,
  rep04Lines,
  rep06Lines,
  vintagesOf,
} from '../../core/recalcImport';
import { formulasFor } from '../../core/recalcFormulas';
import { money, parseNumber } from '../../core/format';
import {
  RecalcRow,
  accretionSchedule,
  curveMaxTerm,
  recalcBridge,
  recalcCurveTerm,
  recalculate,
  sourceFigures,
  varianceFlag,
} from '../../engine/recalc';
import { autoMap, readSheet, ExtractKind } from '../../xlsx/read';
import { recalcWorkbook } from '../../xlsx/recalcWorkbook';
import { download } from '../../xlsx/write';
import { Block, Empty, Field, Stats, Tag, SheetTable, num } from '../components';

/* ══ Shared ════════════════════════════════════════════════════════════ */

const EXTRACTS: { kind: ExtractKind; label: string; note: string }[] = [
  { kind: 'rep04', label: 'REP04', note: 'Cost estimates and cost estimate dates' },
  { kind: 'rep06', label: 'REP06', note: 'Settlement dates and the reported FV / PV' },
  { kind: 'curve', label: 'Interest rate curve', note: 'Valid on, term, rate' },
];

const signed = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return `${r > 0 ? '+' : r < 0 ? '-' : ''}${money(Math.abs(r))}`;
};
const ratePct = (n: number) => `${(n * 100).toFixed(5)}%`;

/** The register, and a helper that writes a new one through the write path. */
function useRegister() {
  const { ui, write } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const reg = data.recalc;

  const set = (
    action: string,
    domain: 'register' | 'assumptions' | 'evidence',
    next: Partial<RecalcRegister>,
  ) =>
    write<RecalcRegister>({
      domain,
      record: `${unit.id}-recalc`,
      recordLabel: 'Recalculation register',
      before: reg,
      after: { ...reg, ...next },
      action,
      apply: (s, value) => {
        s.data[unit.id].recalc = value;
      },
    });

  return { reg, set, unit, editable: canEdit(ui.role), role: ui.role };
}

/**
 * Raw extract rows, held for this browser session only and never persisted.
 *
 * This is client data read off a workbook on the reviewer's own machine. The
 * register keeps the figures it needs; keeping several thousand raw source rows
 * as well — in the store, and therefore in the database — would be storing the
 * client's extract rather than the conclusion drawn from it. So the viewer
 * holds them here, they clear on reload, and the screen says so.
 */
interface SourceSnapshot {
  kind: ExtractKind;
  file: string;
  sheetName: string;
  headers: string[];
  rows: string[][];
  total: number;
  map: Record<string, number>;
  vintage: string;
}
const SESSION_SOURCES: SourceSnapshot[] = [];

/* ══ Source extracts ═══════════════════════════════════════════════════ */

export function RecalcImport() {
  const { reg, set, editable } = useRegister();
  const [stage, setStage] = useState<StagedExtract | null>(null);
  const [busy, setBusy] = useState<ExtractKind | ''>('');
  const [error, setError] = useState('');

  const pick = (kind: ExtractKind) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(kind);
    setError('');
    file
      .arrayBuffer()
      .then((buf) => readSheet(new Uint8Array(buf)))
      .then((sheet) => {
        const next: StagedExtract = { kind, file: file.name, sheet, map: autoMap(kind, sheet.headers) };
        if (kind === 'curve') next.vintage = pickVintage(next, reg.fyEnd);
        setBusy('');
        setStage(next);
      })
      .catch((err: Error) => {
        setBusy('');
        setError(`Could not read that file: ${err?.message ?? err}`);
      });
  };

  const apply = () => {
    if (!stage) return;
    SESSION_SOURCES.push({
      kind: stage.kind,
      file: stage.file,
      sheetName: stage.sheet.sheetName,
      headers: stage.sheet.headers.map((h) => h.label),
      rows: stage.sheet.rows.slice(0, 5000),
      total: stage.sheet.rows.length,
      map: { ...stage.map },
      vintage: stage.vintage ?? '',
    });

    if (stage.kind === 'curve') {
      const points = curveFromStage(stage, stage.vintage);
      if (points.length < 2) {
        setError('No usable curve rows — check the column mapping and the vintage.');
        return;
      }
      set('Import interest rate curve', 'assumptions', {
        curve: { asAt: stage.vintage || 'imported', points },
        curveSource: `${stage.file} · ${points.length} terms`,
      });
    } else if (stage.kind === 'rep04') {
      const out = mergeRep04(reg.rows, reg.seeded, rep04Lines(stage), stage.file);
      if (!out.rows.length) {
        setError('No usable rows — check the column mapping.');
        return;
      }
      set('Import REP04 extract', 'register', {
        rows: out.rows,
        seeded: false,
        rep04: withFile(reg.rep04, stage.file, out.summary),
      });
    } else {
      const out = mergeRep06(reg.rows, rep06Lines(stage), stage.file);
      set('Import REP06 extract', 'register', {
        rows: out.rows,
        seeded: false,
        rep06: withFile(reg.rep06, stage.file, out.summary),
      });
    }
    setStage(null);
    setError('');
  };

  const curve = curveInForce(reg);

  return (
    <>
      <Block
        kicker="Source extracts"
        title="Read the source system's own reports"
        note="The file is opened here, in this page, and never leaves the machine. Nothing is written to the register until the column mapping below has been looked at: the sheet, the header row and every column are guesses, and each one is a place a silent import puts the wrong number in front of a reviewer."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12 }}>
          {EXTRACTS.map((x) => {
            const done =
              x.kind === 'rep04' ? reg.rep04 : x.kind === 'rep06' ? reg.rep06 : reg.curve ? { summary: reg.curveSource } : null;
            return (
              <div key={x.kind} style={{ background: 'var(--color-surface)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="kicker">{x.label}</div>
                <div style={{ fontSize: 12, lineHeight: 1.5 }} className="muted">
                  {done ? done.summary : x.note}
                </div>
                {editable && (
                  <label className={done ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'} style={{ cursor: 'pointer', alignSelf: 'flex-start' }}>
                    {busy === x.kind ? 'Reading…' : done ? `Merge another ${x.label}` : `Choose ${x.label} .xlsx`}
                    <input type="file" accept=".xlsx" style={{ display: 'none' }} onChange={pick(x.kind)} />
                  </label>
                )}
              </div>
            );
          })}
        </div>
        {error && (
          <div className="note-panel" style={{ marginTop: 12, borderLeftColor: 'var(--bad)' }}>{error}</div>
        )}
      </Block>

      {stage && <StagePanel stage={stage} setStage={setStage} onApply={apply} fyEnd={reg.fyEnd} />}

      <Block kicker="Curve in force" title={curve.asAt}
        note={reg.curve
          ? 'Discount rates are read from the client table imported above.'
          : 'No client curve has been imported, so rates come from the built-in FY26 table. Every figure derived from it is illustrative, and the exception list says so.'}
        actions={editable && reg.curve && (
          <button className="btn btn-secondary btn-sm" onClick={() => set('Clear imported curve', 'assumptions', { curve: null, curveSource: '' })}>
            Revert to the built-in curve
          </button>
        )}>
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Term (yrs)</th><th className="num">Rate</th><th className="num">Obligations at this term</th></tr></thead>
            <tbody>
              {curve.points.map((p) => {
                const used = reg.rows.filter(
                  (r) => recalcCurveTerm(curve, recalculate(r, assumptionsOf(reg), curve).tD).term === p.term,
                ).length;
                return (
                  <tr key={p.term}>
                    <td>{p.term}</td>
                    <td className="num">{ratePct(p.rate)}</td>
                    <td className="num">{used ? num(used) : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Block>
    </>
  );
}

function StagePanel({
  stage, setStage, onApply, fyEnd,
}: {
  stage: StagedExtract;
  setStage: (s: StagedExtract | null) => void;
  onApply: () => void;
  fyEnd: string;
}) {
  const fields = PREVIEW_FIELDS[stage.kind];
  const vintages = stage.kind === 'curve' ? vintagesOf(stage) : [];
  const curveRows = stage.kind === 'curve' ? curveFromStage(stage, stage.vintage) : [];
  const preview = previewRows(stage);

  return (
    <Block
      kicker={`${stage.kind.toUpperCase()} — map the columns`}
      title={stage.file}
      note={`Sheet "${stage.sheet.sheetName}" · ${num(stage.sheet.rows.length)} data rows · headers taken from row ${stage.sheet.headerRow + 1}.`}
      actions={
        <>
          <button className="btn btn-secondary btn-sm" onClick={() => setStage(null)}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={onApply}>Import into the register</button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 12, marginBottom: 14 }}>
        {fields.map((f) => {
          const mapped = stage.map[f.key] >= 0;
          return (
            <Field key={f.key} label={f.label} hint={mapped ? 'matched' : 'not found — pick the column'}>
              <select
                value={String(stage.map[f.key] ?? -1)}
                style={mapped ? undefined : { borderColor: 'var(--bad)' }}
                onChange={(e) => setStage({ ...stage, map: { ...stage.map, [f.key]: Number(e.target.value) } })}
              >
                <option value="-1">— not mapped —</option>
                {stage.sheet.headers.map((h) => (
                  <option key={h.index} value={String(h.index)}>{h.label}</option>
                ))}
              </select>
            </Field>
          );
        })}
        {stage.kind === 'curve' && vintages.length > 0 && (
          <Field
            label="Vintage"
            hint={curveRows.length
              ? `${curveRows.length} terms · ${curveRows[0].term} to ${curveRows[curveRows.length - 1].term} yrs`
              : 'No usable rows for this vintage'}
            help="A client curve export usually carries every vintage the system holds, not just the one wanted. The vintage matching the year end is offered first."
          >
            <select value={stage.vintage ?? ''} onChange={(e) => setStage({ ...stage, vintage: e.target.value })}>
              {vintages.map((v) => (
                <option key={v.value} value={v.value}>{v.value} ({v.rows} terms)</option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="kicker" style={{ marginBottom: 6 }}>
        First {preview.length} rows, as this mapping reads them
        {stage.kind === 'curve' && vintages.length === 0 && ` · no vintage column, so every row is taken · year end ${fyEnd}`}
      </div>
      <div className="scroll-x">
        <table className="table">
          <thead><tr>{fields.map((f) => <th key={f.key}>{f.label}</th>)}</tr></thead>
          <tbody>
            {preview.map((cells, i) => (
              <tr key={i}>
                {cells.map((c, j) => (
                  <td key={j}>
                    {c.shown}
                    {c.raw && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>was {c.raw}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  );
}

/* ══ Imported data ═════════════════════════════════════════════════════ */

export function RecalcSource() {
  const [kind, setKind] = useState<ExtractKind>('rep04');
  const [sel, setSel] = useState(0);
  const list = SESSION_SOURCES.filter((s) => s.kind === kind);
  const snap = list[Math.min(sel, Math.max(0, list.length - 1))] ?? null;

  const roleAt: Record<number, string> = {};
  if (snap) {
    for (const [key, i] of Object.entries(snap.map)) {
      if (i >= 0) roleAt[i] = PREVIEW_FIELDS[snap.kind].find((f) => f.key === key)?.label ?? key;
    }
  }

  return (
    <Block
      kicker="Imported data"
      title={snap ? snap.file : 'Nothing imported in this session'}
      note="The extracts exactly as they were read, with the mapped columns marked, so every figure in the recalculation can be tied back to a row in the original workbook. These rows are held in memory for this session only — they are the client's data and are never written to the database, so they clear on reload."
      actions={
        <div style={{ display: 'flex', gap: 6 }}>
          {EXTRACTS.map((x) => {
            const n = SESSION_SOURCES.filter((s) => s.kind === x.kind).length;
            return (
              <button
                key={x.kind}
                className={kind === x.kind ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                onClick={() => { setKind(x.kind); setSel(0); }}
              >
                {x.label}{n ? ` (${n})` : ''}
              </button>
            );
          })}
        </div>
      }
    >
      {list.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {list.map((s, i) => (
            <button key={i} className={i === sel ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => setSel(i)}>
              {s.file} · {num(s.total)} rows
            </button>
          ))}
        </div>
      )}

      {!snap ? (
        <Empty>
          Nothing has been imported in this session. Source rows are held in memory only, so they clear on reload —
          import the extract again on Source extracts to inspect it here.
        </Empty>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
            Sheet "{snap.sheetName}" · {num(snap.total)} data rows · {snap.headers.length} columns
            {snap.total > snap.rows.length && ` · first ${num(snap.rows.length)} held for viewing`}
            {snap.vintage && ` · vintage ${snap.vintage}`}
          </div>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  {snap.headers.map((h, i) => (
                    <th key={i} style={roleAt[i] ? { color: 'var(--color-accent)' } : undefined}>
                      {h}
                      {roleAt[i] && <div className="kicker" style={{ color: 'var(--color-accent)' }}>{roleAt[i]}</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snap.rows.slice(0, 200).map((row, j) => (
                  <tr key={j}>
                    <td className="num muted">{num(j + 1)}</td>
                    {snap.headers.map((_, i) => (
                      <td key={i} className={roleAt[i] ? undefined : 'muted'}>{String(row[i] ?? '').trim() || '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {snap.rows.length > 200 && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
              Showing the first 200 of {num(snap.rows.length)} held rows.
            </div>
          )}
        </>
      )}
    </Block>
  );
}

/* ══ Recalculation ═════════════════════════════════════════════════════ */

export function Recalculation() {
  const { reg, set, unit, editable } = useRegister();
  const a = assumptionsOf(reg);
  const curve = curveInForce(reg);
  const totals = useMemo(() => portfolioTotals(reg), [reg]);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const dv = (key: string, committed: string) => draft[key] ?? committed;
  const commit = (key: string) => setDraft((d) => { const n = { ...d }; delete n[key]; return n; });

  const exportBook = () => {
    const at = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    download(`${unit.entity.replace(/\W+/g, '-')}-recalculation-${reg.fyEnd}.xlsx`, recalcWorkbook(reg, at));
  };

  return (
    <>
      <Block kicker="Assumptions" title="What the recalculation runs on"
        note="One inflation rate across the population, and the discount rate read off the curve at the term rounded up to the next whole year — the source system's own convention, reproduced rather than corrected.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
          <Field label="FY year end" hint="The valuation date every term is measured from.">
            <input value={dv('fyEnd', reg.fyEnd)} disabled={!editable}
              onChange={(e) => setDraft((d) => ({ ...d, fyEnd: e.target.value }))}
              onBlur={(e) => { commit('fyEnd'); if (e.target.value !== reg.fyEnd) set('Set FY year end', 'assumptions', { fyEnd: e.target.value }); }} />
          </Field>
          <Field label="Inflation / escalation %" hint="Applied to both escalation legs.">
            <input value={dv('infl', (reg.inflation * 100).toFixed(2))} disabled={!editable}
              onChange={(e) => setDraft((d) => ({ ...d, infl: e.target.value }))}
              onBlur={(e) => { commit('infl'); set('Set inflation rate', 'assumptions', { inflation: parseNumber(e.target.value) / 100 }); }} />
          </Field>
          <Field label="Curve" hint={reg.curveSource || 'Built-in FY26 curve'}>
            <input value={`${curve.asAt} · ${curve.points.length} terms to ${curveMaxTerm(curve)} yrs`} readOnly />
          </Field>
        </div>
      </Block>

      <Block kicker="Recalculation" title={`${num(totals.count)} obligation${totals.count === 1 ? '' : 's'}`}
        note="Open a row for the same calculation written as Excel. Paste that column into A1 of a blank sheet and every figure in the row reproduces — each formula references the rows above it, exactly as the chain chains its steps."
        actions={<button className="btn btn-primary btn-sm" onClick={exportBook} disabled={!reg.rows.length}>Export workbook</button>}>
        <Stats items={[
          { label: 'Cost estimate at FY end', value: money(totals.cce) },
          { label: 'FV at settlement', value: money(totals.fv) },
          { label: 'PV at FY year end', value: money(totals.pv) },
          { label: 'Compared', value: `${num(totals.covered)} of ${num(totals.count)}` },
        ]} />

        {!reg.rows.length ? (
          <Empty>
            The register is empty. Import a REP04 extract on Source extracts — it carries the cost estimates and the
            cost estimate dates every other figure is built from.
          </Empty>
        ) : (
          <SheetTable
            rows={reg.rows}
            rowKey={(r) => `${r.id}-${r.costEstimateDate}-${r.settlementDate}`}
            noun="obligations"
            expand={(r) => <FormulaPanel row={r} reg={reg} />}
            columns={[
              { key: 'id', header: 'Obligation', value: (r) => r.id, cell: (r) => <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{r.id}</span> },
              { key: 'pk', header: 'Cost est. date', kind: 'date', value: (r) => r.costEstimateDate, cell: (r) => r.costEstimateDate || <Tag kind="bad">missing</Tag> },
              { key: 'st', header: 'Settlement', kind: 'date', value: (r) => r.settlementDate, cell: (r) => r.settlementDate || <Tag kind="bad">missing</Tag> },
              { key: 'term', header: 'Term', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => recalculate(r, a, curve).tD, cell: (r) => recalculate(r, a, curve).tD.toFixed(2) },
              { key: 'curveT', header: 'Curve term', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => recalculate(r, a, curve).curveTerm, cell: (r) => {
                const k = recalculate(r, a, curve);
                return <>{k.curveTerm}{k.beyond && <> <Tag kind="warn">capped</Tag></>}</>;
              } },
              { key: 'rate', header: 'Discount %', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => recalculate(r, a, curve).rate, cell: (r) => {
                const k = recalculate(r, a, curve);
                return <span style={k.overridden ? { color: 'var(--color-accent)' } : undefined}>{ratePct(k.rate)}</span>;
              } },
              { key: 'cost', header: 'Cost est. (REP04)', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => r.cost, cell: (r) => r.cost ? money(r.cost) : <Tag kind="bad">none</Tag> },
              { key: 'cce', header: 'At FY end', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => recalculate(r, a, curve).cce, cell: (r) => money(recalculate(r, a, curve).cce) },
              { key: 'fv', header: 'FV', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => recalculate(r, a, curve).fv, cell: (r) => money(recalculate(r, a, curve).fv) },
              { key: 'pv', header: 'PV', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => recalculate(r, a, curve).pv, cell: (r) => <strong>{money(recalculate(r, a, curve).pv)}</strong> },
            ]}
          />
        )}
      </Block>
    </>
  );
}

function FormulaPanel({ row, reg }: { row: RecalcRow; reg: RecalcRegister }) {
  const rows = formulasFor(row, assumptionsOf(reg), curveInForce(reg), reg.materiality);
  return (
    <div style={{ padding: '10px 0' }}>
      <div className="note-panel" style={{ marginBottom: 10 }}>
        This is the calculation itself, written as Excel. Paste the formula column into A1 of a blank sheet and every
        figure below reproduces exactly — each row references the rows above it, and every date and rate is a literal,
        so nothing else needs wiring up.
      </div>
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th>Cell</th><th>What it computes</th><th>Formula</th><th className="num">Value</th></tr></thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.ref}>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{f.ref}</td>
                <td style={{ maxWidth: 380 }}>{f.label}</td>
                <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, wordBreak: 'break-all' }}>{f.formula}</td>
                <td className="num">{f.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ══ Source comparison ═════════════════════════════════════════════════ */

export function RecalcCompare() {
  const { reg, set, editable } = useRegister();
  const a = assumptionsOf(reg);
  const curve = curveInForce(reg);
  const totals = useMemo(() => portfolioTotals(reg), [reg]);
  const comp = useMemo(() => completeness(reg), [reg]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const dv = (k: string, v: string) => draft[k] ?? v;
  const commit = (k: string) => setDraft((d) => { const n = { ...d }; delete n[k]; return n; });

  const compared = reg.rows.filter((r) => sourceFigures(r).has);

  return (
    <>
      <Block kicker="Completeness" title="The trial balance control total"
        note={comp.note}
        actions={
          <Tag kind={comp.status === 'AGREES' ? 'accent' : comp.status === 'DIFFERENCE' ? 'bad' : 'warn'}>{comp.status}</Tag>
        }>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12, marginBottom: 12 }}>
          <Field label="Total ARO PV per the source trial balance"
            help="Your independent control total. Nothing is derived from it — it exists to prove the extract population is complete, because a perfect recalculation of half the balance still reads clean.">
            <input
              value={dv('tb', reg.trialBalancePv === null ? '' : String(reg.trialBalancePv))}
              disabled={!editable}
              placeholder="not entered"
              onChange={(e) => setDraft((d) => ({ ...d, tb: e.target.value }))}
              onBlur={(e) => {
                commit('tb');
                const raw = e.target.value.trim();
                set('Set trial balance control total', 'register', { trialBalancePv: raw === '' ? null : parseNumber(raw) });
              }}
            />
          </Field>
          <Field label="Materiality — absolute" help="A difference larger than this is flagged, whatever it is a proportion of.">
            <input value={dv('mu', String(reg.materiality.usd))} disabled={!editable}
              onChange={(e) => setDraft((d) => ({ ...d, mu: e.target.value }))}
              onBlur={(e) => { commit('mu'); set('Set absolute materiality', 'assumptions', { materiality: { ...reg.materiality, usd: Math.abs(parseNumber(e.target.value)) } }); }} />
          </Field>
          <Field label="Materiality — relative %" help="A difference larger than this share of the reported balance is flagged. Either threshold breaching is enough.">
            <input value={dv('mp', String(reg.materiality.pct))} disabled={!editable}
              onChange={(e) => setDraft((d) => ({ ...d, mp: e.target.value }))}
              onBlur={(e) => { commit('mp'); set('Set relative materiality', 'assumptions', { materiality: { ...reg.materiality, pct: Math.abs(parseNumber(e.target.value)) } }); }} />
          </Field>
        </div>
        <Stats items={[
          { label: 'Reported PV (REP06)', value: money(comp.reportedPv) },
          { label: 'TB less reported', value: comp.status === 'NOT ENTERED' ? '—' : signed(comp.vsReported), tone: comp.status === 'DIFFERENCE' ? 'bad' : undefined },
          { label: 'Recalculated PV', value: money(comp.recalculatedPv) },
          { label: 'TB less recalculated', value: comp.status === 'NOT ENTERED' ? '—' : signed(comp.vsRecalculated) },
          { label: 'Carrying a reported PV', value: `${num(comp.covered)} of ${num(comp.count)}` },
        ]} />
      </Block>

      <Block kicker="Source comparison" title={`${num(totals.flagged)} of ${num(totals.covered)} above materiality`}
        note="The recalculation against what the source system reported. The FV variance is shown separately from the PV variance on purpose: an FV that does not agree points at the cost estimate, the inflation rate or the dates, not at the discounting.">
        <Stats items={[
          { label: 'Recalculated PV (compared)', value: money(totals.comparedPv) },
          { label: 'Reported PV', value: money(totals.reportedPv) },
          { label: 'Variance', value: signed(totals.variance), tone: totals.flag === 'VARIANCE' ? 'bad' : 'ok' },
          { label: 'Variance %', value: totals.reportedPv ? `${((totals.variance / totals.reportedPv) * 100).toFixed(4)}%` : '—' },
        ]} />

        {!compared.length ? (
          <Empty>
            No obligation carries both a reported FV and a reported PV, so there is nothing to compare. Import a REP06
            extract on Source extracts.
          </Empty>
        ) : (
          <SheetTable
            rows={compared}
            rowKey={(r) => `${r.id}-${r.settlementDate}`}
            noun="obligations"
            columns={[
              { key: 'id', header: 'Obligation', value: (r) => r.id, cell: (r) => <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{r.id}</span> },
              { key: 'fv', header: 'FV — recalculated', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => recalculate(r, a, curve).fv, cell: (r) => money(recalculate(r, a, curve).fv) },
              { key: 'sapFv', header: 'FV — reported', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => sourceFigures(r).fv, cell: (r) => money(sourceFigures(r).fv) },
              { key: 'dFv', header: 'Δ FV', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => sourceFigures(r).fv - recalculate(r, a, curve).fv, cell: (r) => signed(sourceFigures(r).fv - recalculate(r, a, curve).fv) },
              { key: 'pv', header: 'PV — recalculated', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => recalculate(r, a, curve).pv, cell: (r) => money(recalculate(r, a, curve).pv) },
              { key: 'sapPv', header: 'PV — reported', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => sourceFigures(r).pv, cell: (r) => money(sourceFigures(r).pv) },
              { key: 'dPv', header: 'Δ PV', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => sourceFigures(r).pv - recalculate(r, a, curve).pv, cell: (r) => <strong>{signed(sourceFigures(r).pv - recalculate(r, a, curve).pv)}</strong> },
              { key: 'dPct', header: 'Δ %', kind: 'number', thClassName: 'num', tdClassName: 'num',
                value: (r) => { const s = sourceFigures(r); return s.pv ? (s.pv - recalculate(r, a, curve).pv) / s.pv : 0; },
                cell: (r) => { const s = sourceFigures(r); return s.pv ? `${(((s.pv - recalculate(r, a, curve).pv) / s.pv) * 100).toFixed(4)}%` : '—'; } },
              { key: 'flag', header: 'Flag',
                value: (r) => varianceFlag(sourceFigures(r).pv - recalculate(r, a, curve).pv, sourceFigures(r).pv, reg.materiality),
                cell: (r) => {
                  const f = varianceFlag(sourceFigures(r).pv - recalculate(r, a, curve).pv, sourceFigures(r).pv, reg.materiality);
                  return <Tag kind={f === 'VARIANCE' ? 'bad' : 'neutral'}>{f}</Tag>;
                } },
            ]}
          />
        )}
      </Block>
    </>
  );
}

/* ══ Exceptions & clearance ════════════════════════════════════════════ */

export function RecalcExceptions() {
  const { reg } = useRegister();
  const { setUi } = useStore();
  const report = useMemo(() => exceptions(reg), [reg]);

  const tone = (s: Exception['severity']) => (s === 'BLOCKER' ? 'bad' : s === 'REVIEW' ? 'warn' : 'neutral');

  return (
    <Block
      kicker="Exceptions & clearance"
      title={report.clear ? 'Clear to finalise' : `${report.blockers} blocker${report.blockers === 1 ? '' : 's'} open`}
      note={report.clear
        ? 'No blockers outstanding. Anything left below is a matter to explain on file, not a bar to finalising.'
        : 'The recalculation cannot be finalised while a blocker is open. Each one either has no answer in the data, or means the tested population is not proven complete. Nothing here can be ticked away — an exception goes when the data that caused it changes.'}
      actions={<Tag kind={report.clear ? 'accent' : 'bad'}>{report.clear ? 'CLEAR' : `${report.blockers} OPEN`}</Tag>}
    >
      <Stats items={[
        { label: 'Blockers', value: String(report.blockers), tone: report.blockers ? 'bad' : 'ok' },
        { label: 'For review', value: String(report.reviews), tone: report.reviews ? 'warn' : undefined },
        { label: 'Information', value: String(report.infos) },
      ]} />

      {!report.items.length ? (
        <Empty>Nothing outstanding. The register reconciles, the population is proven and the conclusion is signed.</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr><th>Severity</th><th>Exception</th><th className="num">Obligations</th><th>Resolve</th></tr>
            </thead>
            <tbody>
              {report.items.map((x) => (
                <tr key={x.id}>
                  <td><Tag kind={tone(x.severity)}>{x.severity}</Tag></td>
                  <td style={{ maxWidth: 620 }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{x.title}</div>
                    <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5, textWrap: 'pretty' }}>{x.detail}</div>
                  </td>
                  <td className="num">{x.count ? num(x.count) : <span className="muted">—</span>}</td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => setUi({ screen: x.screen })}>{x.action}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}

/* ══ Variance & sign-off ═══════════════════════════════════════════════ */

export function RecalcVariance() {
  const { reg, set } = useRegister();
  const { ui } = useStore();
  const a = assumptionsOf(reg);
  const curve = curveInForce(reg);
  const report = useMemo(() => exceptions(reg), [reg]);
  const compared = reg.rows.filter((r) => sourceFigures(r).has);
  const [selId, setSelId] = useState('');
  const row = compared.find((r) => r.id === selId) ?? compared[0];

  if (!row) {
    return (
      <Empty>
        No obligation carries both a reported FV and a reported PV, so there is no variance to explain. Import a REP06
        extract on Source extracts.
      </Empty>
    );
  }

  const k = recalculate(row, a, curve);
  const s = sourceFigures(row);
  const bridge = recalcBridge(row, a, curve);
  const schedule = accretionSchedule(row, a, curve);
  const flag = varianceFlag(s.pv - k.pv, s.pv, reg.materiality);
  // INVARIANTS §7 — a preparer prepares; a reviewer or partner concludes.
  const canConclude = (signLevel(ui.role) ?? -1) >= 1;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.000005;
  const maxStep = Math.max(...bridge.steps.map((x) => Math.abs(x.amount)), Math.abs(s.pv - k.pv), 0.01);

  return (
    <>
      <Block kicker="Variance & sign-off" title={`Obligation ${row.id}`}
        note="The source system publishes three figures and none of its assumptions, so its rates are back-solved over the recalculated terms. An implied rate absorbs everything in its leg — including a wrong cost estimate or a wrong date — which is why the steps are labelled by leg rather than by cause."
        actions={
          <select value={row.id} onChange={(e) => setSelId(e.target.value)}>
            {compared.map((r) => <option key={r.id} value={r.id}>Obligation {r.id}</option>)}
          </select>
        }>
        <Stats items={[
          { label: 'Recalculated PV', value: money(k.pv) },
          { label: 'Reported PV', value: money(s.pv) },
          { label: 'Variance', value: signed(s.pv - k.pv), tone: flag === 'VARIANCE' ? 'bad' : 'ok' },
          { label: 'Flag', value: flag, tone: flag === 'VARIANCE' ? 'bad' : 'ok' },
        ]} />

        <div className="kicker" style={{ marginBottom: 6 }}>The bridge — these steps sum to the variance exactly</div>
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Step</th><th className="num">Amount</th><th style={{ width: '45%' }}>Size</th></tr></thead>
            <tbody>
              <tr><td>Recalculated PV</td><td className="num">{money(bridge.start)}</td><td /></tr>
              {bridge.steps.map((step) => (
                <tr key={step.label}>
                  <td>{step.label}</td>
                  <td className="num">{signed(step.amount)}</td>
                  <td>
                    <div style={{ height: 10, background: 'var(--color-surface)' }}>
                      <div style={{
                        height: 10,
                        width: `${(Math.abs(step.amount) / maxStep) * 100}%`,
                        background: step.amount >= 0 ? 'var(--color-accent)' : 'var(--color-neutral-800, #444141)',
                      }} />
                    </div>
                  </td>
                </tr>
              ))}
              <tr><td><strong>Reported PV</strong></td><td className="num"><strong>{money(bridge.end)}</strong></td><td /></tr>
            </tbody>
          </table>
        </div>
      </Block>

      <Block kicker="Input by input" title="Ours against theirs"
        note="Where the two differ, the implied rate is what the source system must have used to reach the figures it published — not a rate it disclosed.">
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Input</th><th className="num">Recalculated</th><th className="num">Implied by the source</th><th>Agrees</th></tr></thead>
            <tbody>
              {[
                ['Inflation rate', `${(a.inflation * 100).toFixed(4)}%`, `${(bridge.implied.inflation * 100).toFixed(4)}%`, near(a.inflation, bridge.implied.inflation)],
                ['Discount rate', ratePct(k.rate), `${(bridge.implied.rate * 100).toFixed(5)}%`, near(k.rate, bridge.implied.rate)],
                ['Escalation term', bridge.implied.tE.toFixed(4), '30/360', true],
                ['Discount term', bridge.implied.tD.toFixed(4), '30/360', true],
                ['FV at settlement', money(k.fv), money(s.fv), Math.abs(k.fv - s.fv) < 0.005],
                ['PV at FY year end', money(k.pv), money(s.pv), Math.abs(k.pv - s.pv) < 0.005],
              ].map(([label, ours, theirs, agrees]) => (
                <tr key={label as string}>
                  <td>{label}</td>
                  <td className="num">{ours}</td>
                  <td className="num">{theirs}</td>
                  <td>{agrees ? <Tag kind="neutral">agrees</Tag> : <Tag kind="bad">differs</Tag>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>

      <Block kicker="Accretion" title={`${schedule.periods.length} period${schedule.periods.length === 1 ? '' : 's'} to settlement`}
        note="The discount unwinding from the recalculated PV to the future value being compared. Nothing is posted from this in Mode 1 — it is here so the two figures can be seen to be the same measurement at different dates.">
        <Stats items={[
          { label: 'Opening PV', value: money(k.pv) },
          { label: 'Total unwinding', value: money(schedule.total) },
          { label: 'FV at settlement', value: money(k.fv) },
        ]} />
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>To</th><th className="num">Opening</th><th className="num">Accretion</th><th className="num">Closing</th><th className="num">% of FV</th></tr></thead>
            <tbody>
              {schedule.periods.map((p) => (
                <tr key={p.to}>
                  <td>{p.to}</td>
                  <td className="num">{money(p.opening)}</td>
                  <td className="num">{money(p.accretion)}</td>
                  <td className="num">{money(p.closing)}</td>
                  <td className="num">{(p.ofFv * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>

      <Block kicker="Conclusion" title={reg.signedOff ? `Signed by ${reg.signedOff.by}` : 'Awaiting review'}
        note={report.clear
          ? 'No blocker is open, so the variance analysis can be concluded on.'
          : `The conclusion is held while ${report.blockers} blocker${report.blockers === 1 ? '' : 's'} remain${report.blockers === 1 ? 's' : ''} open on Exceptions & clearance.`}>
        {reg.signedOff ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Tag kind="accent">SIGNED</Tag>
            <span className="muted" style={{ fontSize: 12 }}>{reg.signedOff.by} · {reg.signedOff.at}</span>
            {canConclude && (
              <button className="btn btn-secondary btn-sm" onClick={() => set('Withdraw variance sign-off', 'evidence', { signedOff: null })}>
                Withdraw
              </button>
            )}
          </div>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            disabled={!report.clear || !canConclude}
            onClick={() => set('Sign off the variance analysis', 'evidence', {
              signedOff: { by: ui.userName, at: new Date().toISOString().slice(0, 10) },
            })}
          >
            {!report.clear
              ? `Blocked — ${report.blockers} to resolve`
              : !canConclude
                ? 'A reviewer or partner signs this off'
                : 'Sign off the variance analysis'}
          </button>
        )}
      </Block>
    </>
  );
}

/** Re-exported so the built-in curve is reachable from the screen registry tests. */
export { BUILT_IN_CURVE };

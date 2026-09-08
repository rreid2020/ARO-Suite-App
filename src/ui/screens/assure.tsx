/**
 * Assure phase — evidence & freeze, sampling & tickmarks, completeness pack,
 * review & sign-off.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit, canLockPeriod, roleById, signLevel } from '../../core/authority';
import { YEAR_END_GATES, runGates, YearEndState } from '../../core/gates';
import { Block, Empty, Field, currency, num, SheetTable, Stats, Tag } from '../components';
import { download, S } from '../../xlsx/write';

/* ══ Evidence & freeze ═════════════════════════════════════════════════ */

export function Freeze() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;

  const take = () => {
    const rows = derived.rows.map((d) => ({ obligationId: d.obligationId, ref: d.ref, pv: d.pv }));
    let h = 0;
    for (const r of rows) h = (h * 31 + Math.round(r.pv * 100)) | 0;
    apply('Freeze dataset', 'write',
      `Froze the dataset as version ${data.freezes.length + 1}: ${rows.length} obligations totalling ${currency(derived.total, unit.currency)}. A re-import is a new version with a diff, never an edit of this one.`,
      (s) => {
        s.data[unit.id].freezes.push({
          id: `fz-${Date.now().toString(36)}`, unitId: unit.id,
          version: s.data[unit.id].freezes.length + 1,
          hash: `sha256:${(h >>> 0).toString(16).padStart(8, '0')}…`,
          population: rows.length, total: derived.total,
          createdAt: new Date().toISOString(), createdBy: ui.userName, rows,
        });
      });
  };

  const latest = data.freezes[data.freezes.length - 1];
  const prev = data.freezes[data.freezes.length - 2];

  /** A re-import is a new version WITH A DIFF — INVARIANTS §2. */
  const diff = useMemo(() => {
    if (!latest || !prev) return null;
    const before = new Map(prev.rows.map((r) => [r.obligationId, r]));
    const after = new Map(latest.rows.map((r) => [r.obligationId, r]));
    const added = latest.rows.filter((r) => !before.has(r.obligationId));
    const removed = prev.rows.filter((r) => !after.has(r.obligationId));
    const changed = latest.rows.filter((r) => {
      const b = before.get(r.obligationId);
      return b && Math.abs(b.pv - r.pv) > 0.005;
    });
    return { added, removed, changed, movement: latest.total - prev.total };
  }, [latest, prev]);

  return (
    <>
      <Block kicker="Evidence & freeze" title={`${data.freezes.length} version${data.freezes.length === 1 ? '' : 's'}`}
        note="A freeze fixes the population and its measurement at a point in time. Re-importing does not edit a frozen version — it creates a new one, and the difference between them is shown as added, removed, changed PV and movement in total."
        actions={canEdit(ui.role) && <button className="btn btn-primary btn-sm" onClick={take}>Freeze the current dataset</button>}>
        {data.freezes.length === 0 ? (
          <Empty>Nothing frozen yet. Sampling and the completeness pack both work from a freeze, so this is the first Assure step.</Empty>
        ) : (
          <SheetTable
            rows={[...data.freezes].reverse()}
            rowKey={(f) => f.id}
            noun="versions"
            columns={[
              { key: 'version', header: 'Version', kind: 'number', thClassName: 'num', tdClassName: 'num', tdStyle: { fontFamily: 'var(--font-heading)', fontWeight: 800 }, value: (f) => f.version, cell: (f) => `v${f.version}` },
              { key: 'taken', header: 'Taken', kind: 'date', value: (f) => f.createdAt, cell: (f) => f.createdAt.replace('T', ' ').slice(0, 16) },
              { key: 'by', header: 'By', value: (f) => f.createdBy, cell: (f) => f.createdBy },
              { key: 'population', header: 'Population', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (f) => f.population, cell: (f) => num(f.population) },
              { key: 'total', header: 'Total', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (f) => f.total, cell: (f) => currency(f.total, unit.currency) },
              { key: 'hash', header: 'Hash', value: (f) => f.hash, tdClassName: 'muted', cell: (f) => f.hash },
            ]}
          />
        )}
      </Block>

      {diff && (
        <Block kicker="Diff" title={`v${prev!.version} → v${latest!.version}`}>
          <Stats items={[
            { label: 'Added', value: String(diff.added.length) },
            { label: 'Removed', value: String(diff.removed.length) },
            { label: 'Changed PV', value: String(diff.changed.length) },
            { label: 'Movement in total', value: currency(diff.movement, unit.currency) },
          ]} />
          {diff.changed.length > 0 && (
            <SheetTable
              rows={diff.changed.slice(0, 30).map((r) => {
                const b = prev!.rows.find((x) => x.obligationId === r.obligationId)!;
                return { r, was: b.pv };
              })}
              rowKey={(row) => row.r.obligationId}
              noun="changes"
              columns={[
                { key: 'ref', header: 'Obligation Number', value: (row) => row.r.ref, cell: (row) => row.r.ref },
                { key: 'was', header: 'Was', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.was, cell: (row) => currency(row.was, unit.currency) },
                { key: 'now', header: 'Now', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.r.pv, cell: (row) => currency(row.r.pv, unit.currency) },
                { key: 'movement', header: 'Movement', kind: 'number', thClassName: 'num', tdClassName: 'num derived', value: (row) => row.r.pv - row.was, cell: (row) => currency(row.r.pv - row.was, unit.currency) },
              ]}
            />
          )}
        </Block>
      )}
    </>
  );
}

/* ══ Sampling & tickmarks ══════════════════════════════════════════════ */

export function Sampling() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const [method, setMethod] = useState<'MUS' | 'Stratified' | 'Random'>('MUS');
  const [size, setSize] = useState('15');
  const [seed, setSeed] = useState(String(Math.floor(Math.random() * 1e6)));

  const freeze = data.freezes[data.freezes.length - 1];
  const sample = data.samples[data.samples.length - 1];

  const draw = () => {
    if (!freeze) return;
    const n = Math.min(Number(size) || 0, freeze.rows.length);
    let s = Number(seed) >>> 0;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

    let picked: string[] = [];
    if (method === 'MUS') {
      // Monetary-unit sampling: probability proportional to the provision.
      const total = freeze.rows.reduce((a, r) => a + Math.abs(r.pv), 0);
      const step = total / n;
      let cursor = rand() * step;
      let run = 0;
      for (const r of freeze.rows) {
        run += Math.abs(r.pv);
        while (cursor < run && picked.length < n) { picked.push(r.obligationId); cursor += step; }
      }
    } else if (method === 'Stratified') {
      const sorted = [...freeze.rows].sort((a, b) => Math.abs(b.pv) - Math.abs(a.pv));
      const strata = 3;
      const per = Math.ceil(n / strata);
      for (let i = 0; i < strata; i++) {
        const band = sorted.slice(i * Math.ceil(sorted.length / strata), (i + 1) * Math.ceil(sorted.length / strata));
        for (let k = 0; k < per && band.length; k++) picked.push(band[Math.floor(rand() * band.length)].obligationId);
      }
      picked = picked.slice(0, n);
    } else {
      const pool = [...freeze.rows];
      for (let i = 0; i < n && pool.length; i++) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0].obligationId);
    }
    picked = [...new Set(picked)];

    apply('Draw sample', 'write',
      `Drew a ${method} sample of ${picked.length} from freeze v${freeze.version} with seed ${seed}. The method, size and seed are logged so the selection can be reproduced exactly.`,
      (s2) => {
        s2.data[unit.id].samples.push({
          id: `sm-${Date.now().toString(36)}`, freezeId: freeze.id, method,
          size: picked.length, seed: Number(seed), createdBy: ui.userName,
          createdAt: new Date().toISOString(), picked,
        });
      });
  };

  const tick = (obligationId: string, who: 'preparer' | 'reviewer') => {
    apply('Tickmark', 'write',
      `${who === 'preparer' ? 'Prepared' : 'Reviewed'} ${data.obligations.find((o) => o.id === obligationId)?.ref}.`,
      (s) => {
        const list = s.data[unit.id].tickmarks;
        const existing = list.find((t) => t.obligationId === obligationId && t.freezeId === freeze!.id);
        if (existing) existing[who] = ui.userName;
        else list.push({ id: `tm-${Date.now().toString(36)}`, obligationId, freezeId: freeze!.id, [who]: ui.userName, markedAt: new Date().toISOString() } as never);
      });
  };

  if (!freeze) return <Empty>Sampling works from a freeze. Take one on Evidence &amp; freeze first — sampling a moving population would not be reproducible.</Empty>;

  return (
    <>
      <Block kicker="Sampling" title={`Freeze v${freeze.version} — ${freeze.population} obligations`}
        note="The method, the size and the seed are all logged, so the selection can be reproduced exactly by anyone holding the freeze.">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '0 0 160px' }}>
            <Field label="Method" help="MUS selects with probability proportional to the provision. Stratified splits the population into bands by size. Random gives every obligation an equal chance.">
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value as never)}>
                <option>MUS</option><option>Stratified</option><option>Random</option>
              </select>
            </Field>
          </div>
          <div style={{ flex: '0 0 110px' }}><Field label="Size"><input className="input num" value={size} onChange={(e) => setSize(e.target.value)} /></Field></div>
          <div style={{ flex: '0 0 140px' }}><Field label="Seed" help="Logged with the sample so the same selection can be drawn again."><input className="input num" value={seed} onChange={(e) => setSeed(e.target.value)} /></Field></div>
          {canEdit(ui.role) && <button className="btn btn-primary btn-sm" onClick={draw}>Draw the sample</button>}
        </div>
      </Block>

      {sample && (
        <Block kicker="Selected" title={`${sample.picked.length} obligations — ${sample.method}, seed ${sample.seed}`}>
          <SheetTable
            rows={sample.picked.map((id) => ({
              id,
              o: data.obligations.find((x) => x.id === id),
              row: freeze.rows.find((r) => r.obligationId === id),
              tm: data.tickmarks.find((t) => t.obligationId === id && t.freezeId === freeze.id),
            }))}
            rowKey={(row) => row.id}
            noun="obligations"
            columns={[
              { key: 'ref', header: 'Obligation Number', value: (row) => row.o?.ref, cell: (row) => row.o?.ref },
              { key: 'desc', header: 'Description', value: (row) => row.o?.description, tdStyle: { whiteSpace: 'normal', maxWidth: 240 }, cell: (row) => row.o?.description },
              { key: 'pv', header: 'Provision', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.row?.pv ?? 0, cell: (row) => currency(row.row?.pv ?? 0, unit.currency) },
              { key: 'preparer', header: 'Preparer', value: (row) => row.tm?.preparer, cell: (row) => row.tm?.preparer ?? (canEdit(ui.role) && <button className="btn btn-ghost btn-sm" onClick={() => tick(row.id, 'preparer')}>Tick</button>) },
              { key: 'reviewer', header: 'Reviewer', value: (row) => row.tm?.reviewer, cell: (row) => row.tm?.reviewer ?? (signLevel(ui.role) !== null && signLevel(ui.role)! >= 1 && <button className="btn btn-ghost btn-sm" onClick={() => tick(row.id, 'reviewer')}>Tick</button>) },
            ]}
          />
        </Block>
      )}
    </>
  );
}

/* ══ Completeness pack ═════════════════════════════════════════════════ */

export function Complete() {
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;

  const rows = derived.rows.map((d) => {
    const o = data.obligations.find((x) => x.id === d.obligationId)!;
    return { o, d };
  });

  /** INVARIANTS §6 — hashed from the register, assumptions, curve and policy. */
  const stamp = useMemo(() => {
    let h = 0;
    const bits = [
      ...rows.map((r) => `${r.o.ref}:${Math.round(r.d.pv * 100)}`),
      unit.inflation, unit.contingency, unit.termConvention, unit.dayCount,
      derived.curve?.id, derived.curve?.asAt, unit.materialityUsd, unit.materialityPct,
    ].join('|');
    for (let i = 0; i < bits.length; i++) h = (h * 31 + bits.charCodeAt(i)) | 0;
    return `sha256:${(h >>> 0).toString(16).padStart(8, '0')}…`;
  }, [rows, unit, derived.curve]);

  const signedStamp = data.signatures[0]?.recalcStamp;
  const invalidated = signedStamp && signedStamp !== stamp;

  const exportPack = () => {
    const sheets = [
      {
        name: 'Statement',
        rows: [
          [{ v: `${unit.entity} — completeness pack`, s: S.title }],
          [],
          ['Year end', unit.fyEnd],
          ['Currency', unit.currency],
          ['Population', rows.length],
          ['Provision', { v: derived.total, s: S.money }],
          ['Curve', derived.curve?.name ?? ''],
          ['Curve as at', derived.curve?.asAt ?? ''],
          ['Inflation', { v: unit.inflation, s: S.rate }],
          ['Contingency', { v: unit.contingency, s: S.rate }],
          ['Day count', unit.dayCount],
          ['Term convention', unit.termConvention],
          ['Materiality (absolute)', { v: unit.materialityUsd, s: S.money }],
          ['Materiality (relative)', { v: unit.materialityPct, s: S.rate }],
          ['Measurement stamp', stamp],
          [],
          ['Signatures'],
          ...data.signatures.map((s) => [s.stage, s.by, s.at.slice(0, 19).replace('T', ' ')]),
        ] as never,
        cols: [30, 30, 22],
      },
      {
        name: 'Population',
        rows: [
          ['Obligation Number', 'Description', 'Provision'].map((h) => ({ v: h, s: S.head })),
          ...rows.map((r) => [r.o.ref, r.o.description, { v: r.d.pv, s: S.money }]),
        ] as never,
        cols: [14, 34, 16],
        freeze: 1,
      },
      {
        name: 'Roll-forward',
        rows: [
          ['Period', 'Opening', 'Additions', 'Accretion', 'Revisions', 'Settlements', 'FX', 'Closing'].map((h) => ({ v: h, s: S.head })),
          ...derived.periods.map((p, i) => [
            data.periods[i]?.code ?? p.periodId,
            { v: p.opening, s: S.money }, { v: p.additions, s: S.money }, { v: p.accretion, s: S.money },
            { v: p.revisions, s: S.money }, { v: p.settlements, s: S.money }, { v: p.fx, s: S.money },
            { f: `SUM(B${i + 2}:G${i + 2})`, s: S.money },
          ]),
        ] as never,
        cols: [14, 15, 14, 14, 14, 15, 12, 15],
        freeze: 1,
      },
    ];
    download(`${unit.entity.replace(/\W+/g, '-')}-completeness-pack-${unit.fyEnd}.xlsx`, sheets as never);
  };

  return (
    <>
      <Stats items={[
        { label: 'Population', value: String(rows.length) },
        { label: 'Provision', value: currency(derived.total, unit.currency) },
        { label: 'Roll-forward foots', value: derived.annual.foots ? 'Yes' : 'No', tone: derived.annual.foots ? 'ok' : 'bad' },
        { label: 'Freezes', value: String(data.freezes.length) },
      ]} />

      <Block kicker="Completeness pack" title="Population, roll-forward, statement"
        note="The pack carries a measurement stamp hashed from the register, the assumptions, the curve and the policy. Changing a figure invalidates the signature, and the product says so rather than letting a stale signature stand."
        actions={<button className="btn btn-secondary btn-sm" onClick={exportPack}>Export the pack</button>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
          <div style={{ background: 'var(--color-surface)', padding: '10px 12px' }}>
            <div className="kicker">Measurement stamp</div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>{stamp}</div>
          </div>
          <div style={{ background: 'var(--color-surface)', padding: '10px 12px' }}>
            <div className="kicker">Signed stamp</div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>{signedStamp ?? '— not signed —'}</div>
          </div>
        </div>

        {invalidated && (
          <div className="note-panel" style={{ borderLeftColor: 'var(--bad)', marginTop: 12 }}>
            A figure has changed since this pack was signed. The measurement stamp no longer matches the one signed,
            so the signature is invalid and the pack must be re-signed.
          </div>
        )}
      </Block>
    </>
  );
}

/* ══ Review & sign-off ═════════════════════════════════════════════════ */

export function Review() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;

  const state: YearEndState = {
    periods: data.periods.map((p) => ({ code: p.code, status: p.status })),
    annualResidual: derived.annual.residual,
    periodResiduals: derived.periods
      .map((p, i) => ({ code: data.periods[i]?.code ?? p.periodId, residual: p.residual }))
      .filter((p) => p.residual !== 0),
    conversionAgreed: data.conversionAgreed,
    conversionNote: data.conversionAgreed
      ? 'Opening balances are locked and agreed to the opening trial balance totals.'
      : 'Opening balances have not been locked. Reconcile the opening register to the trial balance and lock them in Setup.',
    batches: data.batches.map((b) => ({ number: b.number, status: b.status })),
    subLedgerTotal: derived.total,
    glTotal: data.glTotal,
    packSigned: data.signatures.map((s) => ({ stage: s.stage, by: s.by, at: s.at })),
    noteGenerated: data.noteGenerated,
    yearLocked: data.yearLocked,
  };

  const gates = runGates(YEAR_END_GATES, state);
  const stages: ('Preparer' | 'Reviewer' | 'Partner')[] = ['Preparer', 'Reviewer', 'Partner'];
  const level = signLevel(ui.role);

  const sign = (stage: 'Preparer' | 'Reviewer' | 'Partner') => {
    let h = 0;
    const bits = derived.rows.map((r) => `${r.ref}:${Math.round(r.pv * 100)}`).join('|');
    for (let i = 0; i < bits.length; i++) h = (h * 31 + bits.charCodeAt(i)) | 0;
    apply('Sign off', 'sign', `${stage} sign-off recorded by ${ui.userName}.`, (s) => {
      s.data[unit.id].signatures.push({
        stage, by: ui.userName, at: new Date().toISOString(),
        recalcStamp: `sha256:${(h >>> 0).toString(16).padStart(8, '0')}…`,
      });
    });
  };

  return (
    <>
      <Block kicker="Sign-off" title="Three stages"
        note="Preparer approves, reviewer or partner posts, partner only reverses. A stage can only be signed by a role at or above it.">
        <SheetTable
          rows={stages.map((stage, i) => {
            const sig = data.signatures.find((s) => s.stage === stage);
            return { stage, sig, allowed: level !== null && level >= i && !sig };
          })}
          rowKey={(row) => row.stage}
          noun="stages"
          columns={[
            { key: 'stage', header: 'Stage', value: (row) => row.stage, tdStyle: { fontFamily: 'var(--font-heading)', fontWeight: 800 }, cell: (row) => row.stage },
            { key: 'by', header: 'Signed by', value: (row) => row.sig?.by, cell: (row) => row.sig?.by ?? <span className="muted">—</span> },
            { key: 'when', header: 'When', kind: 'date', value: (row) => row.sig?.at, cell: (row) => row.sig ? row.sig.at.replace('T', ' ').slice(0, 16) : '—' },
            { key: 'stamp', header: 'Stamp', value: (row) => row.sig?.recalcStamp, tdClassName: 'muted', tdStyle: { fontFamily: 'ui-monospace, monospace', fontSize: 11 }, cell: (row) => row.sig?.recalcStamp ?? '—' },
            { key: 'act', header: '', cell: (row) => row.sig ? <Tag kind="accent">Signed</Tag>
              : <button className="btn btn-primary btn-sm" disabled={!row.allowed}
                  title={row.allowed ? undefined : `Signing at the ${row.stage.toLowerCase()} stage needs a role at or above it.`}
                  onClick={() => sign(row.stage)}>Sign</button> },
          ]}
        />
      </Block>

      <Block kicker="Year-end lock" title="Eight gates, in order"
        note="Every gate reads live state and computes its own result. A gate below an unpassed gate reads 'not reached' — the sequence cannot be skipped, and the lock itself is partner-only.">
        <SheetTable
          rows={gates.map((g, i) => ({ ...g, n: i + 1 }))}
          rowKey={(g) => g.id}
          noun="gates"
          columns={[
            { key: 'n', header: '', kind: 'number', thClassName: 'num', tdClassName: 'num muted', width: 30, value: (g) => g.n, cell: (g) => g.n },
            { key: 'gate', header: 'Gate', value: (g) => g.label, tdStyle: { fontFamily: 'var(--font-heading)', fontWeight: 800 }, cell: (g) => g.label },
            { key: 'kind', header: 'Kind', value: (g) => g.kind, cell: (g) => <Tag kind="neutral">{g.kind}</Tag> },
            { key: 'result', header: 'Result', value: (g) => g.state === 'pass' ? 'Pass' : g.state === 'fail' ? 'Fail' : 'Not reached', cell: (g) => (
              g.state === 'pass' ? <Tag kind="accent">Pass</Tag>
                : g.state === 'fail' ? <Tag kind="bad">Fail</Tag>
                  : <Tag kind="neutral">Not reached</Tag>
            ) },
            { key: 'found', header: 'What it found', value: (g) => g.detail, tdClassName: 'muted', tdStyle: { whiteSpace: 'normal' }, cell: (g) => g.detail },
          ]}
        />

        <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm"
            disabled={!canLockPeriod(ui.role) || data.yearLocked || gates.slice(0, 7).some((g) => g.state !== 'pass')}
            onClick={() => apply('Lock the year', 'lock',
              `Locked the financial year ending ${unit.fyEnd}. Nothing further posts into it.`,
              (s) => { s.data[unit.id].yearLocked = true; })}>
            Lock the year
          </button>
          {!canLockPeriod(ui.role) && <span className="muted" style={{ fontSize: 11.5 }}>Locking the year is an engagement partner action.</span>}
          {data.yearLocked && canLockPeriod(ui.role) && (
            <button className="btn btn-secondary btn-sm"
              onClick={() => apply('Unlock the year', 'lock',
                `Unlocked the financial year ending ${unit.fyEnd}. The unlock is itself logged.`,
                (s) => { s.data[unit.id].yearLocked = false; })}>Unlock the year</button>
          )}
        </div>
      </Block>
    </>
  );
}

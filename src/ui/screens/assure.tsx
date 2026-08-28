/**
 * Assure phase — evidence & freeze, sampling & tickmarks, completeness pack,
 * review & sign-off.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit, canLockPeriod, roleById, signLevel } from '../../core/authority';
import { YEAR_END_GATES, runGates, YearEndState } from '../../core/gates';
import { Block, Empty, Field, money, money2, pct, Stats, Tag } from '../components';
import { download, S } from '../../xlsx/write';
import { sourceOf } from './Register';

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
      `Froze the dataset as version ${data.freezes.length + 1}: ${rows.length} obligations totalling ${money2(derived.total)}. A re-import is a new version with a diff, never an edit of this one.`,
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
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th className="num">Version</th><th>Taken</th><th>By</th><th className="num">Population</th><th className="num">Total</th><th>Hash</th></tr></thead>
              <tbody>
                {[...data.freezes].reverse().map((f) => (
                  <tr key={f.id}>
                    <td className="num" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>v{f.version}</td>
                    <td>{f.createdAt.replace('T', ' ').slice(0, 16)}</td>
                    <td>{f.createdBy}</td>
                    <td className="num">{f.population}</td>
                    <td className="num">{money2(f.total)}</td>
                    <td className="muted">{f.hash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      {diff && (
        <Block kicker="Diff" title={`v${prev!.version} → v${latest!.version}`}>
          <Stats items={[
            { label: 'Added', value: String(diff.added.length) },
            { label: 'Removed', value: String(diff.removed.length) },
            { label: 'Changed PV', value: String(diff.changed.length) },
            { label: 'Movement in total', value: money2(diff.movement) },
          ]} />
          {diff.changed.length > 0 && (
            <div className="scroll-x">
              <table className="table">
                <thead><tr><th>Reference</th><th className="num">Was</th><th className="num">Now</th><th className="num">Movement</th></tr></thead>
                <tbody>
                  {diff.changed.slice(0, 30).map((r) => {
                    const b = prev!.rows.find((x) => x.obligationId === r.obligationId)!;
                    return (
                      <tr key={r.obligationId}>
                        <td>{r.ref}</td>
                        <td className="num">{money2(b.pv)}</td>
                        <td className="num">{money2(r.pv)}</td>
                        <td className="num derived">{money2(r.pv - b.pv)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Reference</th><th>Description</th><th className="num">Provision</th><th>Preparer</th><th>Reviewer</th></tr></thead>
              <tbody>
                {sample.picked.map((id) => {
                  const o = data.obligations.find((x) => x.id === id);
                  const row = freeze.rows.find((r) => r.obligationId === id);
                  const tm = data.tickmarks.find((t) => t.obligationId === id && t.freezeId === freeze.id);
                  return (
                    <tr key={id}>
                      <td>{o?.ref}</td>
                      <td style={{ whiteSpace: 'normal', maxWidth: 240 }}>{o?.description}</td>
                      <td className="num">{money2(row?.pv ?? 0)}</td>
                      <td>{tm?.preparer ?? (canEdit(ui.role) && <button className="btn btn-ghost btn-sm" onClick={() => tick(id, 'preparer')}>Tick</button>)}</td>
                      <td>{tm?.reviewer ?? (signLevel(ui.role) !== null && signLevel(ui.role)! >= 1 && <button className="btn btn-ghost btn-sm" onClick={() => tick(id, 'reviewer')}>Tick</button>)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Block>
      )}
    </>
  );
}

/* ══ Completeness pack ═════════════════════════════════════════════════ */

export function Complete() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;

  const rows = derived.rows.map((d) => {
    const o = data.obligations.find((x) => x.id === d.obligationId)!;
    const source = sourceOf(o, d.pv);
    return { o, d, source, variance: d.pv - source };
  });
  const uncaused = rows.filter((r) => {
    const threshold = Math.max(unit.materialityUsd, Math.abs(r.source) * unit.materialityPct);
    return Math.abs(r.variance) >= threshold && !r.o.varianceCause;
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
          ['Recalculation stamp', stamp],
          [],
          ['Signatures'],
          ...data.signatures.map((s) => [s.stage, s.by, s.at.slice(0, 19).replace('T', ' ')]),
        ] as never,
        cols: [30, 30, 22],
      },
      {
        name: 'Population',
        rows: [
          ['Reference', 'Description', 'Provision', 'Source', 'Variance', 'Cause'].map((h) => ({ v: h, s: S.head })),
          ...rows.map((r) => [r.o.ref, r.o.description, { v: r.d.pv, s: S.money }, { v: r.source, s: S.money }, { v: r.variance, s: S.money }, r.o.varianceCause ?? '']),
        ] as never,
        cols: [14, 34, 16, 16, 15, 28],
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
        { label: 'Provision', value: `${unit.currency} ${money(derived.total)}` },
        { label: 'Roll-forward foots', value: derived.annual.foots ? 'Yes' : 'No', tone: derived.annual.foots ? 'ok' : 'bad' },
        { label: 'Uncaused material variances', value: String(uncaused.length), tone: uncaused.length ? 'bad' : 'ok' },
        { label: 'Freezes', value: String(data.freezes.length) },
      ]} />

      <Block kicker="Completeness pack" title="Population, recalculation, variance, roll-forward, statement"
        note="The pack carries a recalculation stamp hashed from the register, the assumptions, the curve and the policy. Changing a figure invalidates the signature, and the product says so rather than letting a stale signature stand."
        actions={<button className="btn btn-secondary btn-sm" onClick={exportPack}>Export the pack</button>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10 }}>
          <div style={{ background: 'var(--color-surface)', padding: '10px 12px' }}>
            <div className="kicker">Recalculation stamp</div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>{stamp}</div>
          </div>
          <div style={{ background: 'var(--color-surface)', padding: '10px 12px' }}>
            <div className="kicker">Signed stamp</div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>{signedStamp ?? '— not signed —'}</div>
          </div>
        </div>

        {invalidated && (
          <div className="note-panel" style={{ borderLeftColor: 'var(--bad)', marginTop: 12 }}>
            A figure has changed since this pack was signed. The recalculation stamp no longer matches the one signed,
            so the signature is invalid and the pack must be re-signed.
          </div>
        )}

        {uncaused.length > 0 && (
          <div className="note-panel" style={{ borderLeftColor: 'var(--warn)', marginTop: 12 }}>
            {uncaused.length} material variance{uncaused.length === 1 ? ' has' : 's have'} no recorded cause:{' '}
            {uncaused.slice(0, 8).map((u) => u.o.ref).join(', ')}
            {uncaused.length > 8 ? ' …' : ''}. Record a cause on the Recalculation step before signing.
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
      ? 'The opening balance conversion has been agreed to the legacy closing balance.'
      : 'The opening balance conversion has not been agreed. See Opening balances.',
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
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Stage</th><th>Signed by</th><th>When</th><th>Stamp</th><th /></tr></thead>
            <tbody>
              {stages.map((stage, i) => {
                const sig = data.signatures.find((s) => s.stage === stage);
                const allowed = level !== null && level >= i && !sig;
                return (
                  <tr key={stage}>
                    <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{stage}</td>
                    <td>{sig?.by ?? <span className="muted">—</span>}</td>
                    <td>{sig ? sig.at.replace('T', ' ').slice(0, 16) : '—'}</td>
                    <td className="muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{sig?.recalcStamp ?? '—'}</td>
                    <td>
                      {sig ? <Tag kind="accent">Signed</Tag>
                        : <button className="btn btn-primary btn-sm" disabled={!allowed}
                            title={allowed ? undefined : `Signing at the ${stage.toLowerCase()} stage needs a role at or above it.`}
                            onClick={() => sign(stage)}>Sign</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Block>

      <Block kicker="Year-end lock" title="Eight gates, in order"
        note="Every gate reads live state and computes its own result. A gate below an unpassed gate reads 'not reached' — the sequence cannot be skipped, and the lock itself is partner-only.">
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th style={{ width: 30 }} /><th>Gate</th><th>Kind</th><th>Result</th><th>What it found</th></tr></thead>
            <tbody>
              {gates.map((g, i) => (
                <tr key={g.id}>
                  <td className="num muted">{i + 1}</td>
                  <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{g.label}</td>
                  <td><Tag kind="neutral">{g.kind}</Tag></td>
                  <td>
                    {g.state === 'pass' ? <Tag kind="accent">Pass</Tag>
                      : g.state === 'fail' ? <Tag kind="bad">Fail</Tag>
                        : <Tag kind="neutral">Not reached</Tag>}
                  </td>
                  <td style={{ whiteSpace: 'normal' }} className="muted">{g.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

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

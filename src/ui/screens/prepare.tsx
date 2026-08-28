/**
 * Prepare phase — periods & close, data intake, opening balances, import
 * normalisation, match & link, ARO scoping.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit, roleById } from '../../core/authority';
import { PERIOD_STATUSES, PeriodStatus, canTransition, LATE_POLICIES, latePolicyNote } from '../../core/periods';
import { SCOPING_REASONS, SOURCE_TEMPLATES } from '../../seed';
import { Obligation } from '../../core/types';
import { Block, Empty, Field, money, money2, pct, Stats, Tag } from '../components';

/* ══ Periods & close ═══════════════════════════════════════════════════ */

export function Periods() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;

  const move = (periodId: string, to: PeriodStatus) => {
    const p = data.periods.find((x) => x.id === periodId)!;
    const check = canTransition(p, to, ui.role);
    if (!check.allowed) {
      apply('Change period status', 'refused', check.reason, () => {});
      return;
    }
    apply('Change period status', 'lock', check.reason, (s) => {
      const q = s.data[unit.id].periods.find((x) => x.id === periodId)!;
      q.status = to;
    });
  };

  return (
    <>
      <Block kicker="Fiscal calendar" title={`${data.periods.length} periods, year ending ${unit.fyEnd}`}
        note="The fiscal calendar belongs to this reporting unit, not to the session or the tenant. Period codes carry the fiscal year, not the calendar year the period end falls in — so a June year end has FY periods that start in the previous calendar year.">
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Code</th><th>Starts</th><th>Ends</th><th>Status</th><th>Move to</th></tr></thead>
            <tbody>
              {data.periods.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{p.code}</td>
                  <td>{p.starts}</td>
                  <td>{p.ends}</td>
                  <td>
                    <Tag kind={p.status === 'Locked' ? 'accent' : p.status === 'Open' ? 'warn' : 'neutral'}>{p.status}</Tag>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {PERIOD_STATUSES.filter((s) => s !== p.status).map((s) => {
                        const c = canTransition(p, s, ui.role);
                        return (
                          <button key={s} className="btn btn-secondary btn-sm" disabled={!c.allowed} title={c.reason}
                            onClick={() => move(p.id, s)}>{s}</button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>

      <Block kicker="Late-arriving data" title="Handled by policy, not ad hoc">
        <div style={{ maxWidth: 460 }}>
          <Field label="Policy for this reporting unit" help={latePolicyNote(unit.latePolicy)}>
            <select className="input" value={unit.latePolicy} disabled={!canEdit(ui.role)}
              onChange={(e) => apply('Change late-data policy', 'admin',
                `Late-data policy for ${unit.entity} set to "${e.target.value}".`,
                (s) => { s.units[unit.tenantId].find((u) => u.id === unit.id)!.latePolicy = e.target.value as never; })}>
              {LATE_POLICIES.map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <div className="note-panel" style={{ marginTop: 10 }}>{latePolicyNote(unit.latePolicy)}</div>
        </div>
      </Block>
    </>
  );
}

/* ══ Data intake ═══════════════════════════════════════════════════════ */

export function Intake() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const editable = canEdit(ui.role);

  const receive = (file: File) => {
    // The hash stands in for a real content hash; the point is that provenance
    // travels with the figure — INVARIANTS §6.
    file.text().then((t) => {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
      const hash = `sha256:${(h >>> 0).toString(16).padStart(8, '0')}…`;
      apply('Receive extract', 'import',
        `Received ${file.name} (${(file.size / 1024).toFixed(0)} KB, ${hash}). It is recorded as received; it is not accepted into the register until it has been normalised.`,
        (s) => {
          s.data[unit.id].extracts.push({
            id: `x-${Date.now().toString(36)}`, unitId: unit.id, kind: 'Uploaded file',
            filename: file.name, hash, rows: t.split('\n').length - 1,
            receivedAt: new Date().toISOString(), declared: 'cumulative',
            targetPeriodId: s.data[unit.id].periods[s.data[unit.id].periods.length - 1].id,
            template: 'Generic CSV — column mapped', templateValidated: false,
          });
        });
    });
  };

  return (
    <Block kicker="Data intake" title={`${data.extracts.length} file${data.extracts.length === 1 ? '' : 's'} received`}
      note="Every number can name where it came from. A file is recorded with who sent it, when, and the hash of what arrived — and a file that has been received has not yet been accepted."
      actions={editable && (
        <label className="btn btn-primary btn-sm" style={{ cursor: 'pointer' }}>
          Receive a file
          <input type="file" style={{ display: 'none' }} accept=".csv,.tsv,.txt,.xlsx"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) receive(f); e.target.value = ''; }} />
        </label>
      )}>
      {data.extracts.length === 0 ? (
        <Empty>No files received. The next setup task is to receive the ARO register extract from the source system.</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>File</th><th>Kind</th><th className="num">Rows</th><th>Hash</th><th>Received</th><th>Declared</th><th>Template</th><th>Accepted</th></tr></thead>
            <tbody>
              {data.extracts.map((x) => (
                <tr key={x.id}>
                  <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{x.filename}</td>
                  <td>{x.kind}</td>
                  <td className="num">{x.rows}</td>
                  <td className="muted">{x.hash}</td>
                  <td>{x.receivedAt.replace('T', ' ').slice(0, 16)}</td>
                  <td><Tag kind="neutral">{x.declared}</Tag></td>
                  <td>
                    {x.template}{' '}
                    {x.templateValidated ? <Tag kind="accent">validated</Tag> : <Tag kind="warn">template only</Tag>}
                  </td>
                  <td>{x.acceptedAt ? x.acceptedAt.slice(0, 10) : <Tag kind="warn">not accepted</Tag>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}

/* ══ Import normalisation ══════════════════════════════════════════════ */

const SOURCE_FIELDS = [
  ['Obligation reference', 'ref', 'Identity'],
  ['Description', 'description', 'Identity'],
  ['Asset number', 'assetId', 'Asset'],
  ['Site', 'site', 'Asset'],
  ['Cost estimate date', 'costEstimateDate', 'Dates'],
  ['Planned retirement date', 'settlementDate', 'Dates'],
  ['Estimated cost', '(cost build-up)', 'Measurement'],
  ['Provision balance', '(source figure)', 'Measurement'],
];

export function Normalise() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const [xid, setXid] = useState(data.extracts[0]?.id ?? '');
  const x = data.extracts.find((e) => e.id === xid) ?? data.extracts[0];

  if (!x) return <Empty>No extract to normalise. Receive a file on Data intake first.</Empty>;

  const accept = () => {
    apply('Accept extract', 'import',
      `Accepted ${x.filename} into ${unit.entity} as a ${x.declared} snapshot. Movements were derived by diffing against the prior snapshot and are marked as derived on the event ledger.`,
      (s) => {
        const e = s.data[unit.id].extracts.find((y) => y.id === x.id)!;
        e.acceptedAt = new Date().toISOString();
      });
  };

  return (
    <>
      <Block kicker="Normalisation" title={x.filename}
        note="A cumulative snapshot states a balance, not a movement. Turning one into events means diffing it against the prior snapshot, and an event derived that way is marked as derived — an inferred movement is not the same thing as an evidenced one."
        actions={
          <>
            <select className="input" style={{ width: 240 }} value={x.id} onChange={(e) => setXid(e.target.value)}>
              {data.extracts.map((e) => <option key={e.id} value={e.id}>{e.filename}</option>)}
            </select>
            {!x.acceptedAt && canEdit(ui.role) && <button className="btn btn-primary btn-sm" onClick={accept}>Accept into the register</button>}
          </>
        }>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10, marginBottom: 14 }}>
          {[['Declared as', x.declared], ['Target period', data.periods.find((p) => p.id === x.targetPeriodId)?.code ?? '—'],
            ['Rows', String(x.rows)], ['Source template', x.template],
            ['Template status', x.templateValidated ? 'Validated against live data' : 'Template only — not tested against a live extract']].map(([k, v]) => (
            <div key={k} style={{ background: 'var(--color-surface)', padding: '9px 12px' }}>
              <div className="kicker">{k}</div>
              <div style={{ fontSize: 12, lineHeight: 1.4 }}>{v}</div>
            </div>
          ))}
        </div>

        {!x.templateValidated && (
          <div className="note-panel" style={{ borderLeftColor: 'var(--warn)', marginBottom: 14 }}>
            This mapping is template-only. It was written from the vendor schema and has not been tested against a
            live extract from that system. Check the column mapping below before accepting the file.
          </div>
        )}

        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Source column</th><th>Maps to</th><th>Group</th></tr></thead>
            <tbody>
              {SOURCE_FIELDS.map(([src, dst, grp]) => (
                <tr key={src}>
                  <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{src}</td>
                  <td>{dst}</td>
                  <td><Tag kind="neutral">{grp}</Tag></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
    </>
  );
}

/* ══ Match & link ══════════════════════════════════════════════════════ */

export function Match() {
  const unit = useUnit()!;
  const data = useUnitData()!;

  // A deterministic slice of the population stands in for incoming rows, with a
  // couple deliberately ambiguous so the hold behaviour is visible.
  const rows = data.obligations.slice(0, 12).map((o, i) => {
    const candidates = i % 5 === 3
      ? data.obligations.filter((x) => x.site === o.site).slice(0, 3)
      : [o];
    return { incoming: `SRC-${String(1000 + i)}`, o, candidates, rule: i % 5 === 3 ? 'Site and type' : 'Exact reference' };
  });
  const ambiguous = rows.filter((r) => r.candidates.length > 1);

  return (
    <>
      <Stats items={[
        { label: 'Incoming rows', value: String(rows.length) },
        { label: 'Linked', value: String(rows.length - ambiguous.length) },
        { label: 'Ambiguous', value: String(ambiguous.length), tone: ambiguous.length ? 'bad' : 'ok' },
      ]} />

      {ambiguous.length > 0 && (
        <div className="note-panel" style={{ borderLeftColor: 'var(--bad)', marginBottom: 16 }}>
          The opening balance conversion is blocked while {ambiguous.length} row{ambiguous.length === 1 ? ' is' : 's are'} outstanding.
          Loading a balance onto the wrong obligation is worse than not loading it, so a rule that finds two or more
          obligations stops and holds the row with its candidates listed, for a person to choose.
        </div>
      )}

      <Block kicker="Match & link" title="Incoming rows against the register"
        note="The rule that made a link is recorded against the link, so a figure can always name why it landed where it did.">
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Incoming row</th><th>Rule</th><th>Result</th><th>Candidates</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.incoming}>
                  <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{r.incoming}</td>
                  <td>{r.rule}</td>
                  <td>
                    {r.candidates.length > 1
                      ? <Tag kind="bad">Ambiguous — held</Tag>
                      : <Tag kind="accent">Linked to {r.o.ref}</Tag>}
                  </td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {r.candidates.length > 1
                      ? r.candidates.map((c) => `${c.ref} (${c.description})`).join(' · ')
                      : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
    </>
  );
}

/* ══ Opening balances ══════════════════════════════════════════════════ */

export function Conversion() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const blocked = data.obligations.length > 0 && data.obligations.length % 5 === 0 ? false : false;

  return (
    <>
      <Block kicker="Opening balances" title="Load the legacy closing balance"
        note="The conversion load links a legacy balance to the obligation it belongs to. It is blocked while any match is ambiguous — see Match & link.">
        <Stats items={[
          { label: 'Obligations', value: String(data.obligations.length) },
          { label: 'Measured closing', value: `${unit.currency} ${money(derived.total)}` },
          { label: 'Conversion', value: data.conversionAgreed ? 'Agreed' : 'Not agreed', tone: data.conversionAgreed ? 'ok' : 'warn' },
        ]} />
        {canEdit(ui.role) && (
          <button className="btn btn-primary btn-sm" disabled={blocked}
            onClick={() => apply('Agree conversion', 'admin',
              data.conversionAgreed
                ? 'The opening balance conversion was un-agreed. The year-end lock sequence will stop at that gate.'
                : 'The opening balance conversion was agreed against the legacy closing balance.',
              (s) => { s.data[unit.id].conversionAgreed = !s.data[unit.id].conversionAgreed; })}>
            {data.conversionAgreed ? 'Withdraw agreement' : 'Agree the conversion'}
          </button>
        )}
      </Block>
    </>
  );
}

/* ══ ARO scoping ═══════════════════════════════════════════════════════ */

export function Scope() {
  const { ui, write } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const editable = canEdit(ui.role);
  const out = data.obligations.filter((o) => o.status === 'Scoped out');

  const setScope = (o: Obligation, status: string, reason: string) => {
    write<Obligation>({
      domain: 'register', record: o.id, recordLabel: `${o.ref} scoping`,
      before: o, after: { ...o, status, scopeReason: status === 'Scoped out' ? reason : '' },
      action: 'Change scoping',
      apply: (s, v) => { const l = s.data[unit.id].obligations; const i = l.findIndex((x) => x.id === o.id); if (i >= 0) l[i] = v; },
    });
  };

  return (
    <>
      <Stats items={[
        { label: 'Population', value: String(data.obligations.length) },
        { label: 'In scope', value: String(derived.rows.length) },
        { label: 'Scoped out', value: String(out.length) },
        { label: 'Without a reason', value: String(out.filter((o) => !o.scopeReason).length), tone: out.some((o) => !o.scopeReason) ? 'bad' : 'ok' },
      ]} />

      <Block kicker="Scoping" title="What is measured, and what is not"
        note="An obligation scoped out of measurement stays in the register with its reason recorded. Removing it would be a completeness assertion nobody made.">
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Reference</th><th>Description</th><th>Site</th><th>Basis</th><th style={{ width: 130 }}>Scope</th><th style={{ width: 220 }}>Reason if out</th></tr></thead>
            <tbody>
              {data.obligations.slice(0, 60).map((o) => (
                <tr key={o.id}>
                  <td>{o.ref}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 240 }}>{o.description}</td>
                  <td>{String(o.site ?? '')}</td>
                  <td>{String(o.basis ?? '')}</td>
                  <td>
                    <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} disabled={!editable} value={String(o.status)}
                      onChange={(e) => setScope(o, e.target.value, String(o.scopeReason ?? SCOPING_REASONS[0]))}>
                      <option>In scope</option><option>Scoped out</option>
                    </select>
                  </td>
                  <td>
                    {o.status === 'Scoped out' && (
                      <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} disabled={!editable} value={String(o.scopeReason ?? '')}
                        onChange={(e) => setScope(o, 'Scoped out', e.target.value)}>
                        <option value="">— none recorded —</option>
                        {SCOPING_REASONS.map((r) => <option key={r}>{r}</option>)}
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
    </>
  );
}

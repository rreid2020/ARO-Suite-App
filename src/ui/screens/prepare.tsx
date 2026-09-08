/**
 * Prepare phase — periods, auditor intake and normalisation.
 * ARO scoping lives in scoping.tsx. Opening register lives in Setup.
 */

import React, { useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { canConfigureTenant, canEdit } from '../../core/authority';
import { unitSetupComplete } from '../../core/createUnit';
import { PERIOD_STATUSES, PeriodStatus, canTransition, LATE_POLICIES, latePolicyNote } from '../../core/periods';
import { Block, Empty, Field, num, SheetTable, Tag } from '../components';

/* ══ Periods & close ═══════════════════════════════════════════════════ */

export function Periods() {
  const { state, ui, setUi, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const allowed = canConfigureTenant(ui.role);
  const confirmed = unitSetupComplete(state, unit);

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
        note="The fiscal calendar belongs to this reporting unit, not to the session or the tenant. Opening a period is not a posting trigger. Month-end accretion and amortization run from Close → Month-end posting, after in-period new ARO, cost and term postings. Period codes carry the fiscal year, not the calendar year the period end falls in. Framework, inflation, contingency and the discount table are on Unit settings."
        actions={<button className="btn btn-secondary btn-sm" type="button" onClick={() => setUi({ screen: 'month-end', tab: '', sub: '' })}>Month-end posting</button>}>
        <SheetTable
          rows={data.periods}
          rowKey={(p) => p.id}
          noun="periods"
          columns={[
            { key: 'code', header: 'Code', value: (p) => p.code, cell: (p) => <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{p.code}</span> },
            { key: 'starts', header: 'Starts', kind: 'date', value: (p) => p.starts, cell: (p) => p.starts },
            { key: 'ends', header: 'Ends', kind: 'date', value: (p) => p.ends, cell: (p) => p.ends },
            { key: 'status', header: 'Status', value: (p) => p.status, cell: (p) => (
              <Tag kind={p.status === 'Locked' ? 'accent' : p.status === 'Open' ? 'warn' : 'neutral'}>{p.status}</Tag>
            ) },
            { key: 'move', header: 'Move to', cell: (p) => (
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {PERIOD_STATUSES.filter((s) => s !== p.status).map((s) => {
                  const c = canTransition(p, s, ui.role);
                  return (
                    <button key={s} className="btn btn-secondary btn-sm" disabled={!c.allowed} title={c.reason}
                      onClick={() => move(p.id, s)}>{s}</button>
                  );
                })}
              </div>
            ) },
          ]}
        />
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

      {confirmed ? (
        <div className="note-panel" style={{ marginTop: 16 }}>Unit setup confirmed. You can still change the calendar and late-data policy here; they stay on this reporting unit.</div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" type="button" disabled={!allowed}
            onClick={() => setUi({ screen: 'unit-opening', tab: '', sub: '' })}>
            Continue to opening register
          </button>
        </div>
      )}
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
        <SheetTable
          rows={data.extracts}
          rowKey={(x) => x.id}
          noun="files"
          columns={[
            { key: 'filename', header: 'File', value: (x) => x.filename, cell: (x) => <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{x.filename}</span> },
            { key: 'kind', header: 'Kind', value: (x) => x.kind, cell: (x) => x.kind },
            { key: 'rows', header: 'Rows', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (x) => x.rows, cell: (x) => num(x.rows) },
            { key: 'hash', header: 'Hash', value: (x) => x.hash, tdClassName: 'muted', cell: (x) => x.hash },
            { key: 'received', header: 'Received', kind: 'date', value: (x) => x.receivedAt, cell: (x) => x.receivedAt.replace('T', ' ').slice(0, 16) },
            { key: 'declared', header: 'Declared', value: (x) => x.declared, cell: (x) => <Tag kind="neutral">{x.declared}</Tag> },
            { key: 'template', header: 'Template', value: (x) => `${x.template} ${x.templateValidated ? 'validated' : 'template only'}`, cell: (x) => (
              <>{x.template}{' '}{x.templateValidated ? <Tag kind="accent">validated</Tag> : <Tag kind="warn">template only</Tag>}</>
            ) },
            { key: 'accepted', header: 'Accepted', value: (x) => x.acceptedAt ?? 'not accepted', cell: (x) => x.acceptedAt ? x.acceptedAt.slice(0, 10) : <Tag kind="warn">not accepted</Tag> },
          ]}
        />
      )}
    </Block>
  );
}

/* ══ Import normalisation ══════════════════════════════════════════════ */

const SOURCE_FIELDS = [
  ['Obligation reference', 'ref', 'Identity'],
  ['Description', 'description', 'Identity'],
  ['TCA asset number', 'assetId', 'Asset'],
  ['ARO asset number', 'aroAssetNumber', 'Asset'],
  ['Site', 'site', 'Asset'],
  ['Cost estimate date', 'costEstimateDate', 'Dates'],
  ['Planned retirement date', 'settlementDate', 'Dates'],
  ['Estimated cost', '(cost build-up)', 'Measurement'],
  ['Provision balance', 'provision', 'Measurement'],
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

        <SheetTable
          rows={SOURCE_FIELDS.map(([src, dst, grp]) => ({ src, dst, grp }))}
          rowKey={(r) => r.src}
          noun="columns"
          columns={[
            { key: 'src', header: 'Source column', value: (r) => r.src, cell: (r) => <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{r.src}</span> },
            { key: 'dst', header: 'Maps to', value: (r) => r.dst, cell: (r) => r.dst },
            { key: 'grp', header: 'Group', value: (r) => r.grp, cell: (r) => <Tag kind="neutral">{r.grp}</Tag> },
          ]}
        />
      </Block>
    </>
  );
}

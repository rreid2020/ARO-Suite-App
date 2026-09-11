/**
 * Close phase — close calendar, month-end posting, year-end revaluation,
 * journals, journal batches, GL reconciliation. Settlements post on Transactions.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit, canPost, canReverse, roleById } from '../../core/authority';
import { derive } from '../../engine/derive';
import { frameworkPolicy } from '../../engine/framework';
import { curveOptionLabel } from '../../engine/curve';
import { suggestedClosingCurve } from '../../core/createUnit';
import { Block, Empty, Field, currency, num, parseNumber, SheetTable, Stats, Tag } from '../components';
import { JournalBatchActions, JournalStatusTag } from '../JournalBatchCard';
import { accountForRole, suspenseAccount } from '../../core/posting';
import { Obligation } from '../../core/types';
import {
  allocateMonthEnd, createOrFillPeriodBatch, monthEndRefusal, openPeriod, periodBatchRefusal, planMonthEnd,
  summariseByAccount,
  type MonthEndRun,
} from '../../core/periodClose';
import { unitCurve } from '../../core/measure';

/* ══ Close calendar ════════════════════════════════════════════════════ */

const TASKS: [string, string, number, string][] = [
  ['CL-01', 'Receive the ARO register extract', -2, 'Preparer'],
  ['CL-02', 'Receive the GL trial balance', -1, 'Preparer'],
  ['CL-03', 'Normalise and accept the extract', 1, 'Preparer'],
  ['CL-04', 'Review the engine measurement for the period', 2, 'Preparer'],
  ['CL-05', 'Allocate accretion for the period', 3, 'Preparer'],
  ['CL-06', 'Allocate amortization for the period', 3, 'Preparer'],
  ['CL-07', 'Approve the journal batch', 4, 'Preparer'],
  ['CL-08', 'Post the journal batch', 4, 'Reviewer'],
  ['CL-09', 'Reconcile the sub-ledger to the GL', 5, 'Preparer'],
  ['CL-10', 'Review the roll-forward', 6, 'Reviewer'],
  ['CL-11', 'Close the period', 6, 'Reviewer'],
];

function useMonthEndRuns() {
  const { state, ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const open = openPeriod(data);
  const curve = unitCurve(state, unit);
  const accretion = open ? planMonthEnd(unit, data, curve, open, 'accretion') : null;
  const amortization = open ? planMonthEnd(unit, data, curve, open, 'amortization') : null;
  const accretionAllocated = open ? data.events.some((e) => e.periodId === open.id && e.type === 'accretion') : false;
  const amortizationAllocated = open ? data.events.some((e) => e.periodId === open.id && e.type === 'depreciation') : false;

  const allocate = (run: MonthEndRun) => {
    const blocked = monthEndRefusal(state, unit.tenantId, unit.id, run);
    if (blocked) {
      apply(`Allocate ${run}`, 'refused', blocked, () => {});
      return;
    }
    const period = openPeriod(data)!;
    const plan = planMonthEnd(unit, data, curve, period, run);
    apply(`Allocate ${run}`, 'write',
      `Allocated ${currency(plan.amount, unit.currency)} ${run} for ${period.code}.`,
      (s) => { allocateMonthEnd(s, unit.tenantId, unit.id, run); });
  };

  return {
    open, accretion, amortization,
    accretionAllocated, amortizationAllocated,
    allocate, editable: canEdit(ui.role),
  };
}

export function Calendar() {
  const { setUi } = useStore();
  const data = useUnitData()!;
  const runs = useMonthEndRuns();
  const open = runs.open ?? data.periods[data.periods.length - 1];
  const [done, setDone] = useState<Set<string>>(new Set(['CL-01', 'CL-02', 'CL-03']));

  const liveStatus = (ref: string) => {
    if (ref === 'CL-05') return runs.accretionAllocated ? 'Allocated' : 'Outstanding';
    if (ref === 'CL-06') return runs.amortizationAllocated ? 'Allocated' : 'Outstanding';
    return done.has(ref) ? 'Done' : 'Outstanding';
  };

  return (
    <Block kicker="Close calendar" title={`${open.code} — ${TASKS.length} tasks`}
      note="Working-day offsets are relative to the period end. A negative offset is before it. New ARO, cost and term adjustments, settlements and retirements each create a journal when you record them. Run accretion and amortization from Month-end posting — or the Run buttons on CL-05 and CL-06 — after those postings, then create a journal batch for those remaining events. Ticking a row does not allocate."
      actions={<button className="btn btn-primary btn-sm" onClick={() => setUi({ screen: 'month-end', tab: '', sub: '' })}>Open month-end posting</button>}>
      <SheetTable
        rows={TASKS.map(([ref, label, wd, owner]) => ({ ref, label, wd, owner }))}
        rowKey={(t) => t.ref}
        noun="tasks"
        columns={[
          { key: 'ref', header: 'Ref', value: (t) => t.ref, cell: (t) => t.ref },
          { key: 'task', header: 'Task', value: (t) => t.label, tdStyle: { fontFamily: 'var(--font-heading)', fontWeight: 800 }, cell: (t) => t.label },
          { key: 'wd', header: 'Working day', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (t) => t.wd, cell: (t) => t.wd > 0 ? `WD+${t.wd}` : `WD${t.wd}` },
          { key: 'owner', header: 'Owner', value: (t) => t.owner, cell: (t) => t.owner },
          { key: 'status', header: 'Status', value: (t) => liveStatus(t.ref), cell: (t) => {
            if (t.ref === 'CL-05') return <Tag kind={runs.accretionAllocated ? 'accent' : 'warn'}>{liveStatus(t.ref)}</Tag>;
            if (t.ref === 'CL-06') return <Tag kind={runs.amortizationAllocated ? 'accent' : 'warn'}>{liveStatus(t.ref)}</Tag>;
            return (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5 }}>
                <input type="checkbox" checked={done.has(t.ref)} onChange={(e) => {
                  const n = new Set(done);
                  e.target.checked ? n.add(t.ref) : n.delete(t.ref);
                  setDone(n);
                }} />
                {done.has(t.ref) ? 'Done' : 'Outstanding'}
              </label>
            );
          } },
          { key: 'act', header: '', cell: (t) => {
            if (t.ref === 'CL-05' && runs.editable) {
              return (
                <button className="btn btn-primary btn-sm" disabled={!runs.open || runs.accretionAllocated}
                  onClick={() => runs.allocate('accretion')}>
                  {runs.accretionAllocated ? 'Allocated' : 'Run accretion'}
                </button>
              );
            }
            if (t.ref === 'CL-06' && runs.editable) {
              return (
                <button className="btn btn-primary btn-sm" disabled={!runs.open || runs.amortizationAllocated}
                  onClick={() => runs.allocate('amortization')}>
                  {runs.amortizationAllocated ? 'Allocated' : 'Run amortization'}
                </button>
              );
            }
            return null;
          } },
        ]}
      />
    </Block>
  );
}

/* ══ Month-end posting ═════════════════════════════════════════════════ */

export function MonthEnd() {
  const { setUi } = useStore();
  const unit = useUnit()!;
  const runs = useMonthEndRuns();
  const { open, accretion, amortization, accretionAllocated, amortizationAllocated, allocate, editable } = runs;

  return (
    <Block kicker="Month-end posting" title={open ? `${open.code} — ${open.starts} to ${open.ends}` : 'No period is open'}
      note="Opening a period and assigning a curve does not post anything. During the month, new ARO, cost and term adjustments, settlements and retirements each create a draft journal when you record them. At month end, allocate accretion and amortization here as two separate runs, then create a journal batch for those remaining events.">
      {!open ? (
        <Empty>Open a period on Periods & close first. Month-end posting writes into the Open period only.</Empty>
      ) : (
        <>
          <Stats items={[
            { label: 'Open period', value: open.code },
            { label: 'Accretion', value: accretionAllocated ? `Allocated ${currency(accretion?.already ?? 0, unit.currency)}` : `${currency(accretion?.amount ?? 0, unit.currency)} to allocate`, tone: accretionAllocated ? 'ok' : 'warn' },
            { label: 'Amortization', value: amortizationAllocated ? `Allocated ${currency(amortization?.already ?? 0, unit.currency)}` : `${currency(amortization?.amount ?? 0, unit.currency)} to allocate`, tone: amortizationAllocated ? 'ok' : 'warn' },
          ]} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
            <div className="note-panel">
              <div className="kicker">CL-05</div>
              <div className="block-title" style={{ margin: '6px 0 8px' }}>Allocate accretion</div>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                Provision after this period's new ARO, cost and term postings, times the rate in force, times this period's year fraction. Not a full-year dump into the first month.
              </div>
              {editable && (
                <button className="btn btn-primary" style={{ marginTop: 14 }} disabled={accretionAllocated}
                  onClick={() => allocate('accretion')}>
                  {accretionAllocated ? `Accretion allocated for ${open.code}` : `Allocate accretion — ${currency(accretion?.amount ?? 0, unit.currency)}`}
                </button>
              )}
            </div>
            <div className="note-panel">
              <div className="kicker">CL-06</div>
              <div className="block-title" style={{ margin: '6px 0 8px' }}>Allocate amortization</div>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                ARO-asset carrying amount after those same postings, times this period's year fraction, over remaining useful life.
              </div>
              {editable && (
                <button className="btn btn-primary" style={{ marginTop: 14 }} disabled={amortizationAllocated}
                  onClick={() => allocate('amortization')}>
                  {amortizationAllocated ? `Amortization allocated for ${open.code}` : `Allocate amortization — ${currency(amortization?.amount ?? 0, unit.currency)}`}
                </button>
              )}
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={() => setUi({ screen: 'batches', tab: '', sub: '' })}>
              Create a journal batch for remaining month-end entries
            </button>
          </div>
        </>
      )}
    </Block>
  );
}

/* ══ Year-end revaluation ══════════════════════════════════════════════ */

export function Reval() {
  const { state, ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const curves = state.curves[unit.tenantId] ?? [];
  const inForce = curves.find((c) => c.id === unit.curveId);
  const suggested = suggestedClosingCurve(state, unit.tenantId, unit);
  const [closingId, setClosingId] = useState(suggested?.id ?? unit.curveId);
  const closing = curves.find((c) => c.id === closingId);

  const layered = frameworkPolicy(unit.frameworkId).ratePerLayer;
  const deriveOpts = {
    framework: unit.frameworkId,
    discount: unit.discount,
    layerPolicy: unit.layerPolicy,
  };

  const p12 = data.periods[data.periods.length - 1];
  const p12Accretion = data.events.some((e) => e.periodId === p12?.id && e.type === 'accretion');

  /**
   * Five live conditions — ENGINE-SPEC §7. Each reads state and computes its own
   * result; none is a stored flag.
   */
  const gates = [
    { label: 'Period 12 accretion allocated', pass: p12Accretion, detail: p12Accretion ? `Accretion has been allocated to ${p12.code}.` : `Accretion has not been allocated to ${p12.code}. In-year accretion must run on the table in force before the closing table is applied.` },
    { label: 'Not already revalued', pass: !unit.revaluedOn, detail: unit.revaluedOn ? `Already revalued on ${unit.revaluedOn}. A second run would revalue a revalued population.` : 'No revaluation has been run for this year.' },
    { label: 'Period not locked', pass: p12?.status !== 'Locked', detail: p12?.status === 'Locked' ? `${p12.code} is locked, so nothing can be written into it.` : `${p12?.code} is ${p12?.status.toLowerCase()} and will accept the run.` },
    { label: 'A closing table chosen that differs from the one in force', pass: !!closing && closing.id !== unit.curveId, detail: !closing ? 'No closing curve chosen.' : closing.id === unit.curveId ? 'The chosen table is the one already in force, so nothing would move. Start a later as-at table in the curve library first.' : `${closing.name} (as at ${closing.asAt}) differs from the table in force.` },
    { label: 'Role can post', pass: canPost(ui.role), detail: canPost(ui.role) ? `${roleById(ui.role).label} can post.` : 'A revaluation posts a change in estimate, so it needs a reviewer or a partner.' },
  ];
  const ready = gates.every((g) => g.pass);

  /** Previewed by running the engine twice, so the figure shown is the figure posted. */
  const preview = useMemo(() => {
    if (!closing) return null;
    let before = 0;
    let after = 0;
    for (const o of data.obligations) {
      if (o.status === 'Scoped out') continue;
      const cur = derive(o as Obligation, derived.assumptions, { curve: derived.curve ?? closing, priorCurve: derived.priorCurve ?? undefined, ...deriveOpts });
      const nxt = derive(o as Obligation, derived.assumptions, { curve: closing, priorCurve: derived.curve ?? undefined, ...deriveOpts });
      before += cur.pv;
      after += nxt.pv;
    }
    return { before, after, movement: after - before };
  }, [closing, data.obligations, derived, deriveOpts]);

  return (
    <>
      <Block kicker="Year-end revaluation" title="A change in estimate, not accretion"
        note={layered
          ? `This year ends ${unit.fyEnd}. ${frameworkPolicy(unit.frameworkId).name} locks a rate onto each layer. Running the revaluation brings the closing table into force for layers that arise after it — it does not remeasure existing layers. Inflation still reprices the cash flows on every layer.`
          : `This year ends ${unit.fyEnd}. In-year accretion stays on the table currently in force. The change in estimate is explicit: pick the published table whose as-at is this year end, then run the revaluation. That movement is IAS 8 / ASC 250 — not accretion and not a correction. Next year's accretion uses the new table. Do not edit the in-force points: that would rewrite the year already measured.`}>
        <div className="note-panel" style={{ marginBottom: 16 }}>
          <div><strong>In force now</strong> (in-year accretion): {inForce ? curveOptionLabel(inForce) : 'none assigned'}.</div>
          <div style={{ marginTop: 6 }}>
            <strong>This year end</strong> ({unit.fyEnd}): {suggested
              ? `${curveOptionLabel(suggested)}${suggested.id === unit.curveId ? ' — already in force' : ' — pre-selected as the closing table'}.`
              : `no published ${unit.currency} table as at ${unit.fyEnd} in the library. Add one with New as-at table, then return here.`}
          </div>
        </div>
        <div style={{ maxWidth: 520, marginBottom: 16 }}>
          <Field label="Closing rate table" help="The published table whose as-at matches this year end. The preview runs the engine twice so the figure shown is the figure posted.">
            <select className="input" value={closingId} onChange={(e) => setClosingId(e.target.value)}>
              {curves.map((c) => {
                const marks = [
                  c.id === unit.curveId ? 'in force' : '',
                  c.currency === unit.currency && c.asAt === unit.fyEnd && c.id !== unit.curveId ? 'this year end' : '',
                ].filter(Boolean);
                return (
                  <option key={c.id} value={c.id}>
                    {curveOptionLabel(c)}{marks.length ? ` — ${marks.join(', ')}` : ''}
                  </option>
                );
              })}
            </select>
          </Field>
        </div>

        {preview && (
          <Stats items={[
            { label: 'On the table in force', value: currency(preview.before, unit.currency) },
            { label: 'On the closing table', value: currency(preview.after, unit.currency) },
            { label: 'Change in estimate', value: currency(preview.movement, unit.currency), tone: preview.movement > 0 ? 'warn' : 'ok' },
          ]} />
        )}

        <div style={{ marginTop: 8 }}>
          <SheetTable
            rows={gates}
            rowKey={(g) => g.label}
            noun="conditions"
            columns={[
              { key: 'condition', header: 'Condition', value: (g) => g.label, tdStyle: { fontFamily: 'var(--font-heading)', fontWeight: 800 }, cell: (g) => g.label },
              { key: 'result', header: 'Result', value: (g) => g.pass ? 'Pass' : 'Fail', cell: (g) => g.pass ? <Tag kind="accent">Pass</Tag> : <Tag kind="bad">Fail</Tag> },
              { key: 'found', header: 'What it found', value: (g) => g.detail, tdClassName: 'muted', tdStyle: { whiteSpace: 'normal' }, cell: (g) => g.detail },
            ]}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" disabled={!ready}
            onClick={() => apply('Run year-end revaluation', 'post',
              `Revalued ${derived.rows.length} obligations onto ${closing!.name} as at ${closing!.asAt}. The movement of ${currency(preview?.movement ?? 0, unit.currency)} is a change in estimate, recorded as such.`,
              (s) => {
                const u = s.units[unit.tenantId].find((x) => x.id === unit.id)!;
                u.priorCurveId = u.curveId;
                u.curveId = closingId;
                u.revaluedOn = new Date().toISOString().slice(0, 10);
              })}>
            Run the revaluation
          </button>
          {unit.revaluedOn && canReverse(ui.role) && (
            <button className="btn btn-secondary btn-sm"
              onClick={() => apply('Reverse year-end revaluation', 'reverse',
                `Reversed the revaluation run on ${unit.revaluedOn}. The reversal is itself logged and the prior table is back in force.`,
                (s) => {
                  const u = s.units[unit.tenantId].find((x) => x.id === unit.id)!;
                  if (u.priorCurveId) { u.curveId = u.priorCurveId; }
                  u.revaluedOn = undefined;
                })}>
              Reverse the revaluation
            </button>
          )}
          {unit.revaluedOn && !canReverse(ui.role) && (
            <span className="muted" style={{ fontSize: 11.5, alignSelf: 'center' }}>
              Reversing a revaluation is an engagement partner action.
            </span>
          )}
        </div>
      </Block>
    </>
  );
}

/* ══ Journals ══════════════════════════════════════════════════════════ */

export function Journals() {
  const { state } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const settings = state.settings[unit.tenantId];

  const accountFor = (role: string, obligationId?: string) => {
    const o = obligationId ? data.obligations.find((x) => x.id === obligationId) : undefined;
    return accountForRole(settings, unit.tenantId, role, o);
  };
  const suspense = suspenseAccount(settings, unit.tenantId);

  const lines = data.events.slice(0, 60).map((e) => {
    const rule = settings.postingRules.find((r) => r.eventType === e.type);
    const dr = rule ? accountFor(rule.debitRole, e.obligationId) : undefined;
    const cr = rule ? accountFor(rule.creditRole, e.obligationId) : undefined;
    return { e, rule, dr, cr, unmapped: !rule || !dr || !cr };
  });
  const unmapped = lines.filter((l) => l.unmapped).length;

  return (
    <Block kicker="Journals" title={`${lines.length} entries from the event ledger`}
      note={`An event with no posting rule fails into suspense (${suspense?.code ?? '99999'}), never to a default account. ${unmapped} entr${unmapped === 1 ? 'y falls' : 'ies fall'} into suspense at present.`}>
      <SheetTable
        rows={lines}
        rowKey={(l) => l.e.id}
        noun="entries"
        columns={[
          { key: 'period', header: 'Period', value: (l) => data.periods.find((p) => p.id === l.e.periodId)?.code, cell: (l) => data.periods.find((p) => p.id === l.e.periodId)?.code },
          { key: 'event', header: 'Event', value: (l) => l.e.type, cell: (l) => <Tag kind="neutral">{l.e.type}</Tag> },
          { key: 'amount', header: 'Amount', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (l) => l.e.amount, cell: (l) => currency(l.e.amount, unit.currency) },
          { key: 'debit', header: 'Debit', value: (l) => l.dr ? `${l.dr.code} ${l.dr.name}` : `suspense ${suspense?.code}`, cell: (l) => l.dr ? `${l.dr.code} ${l.dr.name}` : <Tag kind="bad">suspense {suspense?.code}</Tag> },
          { key: 'credit', header: 'Credit', value: (l) => l.cr ? `${l.cr.code} ${l.cr.name}` : `suspense ${suspense?.code}`, cell: (l) => l.cr ? `${l.cr.code} ${l.cr.name}` : <Tag kind="bad">suspense {suspense?.code}</Tag> },
          { key: 'rule', header: 'Rule', value: (l) => l.rule ? `${l.rule.debitRole} → ${l.rule.creditRole}` : 'no rule', tdClassName: 'muted', cell: (l) => l.rule ? `${l.rule.debitRole} → ${l.rule.creditRole}` : 'no rule' },
        ]}
      />
    </Block>
  );
}

/* ══ Journal batches ═══════════════════════════════════════════════════ */

export function Batches() {
  const { state, ui, apply, setUi } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const open = openPeriod(data);
  const [drillAccountId, setDrillAccountId] = useState<string | null>(null);
  const settings = state.settings[unit.tenantId];
  const accounts = settings.accounts;
  const selected = data.batches.find((b) => b.id === ui.sub) ?? null;

  const create = () => {
    const blocked = periodBatchRefusal(state, unit.tenantId, unit.id);
    if (blocked) {
      apply('Create journal batch', 'refused', blocked, () => {});
      return;
    }
    apply('Create journal batch', 'write',
      `Created a batch from the ${open?.code} ledger.`,
      (s) => { createOrFillPeriodBatch(s, unit.tenantId, unit.id); });
  };

  const openBatch = (id: string) => {
    setUi({ sub: id });
    setDrillAccountId(null);
  };

  const accountLabel = (accountId: string) => {
    const a = accounts.find((x) => x.id === accountId);
    return a ? `${a.code} ${a.name}` : accountId;
  };

  const accountCode = (accountId: string) => accounts.find((x) => x.id === accountId)?.code ?? accountId;

  if (selected) {
    const period = data.periods.find((p) => p.id === selected.periodId);
    const dr = selected.lines.reduce((s, l) => s + l.debit, 0);
    const cr = selected.lines.reduce((s, l) => s + l.credit, 0);
    const glRows = summariseByAccount(selected.lines).sort((a, b) => accountCode(a.accountId).localeCompare(accountCode(b.accountId), undefined, { numeric: true }));
    const drill = drillAccountId ? glRows.find((r) => r.accountId === drillAccountId) : null;
    const segmentNames = [...settings.segments].sort((a, b) => a.ord - b.ord).map((s) => s.name);
    const detailRows = (drill ? selected.lines.filter((l) => l.accountId === drill.accountId) : []).map((l) => {
      const event = l.eventId ? data.events.find((e) => e.id === l.eventId) : undefined;
      const obligation = l.obligationId ? data.obligations.find((o) => o.id === l.obligationId) : undefined;
      const coding = segmentNames.map((n) => l.coding[n]).filter(Boolean).join(' · ');
      return { l, event, obligation, coding };
    });
    const showCoding = detailRows.some((row) => row.coding);

    return (
      <Block kicker="Journal batch" title={`${selected.number} — ${period?.code ?? 'no period'}`}
        note={drill
          ? `${accountLabel(drill.accountId)} in this batch. These are the obligation lines that make up the GL total.`
          : 'The journal entry is summarised by GL account. Open an account to see the obligation lines behind it. Approve is the preparer\'s sign-off that the entry is right — it does not post. A reviewer or partner Posts after that.'}
        actions={(
          <>
            <button className="btn btn-secondary btn-sm" onClick={() => { setUi({ sub: '' }); setDrillAccountId(null); }}>All batches</button>
            {drill && <button className="btn btn-secondary btn-sm" onClick={() => setDrillAccountId(null)}>Journal entry</button>}
            <JournalBatchActions batch={selected} />
          </>
        )}>
        <Stats items={[
          { label: 'Status', value: selected.status, tone: selected.status === 'Posted' ? 'ok' : selected.status === 'Reversed' ? 'bad' : 'warn' },
          { label: 'Debits', value: currency(drill ? drill.debit : dr, unit.currency) },
          { label: 'Credits', value: currency(drill ? drill.credit : cr, unit.currency) },
          { label: drill ? 'Account lines' : 'GL accounts', value: drill ? num(drill.count) : num(glRows.length) },
          { label: 'Lines', value: num(selected.lines.length) },
          { label: 'Approved by', value: selected.approvedBy ?? '—' },
          { label: 'Posted by', value: selected.postedBy ?? '—' },
        ]} />
        {selected.lines.length === 0 ? (
          <Empty>This batch has no lines. Allocate accretion and amortization on Month-end posting, then create or fill a batch from the remaining ledger events.</Empty>
        ) : drill ? (
          <SheetTable
            rows={detailRows}
            rowKey={(row) => `${selected.id}-${row.l.ord}`}
            noun="lines"
            columns={[
              { key: 'ord', header: 'Line', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.l.ord, cell: (row) => num(row.l.ord) },
              { key: 'obligation', header: 'Obligation', value: (row) => row.obligation?.ref, cell: (row) => row.obligation ? `${row.obligation.ref} — ${row.obligation.description}` : '—' },
              { key: 'event', header: 'Event', value: (row) => row.event?.type, cell: (row) => row.event ? <Tag kind="neutral">{row.event.type}</Tag> : '—' },
              { key: 'date', header: 'Date', kind: 'date', value: (row) => row.event?.date, cell: (row) => row.event?.date ?? '—' },
              { key: 'debit', header: 'Debit', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.l.debit, cell: (row) => row.l.debit ? currency(row.l.debit, unit.currency) : '' },
              { key: 'credit', header: 'Credit', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.l.credit, cell: (row) => row.l.credit ? currency(row.l.credit, unit.currency) : '' },
              ...(showCoding ? [{ key: 'coding', header: 'Coding', value: (row: (typeof detailRows)[number]) => row.coding, tdClassName: 'muted' as const, cell: (row: (typeof detailRows)[number]) => row.coding || '—' }] : []),
            ]}
          />
        ) : (
          <SheetTable
            rows={glRows}
            rowKey={(row) => row.accountId}
            noun="accounts"
            footer={
              <tr>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Journal entry</td>
                <td className="num" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{currency(dr, unit.currency)}</td>
                <td className="num" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{currency(cr, unit.currency)}</td>
                <td className="num">{num(selected.lines.length)}</td>
                <td />
              </tr>
            }
            columns={[
              { key: 'account', header: 'Account', value: (row) => accountLabel(row.accountId), tdStyle: { fontFamily: 'var(--font-heading)', fontWeight: 800 }, cell: (row) => (
                <button type="button" className="btn btn-ghost btn-sm"
                  style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, paddingLeft: 0, paddingRight: 0, textDecoration: 'underline', textUnderlineOffset: 3 }}
                  onClick={() => setDrillAccountId(row.accountId)}>
                  {row.suspense ? <Tag kind="bad">{accountLabel(row.accountId)}</Tag> : accountLabel(row.accountId)}
                </button>
              ) },
              { key: 'debit', header: 'Debit', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.debit, cell: (row) => row.debit ? currency(row.debit, unit.currency) : '' },
              { key: 'credit', header: 'Credit', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.credit, cell: (row) => row.credit ? currency(row.credit, unit.currency) : '' },
              { key: 'lines', header: 'Lines', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.count, cell: (row) => num(row.count) },
              { key: 'act', header: '', cell: (row) => (
                <button className="btn btn-secondary btn-sm" onClick={() => setDrillAccountId(row.accountId)}>Open</button>
              ) },
            ]}
          />
        )}
      </Block>
    );
  }

  return (
    <Block kicker="Journal batches" title={`${data.batches.length} batch${data.batches.length === 1 ? '' : 'es'}`}
      note={open
        ? `${open.code} is open. Open a batch to inspect the journal entry by GL account before you act. Approve is the preparer's sign-off — it is not posting. A reviewer or partner posts after that. A posted batch is immutable.`
        : 'Open a period before posting. Open a batch to inspect the journal entry by GL account. Approve is not posting. A batch is built from ledger events already written — it does not invent accretion or amortization.'}
      actions={canEdit(ui.role) && (
        <>
          <button className="btn btn-secondary btn-sm" onClick={() => setUi({ screen: 'month-end', tab: '', sub: '' })}>Month-end posting</button>
          <button className="btn btn-primary btn-sm" onClick={create}>Create batch from the ledger</button>
        </>
      )}>
      {data.batches.length === 0 ? (
        <Empty>No batches yet. In-year postings create a draft journal when you record them. Allocate accretion and amortization on Month-end posting, then create a batch for those remaining events.</Empty>
      ) : (
        <SheetTable
          rows={data.batches.map((b) => ({
            b,
            dr: b.lines.reduce((s, l) => s + l.debit, 0),
            cr: b.lines.reduce((s, l) => s + l.credit, 0),
            period: data.periods.find((p) => p.id === b.periodId)?.code,
          }))}
          rowKey={(row) => row.b.id}
          noun="batches"
          columns={[
            { key: 'batch', header: 'Batch', value: (row) => row.b.number, cell: (row) => (
              <button type="button" className="btn btn-ghost btn-sm"
                style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, paddingLeft: 0, paddingRight: 0, textDecoration: 'underline', textUnderlineOffset: 3 }}
                onClick={() => openBatch(row.b.id)}>
                {row.b.number}
              </button>
            ) },
            { key: 'period', header: 'Period', value: (row) => row.period, cell: (row) => row.period },
            { key: 'status', header: 'Status', value: (row) => row.b.status, cell: (row) => <JournalStatusTag status={row.b.status} /> },
            { key: 'debits', header: 'Debits', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.dr, cell: (row) => currency(row.dr, unit.currency) },
            { key: 'credits', header: 'Credits', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (row) => row.cr, cell: (row) => currency(row.cr, unit.currency) },
            { key: 'postedBy', header: 'Posted by', value: (row) => row.b.postedBy, cell: (row) => row.b.postedBy ?? '—' },
            { key: 'act', header: '', tdStyle: { display: 'flex', gap: 6 }, cell: (row) => (
              <>
                <button className="btn btn-secondary btn-sm" onClick={() => openBatch(row.b.id)}>Open</button>
                <JournalBatchActions batch={row.b} />
              </>
            ) },
          ]}
        />
      )}
    </Block>
  );
}

/* ══ GL reconciliation ═════════════════════════════════════════════════ */

export function Recon() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const [entry, setEntry] = useState('');

  const diff = data.glTotal === null ? null : derived.total - data.glTotal;

  return (
    <Block kicker="GL reconciliation" title="Sub-ledger against the general ledger"
      note="An incomplete reconciliation is reported as incomplete — 'no GL balance received' — never as a pass. The two figures are derived separately on purpose: the check is only falsifiable if they are.">
      <Stats items={[
        { label: 'ARO sub-ledger', value: currency(derived.total, unit.currency) },
        { label: 'General ledger', value: data.glTotal === null ? 'Not received' : currency(data.glTotal, unit.currency) },
        { label: 'Difference', value: diff === null ? '—' : currency(diff, unit.currency), tone: diff === null ? 'warn' : Math.abs(diff) <= 0.005 ? 'ok' : 'bad' },
      ]} />

      {data.glTotal === null ? (
        <div className="note-panel" style={{ borderLeftColor: 'var(--warn)' }}>
          No GL balance has been received, so this reconciliation is incomplete. It is not a pass, and the year-end
          lock sequence will stop at the sub-ledger gate until a balance arrives.
        </div>
      ) : Math.abs(diff!) <= 0.005 ? (
        <div className="note-panel">The ARO sub-ledger agrees to the provision accounts in the general ledger.</div>
      ) : (
        <div className="note-panel" style={{ borderLeftColor: 'var(--bad)' }}>
          The sub-ledger is out by {currency(diff!, unit.currency)} against the general ledger. The difference must be explained before
          the year can be locked.
        </div>
      )}

      {canEdit(ui.role) && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: '0 0 200px' }}>
            <Field label="GL provision balance" help="The closing balance on the provision accounts, taken from the trial balance.">
              <input className="input num" value={entry} onChange={(e) => setEntry(e.target.value)}
                onBlur={(e) => {
                  const n = parseNumber(e.target.value);
                  if (Number.isFinite(n)) setEntry(currency(n, unit.currency));
                }}
                placeholder={`e.g. ${currency(5_120_000, unit.currency)}`} />
            </Field>
          </div>
          <button className="btn btn-primary btn-sm" disabled={!entry.trim() || !Number.isFinite(parseNumber(entry))}
            onClick={() => apply('Record GL balance', 'write',
              `Recorded a GL provision balance of ${currency(parseNumber(entry), unit.currency)} for the reconciliation.`,
              (s) => { s.data[unit.id].glTotal = parseNumber(entry); })}>Record</button>
          {data.glTotal !== null && (
            <button className="btn btn-secondary btn-sm"
              onClick={() => apply('Clear GL balance', 'write', 'Cleared the GL balance. The reconciliation is incomplete again.',
                (s) => { s.data[unit.id].glTotal = null; })}>Clear</button>
          )}
        </div>
      )}
    </Block>
  );
}

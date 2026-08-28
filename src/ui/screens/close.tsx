/**
 * Close phase — close calendar, year-end revaluation, settlements, journals,
 * journal batches, GL reconciliation.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit, canPost, canReverse, roleById } from '../../core/authority';
import { canPostInto } from '../../core/periods';
import { settle } from '../../engine/rollforward';
import { derive } from '../../engine/derive';
import { Block, Empty, Field, money, money2, pct, Stats, Tag } from '../components';
import { JournalBatch, JournalLine, Obligation } from '../../core/types';

/* ══ Close calendar ════════════════════════════════════════════════════ */

const TASKS: [string, string, number, string][] = [
  ['CL-01', 'Receive the ARO register extract', -2, 'Preparer'],
  ['CL-02', 'Receive the GL trial balance', -1, 'Preparer'],
  ['CL-03', 'Normalise and accept the extract', 1, 'Preparer'],
  ['CL-04', 'Recalculate and explain material variances', 2, 'Preparer'],
  ['CL-05', 'Allocate accretion for the period', 3, 'Preparer'],
  ['CL-06', 'Approve the journal batch', 4, 'Preparer'],
  ['CL-07', 'Post the journal batch', 4, 'Reviewer'],
  ['CL-08', 'Reconcile the sub-ledger to the GL', 5, 'Preparer'],
  ['CL-09', 'Review the roll-forward', 6, 'Reviewer'],
  ['CL-10', 'Close the period', 6, 'Reviewer'],
];

export function Calendar() {
  const data = useUnitData()!;
  const open = data.periods.find((p) => p.status === 'Open') ?? data.periods[data.periods.length - 1];
  const [done, setDone] = useState<Set<string>>(new Set(['CL-01', 'CL-02', 'CL-03']));

  return (
    <Block kicker="Close calendar" title={`${open.code} — ${TASKS.length} tasks`}
      note="Working-day offsets are relative to the period end. A negative offset is before it.">
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th>Ref</th><th>Task</th><th className="num">Working day</th><th>Owner</th><th>Status</th></tr></thead>
          <tbody>
            {TASKS.map(([ref, label, wd, owner]) => (
              <tr key={ref}>
                <td>{ref}</td>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{label}</td>
                <td className="num">{wd > 0 ? `WD+${wd}` : `WD${wd}`}</td>
                <td>{owner}</td>
                <td>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5 }}>
                    <input type="checkbox" checked={done.has(ref)} onChange={(e) => {
                      const n = new Set(done);
                      e.target.checked ? n.add(ref) : n.delete(ref);
                      setDone(n);
                    }} />
                    {done.has(ref) ? 'Done' : 'Outstanding'}
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  const [closingId, setClosingId] = useState(unit.curveId);
  const closing = curves.find((c) => c.id === closingId);

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
    { label: 'A closing table chosen that differs from the one in force', pass: !!closing && closing.id !== unit.priorCurveId, detail: !closing ? 'No closing curve chosen.' : closing.id === unit.priorCurveId ? 'The chosen table is the one already in force, so nothing would move.' : `${closing.name} differs from the table in force.` },
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
      const cur = derive(o as Obligation, derived.assumptions, { curve: derived.curve ?? closing, priorCurve: derived.priorCurve ?? undefined });
      const nxt = derive(o as Obligation, derived.assumptions, { curve: closing, priorCurve: derived.curve ?? undefined });
      before += cur.pv;
      after += nxt.pv;
    }
    return { before, after, movement: after - before };
  }, [closing, data.obligations, derived]);

  return (
    <>
      <Block kicker="Year-end revaluation" title="A change in estimate, not accretion"
        note="The curve and inflation in force are period-stamped, so a table loaded during period n governs the periods after it. In-year accretion therefore lags the closing rates, and the closing table cannot simply be loaded on top: applying it revalues the whole population, and that movement is a change in estimate under IAS 8 / ASC 250 — not accretion and not a correction.">
        <div style={{ maxWidth: 420, marginBottom: 16 }}>
          <Field label="Closing rate table" help="The curve to bring into force at the year end. The preview runs the engine twice so the figure shown is the figure posted.">
            <select className="input" value={closingId} onChange={(e) => setClosingId(e.target.value)}>
              {curves.map((c) => <option key={c.id} value={c.id}>{c.name} (as at {c.asAt})</option>)}
            </select>
          </Field>
        </div>

        {preview && (
          <Stats items={[
            { label: 'On the table in force', value: `${unit.currency} ${money(preview.before)}` },
            { label: 'On the closing table', value: `${unit.currency} ${money(preview.after)}` },
            { label: 'Change in estimate', value: `${unit.currency} ${money(preview.movement)}`, tone: preview.movement > 0 ? 'warn' : 'ok' },
          ]} />
        )}

        <div className="scroll-x" style={{ marginTop: 8 }}>
          <table className="table">
            <thead><tr><th>Condition</th><th>Result</th><th>What it found</th></tr></thead>
            <tbody>
              {gates.map((g) => (
                <tr key={g.label}>
                  <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{g.label}</td>
                  <td>{g.pass ? <Tag kind="accent">Pass</Tag> : <Tag kind="bad">Fail</Tag>}</td>
                  <td style={{ whiteSpace: 'normal' }} className="muted">{g.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" disabled={!ready}
            onClick={() => apply('Run year-end revaluation', 'post',
              `Revalued ${derived.rows.length} obligations onto ${closing!.name}. The movement of ${money2(preview?.movement ?? 0)} is a change in estimate, recorded as such.`,
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

/* ══ Settlements ═══════════════════════════════════════════════════════ */

export function Settle() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const [draft, setDraft] = useState({ obligationId: '', pct: '100', actualCost: '', settledOn: '' });
  const target = data.obligations.find((o) => o.id === draft.obligationId) ?? data.obligations[0];
  const d = target ? derived.byId.get(target.id) : null;
  const preview = d ? settle(d.pv, Number(draft.pct) / 100, Number(draft.actualCost) || 0) : null;

  return (
    <>
      <Block kicker="Settlements" title={`${data.settlements.length} recorded`}
        note="Released equals the provision carried times the share settled. An overrun goes to operating costs; a surplus is written back. A posted full settlement removes the obligation from the balance sheet.">
        {data.settlements.length === 0 ? (
          <Empty>No settlements recorded in this year.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Obligation</th><th>Kind</th><th className="num">Share</th><th className="num">Released</th><th className="num">Actual cost</th><th className="num">Overrun</th><th className="num">Written back</th><th>Settled</th><th>Posted</th></tr></thead>
              <tbody>
                {data.settlements.map((s) => {
                  const dd = derived.byId.get(s.obligationId);
                  const r = settle(dd?.pv ?? 0, s.pct, s.actualCost);
                  return (
                    <tr key={s.id}>
                      <td>{data.obligations.find((o) => o.id === s.obligationId)?.ref}</td>
                      <td>{s.kind}</td>
                      <td className="num">{pct(s.pct)}</td>
                      <td className="num">{money2(r.released)}</td>
                      <td className="num">{money2(s.actualCost)}</td>
                      <td className="num">{r.overrun ? money2(r.overrun) : '—'}</td>
                      <td className="num">{r.surplus ? money2(r.surplus) : '—'}</td>
                      <td>{s.settledOn}</td>
                      <td>{s.posted ? <Tag kind="accent">Posted</Tag> : <Tag kind="warn">Draft</Tag>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      {canEdit(ui.role) && target && (
        <Block kicker="Record" title="A settlement">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 280px' }}>
              <Field label="Obligation">
                <select className="input" value={target.id} onChange={(e) => setDraft({ ...draft, obligationId: e.target.value })}>
                  {data.obligations.map((o) => <option key={o.id} value={o.id}>{o.ref} — {o.description}</option>)}
                </select>
              </Field>
            </div>
            <div style={{ flex: '0 0 110px' }}>
              <Field label="Share settled (%)"><input className="input num" value={draft.pct} onChange={(e) => setDraft({ ...draft, pct: e.target.value })} /></Field>
            </div>
            <div style={{ flex: '0 0 150px' }}>
              <Field label="Actual cost"><input className="input num" value={draft.actualCost} onChange={(e) => setDraft({ ...draft, actualCost: e.target.value })} /></Field>
            </div>
            <div style={{ flex: '0 0 150px' }}>
              <Field label="Settled on"><input className="input" type="date" value={draft.settledOn} onChange={(e) => setDraft({ ...draft, settledOn: e.target.value })} /></Field>
            </div>
            <button className="btn btn-primary btn-sm" disabled={!draft.actualCost || !draft.settledOn}
              onClick={() => apply('Record settlement', 'write',
                `Recorded a ${Number(draft.pct) >= 100 ? 'full' : 'partial'} settlement of ${target.ref}: ${money2(preview?.released ?? 0)} released against ${money2(Number(draft.actualCost))} spent.`,
                (s) => {
                  s.data[unit.id].settlements.push({
                    id: `st-${Date.now().toString(36)}`, obligationId: target.id,
                    kind: Number(draft.pct) >= 100 ? 'Full' : 'Partial',
                    pct: Number(draft.pct) / 100, actualCost: Number(draft.actualCost),
                    settledOn: draft.settledOn, posted: false,
                  });
                })}>Record</button>
          </div>
          {preview && Number(draft.actualCost) > 0 && (
            <div className="note-panel" style={{ marginTop: 12 }}>
              {money2(preview.released)} of provision would be released.{' '}
              {preview.overrun > 0 && `The spend exceeds it by ${money2(preview.overrun)}, which is charged to operating costs.`}
              {preview.surplus > 0 && `The provision exceeds the spend by ${money2(preview.surplus)}, which is written back to income.`}
              {preview.overrun === 0 && preview.surplus === 0 && 'The spend equals the provision released exactly.'}
              {preview.full && ' A posted full settlement removes the obligation from the balance sheet.'}
            </div>
          )}
        </Block>
      )}
    </>
  );
}

/* ══ Journals ══════════════════════════════════════════════════════════ */

export function Journals() {
  const { state } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const settings = state.settings[unit.tenantId];

  const accountFor = (role: string) => settings.accounts.find((a) => a.engineRole === role);
  const suspense = settings.accounts.find((a) => a.engineRole === 'Suspense');

  const lines = data.events.slice(0, 60).map((e) => {
    const rule = settings.postingRules.find((r) => r.eventType === e.type);
    const dr = rule ? accountFor(rule.debitRole) : undefined;
    const cr = rule ? accountFor(rule.creditRole) : undefined;
    return { e, rule, dr, cr, unmapped: !rule || !dr || !cr };
  });
  const unmapped = lines.filter((l) => l.unmapped).length;

  return (
    <Block kicker="Journals" title={`${lines.length} entries from the event ledger`}
      note={`An event with no posting rule fails into suspense (${suspense?.code ?? '99999'}), never to a default account. ${unmapped} entr${unmapped === 1 ? 'y falls' : 'ies fall'} into suspense at present.`}>
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th>Period</th><th>Event</th><th className="num">Amount</th><th>Debit</th><th>Credit</th><th>Rule</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.e.id}>
                <td>{data.periods.find((p) => p.id === l.e.periodId)?.code}</td>
                <td><Tag kind="neutral">{l.e.type}</Tag></td>
                <td className="num">{money2(l.e.amount)}</td>
                <td>{l.dr ? `${l.dr.code} ${l.dr.name}` : <Tag kind="bad">suspense {suspense?.code}</Tag>}</td>
                <td>{l.cr ? `${l.cr.code} ${l.cr.name}` : <Tag kind="bad">suspense {suspense?.code}</Tag>}</td>
                <td className="muted">{l.rule ? `${l.rule.debitRole} → ${l.rule.creditRole}` : 'no rule'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  );
}

/* ══ Journal batches ═══════════════════════════════════════════════════ */

export function Batches() {
  const { state, ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const derived = useDerived()!;
  const settings = state.settings[unit.tenantId];

  const create = () => {
    const period = data.periods.find((p) => p.status === 'Open') ?? data.periods[data.periods.length - 1];
    const provision = settings.accounts.find((a) => a.engineRole === 'ARO provision');
    const accretion = settings.accounts.find((a) => a.engineRole === 'Accretion expense');
    const amount = data.events.filter((e) => e.periodId === period.id && e.type === 'accretion').reduce((s, e) => s + e.amount, 0);
    const lines: JournalLine[] = [
      { ord: 1, accountId: accretion?.id ?? '', coding: { Company: '1000', 'Cost centre': 'CC-100' }, debit: amount, credit: 0 },
      { ord: 2, accountId: provision?.id ?? '', coding: { Company: '1000', 'Cost centre': 'CC-100' }, debit: 0, credit: amount },
    ];
    apply('Create journal batch', 'write',
      `Created a batch for ${period.code} carrying ${money2(amount)} of accretion.`,
      (s) => {
        s.data[unit.id].batches.push({
          id: `jb-${Date.now().toString(36)}`, unitId: unit.id, periodId: period.id,
          number: `JB-${String(s.data[unit.id].batches.length + 1).padStart(3, '0')}`,
          status: 'Draft', lines,
        });
      });
  };

  const act = (b: JournalBatch, to: JournalBatch['status']) => {
    const period = data.periods.find((p) => p.id === b.periodId);
    if (to === 'Posted') {
      const check = canPostInto(period);
      if (!check.allowed) { apply('Post batch', 'refused', check.reason, () => {}); return; }
      if (!canPost(ui.role)) {
        apply('Post batch', 'refused', `${b.number} cannot post: posting needs a reviewer or a partner. A preparer approves, a reviewer or partner posts.`, () => {});
        return;
      }
    }
    if (to === 'Reversed' && !canReverse(ui.role)) {
      apply('Reverse batch', 'refused', `${b.number} cannot be reversed: reversal is an engagement partner action. A posted batch is immutable — correcting it is a reversal plus a new batch, both logged.`, () => {});
      return;
    }
    apply(
      to === 'Posted' ? 'Post batch' : to === 'Reversed' ? 'Reverse batch' : 'Approve batch',
      to === 'Posted' ? 'post' : to === 'Reversed' ? 'reverse' : 'write',
      to === 'Reversed'
        ? `${b.number} reversed. The posted batch is immutable and stands; this is a reversal, and a new batch is needed to correct it.`
        : `${b.number} moved to ${to.toLowerCase()} in ${period?.code}.`,
      (s) => {
        const x = s.data[unit.id].batches.find((y) => y.id === b.id)!;
        x.status = to;
        if (to === 'Posted') { x.postedBy = ui.userName; x.postedAt = new Date().toISOString(); }
        if (to === 'Approved') x.approvedBy = ui.userName;
        if (to === 'Reversed') x.reversedBy = ui.userName;
      });
  };

  return (
    <Block kicker="Journal batches" title={`${data.batches.length} batch${data.batches.length === 1 ? '' : 'es'}`}
      note="A posted batch is immutable. Correcting it is a reversal plus a new batch, both logged, and reversal is partner-only."
      actions={canEdit(ui.role) && <button className="btn btn-primary btn-sm" onClick={create}>Create batch from the ledger</button>}>
      {data.batches.length === 0 ? (
        <Empty>No batches yet. A batch is built from the events in a period and posts the net movement to the provision accounts.</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Batch</th><th>Period</th><th>Status</th><th className="num">Debits</th><th className="num">Credits</th><th>Posted by</th><th /></tr></thead>
            <tbody>
              {data.batches.map((b) => {
                const dr = b.lines.reduce((s, l) => s + l.debit, 0);
                const cr = b.lines.reduce((s, l) => s + l.credit, 0);
                return (
                  <tr key={b.id}>
                    <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{b.number}</td>
                    <td>{data.periods.find((p) => p.id === b.periodId)?.code}</td>
                    <td><Tag kind={b.status === 'Posted' ? 'accent' : b.status === 'Reversed' ? 'bad' : 'warn'}>{b.status}</Tag></td>
                    <td className="num">{money2(dr)}</td>
                    <td className="num">{money2(cr)}</td>
                    <td>{b.postedBy ?? '—'}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {b.status === 'Draft' && <button className="btn btn-secondary btn-sm" onClick={() => act(b, 'Approved')}>Approve</button>}
                      {b.status === 'Approved' && <button className="btn btn-primary btn-sm" onClick={() => act(b, 'Posted')}>Post</button>}
                      {b.status === 'Posted' && <button className="btn btn-secondary btn-sm" onClick={() => act(b, 'Reversed')}>Reverse</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
        { label: 'ARO sub-ledger', value: `${unit.currency} ${money(derived.total)}` },
        { label: 'General ledger', value: data.glTotal === null ? 'Not received' : `${unit.currency} ${money(data.glTotal)}` },
        { label: 'Difference', value: diff === null ? '—' : `${unit.currency} ${money2(diff)}`, tone: diff === null ? 'warn' : Math.abs(diff) <= 0.005 ? 'ok' : 'bad' },
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
          The sub-ledger is out by {money2(diff!)} against the general ledger. The difference must be explained before
          the year can be locked.
        </div>
      )}

      {canEdit(ui.role) && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: '0 0 200px' }}>
            <Field label="GL provision balance" help="The closing balance on the provision accounts, taken from the trial balance.">
              <input className="input num" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="e.g. 5120000" />
            </Field>
          </div>
          <button className="btn btn-primary btn-sm" disabled={!entry.trim() || !Number.isFinite(Number(entry))}
            onClick={() => apply('Record GL balance', 'write',
              `Recorded a GL provision balance of ${money2(Number(entry))} for the reconciliation.`,
              (s) => { s.data[unit.id].glTotal = Number(entry); })}>Record</button>
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

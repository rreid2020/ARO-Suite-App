/**
 * In-year transaction processing — Measure.
 *
 * One step to post a new obligation (and its ARO asset), a cost or term
 * adjustment, or a partial/full settlement into the open period. The same
 * postings can be recorded from an expanded ARO register row. The register is
 * the as-at books.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { canEdit } from '../../core/authority';
import { classCodeOf, classKey, classNameOf, findAssetClass } from '../../core/assetClass';
import { suggestedAroAssetNumber } from '../../core/openingLoad';
import { tcaForObligation } from '../../core/tcaListing';
import { uniqueObligationRef } from '../../core/tcaSync';
import { postNewAro, postRevision, postSettlement } from '../../core/inYear';
import { assetBooks, openPeriod, provisionCarried } from '../../core/periodClose';
import {
  evaluateNewAroLifeDraft, nextUlDraftFromTca, suggestedSettlementDate, usefulLifeAsAt,
  withSettlementFromRemaining,
} from '../../core/usefulLife';
import { isValidDate, maskDateInput, priorYearEnd } from '../../engine/dates';
import { planCaseEntries, selectPostingCase, type PostingFacts } from '../../engine/postingCases';
import { matchedRevision, txHistoryEvents, type TxHistoryKind } from '../../core/activity';
import { revisionWalkForEvent, type RevisionWalk } from '../../core/postingWalk';
import { journalBatchForEvent } from '../../core/registerBooks';
import { Obligation, Revision } from '../../core/types';
import { REMEASUREMENT_REASONS } from '../../seed';
import type { Rung } from '../../engine/ladder';
import {
  Basis, Block, Empty, Field, JournalRef, NewAroEstimate, NewAroLifeFields, NewAroSettlementFields,
  DEFAULT_ESTIMATE_COLUMNS, currency, emptyEstimateLine, estimateHasCost, estimatePayload,
  parseNumber, pct, SheetTable, Stats, Tag, years,
} from '../components';
import type { EstimateLineDraft, EstimateMode } from '../components';

export type TxKind = 'new' | 'cost' | 'term' | 'settle';

const KINDS: { id: TxKind; label: string; group: 'New' | 'Existing' }[] = [
  { id: 'new', label: 'New obligation', group: 'New' },
  { id: 'cost', label: 'Cost adjustment', group: 'Existing' },
  { id: 'term', label: 'Term adjustment', group: 'Existing' },
  { id: 'settle', label: 'Settlement', group: 'Existing' },
];

const POSTING_TYPES = new Set(['addition', 'expense-recognition', 'revision', 'revision-unproductive', 'settlement', 'disposal', 'downward-excess']);

function kindFromUi(screen: string, tab: string): TxKind {
  if (tab === 'new' || tab === 'cost' || tab === 'term' || tab === 'settle') return tab;
  if (screen === 'settle') return 'settle';
  if (screen === 'adjust') return 'cost';
  if (screen === 'cost') return 'new';
  return 'new';
}

export function Transactions() {
  const { ui, setUi } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const editable = canEdit(ui.role);
  const open = openPeriod(data);
  const kind = kindFromUi(ui.screen, ui.tab);
  const setKind = (next: TxKind) => setUi({ screen: 'transactions', tab: next, sub: ui.sub });

  const live = data.obligations.filter((o) => o.status !== 'Scoped out');
  const periodEvents = useMemo(() => {
    if (!open) return [];
    return data.events
      .filter((e) => e.periodId === open.id && POSTING_TYPES.has(e.type))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  }, [data.events, open]);

  return (
    <>
      <Stats items={[
        { label: 'Open period', value: open ? open.code : 'None', tone: open ? 'ok' : 'warn' },
        { label: 'Obligations in scope', value: String(live.length) },
        { label: open ? `Postings in ${open.code}` : 'Postings', value: String(periodEvents.length) },
      ]} />

      <Block
        kicker="Transactions"
        title="Post into the open period"
        note={open
          ? `These postings write the event ledger in ${open.code} (${open.starts} to ${open.ends}) when you record them. The same cost, term and settlement postings can be recorded from an expanded ARO register row. Accretion and amortization run later from Close → Month-end posting. The ARO register is the as-at books of what has already posted.`
          : 'Open a period on Periods & close before posting. New obligations, cost and term adjustments, and settlements all post into the open period.'}
      >
        <div className="register-tab-groups" style={{ marginBottom: 16 }}>
          <div className="register-tab-group g-tone g-new">
            <div className="kicker">New</div>
            <div className="register-tabs">
              {KINDS.filter((k) => k.group === 'New').map((k) => (
                <button key={k.id} type="button" className={`register-tab${kind === k.id ? ' is-on' : ''}`}
                  onClick={() => setKind(k.id)}>{k.label}</button>
              ))}
            </div>
          </div>
          <div className="register-tab-group g-tone g-existing">
            <div className="kicker">Existing</div>
            <div className="register-tabs">
              {KINDS.filter((k) => k.group === 'Existing').map((k) => (
                <button key={k.id} type="button" className={`register-tab${kind === k.id ? ' is-on' : ''}`}
                  onClick={() => setKind(k.id)}>{k.label}</button>
              ))}
            </div>
          </div>
        </div>

        {!open ? (
          <Empty>Open a period on Periods & close to post in-year transactions.</Empty>
        ) : !editable ? (
          <Empty>This role cannot post in-year transactions.</Empty>
        ) : kind === 'new' ? (
          <NewObligationForm />
        ) : kind === 'cost' || kind === 'term' ? (
          <RevisionForm kind={kind} />
        ) : (
          <SettlementForm />
        )}
      </Block>

      <Block kicker={open ? open.code : 'Ledger'} title={`${periodEvents.length} in-period posting${periodEvents.length === 1 ? '' : 's'}`}
        note="New ARO, cost and term adjustments, and settlements recorded in the open period. Click a JV# to open the journal batch. Month-end accretion and amortization are allocated separately.">
        {periodEvents.length === 0 ? (
          <Empty>Nothing posted in this period yet.</Empty>
        ) : (
          <SheetTable
            rows={periodEvents.map((e) => ({
              e,
              ref: data.obligations.find((o) => o.id === e.obligationId)?.ref ?? e.obligationId,
            }))}
            rowKey={(row) => row.e.id}
            noun="postings"
            columns={[
              { key: 'date', header: 'Date', kind: 'date', value: (row) => row.e.date, cell: (row) => row.e.date },
              { key: 'ref', header: 'Obligation', value: (row) => row.ref, cell: (row) => row.ref },
              { key: 'type', header: 'Type', value: (row) => row.e.type, cell: (row) => <Tag kind="neutral">{row.e.type}</Tag> },
              {
                key: 'amount', header: 'Amount', kind: 'number', thClassName: 'num', tdClassName: 'num',
                value: (row) => row.e.amount, cell: (row) => currency(row.e.amount, unit.currency),
              },
              {
                key: 'jv', header: 'JV#',
                value: (row) => journalBatchForEvent(row.e.id, data.batches)?.number ?? '',
                cell: (row) => <JournalRef eventId={row.e.id} batches={data.batches} />,
              },
              { key: 'note', header: 'Note', value: (row) => row.e.note ?? '', cell: (row) => row.e.note || <span className="muted">—</span> },
            ]}
          />
        )}
      </Block>
    </>
  );
}

export function NewObligationForm() {
  const { state, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const open = openPeriod(data)!;
  const assetClasses = state.settings[unit.tenantId]?.aroAssetClasses ?? [];
  const classCodes = ['', ...[...new Set(assetClasses.map((c) => (c.code ?? '').trim()).filter(Boolean))]];
  const classNames = ['', ...[...new Set(assetClasses.map((c) => c.name.trim()).filter(Boolean))]];

  const [form, setForm] = useState({
    ref: uniqueObligationRef(data.obligations, 'ARO'),
    description: '',
    costEstimateDate: priorYearEnd(unit.fyEnd),
    settlementDate: '',
    aroseOn: open.ends,
    assetClass: '',
    assetId: '',
    aroAssetNumber: '',
    assetAcquisitionDate: '',
    totalUl: '',
    expiredUl: '',
    inProductiveUse: true,
    estimateMode: 'single' as EstimateMode,
    estimateLines: [emptyEstimateLine()] as EstimateLineDraft[],
    estimateColumns: DEFAULT_ESTIMATE_COLUMNS,
  });

  const linkedTca = tcaForObligation(data.tcaAssets, { assetId: form.assetId });
  const listingAcq = linkedTca?.acquisitionDate ?? '';
  const life = evaluateNewAroLifeDraft({
    totalUlText: form.totalUl,
    expiredUlText: form.expiredUl,
    tca: linkedTca,
    assetAcquisitionDate: form.assetAcquisitionDate,
    costEstimateDate: form.costEstimateDate,
    settlementDate: form.settlementDate,
    dayCount: unit.dayCount,
  });
  const canPost = form.ref.trim()
    && estimateHasCost(form.estimateLines, form.estimateColumns)
    && isValidDate(form.assetAcquisitionDate)
    && isValidDate(form.costEstimateDate)
    && isValidDate(form.settlementDate)
    && isValidDate(form.aroseOn)
    && !life.issue;

  const submit = () => {
    const input = {
      ref: form.ref,
      description: form.description,
      ...estimatePayload(form.estimateLines, form.estimateColumns),
      costEstimateDate: form.costEstimateDate,
      settlementDate: form.settlementDate,
      aroseOn: form.aroseOn,
      assetAcquisitionDate: form.assetAcquisitionDate,
      assetClass: form.assetClass || undefined,
      assetId: form.assetId.trim() || undefined,
      aroAssetNumber: form.aroAssetNumber.trim() || undefined,
      totalUl: form.totalUl.trim() === '' ? undefined : parseNumber(form.totalUl),
      expiredUl: form.expiredUl.trim() === '' ? undefined : parseNumber(form.expiredUl),
      inProductiveUse: form.inProductiveUse,
    };
    const probe = postNewAro(structuredClone(state), unit.tenantId, unit.id, input);
    if (typeof probe === 'string') {
      apply('Post new obligation', 'refused', probe, () => {});
      return;
    }
    const how = probe.caseId === 'expense-recognition'
      ? `Charged to expense ${currency(probe.amount, unit.currency)}.`
      : probe.caseId === 'catch-up-recognition'
        ? `Provision and ARO asset ${currency(probe.amount, unit.currency)}, with catch-up amortization.`
        : `Provision and ARO asset ${currency(probe.amount, unit.currency)}.`;
    apply('Post new obligation', 'write',
      `Posted ${input.ref} in ${probe.periodCode}. ${how}`,
      (s) => { postNewAro(s, unit.tenantId, unit.id, input); });
  };

  return (
    <>
      <div className="kicker" style={{ marginBottom: 8 }}>New obligation and ARO asset</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        <Field label="Obligation number"><input className="input" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} /></Field>
        <Field label="Description"><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field
          label="ARO asset acquisition date"
          help="The date the obligating event occurred. Defaults from the linked TCA on the master listing."
          hint={!isValidDate(form.assetAcquisitionDate) && form.assetId.trim() && !linkedTca
            ? 'No TCA on the master listing for that asset number.'
            : !isValidDate(form.assetAcquisitionDate) && linkedTca && !isValidDate(listingAcq)
              ? 'No acquisition date on the master TCA listing.'
              : isValidDate(listingAcq) && form.assetAcquisitionDate === listingAcq
                ? `Defaulted from the TCA acquisition date (${listingAcq}).`
                : isValidDate(listingAcq) && form.assetAcquisitionDate !== listingAcq
                  ? `TCA acquisition date on the listing is ${listingAcq}.`
                  : undefined}
        >
          <input className="input" value={form.assetAcquisitionDate} onChange={(e) => {
            const assetAcquisitionDate = maskDateInput(e.target.value);
            setForm((v) => withSettlementFromRemaining(v, { ...v, assetAcquisitionDate }, unit.dayCount, linkedTca, linkedTca));
          }} placeholder="YYYY-MM-DD" />
        </Field>
        <Field label="Cost estimate date" help={`The price date of the cost build-up. Defaults to the prior financial year end. This year ends ${unit.fyEnd}.`}>
          <input className="input" value={form.costEstimateDate} onChange={(e) => {
            const costEstimateDate = maskDateInput(e.target.value);
            setForm((v) => withSettlementFromRemaining(v, { ...v, costEstimateDate }, unit.dayCount, linkedTca, linkedTca));
          }} placeholder="YYYY-MM-DD" />
        </Field>
        <NewAroSettlementFields
          settlementDate={form.settlementDate}
          yearsToSettlement={life.yearsToSettlement}
          remainingUl={life.remainingUl}
          issue={life.issue}
          suggested={suggestedSettlementDate(form.costEstimateDate, life.remainingUl, unit.dayCount)}
          onSettlementDate={(settlementDate) => setForm((v) => ({ ...v, settlementDate }))}
        />
        <Field label="Effective date"><input className="input" value={form.aroseOn} onChange={(e) => setForm({ ...form, aroseOn: maskDateInput(e.target.value) })} placeholder="YYYY-MM-DD" /></Field>
        <Field label="TCA asset number">
          <input className="input" value={form.assetId} onChange={(e) => {
            const assetId = e.target.value;
            const prevTca = tcaForObligation(data.tcaAssets, { assetId: form.assetId });
            const nextTca = tcaForObligation(data.tcaAssets, { assetId });
            const prevDefault = prevTca?.acquisitionDate ?? '';
            const nextDefault = nextTca?.acquisitionDate ?? '';
            const keepUserDate = Boolean(form.assetAcquisitionDate && form.assetAcquisitionDate !== prevDefault);
            const ul = nextUlDraftFromTca({
              formTotal: form.totalUl,
              formExpired: form.expiredUl,
              prevTca,
              nextTca,
            });
            const keepUserAro = Boolean(form.aroAssetNumber && form.aroAssetNumber !== suggestedAroAssetNumber(data.obligations, form.assetId));
            setForm(withSettlementFromRemaining(
              form,
              {
                ...form,
                assetId,
                aroAssetNumber: keepUserAro ? form.aroAssetNumber : (assetId.trim() ? suggestedAroAssetNumber(data.obligations, assetId) : ''),
                assetAcquisitionDate: keepUserDate ? form.assetAcquisitionDate : (nextDefault || form.assetAcquisitionDate),
                totalUl: ul.totalUl,
                expiredUl: ul.expiredUl,
              },
              unit.dayCount, nextTca, nextTca,
            ));
          }} />
        </Field>
        <Field label="ARO asset number" help="Assigned from the TCA asset number when blank.">
          <input className="input" value={form.aroAssetNumber} onChange={(e) => setForm({ ...form, aroAssetNumber: e.target.value })} />
        </Field>
        <Field label="ARO asset class code">
          <select className="input" value={classCodeOf(form.assetClass, assetClasses)}
            onChange={(e) => {
              const cls = findAssetClass(assetClasses, e.target.value);
              setForm({ ...form, assetClass: cls ? classKey(cls) : e.target.value });
            }}>
            {classCodes.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="ARO asset class name">
          <select className="input" value={classNameOf(form.assetClass, assetClasses)}
            onChange={(e) => {
              const cls = findAssetClass(assetClasses, e.target.value);
              setForm({ ...form, assetClass: cls ? classKey(cls) : e.target.value });
            }}>
            {classNames.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <NewAroLifeFields
          totalUl={form.totalUl}
          expiredUl={form.expiredUl}
          tca={linkedTca}
          assetAcquisitionDate={form.assetAcquisitionDate}
          costEstimateDate={form.costEstimateDate}
          settlementDate={form.settlementDate}
          dayCount={unit.dayCount}
          onTotalUl={(totalUl) => setForm((v) => withSettlementFromRemaining(v, { ...v, totalUl }, unit.dayCount, linkedTca, linkedTca))}
          onExpiredUl={(expiredUl) => setForm((v) => withSettlementFromRemaining(v, { ...v, expiredUl }, unit.dayCount, linkedTca, linkedTca))}
        />
        <Field label="In productive use">
          <select className="input" value={form.inProductiveUse ? 'Yes' : 'No'}
            onChange={(e) => setForm({ ...form, inProductiveUse: e.target.value === 'Yes' })}>
            <option>Yes</option>
            <option>No</option>
          </select>
        </Field>
        <NewAroEstimate
          mode={form.estimateMode}
          lines={form.estimateLines}
          columns={form.estimateColumns}
          currencyCode={unit.currency}
          templates={state.settings[unit.tenantId]?.costEstimateTemplates}
          onMode={(estimateMode) => setForm((v) => ({ ...v, estimateMode }))}
          onLines={(estimateLines) => setForm((v) => ({ ...v, estimateLines }))}
          onColumns={(estimateColumns) => setForm((v) => ({ ...v, estimateColumns }))}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={!canPost}>Post new obligation</button>
      </div>
    </>
  );
}

/** Posted events for one obligation and transaction kind, with posting JV# links. */
export function TxEventHistory({
  obligation, kind,
}: {
  obligation: Obligation;
  kind: TxHistoryKind;
}) {
  const { state } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const events = useMemo(
    () => txHistoryEvents(obligation, data.events, kind),
    [obligation, data.events, kind],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const periodOf = (id: string) => data.periods.find((p) => p.id === id)?.code ?? id;
  const noun = kind === 'settle' ? 'settlements' : kind === 'cost' ? 'cost adjustments' : 'term adjustments';
  const title = kind === 'settle' ? 'Settlement history' : kind === 'cost' ? 'Cost adjustment history' : 'Term adjustment history';
  const showWalk = kind === 'cost' || kind === 'term';
  const recordedTotal = events.reduce((s, e) => s + (matchedRevision(obligation, e)?.amount ?? 0), 0);

  return (
    <div style={{ marginTop: 18 }}>
      <div className="kicker" style={{ marginBottom: 8 }}>{title}</div>
      {kind === 'cost' && events.length > 0 && (
        <p className="muted" style={{ margin: '0 0 10px', fontSize: 12.5, lineHeight: 1.5 }}>
          Recorded is the amount entered, gross of contingency. Provision is that amount after contingency, inflation to settlement, and discounting to the year end. Open a row for the step-by-step formulas.
        </p>
      )}
      {events.length === 0 ? (
        <Empty>No {noun} posted on this obligation yet.</Empty>
      ) : (
        <SheetTable
          rows={events}
          rowKey={(e) => e.id}
          noun={noun}
          leading={showWalk ? {
            width: 56,
            header: '',
            cell: (e) => (
              <button type="button" className="btn btn-ghost btn-sm"
                aria-expanded={openId === e.id}
                aria-label={`${openId === e.id ? 'Hide' : 'Show'} how ${e.id} posted`}
                onClick={() => setOpenId(openId === e.id ? null : e.id)}>
                {openId === e.id ? 'Close' : 'Open'}
              </button>
            ),
          } : undefined}
          expand={showWalk ? (e) => {
            if (openId !== e.id) return false;
            const walk = revisionWalkForEvent(state, unit, obligation, e);
            if (!walk) {
              return <Empty>This posting is not tied to a recorded cost or term adjustment, so there is no chain to show.</Empty>;
            }
            return <WalkPanel walk={walk} posted={e.amount} currencyCode={unit.currency} />;
          } : undefined}
          footer={
            <tr>
              {showWalk ? <td /> : null}
              <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Total</td>
              <td />
              <td />
              {kind === 'cost' ? (
                <td className="num" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>
                  {currency(recordedTotal, unit.currency)}
                </td>
              ) : kind === 'term' ? <td /> : null}
              <td className="num" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>
                {currency(events.reduce((s, e) => s + e.amount, 0), unit.currency)}
              </td>
              <td />
              <td />
              <td />
            </tr>
          }
          columns={[
            { key: 'date', header: 'Date', kind: 'date', value: (e) => e.date, cell: (e) => e.date },
            { key: 'period', header: 'Period', value: (e) => periodOf(e.periodId), cell: (e) => periodOf(e.periodId) },
            { key: 'type', header: 'Type', value: (e) => e.type, cell: (e) => <Tag kind="neutral">{e.type}</Tag> },
            ...(kind === 'cost' ? [{
              key: 'recorded', header: 'Recorded', kind: 'number' as const, thClassName: 'num', tdClassName: 'num',
              value: (e: (typeof events)[number]) => matchedRevision(obligation, e)?.amount ?? '',
              cell: (e: (typeof events)[number]) => {
                const amount = matchedRevision(obligation, e)?.amount;
                return amount == null ? <span className="muted">—</span> : currency(amount, unit.currency);
              },
            }] : kind === 'term' ? [{
              key: 'to', header: 'New settlement', kind: 'date' as const,
              value: (e: (typeof events)[number]) => matchedRevision(obligation, e)?.to ?? '',
              cell: (e: (typeof events)[number]) => matchedRevision(obligation, e)?.to || <span className="muted">—</span>,
            }] : []),
            {
              key: 'amount', header: 'Provision', kind: 'number', thClassName: 'num', tdClassName: 'num',
              value: (e) => e.amount, cell: (e) => currency(e.amount, unit.currency),
            },
            {
              key: 'jv', header: 'JV#',
              value: (e) => journalBatchForEvent(e.id, data.batches)?.number ?? '',
              cell: (e) => <JournalRef eventId={e.id} batches={data.batches} />,
            },
            {
              key: 'reason', header: 'Reason',
              value: (e) => matchedRevision(obligation, e)?.reason ?? e.note ?? '',
              cell: (e) => {
                const adj = matchedRevision(obligation, e);
                return adj?.reason || e.note || <span className="muted">—</span>;
              },
            },
            {
              key: 'evidence', header: 'Evidence',
              value: (e) => matchedRevision(obligation, e)?.evidence ?? '',
              cell: (e) => {
                const adj = matchedRevision(obligation, e);
                return adj?.evidence || <span className="muted">—</span>;
              },
            },
          ]}
        />
      )}
    </div>
  );
}

function rungValue(rung: Rung, currencyCode: string): string {
  if (rung.kind === 'money') return currency(rung.value, currencyCode);
  if (rung.kind === 'rate') return pct(rung.value, 4);
  return years(rung.value);
}

function LadderTable({ rungs, currencyCode }: { rungs: Rung[]; currencyCode: string }) {
  return (
    <div className="scroll-x">
      <table className="table">
        <thead>
          <tr>
            <th>Step</th>
            <th>How</th>
            <th>Formula</th>
            <th className="num">Value</th>
            <th>Basis</th>
          </tr>
        </thead>
        <tbody>
          {rungs.map((rung) => (
            <tr key={rung.key}>
              <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{rung.label}</td>
              <td style={{ maxWidth: 320, fontSize: 12.5 }}>{rung.operator}</td>
              <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, wordBreak: 'break-all' }}>{rung.formula}</td>
              <td className="num">{rungValue(rung, currencyCode)}</td>
              <td>{rung.basis ? <Basis tag={rung.basis} /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WalkPanel({ walk, posted, currencyCode }: { walk: RevisionWalk; posted: number; currencyCode: string }) {
  const mismatch = Math.abs(round2(walk.posted) - round2(posted)) > 0.02;
  return (
    <div style={{ padding: '8px 0 4px' }}>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 12.5, lineHeight: 1.5 }}>
        {walk.kind === 'cost'
          ? 'The recorded amount is gross of contingency. Contingency applies once, then the figure is inflated to settlement and discounted to the year end. That present value is the posted provision.'
          : 'The posted provision is the change in present value from moving the expected settlement date. The whole obligation is repriced; it is not a scaled cost adjustment.'}
        {mismatch ? ' The steps use the curve and assumptions in force now. The posted amount is what was recorded.' : ''}
      </p>
      {walk.kind === 'cost' && walk.rungs.length > 0 && (
        <>
          <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, marginBottom: 10, wordBreak: 'break-all' }}>
            {walk.formula}
            <span className="muted"> = {currency(walk.rungs.at(-1)?.value ?? walk.posted, currencyCode)}</span>
          </div>
          <LadderTable rungs={walk.rungs} currencyCode={currencyCode} />
        </>
      )}
      {(walk.kind === 'term' || walk.rungs.length === 0) && (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Before</th>
                <th>After</th>
                <th>Formula</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Settlement</td>
                <td>{walk.before.settlement}</td>
                <td>{walk.after.settlement}</td>
                <td className="muted">Latest timing revision</td>
              </tr>
              <tr>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Discount term</td>
                <td>{years(walk.before.tD)}</td>
                <td>{years(walk.after.tD)}</td>
                <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>Year end → settlement</td>
              </tr>
              <tr>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Discount rate</td>
                <td>{pct(walk.before.rate, 4)}</td>
                <td>{pct(walk.after.rate, 4)}</td>
                <td className="muted">Looked up on the curve in force</td>
              </tr>
              <tr>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Provision</td>
                <td className="num">{currency(walk.before.pv, currencyCode)}</td>
                <td className="num">{currency(walk.after.pv, currencyCode)}</td>
                <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>{walk.formula}</td>
              </tr>
              <tr>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Posted provision</td>
                <td />
                <td className="num" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{currency(posted, currencyCode)}</td>
                <td style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}>= after − before</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function RevisionForm({
  kind, lockObligationId,
}: {
  kind: 'cost' | 'term';
  lockObligationId?: string;
}) {
  const { state, ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const open = openPeriod(data)!;
  const live = data.obligations.filter((o) => o.status !== 'Scoped out');
  const locked = lockObligationId && live.some((o) => o.id === lockObligationId) ? lockObligationId : undefined;
  const [obligationId, setObligationId] = useState(
    locked ?? (ui.sub && live.some((o) => o.id === ui.sub) ? ui.sub : live[0]?.id ?? ''),
  );
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [date, setDate] = useState(open.ends);
  const [reason, setReason] = useState(REMEASUREMENT_REASONS[0]);
  const [evidence, setEvidence] = useState('');
  const picked = live.find((o) => o.id === obligationId);
  const valid = isValidDate(date) && (kind === 'cost'
    ? Number.isFinite(parseNumber(amount)) && amount !== ''
    : isValidDate(to));

  const submit = () => {
    if (!picked) return;
    const rev: Revision = {
      id: `adj-${Date.now().toString(36)}`,
      kind,
      amount: kind === 'cost' ? parseNumber(amount) : undefined,
      to: kind === 'term' ? to : undefined,
      date, reason, evidence,
      createdBy: ui.userName, createdAt: new Date().toISOString(),
    };
    const probe = postRevision(structuredClone(state), unit.tenantId, unit.id, picked.id, rev, ui.userName);
    if (typeof probe === 'string') {
      apply(`Record ${kind === 'cost' ? 'cost' : 'timing'} revision`, 'refused', probe, () => {});
      return;
    }
    apply(`Record ${kind === 'cost' ? 'cost' : 'timing'} revision`, 'write',
      probe.amount === 0
        ? `Recorded a ${kind} revision on ${picked.ref} in ${probe.periodCode}. The provision did not move.`
        : picked.inProductiveUse === false
          ? `Posted a ${kind} revision on ${picked.ref} in ${probe.periodCode} for ${currency(probe.amount, unit.currency)}. The offset goes to operating expense because the ARO asset is flagged not in productive use.`
          : `Posted a ${kind} revision on ${picked.ref} in ${probe.periodCode} for ${currency(probe.amount, unit.currency)}. The ARO asset moves with the provision.`,
      (s) => { postRevision(s, unit.tenantId, unit.id, picked.id, rev, ui.userName); });
    setAmount('');
    setTo('');
    setEvidence('');
  };

  if (!live.length) return <Empty>There is no in-scope obligation to adjust.</Empty>;

  return (
    <>
      <div className="kicker" style={{ marginBottom: 8 }}>{kind === 'cost' ? 'Cost adjustment' : 'Term adjustment'}</div>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>
        {kind === 'cost'
          ? 'Posts into the open period when you record it — before month-end accretion. Added to direct cost, so contingency then applies to the revised figure. A reduction is a negative amount. History below shows the recorded amount and the provision that posted; open a row for the formulas.'
          : 'Posts into the open period when you record it — before month-end accretion. Once set, this holds the expected settlement date; the register will refuse a direct edit to it.'}
        {picked?.inProductiveUse === false ? ' This ARO asset is flagged not in productive use, so the offset goes to operating expense.' : ''}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {!locked && (
        <div style={{ flex: '1 1 260px' }}>
          <Field label="Obligation">
            <select className="input" value={picked?.id ?? ''} onChange={(e) => setObligationId(e.target.value)}>
              {live.map((o) => <option key={o.id} value={o.id}>{o.ref} — {o.description}</option>)}
            </select>
          </Field>
        </div>
        )}
        {kind === 'cost' ? (
          <div style={{ flex: '0 0 180px' }}>
            <Field label="Amount (gross of contingency)">
              <input className="input num" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onBlur={(e) => {
                  const n = parseNumber(e.target.value);
                  if (Number.isFinite(n)) setAmount(currency(n, unit.currency));
                }} />
            </Field>
          </div>
        ) : (
          <div style={{ flex: '0 0 160px' }}>
            <Field label="New settlement date">
              <input className="input" value={to} onChange={(e) => setTo(maskDateInput(e.target.value))} placeholder="YYYY-MM-DD" />
            </Field>
          </div>
        )}
        <div style={{ flex: '0 0 150px' }}>
          <Field label="Effective date"><input className="input" value={date} onChange={(e) => setDate(maskDateInput(e.target.value))} placeholder="YYYY-MM-DD" /></Field>
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <Field label="Reason">
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
              {REMEASUREMENT_REASONS.map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ flex: '0 0 150px' }}>
          <Field label="Evidence reference"><input className="input" value={evidence} onChange={(e) => setEvidence(e.target.value)} /></Field>
        </div>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={!valid || !picked}>Record {kind === 'cost' ? 'cost' : 'term'} adjustment</button>
      </div>
      {picked && !lockObligationId && <TxEventHistory obligation={picked} kind={kind} />}
    </>
  );
}

export function SettlementForm({
  lockObligationId,
}: {
  lockObligationId?: string;
}) {
  const { state, ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const open = openPeriod(data)!;
  const live = data.obligations.filter((o) => o.status !== 'Scoped out');
  const locked = lockObligationId && live.some((o) => o.id === lockObligationId) ? lockObligationId : undefined;
  const [draft, setDraft] = useState({
    obligationId: locked ?? (ui.sub && live.some((o) => o.id === ui.sub) ? ui.sub : live[0]?.id ?? ''),
    pct: '100',
    actualCost: '',
    settledOn: open.ends,
    disposeAroAsset: true,
    relatedAssetSold: false,
  });
  const target = live.find((o) => o.id === draft.obligationId) ?? live[0];
  const share = Math.min(1, Math.max(0, Number(draft.pct) / 100));
  const actual = parseNumber(draft.actualCost) || 0;
  const preview = (() => {
    if (!target || !open) return null;
    const carried = provisionCarried(data.events, data.periods, target.id, open);
    const books = assetBooks(data.events, data.periods, target, open);
    const life = usefulLifeAsAt(target, data.events, data.periods, unit, open, true);
    const facts: PostingFacts = draft.relatedAssetSold
      ? {
          kind: 'sale',
          remainingUlYears: life.remainingYears,
          expiredUlYears: life.expiredYears,
          totalUlYears: life.totalYears,
          assetNbv: books.nbv,
          assetGross: books.gross,
          assetAccum: books.accum,
          settlement: { share: 1, actualCost: 0, provisionCarried: carried, disposeAsset: true },
        }
      : {
          kind: 'settlement',
          remainingUlYears: life.remainingYears,
          expiredUlYears: life.expiredYears,
          totalUlYears: life.totalYears,
          assetNbv: books.nbv,
          assetGross: books.gross,
          assetAccum: books.accum,
          settlement: {
            share,
            actualCost: actual,
            provisionCarried: carried,
            disposeAsset: draft.disposeAroAsset && share >= 1 - 1e-9,
          },
        };
    const posted = selectPostingCase(facts);
    return { posted, planned: planCaseEntries(posted, facts), carried };
  })();

  if (!live.length) return <Empty>There is no in-scope obligation to settle.</Empty>;

  return (
    <>
      <div className="kicker" style={{ marginBottom: 8 }}>Partial or full settlement</div>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>
        True-up the estimate to actual spend, then consume the provision. A share below 100% is a partial settlement. Full settlement can retire the ARO asset. Sale of the related TCA extinguishes the obligation; proceeds on the TCA are the organisation's PPE journal, not this engine.
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {!locked && (
        <div style={{ flex: '1 1 280px' }}>
          <Field label="Obligation">
            <select className="input" value={target?.id ?? ''} onChange={(e) => setDraft({ ...draft, obligationId: e.target.value })}>
              {live.map((o) => <option key={o.id} value={o.id}>{o.ref} — {o.description}</option>)}
            </select>
          </Field>
        </div>
        )}
        <div style={{ flex: '0 0 130px' }}>
          <Field label="Share settled (%)"><input className="input num" value={draft.pct} onChange={(e) => setDraft({ ...draft, pct: e.target.value })} disabled={draft.relatedAssetSold} /></Field>
        </div>
        {!draft.relatedAssetSold && (
          <div style={{ flex: '0 0 150px' }}>
            <Field label="Actual cost"><input className="input num" value={draft.actualCost}
              onChange={(e) => setDraft({ ...draft, actualCost: e.target.value })}
              onBlur={(e) => {
                const n = parseNumber(e.target.value);
                if (Number.isFinite(n)) setDraft((d) => ({ ...d, actualCost: currency(n, unit.currency) }));
              }} /></Field>
          </div>
        )}
        <div style={{ flex: '0 0 150px' }}>
          <Field label="Settled on"><input className="input" value={draft.settledOn} onChange={(e) => setDraft({ ...draft, settledOn: maskDateInput(e.target.value) })} placeholder="YYYY-MM-DD" /></Field>
        </div>
        <div style={{ flex: '0 0 180px' }}>
          <Field label="Related TCA sold">
            <select className="input" value={draft.relatedAssetSold ? 'Yes' : 'No'}
              onChange={(e) => setDraft({ ...draft, relatedAssetSold: e.target.value === 'Yes', disposeAroAsset: e.target.value === 'Yes' ? true : draft.disposeAroAsset })}>
              <option>No</option>
              <option>Yes</option>
            </select>
          </Field>
        </div>
        {!draft.relatedAssetSold && Number(draft.pct) >= 100 && (
          <div style={{ flex: '0 0 200px' }}>
            <Field label="Retire the ARO asset">
              <select className="input" value={draft.disposeAroAsset ? 'Yes' : 'No'}
                onChange={(e) => setDraft({ ...draft, disposeAroAsset: e.target.value === 'Yes' })}>
                <option>Yes</option>
                <option>No</option>
              </select>
            </Field>
          </div>
        )}
        <button className="btn btn-primary btn-sm"
          disabled={!target || !isValidDate(draft.settledOn) || (!draft.relatedAssetSold && !draft.actualCost)}
          onClick={() => {
            if (!target) return;
            const input = {
              obligationId: target.id,
              pct: share,
              actualCost: actual,
              settledOn: draft.settledOn,
              disposeAroAsset: draft.disposeAroAsset,
              relatedAssetSold: draft.relatedAssetSold,
            };
            const probe = postSettlement(structuredClone(state), unit.tenantId, unit.id, input);
            if (typeof probe === 'string') {
              apply('Record settlement', 'refused', probe, () => {});
              return;
            }
            apply('Record settlement', 'write',
              `Recorded a ${input.relatedAssetSold ? 'sale' : input.pct >= 1 ? 'full' : 'partial'} settlement of ${target.ref} in ${probe.periodCode} (${probe.caseId}).`,
              (s) => { postSettlement(s, unit.tenantId, unit.id, input); });
          }}>Record settlement</button>
      </div>
      {preview && target && (actual > 0 || draft.relatedAssetSold) && (
        <div className="note-panel" style={{ marginTop: 12 }}>
          {preview.posted.label}. Provision carried {currency(preview.carried, unit.currency)}.
          {preview.planned.map((p) => ` ${p.eventType} ${currency(p.amount, unit.currency)}.`).join('')}
          {' '}Map debit and credit roles on Posting rules; assign this organisation's GLs on the posting scenario.
        </div>
      )}

      {target && !lockObligationId && <TxEventHistory obligation={target} kind="settle" />}
    </>
  );
}

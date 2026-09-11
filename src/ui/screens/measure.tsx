/**
 * Measure phase — obligation expand on the register, layers and framework,
 * event ledger. Cost, term and settlement posting can run on the expanded
 * register row; Transactions remains the standalone posting step.
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, useUnit, useUnitData } from '../../core/store';
import { useDerived } from '../../core/useDerived';
import { canEdit, canPost } from '../../core/authority';
import { JournalBatch, Obligation, ReportingUnit } from '../../core/types';
import { LEDGER_EVENT_TYPES } from '../../engine/rollforward';
import {
  curveOptionLabel, curveRateDetail, curveSourcePoints, curveTermOf, isPublishedCurve,
  sortedPoints, type Curve, type TermConvention,
} from '../../engine/curve';
import { frameworkPolicy, unitDiscounts } from '../../engine/framework';
import { openPeriod, remainingDiscountTerm } from '../../core/periodClose';
import { unitCurve } from '../../core/measure';
import { journalBatchForEvent, registerBooks } from '../../core/registerBooks';
import { assetCalcLines, calcLineDrillable, calcLineSource, obligationCalcLines, type CalcDetailLine } from '../../core/calcDetails';
import { accretionSchedule, amortizationSchedule, type ScheduleRow } from '../../core/schedules';
import { applyUlAlignment, dismissUlAlignment, formatUl, ulAlignmentOf, ulAlignmentPending, usefulLifeAsAt } from '../../core/usefulLife';
import { Block, Empty, Field, JournalRef, currency, num, pct, SheetTable, Tag } from '../components';
import { groupToneClass } from '../groupTone';
import { RevisionForm, SettlementForm, TxEventHistory } from './transactions';
import type { ObligationEvent } from '../../engine/rollforward';
import type { Period } from '../../core/periods';

type ExpandTab = 'accretion' | 'curve' | 'obligation-calc' | 'amortization' | 'asset-calc' | 'tx-cost' | 'tx-term' | 'tx-settle';

const OBLIGATION_TABS: { id: ExpandTab; label: string }[] = [
  { id: 'accretion', label: 'Monthly accretion schedule' },
  { id: 'curve', label: 'Discount curve' },
  { id: 'obligation-calc', label: 'Obligation calculation details' },
];

const ASSET_TABS: { id: ExpandTab; label: string }[] = [
  { id: 'amortization', label: 'Monthly amortization schedule' },
  { id: 'asset-calc', label: 'ARO asset calculation details' },
];

const TX_TABS: { id: ExpandTab; label: string }[] = [
  { id: 'tx-cost', label: 'Cost adjustment' },
  { id: 'tx-term', label: 'Term adjustment' },
  { id: 'tx-settle', label: 'Settlement' },
];

/** Expand panel under a register row. */
export function ObligationExpand({
  obligation, fiscalYear, asAtPeriodId,
}: {
  obligation: Obligation;
  fiscalYear: number;
  asAtPeriodId?: string;
}) {
  const { state, ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const editable = canEdit(ui.role);
  const open = openPeriod(data);
  const asAt = (asAtPeriodId ? data.periods.find((p) => p.id === asAtPeriodId) : undefined)
    ?? data.periods.filter((p) => p.fiscalYear === fiscalYear).sort((a, b) => a.no - b.no).at(-1)
    ?? open ?? data.periods[data.periods.length - 1];
  const derived = useDerived(asAt?.ends)!;
  const [tab, setTab] = useState<ExpandTab>('accretion');

  const picked = data.obligations.find((o) => o.id === obligation.id) ?? obligation;
  const d = derived.byId.get(picked.id);
  const books = asAt
    ? registerBooks(picked, data.events, data.periods, data.batches, asAt)
    : null;
  const life = usefulLifeAsAt(picked, data.events, data.periods, unit, asAt);
  const ulFlag = ulAlignmentOf(picked);
  const curve = unitCurve(state, unit);
  const accretion = useMemo(
    () => accretionSchedule(picked, data.events, data.periods, data.batches, unit, curve, fiscalYear),
    [picked, data.events, data.periods, data.batches, unit, curve, fiscalYear],
  );
  const amortization = useMemo(
    () => amortizationSchedule(picked, data.events, data.periods, data.batches, unit, fiscalYear),
    [picked, data.events, data.periods, data.batches, unit, fiscalYear],
  );

  const reviewUl = (approve: boolean) => {
    const next = approve ? applyUlAlignment(picked, ui.userName) : dismissUlAlignment(picked, ui.userName);
    apply(approve ? 'Approve useful-life alignment' : 'Dismiss useful-life alignment', 'write',
      approve
        ? `Approved ARO-asset useful life on ${picked.ref}: total UL is now ${formatUl(next.totalUl as number, unit.calendarType)} so remaining life lines up with settlement ${ulFlag?.settlementDate}.`
        : `Dismissed the useful-life alignment on ${picked.ref}. Remaining UL is unchanged.`,
      (s) => {
        const list = s.data[unit.id].obligations;
        const i = list.findIndex((x) => x.id === picked.id);
        if (i >= 0) list[i] = next;
      });
  };

  return (
    <div className="register-panel">
      <div className="register-tab-groups register-tab-groups-inline">
        <div className="register-tab-group g-tone g-obligation">
          <div className="kicker">Obligation</div>
          <div className="register-tabs">
            {OBLIGATION_TABS.map((t) => (
              <button key={t.id} type="button" className={`register-tab${tab === t.id ? ' is-on' : ''}`}
                onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div className="register-tab-group g-tone g-aro-asset">
          <div className="kicker">ARO asset</div>
          <div className="register-tabs">
            {ASSET_TABS.map((t) => (
              <button key={t.id} type="button" className={`register-tab${tab === t.id ? ' is-on' : ''}`}
                onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div className="register-tab-group g-tone g-existing">
          <div className="kicker">Transactions</div>
          <div className="register-tabs">
            {TX_TABS.map((t) => (
              <button key={t.id} type="button" className={`register-tab${tab === t.id ? ' is-on' : ''}`}
                onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
        </div>
      </div>

      {ulAlignmentPending(picked) && ulFlag && (
        <div className="note-panel" style={{ marginBottom: 14 }}>
          <strong>Useful life review. </strong>
          The term adjustment moved settlement to {ulFlag.settlementDate}. Remaining UL is {formatUl(ulFlag.remainingUl, unit.calendarType)} against a settlement term of {formatUl(ulFlag.settlementTerm, unit.calendarType)}. Proposed total UL {formatUl(ulFlag.proposedTotalUl, unit.calendarType)} so remaining life is {formatUl(ulFlag.proposedRemainingUl, unit.calendarType)}. The ARO asset is not changed until a reviewer or partner approves.
          {canPost(ui.role) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => reviewUl(true)}>Approve UL alignment</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => reviewUl(false)}>Keep current UL</button>
            </div>
          )}
        </div>
      )}

      {tab === 'accretion' && (
        <ScheduleTable
          rows={accretion}
          currency={unit.currency}
          chargeLabel="Accretion"
          openingLabel="Opening provision"
          extra="rate"
          calendar={unit.calendarType}
          note="Unwinding of the discount for each period in this fiscal year. Opening is the prior close. In-period activity is new ARO, revisions, settlements and FX before accretion. Allocated months are on the event ledger. Later months are scheduled at the rate in force × the period year fraction, compounding on the prior closing. Month-end posting writes the allocated row."
        />
      )}

      {tab === 'curve' && (
        <CurveLookup obligation={picked} unit={unit} curve={curve} />
      )}

      {tab === 'amortization' && (
        <ScheduleTable
          rows={amortization}
          currency={unit.currency}
          chargeLabel="Amortization"
          openingLabel="Opening ARO asset"
          extra="ul"
          calendar={unit.calendarType}
          note="Period charge on the retirement-cost asset: carrying amount × year fraction / remaining useful life as at the start of each period. Remaining UL falls as months are posted. Opening is the prior NBV. In-period activity is additions and revisions."
        />
      )}

      {tab === 'obligation-calc' && (
        books
          ? (
            <DetailTable
              kicker="Obligation"
              title="Baseline and in-year movement"
              note="Initial cost is the estimate as recorded. Cost as at the reporting date escalates that estimate to this period end, not this year's year end. Opening provision is the conversion measurement. Terms are from the reporting date to the original and adjusted settlement dates. Open a movement row to see the posted events that make up the total, including the posting JV#. Post a cost or term adjustment or a settlement from Transactions on this row."
              rows={obligationCalcLines(picked, books, d, unit, asAt.ends)}
              currency={unit.currency}
              calendar={unit.calendarType}
              side="obligation"
              obligation={picked}
              books={books}
              events={data.events}
              periods={data.periods}
              batches={data.batches}
              asAt={asAt}
            />
          )
          : <Empty>Generate a fiscal calendar on Periods & close to see this calculation.</Empty>
      )}

      {tab === 'asset-calc' && (
        books
          ? (
            <DetailTable
              kicker="ARO asset"
              title="Useful life and in-year movement"
              note="Useful life is shown in years and months. Opening, additions, amortization and closing are the same ARO asset columns as the register as at the selected period. Open a movement row to see the posted events that make up the total, including the posting JV#. Additions are the capitalized new ARO and revisions. Amortization appears after month-end allocation."
              rows={assetCalcLines(picked, books, life)}
              currency={unit.currency}
              calendar={unit.calendarType}
              side="asset"
              obligation={picked}
              books={books}
              events={data.events}
              periods={data.periods}
              batches={data.batches}
              asAt={asAt}
            />
          )
          : <Empty>Generate a fiscal calendar on Periods & close to see this calculation.</Empty>
      )}

      {(tab === 'tx-cost' || tab === 'tx-term' || tab === 'tx-settle') && (
        <>
          {!open
            ? <Empty>Open a period on Periods & close before posting in-year transactions.</Empty>
            : !editable
              ? <Empty>This role cannot post in-year transactions.</Empty>
              : tab === 'tx-settle'
                ? <SettlementForm lockObligationId={picked.id} />
                : <RevisionForm kind={tab === 'tx-cost' ? 'cost' : 'term'} lockObligationId={picked.id} />}
          <TxEventHistory
            obligation={picked}
            kind={tab === 'tx-settle' ? 'settle' : tab === 'tx-cost' ? 'cost' : 'term'}
          />
        </>
      )}
    </div>
  );
}

function DetailTable({
  kicker, title, note, rows, currency: code, calendar,
  side, obligation, books, events, periods, batches, asAt,
}: {
  kicker: string;
  title: string;
  note: string;
  rows: CalcDetailLine[];
  currency: string;
  calendar: string;
  side: 'obligation' | 'asset';
  obligation: Obligation;
  books: NonNullable<ReturnType<typeof registerBooks>>;
  events: ObligationEvent[];
  periods: Period[];
  batches: JournalBatch[];
  asAt: Period;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <Block kicker={kicker} title={title} note={note}>
      <SheetTable
        rows={rows}
        rowKey={(l) => l.key}
        noun="lines"
        rowClassName={(l) => groupToneClass(l.group)}
        leading={{
          width: 56,
          header: '',
          cell: (l) => (
            <button type="button" className="btn btn-ghost btn-sm"
              aria-expanded={openKey === l.key}
              aria-label={`${openKey === l.key ? 'Hide' : 'Show'} what makes up ${l.label}`}
              onClick={() => setOpenKey(openKey === l.key ? null : l.key)}>
              {openKey === l.key ? 'Close' : 'Open'}
            </button>
          ),
        }}
        expand={(l) => {
          if (openKey !== l.key || !calcLineDrillable(l)) return false;
          if (l.key === 'initialCost') {
            if (!obligation.lines.length) {
              return <Empty>No cost-estimate lines on this obligation. The amount is the recorded estimate.</Empty>;
            }
            return (
              <SheetTable
                rows={obligation.lines}
                rowKey={(line) => line.id}
                noun="estimate lines"
                footer={
                  <tr>
                    <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Total</td>
                    <td />
                    <td />
                    <td className="num" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>
                      {currency(obligation.lines.reduce((s, line) => s + line.qty * line.rate, 0), code)}
                    </td>
                  </tr>
                }
                columns={[
                  { key: 'desc', header: 'Line', value: (line) => line.description, cell: (line) => line.description },
                  { key: 'qty', header: 'Qty', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (line) => line.qty, cell: (line) => num(line.qty) },
                  { key: 'rate', header: 'Rate', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (line) => line.rate, cell: (line) => currency(line.rate, code) },
                  { key: 'amount', header: 'Amount', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (line) => line.qty * line.rate, cell: (line) => currency(line.qty * line.rate, code) },
                ]}
              />
            );
          }
          const source = calcLineSource(l.key, side, obligation, books, events, periods, asAt);
          if (!source.events.length) {
            return <Empty>{source.emptyNote ?? 'No posted events on this line through the selected period.'}</Empty>;
          }
          const periodOf = (id: string) => periods.find((p) => p.id === id)?.code ?? id;
          return (
            <>
              {source.note ? <p className="muted" style={{ margin: '0 0 10px', fontSize: 12.5 }}>{source.note}</p> : null}
              <SheetTable
                rows={source.events}
                rowKey={(e) => e.id}
                noun="events"
                footer={
                  <tr>
                    <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Total</td>
                    <td />
                    <td />
                    <td className="num" style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>
                      {currency(source.events.reduce((s, e) => s + e.amount, 0), code)}
                    </td>
                    <td />
                    <td />
                  </tr>
                }
                columns={[
                  { key: 'date', header: 'Date', kind: 'date', value: (e) => e.date, cell: (e) => e.date },
                  { key: 'period', header: 'Period', value: (e) => periodOf(e.periodId), cell: (e) => periodOf(e.periodId) },
                  { key: 'type', header: 'Type', value: (e) => e.type, cell: (e) => <Tag kind="neutral">{e.type}</Tag> },
                  {
                    key: 'amount', header: 'Amount', kind: 'number', thClassName: 'num', tdClassName: 'num',
                    value: (e) => e.amount, cell: (e) => currency(e.amount, code),
                  },
                  {
                    key: 'jv', header: 'JV#',
                    value: (e) => journalBatchForEvent(e.id, batches)?.number ?? '',
                    cell: (e) => <JournalRef eventId={e.id} batches={batches} />,
                  },
                  { key: 'note', header: 'Note', value: (e) => e.note ?? '', cell: (e) => e.note || <span className="muted">—</span> },
                ]}
              />
            </>
          );
        }}
        columns={[
          {
            key: 'line', header: 'Line', value: (l) => l.label,
            tdStyle: { fontFamily: 'var(--font-heading)' },
            cell: (l) => (
              <span>
                {l.label}
                {l.detail ? <span className="muted" style={{ fontWeight: 400 }}> · {l.detail}</span> : null}
              </span>
            ),
          },
          { key: 'group', header: 'Group', value: (l) => l.group, tdClassName: 'g-label', cell: (l) => l.group },
          {
            key: 'amount', header: 'Amount', kind: 'number', thClassName: 'num',
            tdClassName: (l) => l.group === 'Closing' || l.group === 'Opening' ? 'num derived' : 'num',
            value: (l) => l.amount,
            cell: (l) => l.kind === 'years'
              ? formatUl(l.amount, calendar)
              : currency(l.amount, code),
          },
        ]}
      />
    </Block>
  );
}

function ScheduleTable({
  rows, currency: code, chargeLabel, openingLabel, note, extra, calendar,
}: {
  rows: ScheduleRow[];
  currency: string;
  chargeLabel: string;
  openingLabel: string;
  note: string;
  extra: 'rate' | 'ul';
  calendar?: string;
}) {
  if (rows.length === 0) {
    return <Empty>Generate a fiscal calendar on Periods & close to see this schedule.</Empty>;
  }
  return (
    <Block kicker="Schedule" title={`${rows[0] ? rows[0].code.replace(/ P\d+$/, '') : ''} ${chargeLabel.toLowerCase()}`}
      note={note}>
      <SheetTable
        rows={rows}
        rowKey={(r) => r.periodId}
        noun="periods"
        footer={
          <tr>
            <td className={groupToneClass('lead')} style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Year</td>
            <td className={groupToneClass('opening', true)} />
            <td className={groupToneClass('activity', true, 'num')}>{currency(rows.reduce((s, r) => s + r.activity, 0), code)}</td>
            <td className={groupToneClass('activity', false, 'num')} />
            <td className={groupToneClass('activity', false, 'num')} />
            <td className={groupToneClass('activity', false, 'num derived')}>{currency(rows.reduce((s, r) => s + r.charge, 0), code)}</td>
            <td className={groupToneClass('closing', true, 'num')} />
            <td />
            <td />
          </tr>
        }
        columns={[
          { key: 'period', header: 'Period', value: (r) => r.code, cell: (r) => r.code, thClassName: groupToneClass('lead'), tdClassName: groupToneClass('lead') },
          { key: 'opening', header: openingLabel, kind: 'number', thClassName: groupToneClass('opening', true, 'num'), tdClassName: groupToneClass('opening', true, 'num'), value: (r) => r.opening, cell: (r) => currency(r.opening, code) },
          { key: 'activity', header: 'In-period activity', kind: 'number', thClassName: groupToneClass('activity', true, 'num'), tdClassName: groupToneClass('activity', true, 'num'), value: (r) => r.activity, cell: (r) => currency(r.activity, code) },
          extra === 'rate'
            ? { key: 'rate', header: 'Rate', kind: 'number' as const, thClassName: groupToneClass('activity', false, 'num'), tdClassName: groupToneClass('activity', false, 'num'), value: (r: ScheduleRow) => r.rate, cell: (r: ScheduleRow) => pct(r.rate, 4) }
            : { key: 'ul', header: 'Remaining UL', kind: 'number' as const, thClassName: groupToneClass('activity', false, 'num'), tdClassName: groupToneClass('activity', false, 'num'), value: (r: ScheduleRow) => r.remainingUl, cell: (r: ScheduleRow) => formatUl(r.remainingUl, calendar) },
          { key: 'yf', header: 'Year fraction', kind: 'number', thClassName: groupToneClass('activity', false, 'num'), tdClassName: groupToneClass('activity', false, 'num'), value: (r) => r.yearFraction, cell: (r) => num(r.yearFraction, 4) },
          { key: 'charge', header: chargeLabel, kind: 'number', thClassName: groupToneClass('activity', false, 'num derived'), tdClassName: groupToneClass('activity', false, 'num derived'), value: (r) => r.charge, cell: (r) => currency(r.charge, code) },
          { key: 'closing', header: 'Closing', kind: 'number', thClassName: groupToneClass('closing', true, 'num'), tdClassName: groupToneClass('closing', true, 'num'), value: (r) => r.closing, cell: (r) => currency(r.closing, code) },
          { key: 'status', header: 'Status', value: (r) => r.status, cell: (r) => (
            <Tag kind={r.status === 'Posted' ? 'accent' : r.status === 'Allocated' ? 'warn' : 'neutral'}>{r.status}</Tag>
          ) },
          { key: 'periodStatus', header: 'Period', value: (r) => r.periodStatus, cell: (r) => r.periodStatus },
        ]}
      />
    </Block>
  );
}

function basisWords(basis: string): string {
  switch (basis) {
    case 'exact': return 'an exact published tenor';
    case 'step': return 'the first published tenor at or beyond the term';
    case 'linear': return 'linear interpolation between the bracketing tenors';
    case 'below-first': return 'the first published tenor, because the term is shorter than the curve';
    case 'flat-last': return 'the last published tenor, held flat past the curve';
    case 'log-linear': return 'log-linear extrapolation past the last tenor';
    case 'empty-curve': return 'no published points';
    default: return basis;
  }
}

function CurveLookup({
  obligation, unit, curve,
}: {
  obligation: Obligation;
  unit: ReportingUnit;
  curve: Curve | undefined;
}) {
  const discounts = unitDiscounts(frameworkPolicy(unit.frameworkId), unit.discount);
  const published = isPublishedCurve(curve);
  const tD = remainingDiscountTerm(obligation, unit);
  const convention = unit.termConvention as TermConvention;
  const active = Boolean(curve && published && tD > 0);
  const lookup = active && curve ? curveTermOf(curve, tD, convention) : null;
  const detail = curve && lookup ? curveRateDetail(curve, lookup.term) : null;
  const sources = curve && lookup ? curveSourcePoints(curve, lookup.term) : [];
  const sourceByTerm = new Map(sources.map((s) => [s.point.term, s.role]));
  const points = curve ? sortedPoints(curve) : [];
  const boxRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const row = box.querySelector('tr.is-curve-source') as HTMLElement | null;
    if (!row) return;
    const rowTop = row.getBoundingClientRect().top;
    const boxTop = box.getBoundingClientRect().top;
    box.scrollTop += rowTop - boxTop - box.clientHeight / 2 + row.offsetHeight / 2;
  }, [obligation.id, lookup?.term, curve?.id]);

  if (!discounts) {
    return (
      <Block kicker="Discount curve" title="Not discounted"
        note="This reporting unit does not discount, so accretion does not read a curve.">
        <Empty>No discount rate is looked up for this obligation.</Empty>
      </Block>
    );
  }

  if (!curve || !published) {
    return (
      <Block kicker="Discount curve" title="No published table"
        note="Accretion reads the curve assigned on Unit settings. Publish points on the curve library before month-end posting.">
        <Empty>Assign a published discount curve on Unit settings to see the tenor this rate comes from.</Empty>
      </Block>
    );
  }

  const sourceTerms = sources.filter((s) => s.role === 'source').map((s) => s.point.term);
  const tenorList = sourceTerms.map((t) => `${num(t)}-year`).join(' and ');
  const past = lookup && detail && (lookup.beyond || detail.beyond) ? '; past the last published point' : '';
  const note = !lookup || !detail
    ? `${curveOptionLabel(curve)}. No remaining discount term, so accretion does not read a tenor.`
    : `${curveOptionLabel(curve)}. Remaining term ${num(tD, 4)} years, read at ${num(lookup.term, 4)} years (${convention}). Rate ${pct(detail.rate, 4)} from ${tenorList} (${basisWords(detail.basis)}${past}). The highlighted row is the published tenor the accretion schedule uses.`;

  return (
    <Block kicker="Discount curve" title={curve.name} note={note}>
      <div ref={boxRef} className="curve-lookup-scroll">
        <SheetTable
          rows={points}
          rowKey={(p) => String(p.term)}
          noun="tenors"
          rowClassName={(p) => {
            const role = sourceByTerm.get(p.term);
            if (role === 'source') return 'is-curve-source';
            if (role === 'bracket') return 'is-curve-bracket';
            return undefined;
          }}
          columns={[
            { key: 'term', header: 'Term (yrs)', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (p) => p.term, cell: (p) => num(p.term) },
            { key: 'rate', header: 'Rate', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (p) => p.rate, cell: (p) => pct(p.rate, 4) },
            {
              key: 'used', header: '', value: (p) => sourceByTerm.get(p.term) ?? '',
              cell: (p) => {
                const role = sourceByTerm.get(p.term);
                if (role === 'source') return <Tag kind="accent">This rate</Tag>;
                if (role === 'bracket') return <Tag kind="warn">Slope</Tag>;
                return null;
              },
            },
          ]}
        />
      </div>
    </Block>
  );
}

/* Layers and framework */
export function Layers() {
  const { state, ui, apply } = useStore();
  const unit = useUnit()!;
  const derived = useDerived()!;
  const fws = state.settings[unit.tenantId].frameworks;
  const fw = fws.find((f) => f.id === unit.frameworkId) ?? fws[0];
  const editable = canEdit(ui.role);
  const policy = fw.id === 'usgaap' || fw.id === 'aspe';
  const layerRows = derived.rows.flatMap((d) => d.layers.map((l) => ({
    id: l.id, ref: d.ref, aroseOn: l.aroseOn, direct: l.direct, rate: l.rate, method: l.method, obligationPv: d.pv,
  })));

  return (
    <>
      <Block kicker="Framework in force" title={fw.name}
        note="The framework and (for PSAS) whether this unit discounts are set on Unit settings. This screen shows how that assignment shapes the measurement. Changing the framework there remeasures the open unit on the next save â€” US GAAP and ASPE lock rates onto stored layers; IFRS and PSAS keep a single current rate.">
        {policy && (
          <div style={{ maxWidth: 420, marginBottom: 14 }}>
            <Field label="Downward revision order" help="When a cost reduction arrives, which stored layers it consumes. LIFO is the usual policy.">
              <select className="input" value={unit.layerPolicy ?? 'LIFO'} disabled={!editable}
                onChange={(e) => apply('Change layer policy', 'admin',
                  `Downward revisions on ${unit.entity} now consume layers ${e.target.value}.`,
                  (s) => { s.units[unit.tenantId].find((u) => u.id === unit.id)!.layerPolicy = e.target.value as 'LIFO' | 'FIFO' | 'Pro-rata'; })}>
                <option>LIFO</option>
                <option>FIFO</option>
                <option>Pro-rata</option>
              </select>
            </Field>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 10 }}>
          {Object.entries(fw.axes).map(([k, v]) => (
            <div key={k} style={{ background: 'var(--color-surface)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div className="kicker">{k}</div>
              <div style={{ fontSize: 12, lineHeight: 1.45 }}>{v}</div>
            </div>
          ))}
        </div>
      </Block>

      <Block kicker="Layers" title={policy ? 'Stored, rate locked per layer' : derived.rows.some((d) => !d.discounted) ? 'Undiscounted â€” no discounting applied' : 'Derived, single current rate'}
        note={policy
          ? 'Each upward cost revision is a new layer carrying the rate looked up on the day it arose. That rate stays on the layer. A later closing curve does not remeasure it. A downward revision consumes layers in the order above.'
          : derived.rows.some((d) => !d.discounted)
            ? 'This reporting unit is measured undiscounted under PS 3280. The provision is the cost at current prices. Layers are a presentation of the obligation, not separate measurement units.'
            : 'A single current rate is applied to the whole obligation, so layers here are a presentation of when the obligation arose rather than separate measurement units.'}>
        <SheetTable
          rows={layerRows}
          rowKey={(r) => r.id}
          noun="layers"
          columns={[
            { key: 'obligation', header: 'Obligation', value: (r) => r.ref, cell: (r) => r.ref },
            { key: 'arose', header: 'Arose', kind: 'date', value: (r) => r.aroseOn, cell: (r) => r.aroseOn },
            { key: 'direct', header: 'Cost increment', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => r.direct, cell: (r) => currency(r.direct, unit.currency) },
            { key: 'rate', header: 'Rate', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (r) => r.rate, cell: (r) => pct(r.rate, 4) },
            { key: 'basis', header: 'Basis', value: (r) => r.method, cell: (r) => (
              <Tag kind={r.method === 'interest-method' ? 'accent' : 'neutral'}>
                {r.method === 'interest-method' ? 'locked layer rate' : r.method === 'undiscounted' ? 'undiscounted' : 'single current rate'}
              </Tag>
            ) },
          ]}
        />
      </Block>
    </>
  );
}

/* Event ledger */

export function Ledger() {
  const unit = useUnit()!;
  const data = useUnitData()!;
  const [type, setType] = useState('all');
  const events = data.events.filter((e) => type === 'all' || e.type === type);
  const byPeriod = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data.events) {
      if (e.type === 'depreciation' || e.type === 'asset-retirement') continue;
      m.set(e.periodId, (m.get(e.periodId) ?? 0) + e.amount);
    }
    return m;
  }, [data.events]);

  return (
    <>
      <Block kicker="Event ledger" title={`${data.events.length} events`}
        note="Append-only. There is no update and no delete. An event derived by diffing a cumulative snapshot is marked as derived, which distinguishes an inferred movement from an evidenced one."
        actions={
          <select className="input" style={{ width: 160 }} value={type} onChange={(e) => setType(e.target.value)}>
            {['all', ...LEDGER_EVENT_TYPES].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        }>
        {events.length === 0 ? (
          <Empty>No events yet. Opening events are written when the opening register is loaded. New ARO, cost and term adjustments post when you record them. Accretion and amortization are allocated separately at month end, after those postings.</Empty>
        ) : (
          <SheetTable
            rows={events.slice(0, 200)}
            rowKey={(e) => e.id}
            noun="events"
            columns={[
              { key: 'period', header: 'Period', value: (e) => data.periods.find((p) => p.id === e.periodId)?.code ?? e.periodId, cell: (e) => data.periods.find((p) => p.id === e.periodId)?.code ?? e.periodId },
              { key: 'obligation', header: 'Obligation', value: (e) => data.obligations.find((o) => o.id === e.obligationId)?.ref ?? 'â€”', cell: (e) => data.obligations.find((o) => o.id === e.obligationId)?.ref ?? 'â€”' },
              { key: 'type', header: 'Type', value: (e) => e.type, cell: (e) => <Tag kind="neutral">{e.type}</Tag> },
              { key: 'amount', header: 'Amount', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (e) => e.amount, cell: (e) => currency(e.amount, unit.currency) },
              { key: 'provenance', header: 'Provenance', tdClassName: 'muted', tdStyle: { whiteSpace: 'normal' },
                value: (e) => [e.derived ? 'derived' : '', e.note ?? e.sourceRowRef ?? 'â€”'].filter(Boolean).join(' '),
                cell: (e) => <>{e.derived ? <Tag kind="warn">derived</Tag> : null} {e.note ?? e.sourceRowRef ?? 'â€”'}</> },
            ]}
          />
        )}
      </Block>

      <Block kicker="By period" title="What moved, period by period">
        <SheetTable
          rows={data.periods}
          rowKey={(p) => p.id}
          noun="periods"
          columns={[
            { key: 'period', header: 'Period', value: (p) => p.code, cell: (p) => p.code },
            { key: 'status', header: 'Status', value: (p) => p.status, cell: (p) => p.status },
            { key: 'movement', header: 'Net movement', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (p) => byPeriod.get(p.id) ?? 0, cell: (p) => currency(byPeriod.get(p.id) ?? 0, unit.currency) },
          ]}
        />
      </Block>
    </>
  );
}

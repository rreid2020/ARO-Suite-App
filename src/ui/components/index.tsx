/**
 * Recurring components — SCREENS.md, "Layout pattern".
 *
 * The prerequisites panel, the return banner, basis tags and field help.
 */

import React, { useState } from 'react';
import { num, parseNumber } from '../../core/format';
import {
  evaluateNewAroLifeDraft, expiredUlFromAcquisition, tcaUlText, type NewObligationUlIssue,
} from '../../core/usefulLife';
import { TERM_CONVENTIONS } from '../../engine/curve';
import { DAY_COUNTS, maskDateInput } from '../../engine/dates';

export { SheetTable, SheetTh, SheetStatus, useSheet } from './Sheet';
export type { SheetColumn } from './Sheet';
export { AccountPicker } from './AccountPicker';
export { Walkthrough } from './Walkthrough';
export {
  NewAroEstimate,
  DEFAULT_ESTIMATE_COLUMNS,
  emptyEstimateLine,
  estimateHasCost,
  estimatePayload,
} from './NewAroEstimate';
export type { EstimateLineDraft, EstimateMode } from './NewAroEstimate';
export { currency, money, money2, num, parseNumber, pct, years } from '../../core/format';

/* ── layout ─────────────────────────────────────────────────────────────── */

export function Block({
  title, kicker, actions, children, note, className,
}: {
  title?: string; kicker?: string; actions?: React.ReactNode;
  children: React.ReactNode; note?: string; className?: string;
}) {
  return (
    <section className={['block', className].filter(Boolean).join(' ')}>
      {(title || actions || kicker) && (
        <header style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ marginRight: 'auto', minWidth: 0 }}>
            {kicker && <div className="kicker">{kicker}</div>}
            {title && <div className="block-title">{title}</div>}
          </div>
          {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
        </header>
      )}
      {note && <div className="note-panel" style={{ marginBottom: 12 }}>{note}</div>}
      {children}
    </section>
  );
}

export function Stats({ items }: { items: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 14 }}>
      {items.map((s) => (
        <div key={s.label} style={{ background: 'var(--color-surface)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div className="kicker">{s.label}</div>
          <div style={{
            fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18,
            fontVariantNumeric: 'tabular-nums',
            color: s.tone ? `var(--${s.tone})` : undefined,
          }}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '20px 0', fontSize: 12.5, lineHeight: 1.55, textWrap: 'pretty' }} className="muted">
      {children}
    </div>
  );
}

/* ── basis tags ─────────────────────────────────────────────────────────── */

/** SCREENS.md — on every monetary figure. */
export function Basis({ tag }: { tag: string }) {
  if (!tag) return null;
  return <span className="tag tag-accent" style={{ marginLeft: 6 }}>{tag}</span>;
}

export function Tag({ kind = 'neutral', children }: { kind?: 'accent' | 'neutral' | 'warn' | 'bad'; children: React.ReactNode }) {
  return <span className={`tag tag-${kind}`}>{children}</span>;
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  const bg = tone === 'idle' ? 'var(--color-neutral-400)' : `var(--${tone})`;
  return <span className="dot" style={{ background: bg }} />;
}

/* ── field help ─────────────────────────────────────────────────────────── */

/**
 * "field help (a ? beside each label — hover for a tooltip, click to pin the
 * explanation under the input)" — SCREENS.md.
 */
export function Field({
  label, help, children, hint, hintTone,
}: { label: string; help?: string; children: React.ReactNode; hint?: string; hintTone?: 'ok' | 'warn' | 'bad' }) {
  const [pinned, setPinned] = useState(false);
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        {help && (
          <button
            type="button"
            onClick={() => setPinned((p) => !p)}
            title={help}
            aria-label="What is this field?"
            aria-expanded={pinned}
            style={{
              flex: 'none', width: 16, height: 16, padding: 0, lineHeight: 1,
              border: '1px solid var(--color-divider)', background: 'transparent',
              color: 'color-mix(in srgb,var(--color-text) 58%,transparent)',
              fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 10, cursor: 'pointer',
            }}
          >?</button>
        )}
      </label>
      {children}
      {hint && (
        <div
          style={{ marginTop: 4, fontSize: 11, color: hintTone ? `var(--${hintTone})` : undefined }}
          className={hintTone ? undefined : 'muted'}
        >
          {hint}
        </div>
      )}
      {pinned && help && (
        <div style={{ marginTop: 6, padding: '9px 11px', background: 'var(--color-surface)', fontSize: 11.5, lineHeight: 1.5, textWrap: 'pretty' }}>
          {help}
        </div>
      )}
    </div>
  );
}

function listingUlHint(
  form: string,
  listed: number | null | undefined,
  noun: string,
  empty?: string,
): string | undefined {
  const listedText = tcaUlText(listed);
  if (!listedText && !form.trim()) return empty;
  if (listedText && form.trim() === listedText) {
    return `Defaulted from the TCA ${noun} (${listedText} yr). Change if the ARO asset life differs.`;
  }
  if (listedText && form.trim() !== listedText) {
    return `TCA ${noun} on the listing is ${listedText} yr.`;
  }
  return undefined;
}

function ulFieldHint(issue: NewObligationUlIssue | null, field: NewObligationUlIssue['field'], fallback?: string) {
  if (issue?.field === field) return { hint: issue.message, hintTone: 'bad' as const };
  return { hint: fallback, hintTone: undefined };
}

export function NewAroLifeFields({
  totalUl, expiredUl, tca, assetAcquisitionDate, costEstimateDate, settlementDate, dayCount,
  onTotalUl, onExpiredUl,
}: {
  totalUl: string;
  expiredUl: string;
  tca?: { totalUl?: number | null; expiredUl?: number | null } | null;
  assetAcquisitionDate: string;
  costEstimateDate: string;
  settlementDate: string;
  dayCount: string;
  onTotalUl: (value: string) => void;
  onExpiredUl: (value: string) => void;
}) {
  const life = evaluateNewAroLifeDraft({
    totalUlText: totalUl,
    expiredUlText: expiredUl,
    tca,
    assetAcquisitionDate,
    costEstimateDate,
    settlementDate,
    dayCount,
  });
  const listingTotal = typeof tca?.totalUl === 'number' ? tca.totalUl : null;
  const listingExpired = typeof tca?.expiredUl === 'number' ? tca.expiredUl : null;
  const proposedExpired = expiredUlFromAcquisition(
    assetAcquisitionDate, costEstimateDate, life.totalUl, dayCount,
  );
  const totalHint = ulFieldHint(
    life.issue, 'totalUl',
    listingUlHint(totalUl, listingTotal, 'Total UL', 'No Total UL on the master TCA listing. Enter the ARO asset useful life in years.'),
  );
  const expiredFallback = expiredUl.trim() === '' && listingExpired == null && proposedExpired != null
    ? `From the obligating event to the cost estimate date: ${num(proposedExpired)} years already consumed.`
    : listingUlHint(expiredUl, listingExpired, 'Expired UL');
  const expiredHint = ulFieldHint(life.issue, 'expiredUl', expiredFallback);
  const remainingHint = life.remainingUl != null
    ? 'Total UL minus Expired UL. Expected settlement defaults to this many years after the cost estimate date.'
    : undefined;

  return (
    <>
      <Field
        label="Total UL"
        help="Years. Defaults from the linked TCA on the master listing. Remaining UL falls as amortization is posted."
        hint={totalHint.hint}
        hintTone={totalHint.hintTone}
      >
        <input
          className="input num"
          value={totalUl}
          onChange={(e) => onTotalUl(e.target.value)}
          onBlur={() => {
            const n = parseNumber(totalUl);
            if (Number.isFinite(n)) onTotalUl(num(n));
          }}
        />
      </Field>
      <Field
        label="Expired UL"
        help="Years already consumed when this obligation is recognised. Catch-up amortization uses this over total UL. Defaults from the linked TCA. Leave blank to measure from the ARO asset acquisition date (obligating event) to the cost estimate date when the listing has no Expired UL."
        hint={expiredHint.hint}
        hintTone={expiredHint.hintTone}
      >
        <input
          className="input num"
          value={expiredUl}
          onChange={(e) => onExpiredUl(e.target.value)}
          onBlur={() => {
            const n = parseNumber(expiredUl);
            if (Number.isFinite(n)) onExpiredUl(num(n));
          }}
        />
      </Field>
      <Field
        label="Remaining UL"
        help="Total UL minus Expired UL of the ARO asset. Expected settlement defaults to the cost estimate date plus this remaining life. A later settlement date is allowed."
        hint={remainingHint}
      >
        <input className="input num" value={life.remainingUl == null ? '' : num(life.remainingUl)} readOnly />
      </Field>
    </>
  );
}

export function NewAroSettlementFields({
  settlementDate, yearsToSettlement, remainingUl, issue, suggested,
  onSettlementDate,
}: {
  settlementDate: string;
  yearsToSettlement: number | null;
  remainingUl: number | null;
  issue: NewObligationUlIssue | null;
  suggested: string;
  onSettlementDate: (value: string) => void;
}) {
  const defaulted = Boolean(suggested && settlementDate === suggested);
  const fallback = defaulted && remainingUl != null
    ? `Defaulted from remaining UL (${num(remainingUl)} yr after the cost estimate date). Change to a later date if settlement is further out.`
    : remainingUl != null
      ? `Must be at least remaining UL (${num(remainingUl)} yr).`
      : undefined;
  const settlementHint = ulFieldHint(issue, 'settlement', fallback);
  return (
    <>
      <Field
        label="Expected settlement"
        help="Defaults to the cost estimate date plus remaining UL of the ARO asset. You can move it later; it cannot be sooner than remaining UL."
        hint={settlementHint.hint}
        hintTone={settlementHint.hintTone}
      >
        <input
          className="input"
          value={settlementDate}
          onChange={(e) => onSettlementDate(maskDateInput(e.target.value))}
          placeholder="YYYY-MM-DD"
        />
      </Field>
      <Field
        label="Years to settlement"
        help="From the cost estimate date to expected settlement. Must be equal to or greater than remaining UL."
      >
        <input className="input num" value={yearsToSettlement == null ? '' : num(yearsToSettlement)} readOnly />
      </Field>
    </>
  );
}

/** Selectable day-count and settlement-term conventions. */
export function ConventionSelects({
  dayCount, termConvention, disabled, onDayCount, onTermConvention,
}: {
  dayCount: string;
  termConvention: string;
  disabled?: boolean;
  onDayCount: (value: string) => void;
  onTermConvention: (value: string) => void;
}) {
  return (
    <>
      <Field
        label="Day count convention"
        help="How a term in years is measured between two dates. 30/360 US matches Excel DAYS360(..., FALSE) and is the default. 30E/360 is the European method (DAYS360 TRUE). Actual/365, Actual/360 and Actual/Actual count calendar days."
      >
        <select className="input" name="dayCount" value={dayCount} disabled={disabled}
          onChange={(e) => onDayCount(e.target.value)}>
          {DAY_COUNTS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field
        label="Settlement term rounding"
        help="How the discount term is read against the published curve. Round up to whole year (SAP) is the default. Round up to the next curve point takes the first published tenor at or beyond the term. Exact fractional years uses the unrounded term."
      >
        <select className="input" name="termConvention" value={termConvention} disabled={disabled}
          onChange={(e) => onTermConvention(e.target.value)}>
          {TERM_CONVENTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
    </>
  );
}

/* ── prerequisites panel ────────────────────────────────────────────────── */

export interface Prereq {
  label: string;
  state: 'Ready' | 'Attention' | 'Blocked';
  detail: string;
  /** Jump to the step that fixes it. */
  go?: () => void;
  goLabel?: string;
}

export function Prereqs({ items }: { items: Prereq[] }) {
  if (!items.length) return null;
  const tone = (s: Prereq['state']) => (s === 'Ready' ? 'ok' : s === 'Attention' ? 'warn' : 'bad');
  return (
    <Block kicker="Prerequisites" title="What this step depends on">
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {items.map((p) => (
          <div key={p.label} style={{
            display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap',
            padding: '9px 0', borderBottom: '1px solid var(--color-divider)',
          }}>
            <span style={{ marginTop: 6 }}><Dot tone={tone(p.state)} /></span>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 12.5 }}>{p.label}</div>
              <div style={{ fontSize: 11.5, lineHeight: 1.5, textWrap: 'pretty' }} className="muted">{p.detail}</div>
            </div>
            <span className={`tag tag-${p.state === 'Ready' ? 'accent' : p.state === 'Attention' ? 'warn' : 'bad'}`}>{p.state}</span>
            {p.go && (
              <button className="btn btn-secondary btn-sm" onClick={p.go}>{p.goLabel ?? 'Go'}</button>
            )}
          </div>
        ))}
      </div>
    </Block>
  );
}

/* ── return banner ──────────────────────────────────────────────────────── */

export function ReturnBanner({
  note, label, onBack, onDismiss,
}: { note: string; label: string; onBack: () => void; onDismiss: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      padding: '10px 14px', marginBottom: 18,
      background: 'color-mix(in srgb,var(--color-accent) 12%,var(--color-surface))',
      borderLeft: '3px solid var(--color-accent)',
    }}>
      <div style={{ flex: '1 1 240px', fontSize: 12, lineHeight: 1.5, textWrap: 'pretty' }}>{note}</div>
      <button className="btn btn-primary btn-sm" onClick={onBack}>← {label}</button>
      <button className="btn btn-secondary btn-sm" onClick={onDismiss} title="Dismiss — I am not coming back to the setup">
        Dismiss
      </button>
    </div>
  );
}

/* ── read-only banner ───────────────────────────────────────────────────── */

export function ReadOnlyBanner({ reason }: { reason: string }) {
  return (
    <div className="note-panel" style={{ marginBottom: 16, borderLeftColor: 'var(--warn)' }}>
      <strong style={{ fontFamily: 'var(--font-heading)' }}>Read only. </strong>{reason}
    </div>
  );
}

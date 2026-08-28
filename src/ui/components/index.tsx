/**
 * Recurring components — SCREENS.md, "Layout pattern".
 *
 * The prerequisites panel, the return banner, the calculation ladder, basis tags
 * and field help. One renderer each: the ladder in particular is used in three
 * places and must not fork.
 */

import React, { useState } from 'react';
import { Rung } from '../../engine/ladder';

/* ── formatting ─────────────────────────────────────────────────────────── */

export const money = (n: number | null | undefined, dp = 0) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const money2 = (n: number | null | undefined) => money(n, 2);
export const pct = (n: number, dp = 2) => `${(n * 100).toFixed(dp)}%`;
export const years = (n: number) => `${n.toFixed(4)} yr`;

/* ── layout ─────────────────────────────────────────────────────────────── */

export function Block({
  title, kicker, actions, children, note,
}: {
  title?: string; kicker?: string; actions?: React.ReactNode;
  children: React.ReactNode; note?: string;
}) {
  return (
    <section className="block">
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
  label, help, children, hint,
}: { label: string; help?: string; children: React.ReactNode; hint?: string }) {
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
      {hint && <div style={{ marginTop: 4, fontSize: 11 }} className="muted">{hint}</div>}
      {pinned && help && (
        <div style={{ marginTop: 6, padding: '9px 11px', background: 'var(--color-surface)', fontSize: 11.5, lineHeight: 1.5, textWrap: 'pretty' }}>
          {help}
        </div>
      )}
    </div>
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

/* ── the calculation ladder ─────────────────────────────────────────────── */

/**
 * One renderer, used in three places, collapsed by default. Each rung carries
 * its operator, its basis tag and its Excel formula.
 */
export function Ladder({ rungs, open: openInit = false }: { rungs: Rung[]; open?: boolean }) {
  const [open, setOpen] = useState(openInit);
  const [formulas, setFormulas] = useState(false);

  const fmt = (r: Rung) =>
    r.kind === 'money' ? money2(r.value) : r.kind === 'rate' ? pct(r.value, 4) : years(r.value);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'} calculation ladder
        </button>
        {open && (
          <button className="btn btn-ghost btn-sm" onClick={() => setFormulas((f) => !f)}>
            {formulas ? 'Hide' : 'Show'} Excel formulas
          </button>
        )}
      </div>
      {open && (
        <div style={{ marginTop: 12 }}>
          {rungs.map((r) => (
            <div className="rung" key={r.key}>
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 12.5 }}>
                  {r.label}
                  {r.basis && <Basis tag={r.basis} />}
                </div>
                <div className="rung-op muted">{r.operator}</div>
                {r.note && (
                  <div style={{ marginTop: 5, padding: '7px 10px', background: 'var(--color-surface)', borderLeft: '3px solid var(--color-accent)', fontSize: 11, lineHeight: 1.5, textWrap: 'pretty' }}>
                    {r.note}
                  </div>
                )}
              </div>
              <div className="rung-val">{fmt(r)}</div>
              {formulas && r.formula && <div className="rung-formula">{r.formula}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
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

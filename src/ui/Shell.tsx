/**
 * The app shell — SCREENS.md, "Layout pattern".
 *
 * "Fixed left sidebar (dark, ~230px): tenant picker, reporting-unit picker, the
 * step list grouped by phase, role switcher at the foot. Main column: a header
 * strip with the step name, its one-line purpose and its actions, then content
 * in full-width bordered blocks separated by 2px rules."
 */

import React from 'react';
import { useClerk } from '@clerk/react';
import { useStore, useTenant, useUnit, useUnitWord } from '../core/store';
import { FIRM_NAV, PHASES, resolveFirmNavId, resolveUnitScreen, stepById, stepsFor, unitLandingScreen } from '../core/nav';
import { tourIndexForScreen } from '../core/guide';
import { landingScreen } from '../core/setup';
import { ROLES } from '../core/authority';
import { ReturnBanner, Walkthrough } from './components';
import { AroWordmark } from './Logo';
import { Screen } from './screens';

export function Shell() {
  const { state, ui, setUi } = useStore();
  const { signOut } = useClerk();
  const tenant = useTenant();
  const unit = useUnit();
  const unitWord = useUnitWord();

  if (!tenant) return null;

  const units = state.units[tenant.id] ?? [];
  const steps = stepsFor(tenant.kind);
  const screen = resolveUnitScreen(ui.screen);
  const step = stepById(screen);
  const firmScreen = resolveFirmNavId(ui.screen);
  const firmNav = FIRM_NAV.find((n) => n.id === firmScreen);

  const howto = firmScreen === 'howto';
  const title = step ? step.label : firmNav ? firmNav.label : 'ARO Suite';
  const purpose = step ? step.purpose : firmNav ? firmNav.purpose : '';
  const crumb = step
    ? `${tenant.name} · ${unit?.entity ?? unitWord} · ${step.phase}`
    : tenant.name;

  const go = (screen: string) => {
    const tour = ui.tour == null ? null : tourIndexForScreen(tenant.kind, screen, ui.tour);
    setUi({ screen, tab: '', sub: '', tour });
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'stretch' }}>
      {/* ── sidebar ──────────────────────────────────────────────────── */}
      <nav style={{ width: 262, flex: 'none', background: 'var(--color-accent-900)', color: 'var(--color-bg)', display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100vh', overflowY: 'auto' }}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid color-mix(in srgb,var(--color-bg) 20%,transparent)' }}>
          <AroWordmark inverse size={18} />
        </div>

        <div style={{ padding: '14px 18px', borderBottom: '1px solid color-mix(in srgb,var(--color-bg) 20%,transparent)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.65 }}>Tenant</div>
          <select
            className="input"
            value={tenant.id}
            onChange={(e) => {
              const t = state.tenants.find((x) => x.id === e.target.value)!;
              const owner = state.users.find((u) => u.tenantId === t.id && u.isOwner) ?? state.users.find((u) => u.tenantId === t.id);
              setUi({ tenantId: t.id, unitId: null, screen: landingScreen(state, t.id), userName: owner?.name ?? ui.userName, role: owner?.role ?? ui.role, tour: null });
            }}
            style={{ minHeight: 30, fontSize: 12, padding: '2px 6px', background: 'transparent', color: 'var(--color-bg)', borderColor: 'color-mix(in srgb,var(--color-bg) 40%,transparent)' }}
          >
            {state.tenants.map((t) => <option key={t.id} value={t.id} style={{ color: 'var(--color-text)' }}>{t.name}</option>)}
          </select>
        </div>

        <div style={{ padding: '12px 10px 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.55, padding: '2px 10px 6px' }}>Firm</div>
          {FIRM_NAV.map((n) => (
            // A firm screen does not close the open reporting unit — the two
            // sidebar sections stay live so a trip to the change log does not
            // cost the user their place in the workflow.
            <SideButton key={n.id} active={firmScreen === n.id} label={n.label} title={n.purpose}
              onClick={() => go(n.id)} />
          ))}
          <div style={{ fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.55, padding: '10px 10px 6px' }}>
            {unitWord}s
          </div>
          {units.length === 0 ? (
            <div style={{ padding: '4px 10px 8px', fontSize: 11, opacity: 0.55, lineHeight: 1.35 }}>
              None yet. Create one in Company setup.
            </div>
          ) : units.map((u) => (
            <SideButton
              key={u.id}
              active={ui.unitId === u.id}
              label={u.entity}
              title={`Open ${u.entity} · FY end ${u.fyEnd} · ${u.currency}`}
              onClick={() => {
                const landing = unitLandingScreen(tenant.kind, state, u);
                const stay = ui.unitId === u.id && Boolean(step);
                const nextScreen = stay ? ui.screen : landing;
                const tour = stay ? ui.tour : null;
                setUi({ unitId: u.id, screen: nextScreen, tab: stay ? ui.tab : '', sub: stay ? ui.sub : '', tour });
              }}
            />
          ))}
        </div>

        {unit && (
          <div style={{ padding: '10px 10px 4px', display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid color-mix(in srgb,var(--color-bg) 20%,transparent)', marginTop: 10 }}>
            <div style={{ padding: '6px 10px 8px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.55 }}>{unitWord}</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 12.5, lineHeight: 1.25 }}>{unit.entity}</div>
              <div style={{ fontSize: 10.5, opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>
                FY end {unit.fyEnd} · {unit.currency}
              </div>
              <button
                onClick={() => setUi({ unitId: null, screen: 'units', tour: null })}
                style={{ marginTop: 4, background: 'transparent', border: '1px solid color-mix(in srgb,var(--color-bg) 35%,transparent)', color: 'var(--color-bg)', padding: '3px 7px', fontSize: 10.5, cursor: 'pointer', fontFamily: 'var(--font-body)', alignSelf: 'flex-start' }}
              >Close {unitWord.toLowerCase()}</button>
            </div>

            {PHASES.map((phase) => {
              const inPhase = steps.filter((s) => s.phase === phase);
              if (!inPhase.length) return null;
              return (
                <React.Fragment key={phase}>
                  <div style={{ fontSize: 8.5, letterSpacing: '0.16em', textTransform: 'uppercase', opacity: 0.45, padding: '10px 10px 4px' }}>{phase}</div>
                  {inPhase.map((s) => (
                    <SideButton
                      key={s.id}
                      active={screen === s.id}
                      label={s.label}
                      title={s.purpose}
                      num={String(steps.indexOf(s) + 1).padStart(2, '0')}
                      onClick={() => go(s.id)}
                    />
                  ))}
                </React.Fragment>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 'auto', padding: '14px 18px', borderTop: '1px solid color-mix(in srgb,var(--color-bg) 20%,transparent)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.65 }}>Signed in as</div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 12.5 }}>{ui.userName}</div>
          <select
            className="input"
            value={ui.role}
            onChange={(e) => setUi({ role: e.target.value })}
            title="Demo control — switch role to see permission gating"
            style={{ minHeight: 28, fontSize: 11.5, padding: '2px 6px', background: 'transparent', color: 'var(--color-bg)', borderColor: 'color-mix(in srgb,var(--color-bg) 40%,transparent)' }}
          >
            {ROLES.map((r) => <option key={r.id} value={r.id} style={{ color: 'var(--color-text)' }}>{r.label}</option>)}
          </select>
          <button
            onClick={() => {
              setUi({ signedIn: false, tenantId: null, unitId: null, setupTrail: null, tour: null });
              void signOut();
            }}
            style={{ background: 'transparent', border: '1px solid color-mix(in srgb,var(--color-bg) 40%,transparent)', color: 'var(--color-bg)', padding: '5px 8px', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-body)' }}
          >Sign out</button>
        </div>
      </nav>

      {/* ── main column ──────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {!howto && (
          <header style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '14px 26px', borderBottom: '2px solid var(--color-divider)' }}>
            <div style={{ marginRight: 'auto', minWidth: 0 }}>
              <div style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }} className="muted">{crumb}</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 20, letterSpacing: '-0.02em', lineHeight: 1.15 }}>{title}</div>
              {purpose && <div style={{ fontSize: 12, marginTop: 2, textWrap: 'pretty' }} className="muted">{purpose}</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
              <div style={{ fontSize: 11, textAlign: 'right' }} className="muted">{tenant.env}</div>
              <div className="tag tag-accent">{ROLES.find((r) => r.id === ui.role)?.label}</div>
            </div>
          </header>
        )}

        <main style={{ flex: 1, minWidth: 0, padding: howto ? '28px 40px 80px' : '22px 26px 60px' }}>
          {ui.setupTrail && (
            <ReturnBanner
              note={ui.setupTrail.note}
              label={ui.setupTrail.label}
              onBack={() => setUi({ unitId: ui.setupTrail!.unitId, screen: ui.setupTrail!.screen, setupTrail: null, tour: null })}
              onDismiss={() => setUi({ setupTrail: null })}
            />
          )}
          <Screen />
        </main>
        <Walkthrough />
      </div>
    </div>
  );
}

function SideButton({
  active, label, title, num, onClick,
}: { active: boolean; label: string; title: string; num?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left',
        background: active ? 'color-mix(in srgb,var(--color-bg) 16%,transparent)' : 'transparent',
        color: 'var(--color-bg)', border: 0, padding: num ? '7px 10px' : '8px 10px',
        cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: num ? 12 : 12.5,
      }}
    >
      {num
        ? <span style={{ width: 16, flex: 'none', fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 9.5, fontVariantNumeric: 'tabular-nums', opacity: 0.6 }}>{num}</span>
        : <span style={{ width: 5, height: 5, background: active ? 'var(--color-bg)' : 'color-mix(in srgb,var(--color-bg) 45%,transparent)', flex: 'none' }} />}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}

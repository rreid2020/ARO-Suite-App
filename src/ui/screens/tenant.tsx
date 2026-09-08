/**
 * Tenant-scope screens — SCREENS.md, "Tenant scope".
 *
 * Reporting units live in company setup (first step). Curve, users, frameworks
 * and authority are later company-setup steps. Chart and posting belong to the
 * reporting unit · Change log · Audit trail · Client portal.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useStore, useTenant, useUnitWord } from '../../core/store';
import {
  AUTHORITY_MODES, AuthorityMode, DOMAINS, Domain, MODE_NOTE, ROLES,
  canAdmin, canConfigureTenant, canCreateUnit, canEdit, roleById,
} from '../../core/authority';
import { Curve, CurvePoint, Extrapolation, Interpolation, curveOptionLabel, pointsMatch } from '../../engine/curve';
import { isValidDate } from '../../engine/dates';
import { Block, Empty, Field, num, pct, SheetTable, Stats, Tag } from '../components';
import { addReportingUnit, assignMissingCurves, curveDeleteBlocker, deleteCurve, deleteReportingUnit, publishedCurves, unitsMissingPublishedCurve, updateReportingUnit, unitIdentityLocked, unitSetupComplete } from '../../core/createUnit';
import { patchSetup } from '../../core/setup';
import { unitLandingScreen } from '../../core/nav';
import { ReportingUnit, User } from '../../core/types';
import { userSignInLabel } from '../../core/invite';

/* ══ Reporting units ═══════════════════════════════════════════════════ */

const CURRENCIES = ['CAD', 'USD', 'GBP', 'EUR', 'AUD', 'NOK'];
const identityInput: React.CSSProperties = { minHeight: 26, fontSize: 11.5, width: '100%' };

export function Units() {
  const { state, ui, setUi, apply } = useStore();
  const tenant = useTenant()!;
  const word = useUnitWord();
  const units = state.units[tenant.id] ?? [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ entity: '', fyEnd: '', currency: 'CAD', sector: 'Mining' });
  const canEditIdentity = canCreateUnit(ui.role);

  // An auditor tenancy sees eight steps and the register is not one of them, so
  // opening a unit must land on a step that tenant kind actually has.
  const landingFor = (u: ReportingUnit) => unitLandingScreen(tenant.kind, state, u);

  const editUnit = (u: ReportingUnit, patch: Parameters<typeof updateReportingUnit>[3], detail: string) => {
    if (!canEditIdentity || unitIdentityLocked(state, u)) return;
    if (patch.entity !== undefined && !patch.entity.trim()) return;
    if (patch.fyEnd !== undefined && !isValidDate(patch.fyEnd)) return;
    apply('Edit reporting unit', 'admin', detail, (s) => {
      updateReportingUnit(s, tenant.id, u.id, patch);
    });
  };

  const identityOpen = (u: ReportingUnit) => canEditIdentity && !unitIdentityLocked(state, u);

  const removeUnit = (u: ReportingUnit) => {
    if (!identityOpen(u)) return;
    if (!window.confirm(`Delete ${u.entity}? It has not started, so the entity and its empty calendar will be removed.`)) return;
    apply('Delete reporting unit', 'admin', `Deleted reporting unit ${u.entity}.`, (s) => {
      deleteReportingUnit(s, tenant.id, u.id);
    });
    if (ui.unitId === u.id || ui.setupTrail?.unitId === u.id) {
      setUi({ unitId: null, screen: 'setup', setupTrail: null, tab: '', sub: '' });
    }
  };

  // A unit created before a published table existed keeps an empty curveId.
  // The Assumptions dropdown used to hide that by showing the first library
  // curve. Heal the pointer here without rewriting inflation or other defaults.
  useEffect(() => {
    if (!canEdit(ui.role) && !canConfigureTenant(ui.role)) return;
    const missing = unitsMissingPublishedCurve(state, tenant.id);
    if (!missing.length) return;
    apply('Assign discount curve', 'admin',
      `Assigned a published curve to ${missing.map((u) => u.entity).join(', ')}.`,
      (s) => { assignMissingCurves(s, tenant.id); });
  }, [apply, state, tenant.id, ui.role]);

  const create = () => {
    if (!draft.entity.trim() || !isValidDate(draft.fyEnd)) return;
    apply('Create reporting unit', 'admin',
      `Created ${word.toLowerCase()} ${draft.entity} with a financial year ending ${draft.fyEnd}.`,
      (s) => {
        addReportingUnit(s, {
          tenantId: tenant.id, entity: draft.entity, fyEnd: draft.fyEnd,
          currency: draft.currency, sector: draft.sector,
        });
        s.settings[tenant.id].setup = patchSetup(s.settings[tenant.id].setup, { current: 'unit' });
      });
    setAdding(false);
    setDraft({ entity: '', fyEnd: '', currency: 'CAD', sector: 'Mining' });
  };

  return (
    <>
      <Stats items={[
        { label: word + 's', value: String(units.length) },
        { label: 'Curves in library', value: String((state.curves[tenant.id] ?? []).length) },
        { label: 'Users', value: String(state.users.filter((u) => u.tenantId === tenant.id).length) },
        { label: 'Tenant kind', value: tenant.kind },
      ]} />

      <Block
        kicker={word}
        title={units.length ? `${units.length} ${word.toLowerCase()}${units.length === 1 ? '' : 's'}` : `No ${word.toLowerCase()}s yet`}
        note="Create the legal entity first — name, year end and currency. Framework, measurement assumptions, the discount table, chart of accounts and posting rules are set on that unit when you Open it, before Prepare. The chart is the organisation's GL, shared across units on this tenant. While status is Not started you can still change the identity fields or delete the unit. After it starts — or once obligations are loaded — identity locks because those fields drive the fiscal calendar."
        actions={canCreateUnit(ui.role) && (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : `New ${word.toLowerCase()}`}
          </button>
        )}
      >
        {adding && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16, padding: 12, background: 'var(--color-surface)' }}>
            <div style={{ flex: '1 1 220px' }}>
              <Field label="Entity" help="The legal entity this reporting unit measures. The fiscal calendar belongs to it, not to the tenant.">
                <input className="input" value={draft.entity} onChange={(e) => setDraft({ ...draft, entity: e.target.value })} />
              </Field>
            </div>
            <div style={{ flex: '0 0 150px' }}>
              <Field label="Financial year end" help="Drives the whole fiscal calendar. Period codes carry the fiscal year, not the calendar year the period ends in.">
                <input className="input" type="date" value={draft.fyEnd} onChange={(e) => setDraft({ ...draft, fyEnd: e.target.value })} />
              </Field>
            </div>
            <div style={{ flex: '0 0 110px' }}>
              <Field label="Currency">
                <select className="input" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
            </div>
            <button className="btn btn-primary btn-sm" onClick={create} disabled={!draft.entity.trim() || !isValidDate(draft.fyEnd)}>Create</button>
          </div>
        )}

        {units.length === 0 ? (
          <Empty>
            This tenant has no {word.toLowerCase()}s. Create one here with its entity, year end and currency. Open it to set the rest before Prepare.
          </Empty>
        ) : (
          <SheetTable
            rows={units}
            rowKey={(u) => u.id}
            noun="reporting units"
            columns={[
              { key: 'entity', header: 'Entity', value: (u) => u.entity, cell: (u) => identityOpen(u) ? (
                <input
                  className="input"
                  style={identityInput}
                  defaultValue={u.entity}
                  aria-label={`Entity name for ${u.entity}`}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (!name) { e.target.value = u.entity; return; }
                    e.target.value = name;
                    if (name === u.entity) return;
                    editUnit(u, { entity: name }, `Renamed reporting unit to ${name}.`);
                  }}
                />
              ) : <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{u.entity}</span> },
              { key: 'fyEnd', header: 'FY end', kind: 'date', value: (u) => u.fyEnd, cell: (u) => identityOpen(u) ? (
                <input
                  className="input"
                  type="date"
                  style={identityInput}
                  value={u.fyEnd}
                  aria-label={`Financial year end for ${u.entity}`}
                  onChange={(e) => {
                    const fyEnd = e.target.value;
                    if (!isValidDate(fyEnd) || fyEnd === u.fyEnd) return;
                    editUnit(u, { fyEnd }, `Set ${u.entity} financial year end to ${fyEnd}.`);
                  }}
                />
              ) : u.fyEnd },
              { key: 'currency', header: 'Currency', value: (u) => u.currency, cell: (u) => identityOpen(u) ? (
                <select
                  className="input"
                  style={identityInput}
                  value={u.currency}
                  aria-label={`Currency for ${u.entity}`}
                  onChange={(e) => {
                    if (e.target.value === u.currency) return;
                    editUnit(u, { currency: e.target.value }, `Set ${u.entity} currency to ${e.target.value}.`);
                  }}
                >
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : u.currency },
              { key: 'status', header: 'Status', value: (u) => u.status, cell: (u) => u.status },
              { key: 'stage', header: 'Stage', value: (u) => u.stage, cell: (u) => u.stage },
              { key: 'obs', header: 'Obligations', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (u) => state.data[u.id]?.obligations.length ?? 0, cell: (u) => state.data[u.id]?.obligations.length ?? 0 },
              { key: 'unitsetup', header: 'Unit settings', value: (u) => unitSetupComplete(state, u) ? 'Confirmed' : 'Not confirmed', cell: (u) => (
                unitSetupComplete(state, u) ? <Tag kind="accent">Confirmed</Tag> : <Tag kind="warn">Not confirmed</Tag>
              ) },
              { key: 'open', header: '', cell: (u) => (
                <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button className="btn btn-primary btn-sm" onClick={() => setUi({ unitId: u.id, screen: landingFor(u) })}>Open</button>
                  {identityOpen(u) && (
                    <button
                      className="btn btn-ghost btn-sm"
                      title="Remove this reporting unit. Allowed while status is Not started and no obligations have been loaded."
                      onClick={() => removeUnit(u)}
                    >Delete</button>
                  )}
                </span>
              ) },
            ]}
          />
        )}
      </Block>
    </>
  );
}

/* ══ Curve library ═════════════════════════════════════════════════════ */

const emptyCurveDraft = () => ({
  name: '',
  currency: 'CAD',
  asAt: '',
  source: '',
  basis: 'Zero-coupon, annual compounding',
  interpolation: 'linear' as Interpolation,
  extrapolation: 'flat-last' as Extrapolation,
});

export function Curves() {
  const { state, ui, apply } = useStore();
  const tenant = useTenant()!;
  const curves = state.curves[tenant.id] ?? [];
  const [openId, setOpenId] = useState<string | null>(curves[0]?.id ?? null);
  const [paste, setPaste] = useState('');
  const [report, setReport] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(curves.length === 0);
  const [draft, setDraft] = useState(emptyCurveDraft);
  const [newTerm, setNewTerm] = useState('');
  const [newRate, setNewRate] = useState('');
  const open = curves.find((c) => c.id === openId) ?? null;
  const editable = canEdit(ui.role);
  const canLock = canConfigureTenant(ui.role);
  const pointsWritable = Boolean(editable && open && !open.locked);

  const createCurve = () => {
    if (!draft.name.trim() || !isValidDate(draft.asAt) || !draft.source.trim()) return;
    const id = `curve-${Date.now().toString(36)}`;
    const curve: Curve = {
      id,
      name: draft.name.trim(),
      currency: draft.currency,
      source: draft.source.trim(),
      basis: draft.basis.trim() || 'Zero-coupon, annual compounding',
      interpolation: draft.interpolation,
      extrapolation: draft.extrapolation,
      asAt: draft.asAt,
      points: [],
    };
    apply('Create discount curve', 'admin',
      `Added ${curve.name} (${curve.currency}, as at ${curve.asAt}) to the curve library. Load published points next — the discount rate is looked up from this curve, never entered per obligation.`,
      (s) => {
        (s.curves[tenant.id] ??= []).push(curve);
      });
    setOpenId(id);
    setAdding(false);
    setDraft(emptyCurveDraft());
  };

  const parsePoints = (text: string, filename: string) => {
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    const points: CurvePoint[] = [];
    const problems: string[] = [];
    lines.forEach((line, i) => {
      const parts = line.split(/[\t,;]/).map((p) => p.trim());
      if (parts.length < 2) { problems.push(`Line ${i + 1}: "${line}" has no rate beside the term. Not taken.`); return; }
      const term = Number(parts[0]);
      let rate = Number(String(parts[1]).replace('%', ''));
      if (!Number.isFinite(term) || term <= 0) { problems.push(`Line ${i + 1}: "${parts[0]}" is not a term in years. Not taken.`); return; }
      if (!Number.isFinite(rate)) { problems.push(`Line ${i + 1}: "${parts[1]}" is not a rate. Not taken.`); return; }
      // A value above 1 is read as a percentage, which is how curves are published.
      if (Math.abs(rate) > 1) rate = rate / 100;
      points.push({ term, rate });
    });
    if (open?.locked) {
      apply('Import curve points', 'refused',
        `${open.name} as at ${open.asAt || 'this table'} is locked. A partner or firm admin has to unlock it before points can change.`,
        () => {});
      return;
    }
    if (points.length && open) {
      apply('Import curve points', 'import',
        `Loaded ${points.length} point${points.length === 1 ? '' : 's'} onto ${open.name} from ${filename}. The file name is recorded as the source of the points.`,
        (s) => {
          const c = s.curves[tenant.id].find((x) => x.id === open.id)!;
          if (c.locked) return;
          const merged = new Map(c.points.map((p) => [p.term, p.rate]));
          for (const p of points) merged.set(p.term, p.rate);
          c.points = [...merged.entries()].map(([term, rate]) => ({ term, rate })).sort((a, b) => a.term - b.term);
          c.source = `${c.source.split(' · ')[0]} · loaded from ${filename}`;
          assignMissingCurves(s, tenant.id);
        });
    }
    setReport([
      `${points.length} point${points.length === 1 ? '' : 's'} taken, ${problems.length} not taken.`,
      ...problems,
    ]);
  };

  return (
    <>
      <Block kicker="Curve library" title={`${curves.length} curve${curves.length === 1 ? '' : 's'}`}
        actions={editable && (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'New curve'}
          </button>
        )}
        note="Each row is a published rate table for one currency and one as-at date. A reporting unit holds a pointer to the table in force — it does not own the points. In-year accretion reads that table. At year end, start a later as-at table, load the new published rates, then run year-end revaluation to bring it into force. Do not overwrite last year's points: that would rewrite history. The entity FY end on the reporting unit is not the curve as-at.">
        {adding && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16, padding: 12, background: 'var(--color-surface)' }}>
            <div style={{ flex: '1 1 220px' }}>
              <Field label="Name" help="The published curve you will look the discount rate up from. One curve per currency and as-at date.">
                <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. GBP government zero-coupon" />
              </Field>
            </div>
            <div style={{ flex: '0 0 110px' }}>
              <Field label="Currency">
                <select className="input" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
            </div>
            <div style={{ flex: '0 0 150px' }}>
              <Field label="As at" help="The date the published points apply. A year-end revaluation uses a later as-at, not an edit of this one.">
                <input className="input" type="date" value={draft.asAt} onChange={(e) => setDraft({ ...draft, asAt: e.target.value })} />
              </Field>
            </div>
            <div style={{ flex: '1 1 220px' }}>
              <Field label="Source" help="Provenance. Where the points came from — publisher, extract, or workbook.">
                <input className="input" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="e.g. Bank of England published curve" />
              </Field>
            </div>
            <div style={{ flex: '1 1 220px' }}>
              <Field label="Basis" help="What the publisher published — annual zeros, semi-annual zeros, and so on. This does not change the maths. The engine always discounts as future value ÷ (1 + rate) ^ term (annual compounding). Load points that already match this basis; the engine will not convert compounding for you.">
                <input className="input" value={draft.basis} onChange={(e) => setDraft({ ...draft, basis: e.target.value })} />
              </Field>
            </div>
            <div style={{ flex: '0 0 140px' }}>
              <Field label="Interpolation" help="How to read a rate between published tenors. Linear draws a straight line between the two bracketing points — 4 years on a 3y / 5y curve is halfway. Step takes the first published point at or beyond the term, which is how a discrete tenor sheet is usually read. An exact published tenor always uses that point. Terms shorter than the first point always take the first point's rate.">
                <select className="input" value={draft.interpolation} onChange={(e) => setDraft({ ...draft, interpolation: e.target.value as Interpolation })}>
                  <option value="linear" title="Straight line between the two bracketing points">linear</option>
                  <option value="step" title="First published point at or beyond the term">step</option>
                </select>
              </Field>
            </div>
            <div style={{ flex: '0 0 140px' }}>
              <Field label="Beyond last point" help="What to do when the discount term is longer than the last published tenor. Flat-last keeps the last rate — the default, so you do not invent a long rate. Linear continues the slope of the last two points. Log-linear does the same through the logs of those two rates. The policy is stamped on the row that used it.">
                <select className="input" value={draft.extrapolation} onChange={(e) => setDraft({ ...draft, extrapolation: e.target.value as Extrapolation })}>
                  <option value="flat-last" title="Keep the last published rate">flat-last</option>
                  <option value="linear" title="Continue the slope of the last two points">linear</option>
                  <option value="log-linear" title="Continue through the logs of the last two rates">log-linear</option>
                </select>
              </Field>
            </div>
            <button className="btn btn-primary btn-sm" onClick={createCurve} disabled={!draft.name.trim() || !isValidDate(draft.asAt) || !draft.source.trim()}>
              Create curve
            </button>
          </div>
        )}
        {curves.length === 0 ? (
          <Empty>The library is empty. Without a curve there is no discount rate to look up, so no reporting unit can be measured. Create a curve, then load its published points.</Empty>
        ) : (
          <SheetTable
            rows={curves}
            rowKey={(c) => c.id}
            noun="curves"
            columns={[
              { key: 'name', header: 'Name', value: (c) => c.name, cell: (c) => <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{c.name}{c.isDraft && <Tag kind="warn"> draft</Tag>}{c.locked && <Tag kind="accent"> locked</Tag>}</span> },
              { key: 'currency', header: 'Currency', value: (c) => c.currency, cell: (c) => c.currency },
              { key: 'basis', header: 'Basis', value: (c) => c.basis, cell: (c) => c.basis },
              { key: 'interpolation', header: 'Interpolation', value: (c) => c.interpolation, cell: (c) => c.interpolation },
              { key: 'extrapolation', header: 'Beyond last point', value: (c) => c.extrapolation, cell: (c) => c.extrapolation },
              { key: 'points', header: 'Points', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (c) => c.points.length, cell: (c) => c.points.length },
              { key: 'asAt', header: 'As at', kind: 'date', value: (c) => c.asAt, cell: (c) => c.asAt },
              { key: 'source', header: 'Source', value: (c) => c.source, tdStyle: { maxWidth: 260, whiteSpace: 'normal' }, cell: (c) => c.source },
              { key: 'act', header: '', cell: (c) => (
                <span style={{ display: 'flex', gap: 6 }}>
                  <button
                    className={`btn ${openId === c.id ? 'btn-primary' : 'btn-secondary'} btn-sm`}
                    onClick={() => setOpenId(c.id)}
                  >{openId === c.id ? 'Showing' : 'Points'}</button>
                  {editable && (
                    <>
                      <button className="btn btn-ghost btn-sm" title="Copy points into a draft with a blank as-at. Set the new date, load the year-end rates, then publish. The table in force is untouched."
                        onClick={() => {
                          const id = `${c.id}-${Date.now().toString(36)}`;
                          apply('Start later as-at table', 'admin',
                            `Copied ${c.name} as a draft for a later as-at. Set the new date and load the published rates; do not edit the table already in force.`,
                            (s) => {
                              s.curves[tenant.id].push({
                                ...structuredClone(c),
                                id,
                                name: c.name,
                                asAt: '',
                                isDraft: true,
                                locked: false,
                                source: `${c.source.split(' · ')[0]} · copied from ${c.asAt || 'prior'} table`,
                              });
                            });
                          setOpenId(id);
                        }}>New as-at table</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => apply('Copy curve to draft', 'admin',
                        `Copied ${c.name} to a draft. The published curve is untouched.`,
                        (s) => {
                          s.curves[tenant.id].push({ ...structuredClone(c), id: `${c.id}-draft-${Date.now().toString(36)}`, name: `${c.name} (draft)`, isDraft: true, locked: false });
                        })}>Copy to draft</button>
                      {canLock && !c.isDraft && (
                        c.locked ? (
                          <button className="btn btn-ghost btn-sm" title="Unlock so points can be corrected. Unlocking is logged."
                            onClick={() => apply('Unlock discount curve', 'admin',
                              `Unlocked ${c.name} as at ${c.asAt || 'no as-at'}. Points can be changed until it is locked again.`,
                              (s) => { s.curves[tenant.id].find((x) => x.id === c.id)!.locked = false; })}>
                            Unlock
                          </button>
                        ) : (
                          <button className="btn btn-ghost btn-sm" title="Lock this published table so points cannot be changed. A later year end uses New as-at table, not an edit of these rates."
                            onClick={() => apply('Lock discount curve', 'lock',
                              `Locked ${c.name} as at ${c.asAt || 'no as-at'}. Points cannot change until a partner or firm admin unlocks it.`,
                              (s) => { s.curves[tenant.id].find((x) => x.id === c.id)!.locked = true; })}>
                            Lock
                          </button>
                        )
                      )}
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={Boolean(curveDeleteBlocker(state, tenant.id, c.id))}
                        title={curveDeleteBlocker(state, tenant.id, c.id)
                          ?? 'Remove this table and its points from the library.'}
                        onClick={() => {
                          const blocked = curveDeleteBlocker(state, tenant.id, c.id);
                          if (blocked) {
                            apply('Delete discount curve', 'refused', blocked, () => {});
                            return;
                          }
                          apply('Delete discount curve', 'admin',
                            `Removed ${c.name} (${c.currency}, as at ${c.asAt || 'no as-at'}) from the curve library.`,
                            (s) => { deleteCurve(s, tenant.id, c.id); });
                          setOpenId((id) => {
                            if (id !== c.id) return id;
                            return curves.find((x) => x.id !== c.id)?.id ?? null;
                          });
                        }}
                      >Delete</button>
                    </>
                  )}
                </span>
              ) },
            ]}
          />
        )}
      </Block>

      {open && (
        <Block kicker="Points editor" title={`${open.name} · ${open.currency} · as at ${open.asAt || 'not set'}`}
          note={`${open.basis}. These points belong to this as-at table only. Click Points on another library row to edit that table. Below the first point the first point's rate applies; beyond the last, the ${open.extrapolation} extrapolation policy applies and is stamped on the row that used it.`}>
          {(() => {
            const inForceOn = (state.units[tenant.id] ?? []).filter((u) => u.curveId === open.id);
            if (!inForceOn.length || open.isDraft) return null;
            return (
              <div className="note-panel" style={{ marginBottom: 14, borderLeftColor: 'var(--warn)' }}>
                This table is in force on {inForceOn.map((u) => u.entity).join(', ')}. Use <strong>New as-at table</strong> for the next year end. Changing these points rewrites the table those units already measure on.
              </div>
            );
          })()}
          {(() => {
            const twin = curves.find((c) => c.id !== open.id && pointsMatch(c, open));
            if (!twin) return null;
            return (
              <div className="note-panel" style={{ marginBottom: 14, borderLeftColor: 'var(--warn)' }}>
                These {open.points.length} rates still match {twin.name} as at {twin.asAt || 'an earlier table'}. Copying created a separate table — it did not share one grid. Load this year's published points here (paste or import). Editing the other row does not change these, and vice versa.
              </div>
            );
          })()}
          {open.locked && (
            <div className="note-panel" style={{ marginBottom: 14 }}>
              This table is locked. Points cannot be added, deleted or reloaded. A later year end uses <strong>New as-at table</strong>, not an edit of these rates. A partner or firm admin can Unlock if a correction is required.
            </div>
          )}
          {open.isDraft && editable && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16, padding: 12, background: 'var(--color-surface)' }}>
              <div style={{ flex: '0 0 160px' }}>
                <Field label="As at" help="The date these published points apply. Required before the table can be published and assigned.">
                  <input className="input" type="date" value={open.asAt} onChange={(e) => apply('Set curve as-at', 'admin',
                    `As-at for ${open.name} set to ${e.target.value || 'blank'}.`,
                    (s) => { s.curves[tenant.id].find((x) => x.id === open.id)!.asAt = e.target.value; })} />
                </Field>
              </div>
              <button className="btn btn-primary btn-sm"
                disabled={!isValidDate(open.asAt) || open.points.length === 0}
                title={!isValidDate(open.asAt) ? 'Set an as-at date first.' : open.points.length === 0 ? 'Load published points first.' : undefined}
                onClick={() => apply('Publish discount curve', 'admin',
                  `Published ${open.name} as at ${open.asAt}. Reporting units without a table can now be assigned it.`,
                  (s) => {
                    s.curves[tenant.id].find((x) => x.id === open.id)!.isDraft = false;
                    assignMissingCurves(s, tenant.id);
                  })}>
                Publish this table
              </button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px,1fr) minmax(280px,1fr)', gap: 20 }}>
            <div>
              <div className="kicker" style={{ marginBottom: 6 }}>{open.points.length} published points on this as-at table</div>
              <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--color-divider)' }}>
                <SheetTable
                  rows={open.points}
                  rowKey={(p) => String(p.term)}
                  noun="points"
                  columns={[
                    { key: 'term', header: 'Term (yrs)', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (p) => p.term, cell: (p) => num(p.term) },
                    { key: 'rate', header: 'Rate', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (p) => p.rate, cell: (p) => pct(p.rate, 4) },
                    ...(pointsWritable ? [{ key: 'del', header: '', cell: (p: CurvePoint) => (
                      <button className="btn btn-ghost btn-sm" onClick={() => apply('Delete curve point', 'admin',
                        `Removed the ${p.term}-year point from ${open.name}.`,
                        (s) => {
                          const c = s.curves[tenant.id].find((x) => x.id === open.id)!;
                          if (c.locked) return;
                          c.points = c.points.filter((x) => x.term !== p.term);
                        })}>Delete</button>
                    ) }] : []),
                  ]}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: '0 0 110px' }}>
                  <Field label="Term (yrs)">
                    <input className="input" value={newTerm} onChange={(e) => setNewTerm(e.target.value)} placeholder="1" disabled={!pointsWritable} />
                  </Field>
                </div>
                <div style={{ flex: '0 0 140px' }}>
                  <Field label="Rate" help="A value above 1 is read as a percentage.">
                    <input className="input" value={newRate} onChange={(e) => setNewRate(e.target.value)} placeholder="3.95" disabled={!pointsWritable} />
                  </Field>
                </div>
                <button className="btn btn-secondary btn-sm" disabled={!pointsWritable || !newTerm.trim() || !newRate.trim()}
                  onClick={() => {
                    const term = Number(newTerm);
                    let rate = Number(String(newRate).replace('%', ''));
                    if (!Number.isFinite(term) || term <= 0 || !Number.isFinite(rate)) return;
                    if (Math.abs(rate) > 1) rate = rate / 100;
                    apply('Add curve point', 'admin',
                      `Added a ${term}-year point at ${(rate * 100).toFixed(4)}% on ${open.name}.`,
                      (s) => {
                        const c = s.curves[tenant.id].find((x) => x.id === open.id)!;
                        if (c.locked) return;
                        const merged = new Map(c.points.map((p) => [p.term, p.rate]));
                        merged.set(term, rate);
                        c.points = [...merged.entries()].map(([t, r]) => ({ term: t, rate: r })).sort((a, b) => a.term - b.term);
                      });
                    setNewTerm('');
                    setNewRate('');
                  }}>Add point</button>
              </div>
              <Field label="Paste points" help="Two columns: term in years, then the rate. Tab, comma or semicolon separated. A value above 1 is read as a percentage.">
                <textarea className="input" rows={7} value={paste} onChange={(e) => setPaste(e.target.value)}
                  placeholder={'0.25\t3.10\n0.50\t3.18\n0.75\t3.25'} disabled={!pointsWritable} />
              </Field>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" disabled={!pointsWritable || !paste.trim()}
                  onClick={() => { parsePoints(paste, 'pasted block'); setPaste(''); }}>Load pasted points</button>
                <label className="btn btn-secondary btn-sm" style={{ cursor: pointsWritable ? 'pointer' : 'not-allowed' }}>
                  Import .csv / .tsv / .txt
                  <input type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }} disabled={!pointsWritable}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      f.text().then((t) => parsePoints(t, f.name));
                      e.target.value = '';
                    }} />
                </label>
              </div>
              {report && (
                <div className="note-panel">
                  <ul style={{ margin: 0, paddingLeft: 16 }}>{report.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
              )}
            </div>
          </div>
        </Block>
      )}
    </>
  );
}

/* ══ Users & roles ═════════════════════════════════════════════════════ */

export function Users() {
  const { state, ui, apply, inviteUser, removeUser, setUi } = useStore();
  const tenant = useTenant()!;
  const users = state.users.filter((u) => u.tenantId === tenant.id);
  const [draft, setDraft] = useState({ name: '', email: '', role: 'preparer' });
  const [sending, setSending] = useState(false);
  const admin = canAdmin(ui.role) || roleById(ui.role).sign === 2;

  const partners = users.filter((u) => roleById(u.role).sign === 2);
  /** INVARIANTS §7 — the last partner cannot be removed or demoted. */
  const isLastPartner = (u: User) => roleById(u.role).sign === 2 && partners.length === 1;
  const sendInvite = async (name: string, email: string, role: string) => {
    setSending(true);
    try {
      await inviteUser(name, email, role);
      return true;
    } catch (err) {
      setUi({ toast: { kind: 'refused', text: err instanceof Error ? err.message : 'Could not send the invitation.' } });
      return false;
    } finally {
      setSending(false);
    }
  };
  const dropUser = async (u: User) => {
    setSending(true);
    try {
      await removeUser(u.id);
    } catch (err) {
      setUi({ toast: { kind: 'refused', text: err instanceof Error ? err.message : 'Could not remove that user.' } });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Block kicker="Users & roles" title={`${users.length} user${users.length === 1 ? '' : 's'}`}
        note="Role gating is by capability, not by screen. The role list is engine vocabulary and deliberately fixed — a custom role would be a permission that silently does nothing. An invitation is a Clerk email; the first time they sign in, this roster row is claimed by that work email.">
        <SheetTable
          rows={users}
          rowKey={(u) => u.id}
          noun="users"
          columns={[
            { key: 'name', header: 'Name', value: (u) => u.name, cell: (u) => (
              <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{u.name}{u.isOwner && <Tag kind="accent"> owner</Tag>}</span>
            ) },
            { key: 'email', header: 'Email', value: (u) => u.email, cell: (u) => u.email },
            { key: 'role', header: 'Role', value: (u) => roleById(u.role).label, cell: (u) => (
              <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} value={u.role}
                disabled={!admin || isLastPartner(u)}
                title={isLastPartner(u) ? 'This is the last engagement partner on the tenant. With none, nothing could ever be signed off.' : undefined}
                onChange={(e) => apply('Change role', 'admin',
                  `${u.name} moved from ${roleById(u.role).label} to ${roleById(e.target.value).label}.`,
                  (s) => { const x = s.users.find((y) => y.id === u.id)!; x.role = e.target.value; })}>
                {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            ) },
            { key: 'note', header: 'What the role can do', value: (u) => roleById(u.role).note, tdClassName: 'muted', tdStyle: { whiteSpace: 'normal', maxWidth: 320 }, cell: (u) => roleById(u.role).note },
            { key: 'mfa', header: 'MFA', value: (u) => u.mfa, cell: (u) => u.mfa },
            { key: 'signin', header: 'Sign-in', value: (u) => userSignInLabel(u), cell: (u) => (
              u.sessionActive ? 'Signed in' : <span className="muted">{userSignInLabel(u)}</span>
            ) },
            { key: 'act', header: '', cell: (u) => (
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                {admin && u.pendingInvite && (
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={sending}
                    onClick={() => sendInvite(u.name, u.email, u.role)}
                  >
                    Resend
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" disabled={!admin || isLastPartner(u) || sending}
                  title={isLastPartner(u) ? 'The last engagement partner cannot be removed — with none, nothing could ever be signed off.' : undefined}
                  onClick={() => dropUser(u)}>Remove</button>
              </div>
            ) },
          ]}
        />
        {partners.length === 1 && (
          <div className="note-panel" style={{ marginTop: 12 }}>
            {partners[0].name} is the only engagement partner on this tenant, so they cannot be removed or demoted.
            With no partner, nothing could ever be signed off — the screen says so now rather than failing later.
          </div>
        )}
      </Block>

      {admin && (
        <Block kicker="Add" title="Invite a user"
          note="Sends a Clerk invitation to the work email. If they already have an account, they are added to this tenant with no email — they see it the next time they sign in.">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 160px' }}><Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field></div>
            <div style={{ flex: '1 1 200px' }}><Field label="Work email"><input className="input" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field></div>
            <div style={{ flex: '0 0 170px' }}><Field label="Role">
              <select className="input" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select></Field></div>
            <button
              className="btn btn-primary btn-sm"
              disabled={sending || !draft.name.trim() || !draft.email.trim()}
              onClick={async () => {
                const next = { ...draft };
                const ok = await sendInvite(next.name.trim(), next.email.trim(), next.role);
                if (ok) setDraft({ name: '', email: '', role: 'preparer' });
              }}
            >
              {sending ? 'Sending…' : 'Send invitation'}
            </button>
          </div>
        </Block>
      )}
    </>
  );
}

/* ══ Frameworks ════════════════════════════════════════════════════════ */

export function Frameworks() {
  const { state, ui, apply } = useStore();
  const tenant = useTenant()!;
  const admin = canConfigureTenant(ui.role);
  const fws = state.settings[tenant.id].frameworks;
  const selected = state.settings[tenant.id].defaults.frameworkId || 'ifrs';
  const axes = Object.keys(fws[0]?.axes ?? {});
  const [openId, setOpenId] = useState(fws[0]?.id ?? '');
  const open = fws.find((f) => f.id === openId);

  return (
    <>
      <Block kicker="Default for new units" title="Which framework a new reporting unit starts on"
        note="Policy axes and engine effects are engine vocabulary — they are not editable, because changing them would change the maths without a matching engine. What this tenant owns is which framework a new reporting unit inherits. An existing unit keeps the framework it was created with until it is opened and reassigned in measurement.">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {fws.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`btn btn-${selected === f.id ? 'primary' : 'secondary'} btn-sm`}
              disabled={!admin}
              aria-pressed={selected === f.id}
              onClick={() => apply('Set default framework', 'admin',
                `New reporting units will start on ${f.name}.`,
                (s) => { s.settings[tenant.id].defaults.frameworkId = f.id; })}
            >
              {f.name}
            </button>
          ))}
        </div>
      </Block>

      <Block kicker="Frameworks" title="Four frameworks, ten policy axes"
        note="The engine reads the framework assigned to each reporting unit. IFRS and discounted PSAS use a single current rate. US GAAP and ASPE store a layer per recognition event, each accreting at the rate locked on the day it arose. PSAS may dispense with discounting on the unit.">
        <SheetTable
          rows={axes.map((a) => ({ axis: a, ...Object.fromEntries(fws.map((f) => [f.id, f.axes[a]])) }))}
          rowKey={(r) => r.axis}
          noun="policy axes"
          footer={
            <tr>
              <td>Engine reads this</td>
              {fws.map((f) => <td key={f.id}>{f.wired ? <Tag kind="accent">Wired</Tag> : <Tag kind="bad">Not wired</Tag>}</td>)}
            </tr>
          }
          columns={[
            { key: 'axis', header: 'Policy axis', value: (r) => r.axis, tdStyle: { fontFamily: 'var(--font-heading)', fontWeight: 800, whiteSpace: 'nowrap' }, cell: (r) => r.axis },
            ...fws.map((f) => ({
              key: f.id,
              header: f.name,
              value: (r: { axis: string } & Record<string, string>) => r[f.id],
              tdStyle: { whiteSpace: 'normal' as const, minWidth: 180 },
              cell: (r: { axis: string } & Record<string, string>) => r[f.id],
            })),
          ]}
        />
      </Block>

      <Block kicker="Engine effects" title="What each framework actually changes">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {fws.map((f) => (
            <button key={f.id} className={`btn btn-${openId === f.id ? 'primary' : 'secondary'} btn-sm`} onClick={() => setOpenId(f.id)}>{f.name}</button>
          ))}
        </div>
        {open && (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
            {open.engineEffects.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        )}
      </Block>
    </>
  );
}

/* ══ Authority & security ══════════════════════════════════════════════ */

export function Authority() {
  const { state, ui, apply } = useStore();
  const tenant = useTenant()!;
  const auth = state.authority[tenant.id];
  const settings = state.settings[tenant.id];
  const admin = canAdmin(ui.role) || roleById(ui.role).sign === 2;

  return (
    <>
      <Block kicker="Authority" title="Six domains, three modes"
        note="Enforcement lives in the single write path, not in the UI and not per endpoint. A write into a domain that is not 'We own it' is refused there, the refusal names the domain and the mode, and the refusal is itself logged. This is what makes the three modes one product instead of three.">
        <SheetTable
          rows={[...DOMAINS]}
          rowKey={(d) => d.id}
          noun="domains"
          columns={[
            { key: 'label', header: 'Domain', value: (d) => d.label, tdStyle: { fontFamily: 'var(--font-heading)', fontWeight: 800, whiteSpace: 'nowrap' }, cell: (d) => d.label },
            { key: 'covers', header: 'What a write here touches', value: (d) => d.covers, tdClassName: 'muted', tdStyle: { whiteSpace: 'normal', maxWidth: 300 }, cell: (d) => d.covers },
            { key: 'mode', header: 'Mode', width: 170, value: (d) => auth[d.id], cell: (d) => (
              <select className="input" style={{ minHeight: 28, fontSize: 11.5 }} value={auth[d.id]} disabled={!admin}
                onChange={(e) => apply('Change authority', 'admin',
                  `${d.label} moved from "${auth[d.id]}" to "${e.target.value}" for ${tenant.name}.`,
                  (s) => { s.authority[tenant.id][d.id as Domain] = e.target.value as AuthorityMode; })}>
                {AUTHORITY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) },
            { key: 'means', header: 'What that means', value: (d) => MODE_NOTE[auth[d.id]], tdClassName: 'muted', tdStyle: { whiteSpace: 'normal', maxWidth: 340 }, cell: (d) => MODE_NOTE[auth[d.id]] },
          ]}
        />
      </Block>

      <Block kicker="Security" title="Retention and legal hold"
        note="SSO, SCIM and session reseeding are not tenant-owned settings. Identity is Clerk; clearing the session would wipe live data. Retention and legal hold are the levers this tenant actually owns.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
          <Field label="Retention (years)" help="How long the append-only history is kept. The change log and audit trail are write-once, so retention is the only lever over them.">
            <input className="input num" value={settings.retentionYears} disabled={!admin}
              onChange={(e) => apply('Change retention', 'admin', `Retention set to ${e.target.value} years.`,
                (s) => { s.settings[tenant.id].retentionYears = Number(e.target.value) || 0; })} />
          </Field>
          <Field label="Legal hold" help="Suspends retention deletion entirely. Nothing ages out while a hold is on.">
            <select className="input" value={settings.legalHold ? 'On' : 'Off'} disabled={!admin}
              onChange={(e) => apply('Change legal hold', 'admin', `Legal hold turned ${e.target.value.toLowerCase()}.`,
                (s) => { s.settings[tenant.id].legalHold = e.target.value === 'On'; })}>
              <option>Off</option><option>On</option>
            </select>
          </Field>
        </div>
      </Block>
    </>
  );
}

/* ══ Change log ════════════════════════════════════════════════════════ */

export function ChangeLog() {
  const { state, restoreChange, ui } = useStore();
  const tenant = useTenant()!;
  const [q, setQ] = useState('');
  const entries = useMemo(
    () => state.chg.filter((c) => c.tenantId === tenant.id)
      .filter((c) => !q.trim() || `${c.recordLabel} ${c.field} ${c.actor}`.toLowerCase().includes(q.toLowerCase())),
    [state.chg, tenant.id, q],
  );

  return (
    <Block kicker="Change log" title={`${entries.length} field-level change${entries.length === 1 ? '' : 's'}`}
      note="Write-once. A restore writes the old value back as a new logged change; the original entry stays and is marked restored. History reads forward and is never rewritten."
      actions={<input className="input" style={{ width: 240 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by record, field or actor" />}>
      {entries.length === 0 ? (
        <Empty>Nothing has been changed in this tenant yet. Edit a figure on the register and it appears here, field by field.</Empty>
      ) : (
        <SheetTable
          rows={entries}
          rowKey={(c) => c.id}
          noun="changes"
          columns={[
            { key: 'when', header: 'When', kind: 'date', value: (c) => c.at, tdStyle: { whiteSpace: 'nowrap' }, cell: (c) => c.at.replace('T', ' ').slice(0, 19) },
            { key: 'actor', header: 'Actor', value: (c) => c.actor, cell: (c) => c.actor },
            { key: 'record', header: 'Record', value: (c) => c.recordLabel, tdStyle: { whiteSpace: 'normal', maxWidth: 220 }, cell: (c) => c.recordLabel },
            { key: 'field', header: 'Field', value: (c) => c.field, cell: (c) => c.field },
            { key: 'before', header: 'Before', value: (c) => fmtVal(c.before), tdClassName: 'muted', cell: (c) => fmtVal(c.before) },
            { key: 'after', header: 'After', value: (c) => fmtVal(c.after), cell: (c) => fmtVal(c.after) },
            { key: 'act', header: '', cell: (c) => (
              c.restoredFrom
                ? <Tag kind="neutral">restore</Tag>
                : <button className="btn btn-ghost btn-sm" disabled={!canEdit(ui.role)} onClick={() => restoreChange(c)}>Restore</button>
            ) },
          ]}
        />
      )}
    </Block>
  );
}

const fmtVal = (v: unknown) =>
  v === undefined || v === null || v === '' ? '—' : typeof v === 'number' ? num(v) : String(v);

/* ══ Audit trail ═══════════════════════════════════════════════════════ */

export function AuditTrail() {
  const { state } = useStore();
  const tenant = useTenant()!;
  const [kind, setKind] = useState('all');
  const entries = state.log.filter((l) => l.tenantId === tenant.id).filter((l) => kind === 'all' || l.kind === kind);
  const refused = state.log.filter((l) => l.tenantId === tenant.id && l.kind === 'refused').length;

  return (
    <Block kicker="Audit trail" title={`${entries.length} event${entries.length === 1 ? '' : 's'}`}
      note={`Append-only. Refused writes are listed alongside accepted ones — ${refused} write${refused === 1 ? ' has' : 's have'} been refused in this tenant.`}
      actions={
        <select className="input" style={{ width: 170 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          {['all', 'write', 'refused', 'post', 'reverse', 'lock', 'sign', 'import', 'export', 'admin'].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      }>
      {entries.length === 0 ? (
        <Empty>Nothing has happened in this tenant yet.</Empty>
      ) : (
        <SheetTable
          rows={entries}
          rowKey={(l) => l.id}
          noun="events"
          columns={[
            { key: 'when', header: 'When', kind: 'date', value: (l) => l.at, tdStyle: { whiteSpace: 'nowrap' }, cell: (l) => l.at.replace('T', ' ').slice(0, 19) },
            { key: 'actor', header: 'Actor', value: (l) => l.actor, cell: (l) => l.actor },
            { key: 'action', header: 'Action', value: (l) => l.action, cell: (l) => l.action },
            { key: 'kind', header: 'Kind', value: (l) => l.kind, cell: (l) => <Tag kind={l.kind === 'refused' ? 'bad' : 'neutral'}>{l.kind}</Tag> },
            { key: 'detail', header: 'Detail', value: (l) => l.detail, tdStyle: { whiteSpace: 'normal' }, cell: (l) => l.detail },
          ]}
        />
      )}
    </Block>
  );
}

/* ══ Client portal ═════════════════════════════════════════════════════ */

const REQUESTS = [
  ['ARO register extract', 'The full obligation listing at the year end, with cost build-up and expected settlement dates.', 'Received'],
  ['Discount curve', 'The published curve at the year end, at the publisher\'s granularity.', 'Received'],
  ['Inflation assumption', 'The rate used, and the basis for it.', 'Received'],
  ['Contractor quotations', 'Supporting evidence for any cost revision above materiality.', 'Outstanding'],
  ['Licence documentation', 'Supporting evidence for any timing revision.', 'Outstanding'],
  ['GL trial balance', 'The provision accounts at the year end, for the sub-ledger reconciliation.', 'Received'],
  ['Settlement invoices', 'Actual spend against any provision released in the year.', 'Outstanding'],
  ['Prior-year signed pack', 'Last year\'s completeness pack, for the comparatives.', 'Received'],
];

export function Portal() {
  return (
    <Block kicker="Client portal" title="Request list"
      note="Read only. The list is generated from what the engine actually needs — an item appears because a calculation depends on it, not because it is on a standing checklist.">
      <SheetTable
        rows={REQUESTS.map(([item, why, status]) => ({ item, why, status }))}
        rowKey={(r) => r.item}
        noun="requests"
        columns={[
          { key: 'item', header: 'Item', value: (r) => r.item, cell: (r) => <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{r.item}</span> },
          { key: 'why', header: 'Why it is needed', value: (r) => r.why, tdClassName: 'muted', tdStyle: { whiteSpace: 'normal' }, cell: (r) => r.why },
          { key: 'status', header: 'Status', value: (r) => r.status, cell: (r) => <Tag kind={r.status === 'Received' ? 'accent' : 'warn'}>{r.status}</Tag> },
        ]}
      />
    </Block>
  );
}

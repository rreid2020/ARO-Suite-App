/**
 * Tenant-scope screens — SCREENS.md, "Tenant scope".
 *
 * Reporting units · Curve library · Users & roles · Company settings ·
 * Frameworks · Authority & security · Change log · Audit trail · Client portal.
 */

import React, { useMemo, useState } from 'react';
import { useStore, useTenant, useUnitWord } from '../../core/store';
import {
  AUTHORITY_MODES, AuthorityMode, DOMAINS, Domain, MODE_NOTE, ROLES,
  canAdmin, canCreateUnit, canEdit, roleById,
} from '../../core/authority';
import { Curve, CurvePoint, Interpolation } from '../../engine/curve';
import { isValidDate } from '../../engine/dates';
import { ENGINE_ROLES, SOURCE_TEMPLATES } from '../../seed';
import { Block, Empty, Field, money, money2, pct, Stats, Tag } from '../components';
import { buildCalendar } from '../../core/periods';
import { stepsFor } from '../../core/nav';
import { ReportingUnit, User } from '../../core/types';

/* ══ Reporting units ═══════════════════════════════════════════════════ */

export function Units() {
  const { state, ui, setUi, apply } = useStore();
  const tenant = useTenant()!;
  const word = useUnitWord();
  const units = state.units[tenant.id] ?? [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ entity: '', fyEnd: '', currency: 'GBP', sector: 'Mining' });

  // An auditor tenancy sees eight steps and the register is not one of them, so
  // opening a unit must land on a step that tenant kind actually has.
  const landing = stepsFor(tenant.kind)[0]?.id ?? 'periods';

  const prereqCount = (u: ReportingUnit) => {
    const curves = state.curves[tenant.id] ?? [];
    let n = 0;
    if (!curves.find((c) => c.id === u.curveId)) n += 1;
    if (!(state.data[u.id]?.obligations.length)) n += 1;
    if (!state.settings[tenant.id].accounts.some((a) => a.engineRole === 'ARO provision')) n += 1;
    return n;
  };

  const create = () => {
    if (!draft.entity.trim() || !isValidDate(draft.fyEnd)) return;
    const id = `u-${Date.now().toString(36)}`;
    const partner = state.users.find((x) => x.tenantId === tenant.id && roleById(x.role).sign === 2);
    apply('Create reporting unit', 'admin',
      `Created ${word.toLowerCase()} ${draft.entity} with a financial year ending ${draft.fyEnd}.`,
      (s) => {
        const unit: ReportingUnit = {
          id, tenantId: tenant.id, entity: draft.entity.trim(), client: draft.entity.trim(),
          fyEnd: draft.fyEnd, currency: draft.currency, sector: draft.sector,
          partnerUserId: partner?.id ?? '', frameworkId: 'ifrs', jurisdiction: '',
          calendarType: s.settings[tenant.id].defaults.calendarType,
          latePolicy: 'Prior-period adjustment', status: 'Not started', stage: 'Prepare',
          inflation: s.settings[tenant.id].defaults.inflation,
          contingency: s.settings[tenant.id].defaults.contingency,
          curveId: (s.curves[tenant.id] ?? [])[0]?.id ?? '',
          termConvention: s.settings[tenant.id].defaults.termConvention,
          materialityUsd: 0, materialityPct: 0, extrapolationPolicy: 'flat-last',
          dayCount: s.settings[tenant.id].defaults.dayCount,
        };
        (s.units[tenant.id] ??= []).push(unit);
        s.data[id] = {
          obligations: [], events: [], extracts: [], batches: [], settlements: [],
          freezes: [], samples: [], tickmarks: [], signatures: [],
          periods: buildCalendar(id, draft.fyEnd, unit.calendarType),
          attestedGates: [], glTotal: null, conversionAgreed: false,
          noteGenerated: false, yearLocked: false,
        };
      });
    setAdding(false);
    setDraft({ entity: '', fyEnd: '', currency: 'GBP', sector: 'Mining' });
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
        actions={canCreateUnit(ui.role) && <button className="btn btn-primary btn-sm" onClick={() => setAdding((a) => !a)}>
          {adding ? 'Cancel' : `New ${word.toLowerCase()}`}
        </button>}
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
                  {['GBP', 'USD', 'CAD', 'EUR', 'AUD', 'NOK'].map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
            </div>
            <button className="btn btn-primary btn-sm" onClick={create} disabled={!draft.entity.trim() || !isValidDate(draft.fyEnd)}>Create</button>
          </div>
        )}

        {units.length === 0 ? (
          <Empty>
            This tenant has no {word.toLowerCase()}s. The next setup task is to add a curve to the library, so
            that a {word.toLowerCase()} has a discount rate to look up, and then create the first one.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Entity</th><th>FY end</th><th>Currency</th><th>Framework</th>
                  <th>Status</th><th>Stage</th><th className="num">Obligations</th>
                  <th className="num">Prerequisites</th><th />
                </tr>
              </thead>
              <tbody>
                {units.map((u) => {
                  const n = prereqCount(u);
                  return (
                    <tr key={u.id}>
                      <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{u.entity}</td>
                      <td>{u.fyEnd}</td>
                      <td>{u.currency}</td>
                      <td>{state.settings[tenant.id].frameworks.find((f) => f.id === u.frameworkId)?.name}</td>
                      <td>{u.status}</td>
                      <td>{u.stage}</td>
                      <td className="num">{state.data[u.id]?.obligations.length ?? 0}</td>
                      <td className="num">{n === 0 ? <Tag kind="accent">Ready</Tag> : <Tag kind="warn">{n} outstanding</Tag>}</td>
                      <td>
                        <button className="btn btn-primary btn-sm" onClick={() => setUi({ unitId: u.id, screen: landing })}>Open</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Block>
    </>
  );
}

/* ══ Curve library ═════════════════════════════════════════════════════ */

export function Curves() {
  const { state, ui, apply } = useStore();
  const tenant = useTenant()!;
  const curves = state.curves[tenant.id] ?? [];
  const [openId, setOpenId] = useState<string | null>(curves[0]?.id ?? null);
  const [paste, setPaste] = useState('');
  const [report, setReport] = useState<string[] | null>(null);
  const open = curves.find((c) => c.id === openId) ?? null;
  const editable = canEdit(ui.role);

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
    if (points.length && open) {
      apply('Import curve points', 'import',
        `Loaded ${points.length} point${points.length === 1 ? '' : 's'} onto ${open.name} from ${filename}. The file name is recorded as the source of the points.`,
        (s) => {
          const c = s.curves[tenant.id].find((x) => x.id === open.id)!;
          const merged = new Map(c.points.map((p) => [p.term, p.rate]));
          for (const p of points) merged.set(p.term, p.rate);
          c.points = [...merged.entries()].map(([term, rate]) => ({ term, rate })).sort((a, b) => a.term - b.term);
          c.source = `${c.source.split(' · ')[0]} · loaded from ${filename}`;
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
        note="Points live on the curve at the publisher's granularity, not as a per-currency table of anchors. Each curve records its source, its basis and its interpolation rule, and the discount rate is always looked up from it — never entered per obligation.">
        {curves.length === 0 ? (
          <Empty>The library is empty. Without a curve there is no discount rate to look up, so no reporting unit can be measured. That is the next setup task.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Name</th><th>Currency</th><th>Basis</th><th>Interpolation</th><th>Beyond last point</th><th className="num">Points</th><th>As at</th><th>Source</th><th /></tr></thead>
              <tbody>
                {curves.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{c.name}{c.isDraft && <Tag kind="warn"> draft</Tag>}</td>
                    <td>{c.currency}</td>
                    <td>{c.basis}</td>
                    <td>{c.interpolation}</td>
                    <td>{c.extrapolation}</td>
                    <td className="num">{c.points.length}</td>
                    <td>{c.asAt}</td>
                    <td style={{ maxWidth: 260, whiteSpace: 'normal' }}>{c.source}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setOpenId(c.id)}>Points</button>
                      {editable && (
                        <button className="btn btn-ghost btn-sm" onClick={() => apply('Copy curve to draft', 'admin',
                          `Copied ${c.name} to a draft. The published curve is untouched.`,
                          (s) => {
                            s.curves[tenant.id].push({ ...structuredClone(c), id: `${c.id}-draft-${Date.now().toString(36)}`, name: `${c.name} (draft)`, isDraft: true });
                          })}>Copy to draft</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      {open && (
        <Block kicker="Points editor" title={open.name}
          note={`${open.basis}. Below the first point the first point's rate applies; beyond the last, the ${open.extrapolation} extrapolation policy applies and is stamped on the row that used it.`}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px,1fr) minmax(280px,1fr)', gap: 20 }}>
            <div>
              <div className="kicker" style={{ marginBottom: 6 }}>{open.points.length} published points</div>
              <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--color-divider)' }}>
                <table className="table">
                  <thead><tr><th className="num">Term (yrs)</th><th className="num">Rate</th>{editable && <th />}</tr></thead>
                  <tbody>
                    {open.points.map((p) => (
                      <tr key={p.term}>
                        <td className="num">{p.term}</td>
                        <td className="num">{pct(p.rate, 4)}</td>
                        {editable && (
                          <td>
                            <button className="btn btn-ghost btn-sm" onClick={() => apply('Delete curve point', 'admin',
                              `Removed the ${p.term}-year point from ${open.name}.`,
                              (s) => {
                                const c = s.curves[tenant.id].find((x) => x.id === open.id)!;
                                c.points = c.points.filter((x) => x.term !== p.term);
                              })}>Delete</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Field label="Paste points" help="Two columns: term in years, then the rate. Tab, comma or semicolon separated. A value above 1 is read as a percentage.">
                <textarea className="input" rows={7} value={paste} onChange={(e) => setPaste(e.target.value)}
                  placeholder={'0.25\t3.10\n0.50\t3.18\n0.75\t3.25'} disabled={!editable} />
              </Field>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" disabled={!editable || !paste.trim()}
                  onClick={() => { parsePoints(paste, 'pasted block'); setPaste(''); }}>Load pasted points</button>
                <label className="btn btn-secondary btn-sm" style={{ cursor: editable ? 'pointer' : 'not-allowed' }}>
                  Import .csv / .tsv / .txt
                  <input type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }} disabled={!editable}
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
  const { state, ui, apply } = useStore();
  const tenant = useTenant()!;
  const users = state.users.filter((u) => u.tenantId === tenant.id);
  const [draft, setDraft] = useState({ name: '', email: '', role: 'preparer' });
  const admin = canAdmin(ui.role) || roleById(ui.role).sign === 2;

  const partners = users.filter((u) => roleById(u.role).sign === 2);
  /** INVARIANTS §7 — the last partner cannot be removed or demoted. */
  const isLastPartner = (u: User) => roleById(u.role).sign === 2 && partners.length === 1;

  return (
    <>
      <Block kicker="Users & roles" title={`${users.length} user${users.length === 1 ? '' : 's'}`}
        note="Role gating is by capability, not by screen. The role list is engine vocabulary and deliberately fixed — a custom role would be a permission that silently does nothing.">
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>What the role can do</th><th>MFA</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>
                    {u.name}{u.isOwner && <Tag kind="accent"> owner</Tag>}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} value={u.role}
                      disabled={!admin || isLastPartner(u)}
                      title={isLastPartner(u) ? 'This is the last engagement partner on the tenant. With none, nothing could ever be signed off.' : undefined}
                      onChange={(e) => apply('Change role', 'admin',
                        `${u.name} moved from ${roleById(u.role).label} to ${roleById(e.target.value).label}.`,
                        (s) => { const x = s.users.find((y) => y.id === u.id)!; x.role = e.target.value; })}>
                      {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 320 }} className="muted">{roleById(u.role).note}</td>
                  <td>{u.mfa}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" disabled={!admin || isLastPartner(u)}
                      title={isLastPartner(u) ? 'The last engagement partner cannot be removed — with none, nothing could ever be signed off.' : undefined}
                      onClick={() => apply('Remove user', 'admin', `Removed ${u.name} from ${tenant.name}.`,
                        (s) => { s.users = s.users.filter((y) => y.id !== u.id); })}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {partners.length === 1 && (
          <div className="note-panel" style={{ marginTop: 12 }}>
            {partners[0].name} is the only engagement partner on this tenant, so they cannot be removed or demoted.
            With no partner, nothing could ever be signed off — the screen says so now rather than failing later.
          </div>
        )}
      </Block>

      {admin && (
        <Block kicker="Add" title="Invite a user">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 160px' }}><Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field></div>
            <div style={{ flex: '1 1 200px' }}><Field label="Work email"><input className="input" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field></div>
            <div style={{ flex: '0 0 170px' }}><Field label="Role">
              <select className="input" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select></Field></div>
            <button className="btn btn-primary btn-sm" disabled={!draft.name.trim() || !draft.email.trim()}
              onClick={() => {
                apply('Add user', 'admin', `Added ${draft.name} to ${tenant.name} as ${roleById(draft.role).label}.`,
                  (s) => s.users.push({ id: `u-${Date.now().toString(36)}`, tenantId: tenant.id, name: draft.name.trim(), email: draft.email.trim(), role: draft.role, mfa: 'Not enrolled' }));
                setDraft({ name: '', email: '', role: 'preparer' });
              }}>Add</button>
          </div>
        </Block>
      )}
    </>
  );
}

/* ══ Frameworks ════════════════════════════════════════════════════════ */

export function Frameworks() {
  const { state } = useStore();
  const tenant = useTenant()!;
  const fws = state.settings[tenant.id].frameworks;
  const axes = Object.keys(fws[0]?.axes ?? {});
  const [openId, setOpenId] = useState(fws[0]?.id ?? '');
  const open = fws.find((f) => f.id === openId);

  return (
    <>
      <Block kicker="Frameworks" title="Four frameworks, ten policy axes"
        note="IFRS, US GAAP, PSAS and ASPE are modelled and assignable per reporting unit, but the engine does not yet read the assignment. US GAAP and ASPE need layers with a rate per layer; PSAS needs optional discounting. That is decision 2 in the handoff and it changes the schema, so it is stated here rather than implied.">
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr><th>Policy axis</th>{fws.map((f) => <th key={f.id}>{f.name}</th>)}</tr>
            </thead>
            <tbody>
              {axes.map((a) => (
                <tr key={a}>
                  <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, whiteSpace: 'nowrap' }}>{a}</td>
                  {fws.map((f) => <td key={f.id} style={{ whiteSpace: 'normal', minWidth: 180 }}>{f.axes[a]}</td>)}
                </tr>
              ))}
              <tr>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>Engine reads this</td>
                {fws.map((f) => <td key={f.id}>{f.wired ? <Tag kind="accent">Wired</Tag> : <Tag kind="bad">Not wired</Tag>}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
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
  const { state, ui, apply, storageBytes, reset } = useStore();
  const tenant = useTenant()!;
  const auth = state.authority[tenant.id];
  const settings = state.settings[tenant.id];
  const admin = canAdmin(ui.role) || roleById(ui.role).sign === 2;

  return (
    <>
      <Block kicker="Authority" title="Six domains, three modes"
        note="Enforcement lives in the single write path, not in the UI and not per endpoint. A write into a domain that is not 'We own it' is refused there, the refusal names the domain and the mode, and the refusal is itself logged. This is what makes the three modes one product instead of three.">
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Domain</th><th>What a write here touches</th><th style={{ width: 170 }}>Mode</th><th>What that means</th></tr></thead>
            <tbody>
              {DOMAINS.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, whiteSpace: 'nowrap' }}>{d.label}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 300 }} className="muted">{d.covers}</td>
                  <td>
                    <select className="input" style={{ minHeight: 28, fontSize: 11.5 }} value={auth[d.id]} disabled={!admin}
                      onChange={(e) => apply('Change authority', 'admin',
                        `${d.label} moved from "${auth[d.id]}" to "${e.target.value}" for ${tenant.name}.`,
                        (s) => { s.authority[tenant.id][d.id as Domain] = e.target.value as AuthorityMode; })}>
                      {AUTHORITY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 340 }} className="muted">{MODE_NOTE[auth[d.id]]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>

      <Block kicker="Security" title="Retention, hold and identity">
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
          <Field label="SSO"><select className="input" value={settings.sso ? 'Enabled' : 'Disabled'} disabled><option>Enabled</option><option>Disabled</option></select></Field>
          <Field label="SCIM provisioning"><select className="input" value={settings.scim ? 'Enabled' : 'Disabled'} disabled><option>Enabled</option><option>Disabled</option></select></Field>
        </div>
      </Block>

      <Block kicker="Session" title="Local session size"
        note="This build keeps state in the browser behind a repository interface. That is the demo affordance the backend replaces — it is not the product's storage story.">
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>
            {(storageBytes / 1024).toFixed(0)} KB
          </div>
          <button className="btn btn-secondary btn-sm" onClick={reset}>Clear session and reseed</button>
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
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>When</th><th>Actor</th><th>Record</th><th>Field</th><th>Before</th><th>After</th><th /></tr></thead>
            <tbody>
              {entries.slice(0, 300).map((c) => (
                <tr key={c.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{c.at.replace('T', ' ').slice(0, 19)}</td>
                  <td>{c.actor}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 220 }}>{c.recordLabel}</td>
                  <td>{c.field}</td>
                  <td className="muted">{fmtVal(c.before)}</td>
                  <td>{fmtVal(c.after)}</td>
                  <td>
                    {c.restoredFrom
                      ? <Tag kind="neutral">restore</Tag>
                      : <button className="btn btn-ghost btn-sm" disabled={!canEdit(ui.role)} onClick={() => restoreChange(c)}>Restore</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}

const fmtVal = (v: unknown) =>
  v === undefined || v === null || v === '' ? '—' : typeof v === 'number' ? money2(v) : String(v);

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
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Kind</th><th>Detail</th></tr></thead>
            <tbody>
              {entries.slice(0, 300).map((l) => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{l.at.replace('T', ' ').slice(0, 19)}</td>
                  <td>{l.actor}</td>
                  <td>{l.action}</td>
                  <td><Tag kind={l.kind === 'refused' ? 'bad' : 'neutral'}>{l.kind}</Tag></td>
                  <td style={{ whiteSpace: 'normal' }}>{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th>Item</th><th>Why it is needed</th><th>Status</th></tr></thead>
          <tbody>
            {REQUESTS.map(([item, why, status]) => (
              <tr key={item}>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{item}</td>
                <td style={{ whiteSpace: 'normal' }} className="muted">{why}</td>
                <td><Tag kind={status === 'Received' ? 'accent' : 'warn'}>{status}</Tag></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  );
}

/* ══ Company settings ══════════════════════════════════════════════════ */

const TABS = ['Step defaults', 'Lists & accounts', 'Chart of accounts & coding block', 'Close & templates', 'Source templates', 'Match rules'];

export function Company() {
  const { state, ui, setUi, apply } = useStore();
  const tenant = useTenant()!;
  const s = state.settings[tenant.id];
  const tab = ui.tab || TABS[0];
  const admin = canAdmin(ui.role) || roleById(ui.role).sign === 2;

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 18 }}>
        {TABS.map((t) => (
          <button key={t} className={`btn btn-${tab === t ? 'primary' : 'secondary'} btn-sm`} onClick={() => setUi({ tab: t })}>{t}</button>
        ))}
      </div>

      {tab === 'Step defaults' && (
        <Block kicker="Defaults" title="Applied to a new reporting unit"
          note="These are starting values only. Once a reporting unit exists, its assumptions belong to it — INVARIANTS §9 puts inflation and the year end in the assumptions library, per unit.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
            <Field label="Inflation / escalation rate (%)" help="Escalates the cost estimate from its price date to the year end, and on to settlement. Enter 2.5 for 2.5%.">
              <input className="input num" defaultValue={(s.defaults.inflation * 100).toFixed(2)} disabled={!admin}
                onBlur={(e) => apply('Change default inflation', 'admin', `Default inflation set to ${e.target.value}%.`,
                  (x) => { x.settings[tenant.id].defaults.inflation = (Number(e.target.value) || 0) / 100; })} />
            </Field>
            <Field label="Contingency (% of direct cost)" help="Applied once, before escalation, so it applies to the revised figure including any cost revisions.">
              <input className="input num" defaultValue={(s.defaults.contingency * 100).toFixed(2)} disabled={!admin}
                onBlur={(e) => apply('Change default contingency', 'admin', `Default contingency set to ${e.target.value}%.`,
                  (x) => { x.settings[tenant.id].defaults.contingency = (Number(e.target.value) || 0) / 100; })} />
            </Field>
            <Field label="Day count convention" help="30/360 US (DAYS360) everywhere, including display. This is engine vocabulary and changing it would change every term in the product.">
              <select className="input" value={s.defaults.dayCount} disabled><option>{s.defaults.dayCount}</option></select>
            </Field>
            <Field label="Settlement term rounding" help="Rounded up to the next whole year (SAP) is the default and INVARIANTS §9 says never to change it.">
              <select className="input" value={s.defaults.termConvention} disabled><option>{s.defaults.termConvention}</option></select>
            </Field>
          </div>
        </Block>
      )}

      {tab === 'Chart of accounts & coding block' && (
        <>
          <Block kicker="Chart of accounts" title={`${s.accounts.length} accounts`}
            note="The organisation owns account codes and names. The engine only needs to know which account plays each part, so the engine role is the join, not the code — the engine never posts to a hard-coded account code.">
            <div className="scroll-x">
              <table className="table">
                <thead><tr><th>Code</th><th>Name</th><th>Class</th><th style={{ width: 220 }}>Engine role</th></tr></thead>
                <tbody>
                  {s.accounts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.code}</td>
                      <td>{a.name}</td>
                      <td>{a.cls}</td>
                      <td>
                        <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} value={a.engineRole} disabled={!admin}
                          onChange={(e) => apply('Change engine role', 'admin',
                            `Account ${a.code} now plays "${e.target.value}".`,
                            (x) => { x.settings[tenant.id].accounts.find((y) => y.id === a.id)!.engineRole = e.target.value; })}>
                          <option value="">— unassigned —</option>
                          {ENGINE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <RoleCoverage accounts={s.accounts} />
          </Block>

          <Block kicker="Coding block" title={`${s.segments.length} segments`}>
            <div className="scroll-x">
              <table className="table">
                <thead><tr><th className="num">Order</th><th>Segment</th><th>Required</th><th>Permitted values</th></tr></thead>
                <tbody>
                  {s.segments.map((seg) => (
                    <tr key={seg.id}>
                      <td className="num">{seg.ord}</td>
                      <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{seg.name}</td>
                      <td>{seg.required ? 'Yes' : 'No'}</td>
                      <td>{seg.permitted.length ? seg.permitted.join(', ') : <span className="muted">any</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Block>
        </>
      )}

      {tab === 'Lists & accounts' && (
        <Block kicker="Posting rules" title={`${s.postingRules.length} rules`}
          note="An event with no posting rule fails into suspense, never to a default account.">
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Event</th><th>Debit</th><th>Credit</th><th>Emitted by the engine</th></tr></thead>
              <tbody>
                {s.postingRules.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{r.eventType}</td>
                    <td>{r.debitRole}</td>
                    <td>{r.creditRole}</td>
                    <td>{r.engineEmitted ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      {tab === 'Source templates' && (
        <Block kicker="Source templates" title={`${SOURCE_TEMPLATES.length} templates`}
          note="Only the SAP mapping template is marked validated against live data. The other seven say template-only on their face — provenance travels with the figure, and that includes the provenance of the mapping.">
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Template</th><th>Status</th><th>What that means</th></tr></thead>
              <tbody>
                {SOURCE_TEMPLATES.map((t) => (
                  <tr key={t.name}>
                    <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{t.name}</td>
                    <td>{t.validated ? <Tag kind="accent">Validated</Tag> : <Tag kind="warn">Template only</Tag>}</td>
                    <td style={{ whiteSpace: 'normal' }} className="muted">
                      {t.validated
                        ? 'Mapped and tested against a live extract from this system.'
                        : 'Written from the vendor schema and not yet tested against a live extract. Check the mapping before relying on it.'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      {tab === 'Close & templates' && <CloseTemplates />}
      {tab === 'Match rules' && <MatchRules />}
    </>
  );
}

function RoleCoverage({ accounts }: { accounts: { engineRole: string; code: string }[] }) {
  const problems: string[] = [];
  for (const role of ENGINE_ROLES) {
    const held = accounts.filter((a) => a.engineRole === role);
    if (held.length === 0) problems.push(`"${role}" is not held by any account. Its events will go to suspense (99999).`);
    if (held.length > 1) problems.push(`"${role}" is held by ${held.length} accounts (${held.map((h) => h.code).join(', ')}). Which one posts is a coin toss.`);
  }
  if (!problems.length) {
    return <div className="note-panel" style={{ marginTop: 12 }}>Every engine role is held by exactly one account.</div>;
  }
  return (
    <div className="note-panel" style={{ marginTop: 12, borderLeftColor: 'var(--warn)' }}>
      <ul style={{ margin: 0, paddingLeft: 16 }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
    </div>
  );
}

const SUB_TABS = ['Close calendar', 'Period close checklist', 'Sign-off gates', 'Client request list', 'Cost build-up template'];

function CloseTemplates() {
  const { ui, setUi } = useStore();
  const sub = ui.sub || SUB_TABS[0];
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {SUB_TABS.map((t) => (
          <button key={t} className={`btn btn-${sub === t ? 'primary' : 'secondary'} btn-sm`} onClick={() => setUi({ sub: t })}>{t}</button>
        ))}
      </div>
      <Block kicker="Template" title={sub}
        note="Reference data the customer owns. DOMAIN-MODEL sorts every list into reference data the customer owns and engine vocabulary that is correctly fixed — this is the first kind, so it takes full create, update and delete.">
        <Empty>
          The {sub.toLowerCase()} template is tenant reference data. It is edited here and applied when a reporting unit
          is created; changing it does not retrospectively alter a unit that already has its own copy.
        </Empty>
      </Block>
    </>
  );
}

function MatchRules() {
  return (
    <Block kicker="Match rules" title="How incoming rows find their obligation"
      note="A match rule finding two or more obligations stops and holds the row as ambiguous with its candidates listed, for a person to choose. Loading a balance onto the wrong obligation is worse than not loading it.">
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th className="num">Order</th><th>Rule</th><th>Matches on</th><th>If more than one matches</th></tr></thead>
          <tbody>
            {[
              ['1', 'Exact reference', 'The obligation reference, character for character', 'Cannot happen — references are unique'],
              ['2', 'Asset identifier', 'The asset number carried on the source row', 'Held as ambiguous with candidates listed'],
              ['3', 'Site and type', 'Site plus obligation type', 'Held as ambiguous with candidates listed'],
              ['4', 'Crosswalk alias', 'A recorded alias for a legacy reference', 'Held as ambiguous with candidates listed'],
            ].map(([n, rule, on, amb]) => (
              <tr key={n}>
                <td className="num">{n}</td>
                <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{rule}</td>
                <td>{on}</td>
                <td className="muted">{amb}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  );
}

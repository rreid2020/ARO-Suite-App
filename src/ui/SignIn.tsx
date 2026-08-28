/**
 * Install scope — SCREENS.md.
 *
 * Sign in, the tenant list, and tenant provisioning. "A new tenant starts
 * genuinely empty — no reporting units, no curve library, no obligations, no
 * users but the creator, who becomes the first engagement partner because
 * somebody has to be able to sign off. This path is how architecture blockers
 * surface; keep it."
 */

import React, { useState } from 'react';
import { useStore } from '../core/store';
import { TENANT_KINDS, TenantKind } from '../core/authority';
import { emptyTenant } from '../seed';
import { Field } from './components';

const FACTS = [
  ['Day count', '30/360 US'],
  ['Audit trail', 'Immutable'],
  ['Hand-off', 'Excel with formulas'],
  ['Deployment', 'SaaS / on-prem'],
];

export function SignIn() {
  const { state, setUi, apply } = useStore();
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [tName, setTName] = useState('');
  const [tKind, setTKind] = useState<TenantKind>('Reporting entity');
  const [tUser, setTUser] = useState('');
  const [tEmail, setTEmail] = useState('');

  const enter = (tenantId: string) => {
    const user = state.users.find((u) => u.tenantId === tenantId && u.isOwner)
      ?? state.users.find((u) => u.tenantId === tenantId);
    setUi({
      signedIn: true,
      tenantId,
      userName: user?.name ?? (email.split('@')[0] || 'Demo user'),
      role: user?.role ?? 'partner',
      unitId: null,
      screen: 'units',
    });
  };

  const createDisabled = !tName.trim() || !tUser.trim() || !tEmail.trim();

  const create = () => {
    const made = emptyTenant(tName.trim(), tKind, tUser.trim(), tEmail.trim());
    apply(
      'Provision tenant', 'admin',
      `Provisioned ${made.tenant.name} as a ${tKind.toLowerCase()}. ${made.user.name} is the first engagement partner.`,
      (s) => {
        s.tenants.push(made.tenant);
        s.users.push(made.user);
        s.settings[made.tenant.id] = made.settings;
        s.authority[made.tenant.id] = made.authority;
        s.curves[made.tenant.id] = [];
        s.units[made.tenant.id] = [];
      },
    );
    setUi({ signedIn: true, tenantId: made.tenant.id, userName: made.user.name, role: 'partner', unitId: null, screen: 'units' });
  };

  const dropTenant = (id: string, name: string) => {
    apply('Delete tenant', 'admin', `Deleted the tenant ${name} and everything in it.`, (s) => {
      s.tenants = s.tenants.filter((t) => t.id !== id);
      s.users = s.users.filter((u) => u.tenantId !== id);
      for (const u of s.units[id] ?? []) delete s.data[u.id];
      delete s.units[id]; delete s.settings[id]; delete s.authority[id]; delete s.curves[id];
    });
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(420px,1fr))' }}>
      <div style={{ background: 'var(--color-accent-900)', color: 'var(--color-bg)', padding: '56px 56px 40px', display: 'flex', flexDirection: 'column', gap: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 26, height: 26, background: 'var(--color-bg)' }} />
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 19, letterSpacing: '-0.01em' }}>ARO SUITE</div>
          <div style={{ fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', border: '1px solid color-mix(in srgb,var(--color-bg) 40%,transparent)', padding: '2px 6px' }}>
            working name
          </div>
        </div>
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 460 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 38, lineHeight: 1.05, letterSpacing: '-0.025em', textWrap: 'pretty' }}>
            Own the ARO process, end to end.
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.55, opacity: 0.82, textWrap: 'pretty' }}>
            Built for the group reporting teams who prepare asset retirement obligations — extract intake,
            independent recalculation, roll-forward, disclosure note and postings in one file. Your auditor
            works the same engagement as a specialist working paper, and takes the Excel with the formulas intact.
          </div>
          <div style={{ display: 'flex', gap: 24, paddingTop: 12, borderTop: '1px solid color-mix(in srgb,var(--color-bg) 25%,transparent)', flexWrap: 'wrap' }}>
            {FACTS.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.7 }}>{k}</div>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 14 }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: 56, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 24 }}>
        <div style={{ maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, letterSpacing: '-0.02em' }}>Sign in</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5 }} className="muted">
              Single sign-on is configured per tenant. Demo build — any credentials work.
            </div>
          </div>

          <Field label="Work email">
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@firm.com" />
          </Field>
          <Field label="Password">
            <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" />
          </Field>
          <button className="btn btn-primary" onClick={() => state.tenants[0] && enter(state.tenants[0].id)}>Sign in</button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 18, borderTop: '2px solid var(--color-divider)' }}>
            <div className="kicker">Enter a tenant — reporting entity first</div>
            {state.tenants.map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'stretch', background: 'var(--color-surface)', borderLeft: '3px solid var(--color-accent)' }}>
                <button
                  onClick={() => enter(t.id)}
                  style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', background: 'transparent', border: 0, padding: '10px 12px', cursor: 'pointer', fontFamily: 'var(--font-body)' }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 13 }}>{t.name}</div>
                    <div style={{ fontSize: 11 }} className="muted">
                      {(state.units[t.id] ?? []).length} reporting unit{(state.units[t.id] ?? []).length === 1 ? '' : 's'} · {t.env}
                    </div>
                  </div>
                  <div style={{ fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-accent)', flex: 'none' }}>{t.kind}</div>
                </button>
                {t.custom && (
                  <button
                    onClick={() => dropTenant(t.id, t.name)}
                    title="Delete this tenant and everything in it"
                    style={{ flex: 'none', background: 'transparent', border: 0, borderLeft: '1px solid var(--color-divider)', padding: '0 11px', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 12 }}
                    className="muted"
                  >Delete</button>
                )}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 18, borderTop: '2px solid var(--color-divider)' }}>
            <div className="kicker">Or set up a new tenant</div>
            <div style={{ fontSize: 11.5, lineHeight: 1.5, textWrap: 'pretty' }} className="muted">
              A new tenant starts genuinely empty — no reporting units, no curve library and no obligations.
              You become its first engagement partner, because somebody has to be able to sign off.
            </div>
            <Field label="Organisation">
              <input className="input" value={tName} onChange={(e) => setTName(e.target.value)} placeholder="e.g. Northgate Energy Ltd" />
            </Field>
            <Field label="Type">
              <select className="input" value={tKind} onChange={(e) => setTKind(e.target.value as TenantKind)}>
                {TENANT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </Field>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 150px' }}>
                <Field label="Your name">
                  <input className="input" value={tUser} onChange={(e) => setTUser(e.target.value)} placeholder="e.g. R. Achebe" />
                </Field>
              </div>
              <div style={{ flex: '1 1 170px' }}>
                <Field label="Your work email">
                  <input className="input" value={tEmail} onChange={(e) => setTEmail(e.target.value)} placeholder="name@company.com" />
                </Field>
              </div>
            </div>
            <button className="btn btn-primary" onClick={create} disabled={createDisabled}>Create tenant &amp; enter</button>
          </div>
        </div>
      </div>
    </div>
  );
}

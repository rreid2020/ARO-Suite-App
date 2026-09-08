/**
 * Install scope — SCREENS.md.
 *
 * Sign-in is Clerk. A new tenant starts genuinely empty — no reporting units,
 * no curve library, no obligations, no users but the creator, who becomes the
 * first engagement partner because somebody has to be able to sign off.
 */

import React, { useEffect, useState } from 'react';
import { SignIn as ClerkSignIn, SignUp as ClerkSignUp, useAuth, useUser } from '@clerk/react';
import { useStore } from '../core/store';
import { TENANT_KINDS, TenantKind } from '../core/authority';
import { landingScreen } from '../core/setup';
import { Field } from './components';
import { AroWordmark } from './Logo';
import { aroClerkAppearance } from './clerkAppearance';

const FACTS = [
  ['Day count', '30/360 US'],
  ['Audit trail', 'Immutable'],
  ['Hand-off', 'Excel with formulas'],
  ['Deployment', 'SaaS / on-prem'],
];

function useSignUpMode() {
  const read = () => {
    const q = new URLSearchParams(window.location.search);
    return q.get('auth') === 'signup' || q.has('__clerk_ticket') || q.has('clerk_ticket');
  };
  const [signup, setSignup] = useState(read);
  useEffect(() => {
    const sync = () => setSignup(read());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return signup;
}

export function SignIn() {
  const { state, setUi, createTenant, loadSample, deleteTenant, ready } = useStore();
  const { user } = useUser();
  const { isSignedIn, isLoaded: clerkLoaded } = useAuth();
  const signingUp = useSignUpMode();
  const [tName, setTName] = useState('');
  const [tKind, setTKind] = useState<TenantKind>('Reporting entity');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const email = user?.primaryEmailAddress?.emailAddress ?? '';
  const displayName = user?.fullName || email.split('@')[0] || 'User';

  const enter = (tenantId: string) => {
    const mine = state.users.find((u) => u.tenantId === tenantId && u.email === email)
      ?? state.users.find((u) => u.tenantId === tenantId && u.isOwner)
      ?? state.users.find((u) => u.tenantId === tenantId);
    setUi({
      signedIn: true,
      tenantId,
      userName: displayName,
      role: mine?.role ?? 'partner',
      unitId: null,
      screen: landingScreen(state, tenantId),
    });
  };

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const id = await createTenant(tName.trim(), tKind);
      setUi({
        signedIn: true,
        tenantId: id,
        userName: displayName,
        role: 'partner',
        unitId: null,
        screen: 'setup',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create tenant');
    } finally {
      setBusy(false);
    }
  };

  const sample = async () => {
    setBusy(true); setError(null);
    try {
      await loadSample();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sample data');
    } finally {
      setBusy(false);
    }
  };

  const dropTenant = async (id: string) => {
    setBusy(true); setError(null);
    try {
      await deleteTenant(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete tenant');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(420px,1fr))' }}>
      <div style={{ background: 'var(--color-accent-900)', color: 'var(--color-bg)', padding: '56px 56px 40px', display: 'flex', flexDirection: 'column', gap: 32 }}>
        <AroWordmark inverse size={26} />
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 460 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 38, lineHeight: 1.05, letterSpacing: '-0.025em', textWrap: 'pretty' }}>
            Own the ARO process, end to end.
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.55, opacity: 0.82, textWrap: 'pretty' }}>
            Built for the group reporting teams who prepare asset retirement obligations — extract intake,
            measurement, roll-forward, disclosure note and postings in one file.
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
          <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 22 }}>
          {!clerkLoaded ? (
            <div className="muted">Loading…</div>
          ) : !isSignedIn ? (
            <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, letterSpacing: '-0.02em' }}>
                {signingUp ? 'Create an account' : 'Sign in'}
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.5 }} className="muted">
                {signingUp
                  ? 'Use the work email you were invited with. After you create the account you will see the tenants you belong to.'
                  : 'Use your work account. New tenants start empty; you become the first engagement partner.'}
              </div>
            </div>
            {signingUp ? (
              <ClerkSignUp appearance={aroClerkAppearance()} signInUrl="/" />
            ) : (
              <ClerkSignIn appearance={aroClerkAppearance()} signUpUrl="/?auth=signup" />
            )}
            </>
          ) : !ready ? (
              <div className="muted">Loading your workspaces…</div>
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, letterSpacing: '-0.02em' }}>Choose a tenant</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.5 }} className="muted">
                    Signed in as {displayName}. Data is stored in Postgres, scoped to tenants you belong to.
                  </div>
                </div>
                {error && <div className="toast toast-refused" role="alert">{error}</div>}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: '2px solid var(--color-divider)' }}>
                  <div className="kicker">Your tenants</div>
                  {!state.tenants.length && (
                    <div className="muted" style={{ fontSize: 12.5 }}>No tenants yet. Create one, or load the sample dataset.</div>
                  )}
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
                          onClick={() => dropTenant(t.id)}
                          disabled={busy}
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
                  <Field label="Organisation">
                    <input className="input" value={tName} onChange={(e) => setTName(e.target.value)} placeholder="e.g. Northgate Energy Ltd" />
                  </Field>
                  <Field label="Type">
                    <select className="input" value={tKind} onChange={(e) => setTKind(e.target.value as TenantKind)}>
                      {TENANT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </Field>
                  <button className="btn btn-primary" onClick={create} disabled={busy || !tName.trim()}>
                    Create tenant &amp; enter
                  </button>
                  <button className="btn" onClick={sample} disabled={busy}>
                    Load sample data (Kestrel / Northgate / Halloran)
                  </button>
                </div>
              </>
            )}
          </div>
      </div>
    </div>
  );
}

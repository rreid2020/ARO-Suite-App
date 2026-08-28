import React from 'react';
import { StoreProvider, useStore } from '../core/store';
import { SignIn } from './SignIn';
import { Shell } from './Shell';
import './theme.css';

function Toast() {
  const { ui, setUi } = useStore();
  if (!ui.toast) return null;
  return (
    <div className={`toast toast-${ui.toast.kind}`} role="status">
      <span style={{ flex: 1 }}>{ui.toast.text}</span>
      <button
        onClick={() => setUi({ toast: null })}
        style={{ background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', fontSize: 12, opacity: 0.8 }}
      >Dismiss</button>
    </div>
  );
}

function Root() {
  const { ui } = useStore();
  return (
    <>
      {ui.signedIn && ui.tenantId ? <Shell /> : <SignIn />}
      <Toast />
    </>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Root />
    </StoreProvider>
  );
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import { App } from './ui/App';
import { aroClerkAppearance } from './ui/clerkAppearance';

const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!key) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is not set');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClerkProvider
      publishableKey={key}
      afterSignOutUrl="/"
      signInUrl="/"
      signUpUrl="/?auth=signup"
      appearance={aroClerkAppearance()}
    >
      <App />
    </ClerkProvider>
  </React.StrictMode>,
);

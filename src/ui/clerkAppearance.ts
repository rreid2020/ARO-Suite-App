/**
 * Clerk prebuilt SignIn / SignUp — match DESIGN-TOKENS (forest green, Archivo, radius 0).
 * @clerk/react v6 accepts `layout`; newer docs use `options`. Both are set so the logo lands.
 * Logo URL is origin-absolute so Clerk does not resolve it against accounts.dev.
 */
export function aroClerkAppearance() {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const logo = {
    logoImageUrl: `${origin}/aro-mark.svg`,
    logoPlacement: 'inside' as const,
    socialButtonsVariant: 'blockButton' as const,
    showOptionalFields: false,
  };

  return {
    variables: {
      colorPrimary: '#2f6b47',
      colorTextOnPrimaryBackground: '#f3f2f2',
      colorBackground: '#ffffff',
      colorInputBackground: '#f3f2f2',
      colorInputText: '#201e1d',
      colorText: '#201e1d',
      colorTextSecondary: '#605d5d',
      colorNeutral: '#201e1d',
      colorDanger: '#a32b16',
      colorSuccess: '#2f6b47',
      colorWarning: '#a8730d',
      borderRadius: '0px',
      fontFamily: 'Archivo, system-ui, sans-serif',
      fontFamilyButtons: 'Archivo, system-ui, sans-serif',
    },
    layout: logo,
    options: logo,
    elements: {
      card: {
        boxShadow: 'none',
        border: '2px solid #d7d3d3',
        borderRadius: '0px',
      },
      headerTitle: {
        fontFamily: 'Archivo, system-ui, sans-serif',
        fontWeight: '800',
        letterSpacing: '-0.02em',
      },
      headerSubtitle: {
        fontFamily: 'Archivo, system-ui, sans-serif',
      },
      formButtonPrimary: {
        borderRadius: '0px',
        fontWeight: '800',
        backgroundColor: '#2f6b47',
        boxShadow: 'none',
        textTransform: 'none' as const,
      },
      socialButtonsBlockButton: {
        borderRadius: '0px',
        border: '2px solid #d7d3d3',
        fontFamily: 'Archivo, system-ui, sans-serif',
      },
      formFieldInput: {
        borderRadius: '0px',
        border: '2px solid #d7d3d3',
        fontFamily: 'Archivo, system-ui, sans-serif',
      },
      footerActionLink: {
        color: '#2f6b47',
        fontWeight: '800',
      },
      identityPreviewEditButton: {
        color: '#2f6b47',
      },
    },
  };
}

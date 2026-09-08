import React from 'react';

type LogoProps = {
  inverse?: boolean;
  size?: number;
};

export function AroMark({ inverse = false, size = 26 }: LogoProps) {
  return (
    <img
      src={inverse ? '/aro-mark-inverse.svg' : '/aro-mark.svg'}
      width={size}
      height={size}
      alt=""
    />
  );
}

export function AroWordmark({ inverse = false, size = 26 }: LogoProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <AroMark inverse={inverse} size={size} />
      <div style={{
        fontFamily: 'var(--font-heading)',
        fontWeight: 800,
        fontSize: size > 20 ? 19 : 14,
        letterSpacing: '-0.01em',
      }}>ARO SUITE</div>
    </div>
  );
}

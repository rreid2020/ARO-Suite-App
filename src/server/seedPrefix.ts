import type { AppState } from '../core/types';

export function prefixSeed(state: AppState, prefix: string): AppState {
  const raw = JSON.stringify(state);
  const ids = [
    'kestrel', 'northgate', 'halloran',
    'ku1', 'ku2', 'ku3', 'nu1', 'hu1',
    'u-ka', 'u-kb', 'u-kc', 'u-kd', 'u-na', 'u-ha', 'u-hb',
  ];
  let out = raw;
  for (const id of ['ku1', 'ku2', 'ku3', 'nu1', 'hu1']) {
    out = out.replaceAll(`${id}-`, `${prefix}${id}-`);
  }
  for (const id of ids) {
    const re = new RegExp(`"${id}"`, 'g');
    out = out.replace(re, `"${prefix}${id}"`);
  }
  return JSON.parse(out) as AppState;
}

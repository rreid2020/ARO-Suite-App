import type { AppState } from '../core/types';

export function emptyAppState(): AppState {
  return {
    tenants: [],
    users: [],
    curves: {},
    units: {},
    data: {},
    settings: {},
    authority: {},
    chg: [],
    log: [],
  };
}

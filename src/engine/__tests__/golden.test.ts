/**
 * ENGINE-SPEC §9.1 — the Master Sheet golden file.
 *
 * "The client's spreadsheet, obligation by obligation, to the cent. Any
 * divergence is a defect in the port."
 *
 * The client workbook is real client data, so it is deliberately NOT committed
 * here — README.md is explicit that none of the data in the bundle should ship.
 * Instead this harness reads a golden file from `fixtures/master-sheet.json`,
 * which is gitignored. Drop the extract there and this suite becomes the
 * acceptance gate that BUILD-SEQUENCE Phase 0 requires.
 *
 * Expected shape:
 *
 * {
 *   "assumptions": { "inflation": 0.025, "contingency": 0.10,
 *                    "termConvention": "Round up to whole year (SAP)",
 *                    "fyEnd": "2025-12-31" },
 *   "curve": { ...a Curve, with its published points... },
 *   "obligations": [
 *     { "obligation": { ...an Obligation... },
 *       "expect": { "cost": 0, "cce": 0, "fv": 0, "rate": 0, "pv": 0 } }
 *   ]
 * }
 *
 * Every field in `expect` is optional; only the ones present are asserted, so a
 * partial extract still gates the parts it covers.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { derive, Assumptions, Obligation } from '../derive';
import { Curve } from '../curve';

const GOLDEN = resolve(process.cwd(), 'fixtures/master-sheet.json');

interface GoldenRow {
  obligation: Obligation;
  expect: Partial<Record<'cost' | 'cce' | 'fv' | 'rate' | 'pv' | 'curveTerm' | 'tD', number>>;
}
interface GoldenFile {
  assumptions: Assumptions;
  curve: Curve;
  priorCurve?: Curve;
  obligations: GoldenRow[];
}

const present = existsSync(GOLDEN);

describe.skipIf(!present)('Master Sheet golden file — ENGINE-SPEC §9.1', () => {
  const golden: GoldenFile = present
    ? JSON.parse(readFileSync(GOLDEN, 'utf8'))
    : ({ assumptions: {}, curve: {}, obligations: [] } as unknown as GoldenFile);

  it('has rows to check', () => {
    expect(golden.obligations.length).toBeGreaterThan(0);
  });

  it('agrees with the Master Sheet obligation by obligation, to the cent', () => {
    const divergences: string[] = [];

    for (const row of golden.obligations) {
      const d = derive(row.obligation, golden.assumptions, {
        curve: golden.curve,
        priorCurve: golden.priorCurve,
      });

      for (const [field, want] of Object.entries(row.expect) as [keyof GoldenRow['expect'], number][]) {
        const got = d[field] as number;
        // Money to the cent; rates and terms to eight places.
        const tolerance = field === 'rate' || field === 'curveTerm' || field === 'tD' ? 1e-8 : 0.005;
        if (Math.abs(got - want) > tolerance) {
          divergences.push(
            `${row.obligation.ref} · ${field}: expected ${want}, engine produced ${got} (out by ${(got - want).toFixed(6)})`,
          );
        }
      }
    }

    expect(divergences, `\n${divergences.join('\n')}\n`).toEqual([]);
  });
});

describe.skipIf(present)('Master Sheet golden file — not supplied', () => {
  it('is not present, so §9.1 is NOT yet gating this build', () => {
    // This is a standing reminder, not a failure: the rest of the suite covers
    // §9.2 through §9.9. Phase 0 is not complete until the file above exists.
    expect(present).toBe(false);
  });
});

# ARO Suite

An implementation of the ARO platform described in `design_handoff_aro_platform/`
— measuring, closing, reporting and auditing asset retirement obligations.

Built in React 18 + TypeScript + Vite, with the calculation engine as a
standalone, dependency-free library.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 102 tests
npm run build
```

Sign in with any credentials. Pick **Kestrel Minerals plc** for the fullest data;
**Halloran & Vance LLP** is the auditor tenancy and shows the same engine under a
different authority setting.

## Layout

| Path | What it is |
| --- | --- |
| `src/engine/` | The calculation engine. Pure, dependency-free, imports nothing from the app |
| `src/engine/__tests__/` | The fixtures from `ENGINE-SPEC.md` §9 |
| `src/core/` | Authority, the single write path, periods, gates, the store |
| `src/core/__tests__/` | `INVARIANTS.md` §2–§5, §7, §8 as executable acceptance criteria |
| `src/xlsx/` | The .xlsx writer, ported from the prototype. Formulas, not values |
| `src/ui/` | Shell and screens — 9 tenant screens, 26 workflow steps in five phases |
| `src/seed/` | Synthetic seed data, generated from a fixed PRNG seed |
| `reference/` | The prototype the port was read from, for comparison |

## What the handoff said to port exactly, and where it lives

**The engine** (`ENGINE-SPEC.md`) is `src/engine/`. The chain is `derive.ts`
(`price()` is §3 and is called five times to build the §6 bridge), the day count
is `dates.ts`, the term convention and curve lookup are `curve.ts`, the
roll-forward and settlement arithmetic are `rollforward.ts`. The leap-year shift
and the SAP term rounding are reproduced as specified, including where they look
wrong — see "Findings" below.

**The invariants** (`INVARIANTS.md`) are enforced structurally rather than by
convention:

- **§3 authority** — `src/core/writePath.ts`. `mut()` is the only function that
  changes a domain record. It is pure: it takes the record before and after and
  returns the value to keep plus the entries to append, so it is the same
  function on a server and in a test. The store exposes `write()` and nothing
  else; no screen can bypass it.
- **§2 append-only** — `chg` and `log` are only ever prepended to. A restore is
  a *new* write carrying `restoredFrom`; the original entry stands.
- **§4 evaluated gates** — `src/core/gates.ts`. An evaluated gate carries a
  `check` function and cannot be ticked; an attested gate carries no check and
  must be. The distinction is in the type, not in a label.
- **§5 nothing silently dropped** — a row that fails validation stays in the
  register and is reported (`useDerived().invalid`); a guarded field is refused
  *by name* with the counts written and refused; a paste reports cell by cell.
- **§8 periods** — `src/core/periods.ts`. The status machine, the partner-only
  transitions, and a fiscal calendar that belongs to the reporting unit.

## Findings

Three things worth a decision before this goes further.

**1. `ENGINE-SPEC.md` §9.2's assertion does not hold under §3's implementation.**
§9.2 asks to "assert `t1 + t2` equals the implied term and that `tD` is
unchanged". The `tD` half holds unconditionally and is tested. The `t1 + t2` half
does not.

30/360 is not additive through a mid-point: the year end is folded as `d2` in
leg 1 (a 31st folds only when the start is a 30th) but as `d1` in leg 2 (a 31st
always folds). The leap-year shift corrects that mismatch when the cost estimate
date is *not* a 30th or 31st, and introduces one when it is — and it is keyed on
the leap year, not on the day of the month, so it lands both ways:

| Cost estimate date | FY end | Settlement | Leap | `(t1+t2) − implied` |
| --- | --- | --- | --- | --- |
| 2024-06-30 | 2024-12-31 | 2030-12-31 | yes | 0 |
| 2024-06-30 | 2024-12-31 | 2030-06-30 | yes | −1/360 |
| 2023-06-30 | 2023-12-31 | 2030-06-30 | no | 0 |
| 2025-03-15 | 2025-12-31 | 2033-09-30 | no | +1/360 |

The README says to reproduce the arithmetic exactly and not to "fix" it, so the
implementation follows §3 and the divergence is pinned in
`chain.test.ts` rather than corrected. **The rationale sentence in §3 should be
rewritten, or the shift should be re-keyed on the day of the month** — but that
is a change to the client's Master Sheet agreement, not a code decision.

**2. §9.3 cites the wrong Excel mode.** It says to assert against
`DAYS360(..., TRUE)`. `TRUE` selects Excel's *European* method; the pseudocode in
§1 is the *US/NASD* method, and the two disagree (e.g. `2025-01-15 → 2025-03-31`
is 76 US, 75 European). The pseudocode is authoritative, so the fixtures assert
Excel's US results and mark the rows where the methods differ.

**3. The golden file is not yet gating.** `ENGINE-SPEC.md` §9.1 wants the client
Master Sheet asserted to the cent, and `BUILD-SEQUENCE.md` says nothing else
starts until it passes. The client workbook is real client data and `README.md`
is explicit that none of the bundle's data should ship, so it is **not
committed**. `golden.test.ts` is the harness: drop an extract at
`fixtures/master-sheet.json` (gitignored, shape documented in the file) and it
becomes the acceptance gate. Until then it reports itself as not gating rather
than passing silently. **Phase 0 is not complete without it.**

## Deliberate departures from the prototype

- **Storage.** The prototype's `localStorage` blob is not reproduced. Persistence
  is behind `src/core/repository.ts`; the application never touches storage
  directly, and the append-only tables have no update or delete on the interface.
  Swapping in an HTTP repository against the `DOMAIN-MODEL.md` schema changes
  that one file.
- **The role list** was in the truncated tail of the prototype and is
  reconstructed from the capability model in `INVARIANTS.md` §7 (`edit`, `sign`
  0/1/2, `createEng`, `admin`). Worth checking against the original.
- **Routing** is a lookup in `src/ui/screens/index.tsx` rather than a URL router,
  matching the prototype's single-page shape. Every screen is a plain component,
  so dropping in a real router is a change to that file alone.

## Not built

Scoped out rather than stubbed, and named so the gap is visible:

- **Framework policy is modelled but not wired** — this is decision 2 in the
  handoff README. US GAAP and ASPE need layers *stored* with a rate per layer;
  PSAS needs optional discounting. The Frameworks screen and the Layers step both
  say so on their face rather than showing IFRS figures under another name.
- **Multi-currency, translation reserve and consolidation** (Phase 4).
- **Close calendar and period-close checklist as editable tenant reference data** —
  the screens render the templates but do not yet take full CRUD.
- **SSO/SCIM** are surfaced as settings, not implemented.

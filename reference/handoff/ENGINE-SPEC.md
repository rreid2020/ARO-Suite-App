# Calculation engine specification

This is the part to port exactly. Everything else can be reinterpreted.

Reference implementation: `design/ARO Suite.dc.html`, the `derive()` function
and the date helpers above it. Section numbers below cite the concepts, not
line numbers, since the file will drift.

## 1 · Day count — 30/360 US (DAYS360)

Every term in the product is 30/360 US, matching the client's Master Sheet and
SAP. Never use actual/365 anywhere, including for display.

```
days360(a, b):
  d1 = day(a); d2 = day(b)
  if d1 == 31: d1 = 30
  if d2 == 31 and d1 == 30: d2 = 30
  return (year(b)-year(a))*360 + (month(b)-month(a))*30 + (d2-d1)

term360(a, b) = days360(a, b) / 360
```

All dates are ISO `YYYY-MM-DD` and all date arithmetic is UTC. A malformed
date must return the input unchanged rather than throwing — see §8.

## 2 · Inputs

Per obligation:

- `lines[]` — cost build-up: `{ qty, rate }` pairs. Direct cost = Σ qty × rate.
- `adj[]` — recorded revisions: `{ k: 'cost'|'term', amt | to, date, reason, evidence }`.
- `pk` — cost estimate date (the price date of the build-up).
- `st` — expected settlement date (overridden by the latest `k:'term'` revision).

Per reporting unit (assumptions):

- `infl` — inflation %, `cont` — contingency %, `curve` — curve name,
  `rounding` — term convention, `matUsd` / `matPct` — materiality,
  `fy` — financial year end.

## 3 · The chain, in order

```
direct     = Σ(qty × rate) + Σ(cost revisions)          # gross of contingency
cost       = direct × (1 + cont)                        # CURRENT prices, at pk
leap       = isLeapYear(year(pk))
mcd        = leap ? nextDay(fyEnd) : fyEnd              # modified cost estimate date
t1         = term360(pk,  fyEnd)                        # leg 1
t2         = term360(mcd, st)                           # leg 2
tD         = term360(fyEnd, st)                         # discount term
cce        = cost × (1 + infl)^t1                       # ESCALATED to FY end
fv         = cce  × (1 + infl)^t2                       # FV@SETTLE
curveTerm  = curveTermOf(curve, tD, rounding)           # §4
rate       = curveRate(curve, curveTerm)                # §5
pv         = tD > 0 ? fv / (1 + rate)^tD : fv           # PV@FY-END
```

**The leap-year shift is deliberate.** When the cost estimate date falls in a
leap year, the second escalation leg starts the day *after* the year end so
that the two legs sum to the implied term under 30/360. It matches a manual
adjustment in the client's Master Sheet. Discounting still runs from the year
end, so `tD` is unaffected. Do not "fix" it.

**Contingency is applied once, before escalation.** Cost revisions are entered
and displayed *gross* of contingency and are added to direct cost, so
contingency applies to the revised figure.

## 4 · Term convention (`curveTermOf`)

Chosen per reporting unit, stamped on every export. Default is the first.

| Convention | Behaviour |
| --- | --- |
| **Round up to whole year (SAP)** — *default, never change it* | `ceil(tD)` |
| Round up to the next curve point | the first published point at or beyond `tD` |
| Exact fractional years | `tD` unrounded |

The term is capped at the curve's last point; `beyond = true` is carried on the
row so extrapolation policy can be applied and disclosed.

## 5 · Curve lookup (`curveRate`)

**Points live on the curve, at the publisher's granularity** — not as a
per-currency table of anchors. The Bank of Canada bond yield curve is 120
quarter-year points over 30 years and is a first-class case. Each curve records
its source, its basis, and its interpolation rule:

- **Step** — first point at or beyond the term (correct for a published curve).
- **Linear** — straight line between the bracketing pair.

Below the first point, the first point's rate applies. Beyond the last, the
extrapolation policy (flat-last / linear / log-linear) applies and is stamped.

The discount rate is **never entered per obligation.** It is always looked up.

## 6 · Remeasurement bridge — four repricings

The bridge is the same obligation priced four times, each move changing exactly
one thing. The four effects sum to the total movement, with no residual.

```
pvBase       = price(original cost, original timing, prior rate, prior inflation)
pvCostOnly   = price(revised  cost, original timing, prior rate, prior inflation)
pvTimingOnly = price(revised  cost, revised  timing, prior rate, prior inflation)
pvRateOnly   = price(revised  cost, revised  timing, closing rate, prior inflation)
pv           = price(revised  cost, revised  timing, closing rate, closing inflation)

costEffect    = pvCostOnly   - pvBase
timingEffect  = pvTimingOnly - pvCostOnly
rateEffect    = pvRateOnly   - pvTimingOnly
inflEffect    = pv           - pvRateOnly
```

`priorCurve` / `priorInfl` are written by the year-end revaluation (§7). Before
a revaluation has run, prior equals current and the rate and inflation legs read
nil **because nothing moved** — not because they are unimplemented.

## 7 · Dated rate tables and year-end revaluation

The curve and inflation in force are **period-stamped**. A table loaded during
period *n* governs periods *after* it, so period 12 accretes on the period 11
table. Accretion is allocated weighted by balance **and** by the rate in force
for that period.

Because in-year accretion therefore lags the closing rates, the closing table
cannot simply be loaded on top. Applying it revalues the whole population, and
that movement is a **change in estimate (IAS 8 / ASC 250)** — not accretion and
not a correction. The run is explicit, gated on five live conditions (P12
accretion allocated · not already revalued · period not locked · a closing table
chosen that differs from the one in force · role can post), previewed by running
the engine twice so the figure shown is the figure posted, and reversible by a
partner with the reversal itself logged.

## 8 · Total date helpers

Every date helper must be **total**: given a malformed or half-typed string it
returns the input, never `NaN` and never a throw. This is not defensive
programming for its own sake — a user typing "2026-1" into a year-end field
previously reached `toISOString()` on an Invalid Date and threw out of render.

Three layers stand between typing and the engine, all three of which should
survive the port:

1. Total helpers (above).
2. The reporting unit's year end is validated before the model reads it; the
   last good value stands while a new one is being typed.
3. Standalone date fields are masked: digits only, dashes inserted, committed
   only when eight digits form a real date.

## 9 · Test fixtures the library needs

Write these before the UI. They are the reason to extract the engine first.

1. **Master Sheet golden file.** The client's spreadsheet, obligation by
   obligation, to the cent. Any divergence is a defect in the port.
2. **Leap-year boundary.** A cost estimate date in a leap year and one the day
   either side; assert `t1 + t2` equals the implied term and that `tD` is
   unchanged.
3. **Month-end day count.** 31st → 30th, 30th → 31st, 28/29 February, in both
   directions, against DAYS360(...,TRUE) from Excel.
4. **Term convention.** The same obligation on a quarter-year curve under all
   three conventions; assert SAP rounding and next-curve-point differ, and that
   the difference is material enough to be worth the setting.
5. **Curve edges.** Term below the first point, exactly on a point, between two
   points under both interpolation rules, beyond the last point under all three
   extrapolation policies.
6. **Bridge sums.** Random populations with cost and timing revisions and a
   revaluation applied: assert the four effects sum to the movement exactly.
7. **Roll-forward identity.** Opening + additions + accretion + revisions +
   settlements + FX = closing, per period, and the periods summing to the year.
8. **Settlement.** Full and partial: released equals provision carried × share;
   overrun to operating costs; surplus written back; a posted full settlement
   removes the obligation from the balance sheet.
9. **Zero and degenerate cases.** Nil materiality, zero-term obligation
   (settlement on the year end), settlement date before the year end, empty
   curve, empty population.

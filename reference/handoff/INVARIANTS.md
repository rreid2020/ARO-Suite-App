# Invariants

These are the acceptance criteria of the backend. Most of the prototype's UI is
one of these made visible. If the port satisfies these, it is the same product;
if it does not, it is a lookalike.

## 1 · The roll-forward identity

```
opening + additions + accretion + revisions + settlements + FX = closing
```

Per period, footing to the cent, and the periods summing to the annual
roll-forward. This single identity is three things at once: the completeness
test, the close control, and the audit assertion. Nothing may close while it
does not hold, and it must be **computed independently of the journals** — the
check that the batch's net movement to the provision accounts equals closing
less opening is only falsifiable if the two are derived separately.

## 2 · Append-only history

The event ledger, the change log and the audit trail are **write-once**. There
is no update and no delete.

- A restore writes the old value back as a **new** logged change; the original
  entry stays and is marked restored. History reads forward and is never
  rewritten.
- A re-import of a frozen dataset is a **new version with a diff** (added /
  removed / changed PV / movement in total), never an edit of the frozen one.
- A posted journal batch is immutable. Correcting it is a reversal plus a new
  batch, both logged, and reversal is partner-only.

## 3 · Authority is enforced at the data layer

Six domains — register & scoping · estimates & revisions · assumptions, curve &
materiality · periods, calendar & close · journals, postings & reconciliation ·
evidence, sampling & sign-off. Each is set per tenant to *We own it*,
*Source-owned* or *Frozen copy*, defaulted by tenant kind: a reporting entity
owns everything; an auditor owns its materiality and its conclusion and reads
the rest.

Enforcement lives in **the single write path**, not in the UI and not per
endpoint. A write into a domain that is not *We own it* is refused there, the
refusal names the domain and the mode, and the refusal is itself logged. This is
what makes the three modes one product instead of three.

## 4 · Gates are evaluated, not asserted

Every gate reads live state and computes its own result. The eight year-end lock
gates (all periods closed · annual roll-forward foots to the sum of the periods ·
conversion agreed · every batch posted · sub-ledger tied · pack signed · note
generated · year locked) run in order; a gate below an unpassed gate reads *not
reached*. The sequence cannot be skipped and the lock is partner-only.

A tenant may add its own gates. Those are labelled **attested** rather than
**evaluated**, because they are ticked by a person and not computed. Deleting an
evaluated gate must state that it removes a control.

## 5 · Nothing is silently dropped or silently resolved

- A row failing validation **stays in the register and is reported**. Dropping
  it would be a completeness assertion nobody made.
- A match rule finding two or more obligations stops and holds the row as
  **ambiguous with its candidates listed**, for a person to choose. The
  conversion load is blocked while any ambiguity is outstanding: loading a
  balance onto the wrong obligation is worse than not loading it.
- An event with no posting rule fails into **suspense**, never to a default
  account.
- A paste that will not take is **reported cell by cell**, not truncated.
- A bulk edit that hits a refused field (a settlement date held by a timing
  revision) refuses it **by name** and reports the counts written and refused.
- An incomplete reconciliation is reported as incomplete — "no GL balance
  received" — never as a pass.

## 6 · Provenance travels with the figure

Every number can name where it came from. The rule that made a link is recorded
against the link. The file name is recorded as the source of curve points. An
event derived by diffing a cumulative snapshot is **marked as derived**,
distinguishing an inferred movement from an evidenced one. Only the SAP mapping
template is marked validated against live data; the other seven say
*template-only* on their face.

Signed artefacts carry a **recalculation stamp** hashed from the register,
assumptions, curve and policy. Changing a figure invalidates the signature and
the product says so.

## 7 · Segregation of duties

Preparer approves, reviewer or partner posts, partner only reverses. Sign-off is
three-stage. The last engagement partner on a tenant cannot be removed or
demoted — with none, nothing could ever be signed off, and the screen says so
rather than failing later. The person who provisions a tenant administers it
until they appoint a firm admin, otherwise a real install locks them out
permanently.

## 8 · Period integrity

Status machine: **Future → Open → Soft closed → Closed → Locked.** Close is
preparer/reviewer; lock and reopen are partner-only; every transition is logged.
Posting into a locked period is refused. Late-arriving data is handled by a
per-unit policy — prior-period adjustment or reopen — not ad hoc.

The fiscal calendar belongs to the **reporting unit**, not the session: a June
year-end subsidiary and a December parent coexist in one tenant. Period codes
carry the **fiscal** year, not the calendar year the period end falls in.

## 9 · Conventions that must not drift

- 30/360 (DAYS360 US) day count **everywhere**, including display.
- Settlement term **rounded up to the next whole year (SAP)** is the default
  term convention. Never change the default.
- The discount rate is **looked up from the curve**, never entered per
  obligation.
- Curve points live **on the curve** at the publisher's granularity; the
  per-currency table is a seed only.
- Inflation and the FY year end live in the assumptions library.
- Variance formulas in exports stay **self-contained and paste-ready** — a
  workbook must recalculate in Excel with no external references.

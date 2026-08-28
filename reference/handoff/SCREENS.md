# Screens

Three scopes. Copy in the prototype is final and should be carried across —
it states what a control does to the accounting.

## Install scope

**Sign in.** Any credentials (demo). Below it, the tenant list — each row enters
that tenant; user-created tenants carry a delete. Below that, tenant
provisioning: organisation name, type (Reporting entity | Auditor), the person
setting it up and their email.

A new tenant **starts genuinely empty** — no reporting units, no curve library,
no obligations, no users but the creator, who becomes the first engagement
partner because somebody has to be able to sign off. Reference data starts from
supplied defaults and is editable. Empty states say what the next setup task is.
This path is how architecture blockers surface; keep it.

## Tenant scope

| Screen | Purpose |
| --- | --- |
| Reporting units | The list, with status, stage and outstanding-prerequisite count |
| Curve library | Curves with source, basis, interpolation; a points editor with add/edit/delete, paste box and file import (.csv/.tsv/.txt/.xlsx); copy to draft |
| Users & roles | Full CRUD per tenant; role list fixed; last partner protected |
| Company settings | Six tabs: Step defaults · Lists & accounts · Chart of accounts & coding block · Close & templates (five sub-tabs) · Source templates · Match rules |
| Frameworks | Ten policy axes per framework, engine effects, five-axis comparison, per-unit assignment |
| Authority & security | Six authority domains, retention, legal hold, SSO/SCIM, session size + clear |
| Change log | Field-level: field, record, before → after, with restore |
| Audit trail | Actor, action, kind, detail, timestamp; refused writes listed |
| Client portal | Read-only request list |

## Reporting-unit scope — 26 steps in five phases

**Prepare** — Periods & close · Data intake · Opening balances · Import
normalisation · Match & link · ARO scoping

**Measure** — ARO register · Cost estimates · Adjustments · Layers & framework ·
Retirement cost asset · Event ledger · Recalculation

**Close** — Close calendar · Year-end revaluation · Settlements · Journals ·
Journal batches · GL reconciliation

**Report** — Roll-forward & disclosure · Comparatives · Sensitivity

**Assure** — Evidence & freeze · Sampling & tickmarks · Completeness pack ·
Review & sign-off

An **auditor** tenancy sees eight of these: intake, normalisation, freeze,
recalculation, event ledger, sampling, completeness pack, review. A firm does
not run the client's ARO process — it tests it.

## Layout pattern

Fixed left sidebar (dark, ~230px): tenant picker, reporting-unit picker, the
step list grouped by phase, role switcher at the foot. Main column: a header
strip with the step name, its one-line purpose and its actions, then content in
full-width bordered blocks separated by 2px rules. Tables are full width with a
themed header row and row rules; wide tables scroll horizontally inside their
block rather than shrinking type.

Recurring components: the **prerequisites panel** (each dependency as Ready /
Attention / Blocked with a jump button); the **return banner** (naming the unit
and prerequisite you left to fix, with a back button and a dismiss); the
**calculation ladder** (one renderer, used in three places, collapsed by
default, each rung carrying operator, basis tag and Excel formula); **basis
tags** (CURRENT / ESCALATED / FV@SETTLE / PV@FY-END) on every monetary figure;
**field help** (a ? beside each label — hover for a tooltip, click to pin the
explanation under the input).

## The register

The one screen worth studying before building anything. It renders from a
column definition with a group header row (Identity · Asset · Dates ·
Calculated · Movement), tinted derived cells, five column sets, saved views
(column set + filter + sort, named, per reporting unit), a selection column with
select-all-on-page and select-all-filtered, bulk edit as a single logged change,
in-grid select cells for pick-list columns, keyboard navigation (Enter/↓ down the
column, ↑ up, Tab across), and Excel block paste that fills down and right and
reports what would not take.

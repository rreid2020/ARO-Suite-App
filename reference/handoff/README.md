# Handoff: ARO — Asset Retirement Obligation platform

## Overview

An application for measuring, closing, reporting and auditing asset retirement
obligations (ARO / decommissioning provisions / site restoration). It serves
three use cases from one engine:

| Mode | Who | What it does |
| --- | --- | --- |
| 1 · Recalculation & completeness | Reporting entity or auditor | Recalculates the provision independently over extracts from any finance system and reports the variance against the source figures |
| 2 · Module of record | Corporate group reporting team | Owns the ARO: periods, balances, events, journals, close, disclosure |
| 3 · Audit tool | Audit firm | Freezes the client dataset, recalculates it, samples it, concludes on it |

They are **not three products**. They are the same engine under a different
per-domain *authority* setting (see `INVARIANTS.md` §3). Build the engine once.

**Primary market is the reporting entity, not the audit firm.** A firm already
owns an audit platform and will not adopt a second login for one balance; a
group reporting team has no ARO system at all. The auditor tenancy exists and
must keep working, but it is a hand-off surface, not a parallel product.

## About the design files

The files in this bundle are **design references created in HTML**. They are
prototypes showing intended structure, behaviour and calculation — not
production code to lift. The task is to **recreate them in the target
codebase's existing environment** (React, Vue, server-rendered, native — whatever
the team already runs) using its established patterns, component library, router
and data layer. If no environment exists yet, choose the framework and build
there.

Two things in the prototype are worth *porting rather than reinterpreting*:

1. **The calculation engine** — the day count, escalation, curve lookup,
   discounting and remeasurement bridge. It is specified line by line in
   `ENGINE-SPEC.md`, and it agrees with the client's Master Sheet. Reproduce
   the arithmetic exactly, including the parts that look wrong (the leap-year
   shift, the SAP term rounding). They are deliberate.
2. **The invariants** in `INVARIANTS.md`. They are the product. Most of what
   looks like UI in the prototype is an invariant made visible.

Everything else — layout, routing, state, storage — should be rebuilt natively.

## Fidelity

**High fidelity on structure and behaviour; medium on pixels.**

- Layout, information hierarchy, table structure, empty states, gating,
  validation, wording and every number shown are final and should be
  reproduced faithfully. The copy in particular is load-bearing: it states
  what a control does to the accounting, and it was written to be read by
  someone who has never prepared an ARO.
- Visual styling follows the **Modernist** design system (tokens in
  `DESIGN-TOKENS.md`, stylesheet bundled under `design-system/`). The accent
  is overridden to forest green `#2f6b47`. If the target codebase has its own
  design system, **use it** and keep the structure — do not port these tokens
  into a house that has its own.

## What is in this bundle

| File | What it is |
| --- | --- |
| `README.md` | This document — start here |
| `ENGINE-SPEC.md` | The calculation, formula by formula, with the test fixtures the library needs |
| `DOMAIN-MODEL.md` | Entities, relationships and a proposed relational schema |
| `INVARIANTS.md` | What must always be true. The acceptance criteria of the backend |
| `SCREENS.md` | Every screen: purpose, layout, components, states |
| `BUILD-SEQUENCE.md` | Recommended order of work, with the four decisions to settle first |
| `DESIGN-TOKENS.md` | Colors, type, spacing, elevation |
| `design/ARO Suite.dc.html` | **The reference prototype.** The whole product |
| `design/ARO Recalculation.dc.html` | Single-purpose recalculation tool (the original) |
| `design/ARO Recalculation Demo.dc.html` | Frozen client-side demo build |
| `design/ARO Needs Assessment.dc.html` | The analysis the architecture came from |
| `design/ROADMAP.md` | Standing backlog: what is built, what is queued, what was decided |
| `design/ARCHITECTURE-REVIEW.md` | Prior architecture review notes |
| `design/support.js`, `design/xlsx-*.js`, `design/_ds/` | Runtime the prototypes need to open |

**To open the prototype:** serve `design/` over HTTP (`npx serve design`) and
open `ARO Suite.dc.html`. Opening it from `file://` will not work. It signs in
with any credentials; pick the **Kestrel Minerals plc** tenant for the fullest
data.

## The four decisions to settle before writing schema

1. **Extract the calculation engine as a tested library first.** It currently
   lives inside the page. It is also the only part where being wrong is a
   liability rather than a bug. Golden-file tests against the client Master
   Sheet should exist before any UI is written. See `ENGINE-SPEC.md` §9.
2. **Wire framework policy into the engine.** IFRS / US GAAP / PSAS / ASPE are
   modelled and assignable per reporting unit, but the engine does not yet read
   the assignment. US GAAP and ASPE need **layers with a rate per layer**, PSAS
   needs **optional discounting**. That changes the schema (layers become rows,
   not a derived view), so decide it now rather than migrating later.
3. **Cut the first release.** The prototype covers all three modes. A v1
   backend should not. Recommended order: Mode 1 → Mode 3 → Mode 2.
4. **Pick the deployment story.** SaaS and on-premise imply different auth,
   storage, upgrade and support work, and the productisation gates differ.

## Screens

See `SCREENS.md` for the detail. In summary the app has three scopes:

- **Install scope** — sign-in, tenant list, tenant provisioning.
- **Tenant (firm) scope** — nine screens: reporting-unit list, curve library,
  users & roles, company settings (six tabs), frameworks, authority & security,
  change log, audit trail, client portal.
- **Reporting-unit (engagement) scope** — a 26-step workflow in five phases:
  Prepare · Measure · Close · Report · Assure.

## Interactions & behaviour

Nothing here animates. Behaviour that matters is *gating*, and it is uniform:

- **Every write goes through one path** (`mut()` in the prototype). It
  deep-diffs the record before and after, writes a field-level change entry,
  checks the authority mode of the domain being written, and refuses the write
  with a named reason if the domain is not owned. Reproduce this as a single
  server-side write path, not as per-endpoint checks.
- **Role gating** is by capability, not by screen: `edit`, `sign` (0/1/2 =
  preparer / reviewer / partner), `createEng`, `admin`. Posting requires a
  reviewer or partner; reversal and period lock are partner-only.
- **Gates are evaluated, never asserted.** The year-end lock sequence, the
  period close checklist and the sign-off gates all read live state and compute
  their own pass/fail. A gate a user can tick is labelled *attested* rather
  than *evaluated*, and the UI says which it is. Preserve that distinction.
- **A blocked action explains itself in the accounting**, not in the UI: "the
  batch cannot post because period 11 is locked", not "action unavailable".

## State management

The prototype holds everything in one component state object persisted to
`localStorage` under a 2 MB cap. **Do not reproduce that.** It is a demo
affordance and it is the thing the backend replaces. Map it as:

| Prototype state | Backend |
| --- | --- |
| `tenants`, `users` | Tenant + user tables, real auth |
| `data[firmId][engId]` | Reporting unit → obligations, settlements, adjustments, extracts |
| `curves[firmId]` | Curve library + curve points (tenant-scoped) |
| `firmSettings[firmId]` | Tenant reference data: accounts, coding block, posting rules, pick-lists, templates |
| `log`, `chg` | Append-only audit trail and field-level change log — **write-once tables** |
| `authority[firmId]` | Per-domain authority setting, enforced in the write path |
| `perStatus`, `frozen`, `packSigned` | Period status machine, dataset freezes, signature records |
| `sel`, `views`, `sort`, `filters`, `page` | Genuine client UI state — keep client-side |

## Assets

No images, photographs or bitmap assets. Icons are Lucide, inline SVG. Fonts
are Archivo (400/600/800) from Google Fonts. Numbers, entity names and extract
data in the prototype are **synthetic seed data**, generated per tenant — none
of it is client data and none of it should ship.

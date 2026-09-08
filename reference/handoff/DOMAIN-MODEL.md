# Domain model

## Scope hierarchy

```
Install
└── Tenant  (kind: Reporting entity | Auditor)
    ├── Users, roles
    ├── Reference data  (accounts, coding block, posting rules, pick-lists,
    │                    curves + curve points, templates, match rules)
    ├── Authority settings  (6 domains × 3 modes)
    └── Reporting unit  ("engagement": legal entity + financial year)
        ├── Assumptions  (curve, inflation, contingency, materiality,
        │                 term convention, calendar type, FY end, framework)
        ├── Accounting periods  (status machine)
        ├── Tca assets  (master TCA listing; asset number links obligations)
        ├── Obligations
        │   ├── Cost build-up lines
        │   ├── Revisions  (cost | timing)
        │   ├── Layers  (per recognition event — see note)
        │   ├── Retirement cost asset + accumulated depreciation
        │   ├── Events  (append-only ledger)
        │   └── Settlements  (full | partial)
        ├── Extracts  (files received, with provenance and hash)
        ├── Journal batches  (per period)
        └── Freezes, samples, tickmarks, memos, signatures
```

**"Engagement" and "reporting unit" are the same object** under two names — the
auditor tenancy calls it an engagement, the reporting entity calls it a
reporting unit. Keep one table; vary the label by tenant kind.

## Note on layers

Under IFRS and discounted PSAS, layers are **derived** for presentation: a
single current rate is applied to the whole obligation. Under US GAAP
(ASC 410-20) and ASPE they are **stored**: each upward revision creates a new
layer carrying the discount rate in force on the day it arose, and each layer
accretes at that rate for the rest of its life. A downward revision removes
layers in a policy order (LIFO / FIFO / pro-rata). A later closing curve does
not remeasure existing layers.

PSAS (PS 3280) may dispense with discounting on the reporting unit. When it
does, inflation is not applied either.

## Proposed tables

Sketch, not gospel. Postgres assumed.

```
tenant(id, name, kind, env, domain, created_at)
app_user(id, tenant_id, name, email, role, mfa_state, is_owner, last_seen)
reporting_unit(id, tenant_id, entity, client, fy_end, currency, sector,
               partner_user_id, framework_id, jurisdiction, calendar_type,
               term_convention, status, stage)
assumptions(reporting_unit_id, inflation, contingency, curve_id,
            prior_curve_id, prior_inflation, revalued_on,
            materiality_usd, materiality_pct, extrapolation_policy, …)

tca_asset(id, reporting_unit_id, asset_number, description, asset_class,
          acquisition_date, site, scope, scope_reason, payload jsonb)
          -- unique (reporting_unit_id, asset_number); link from obligation.asset_id
          -- (TCA asset number). Obligation also carries aro_asset_number for the
          -- retirement-cost asset, a different identifier.

curve(id, tenant_id, name, currency, source, basis, interpolation, as_at, is_draft)
curve_point(curve_id, term_years, rate)                       -- PK (curve_id, term)

obligation(id, reporting_unit_id, ref, description, asset_id, site, type_id,
           basis, cost_estimate_date, settlement_date, status, …)
cost_line(id, obligation_id, description, qty, unit_rate, source)
revision(id, obligation_id, kind, amount|new_date, effective_date,
         reason_code, evidence_ref, created_by, created_at)
layer(id, obligation_id, arose_on, amount, rate, life_years, method)
obligation_event(id, obligation_id, period_id, type, event_date, amount,
                 basis_tag, derived boolean, source_row_ref)   -- APPEND ONLY
settlement(id, obligation_id, kind, pct, actual_cost, settled_on, posted)

period(id, reporting_unit_id, no, fiscal_year, starts, ends, status)
close_task(id, period_id, ref, label, wd_offset, owner_user_id, done, done_at)
rate_table(id, reporting_unit_id, from_period, curve_id, inflation,
           loaded_by, loaded_at, note)

account(id, tenant_id, code, name, class, engine_role, required_segments)
coding_segment(id, tenant_id, ord, name, required, permitted_values)
posting_rule(id, tenant_id, event_type, debit_account_id, credit_account_id,
             engine_emitted boolean)
journal_batch(id, reporting_unit_id, period_id, number, status,
              approved_by, posted_by, reversed_by, posted_at)
journal_line(batch_id, ord, account_id, coding_block jsonb, debit, credit,
             obligation_id, event_id)                          -- IMMUTABLE once posted

extract(id, reporting_unit_id, kind, filename, hash, rows, received_at,
        declared cumulative|incremental, target_period_id, accepted_at)
freeze(id, reporting_unit_id, version, hash, population, total, created_at)
sample(id, freeze_id, method, size, seed, created_by, created_at)
tickmark(id, obligation_id, freeze_id, preparer, reviewer, marked_at)

authority(tenant_id, domain, mode)
change_log(id, tenant_id, reporting_unit_id, record, field, old_value,
           new_value, actor, at, restored_from)                -- APPEND ONLY
audit_event(id, tenant_id, reporting_unit_id, actor, action, kind, detail, at)
```

## Reference data vs engine vocabulary

An audit of all 78 seeded lists sorted them into two groups, and the distinction
must survive the port. **When adding a list, decide which it is and say so in
the copy.**

**Reference data the customer owns — needs full create / update / delete:**
chart of accounts, coding block segments, posting rules, curves and their
points, obligation types, currencies, sectors, sites and regions, variance
causes, scoping reasons, settlement statuses, remeasurement reasons, close
calendar template, period close checklist, client request list, cost build-up
template, match rules, crosswalk aliases.

**Engine vocabulary — correctly fixed, roughly thirty lists:** measurement
bases, period statuses, depreciation methods, accretion cadences, day-count
conventions, term conventions, framework policy axes, authority modes, roles,
legal-vs-constructive basis, event types. Making these editable would let a user
name an option the engine has no code path for. Roles in particular drive every
gate in the product — a custom role would be a permission that silently does
nothing.

**Still hard-coded, in queue order:** exception check definitions · source
system templates (applied but not cloneable) · custom fields on the register.

## Accounts carry an engine role

The organisation owns account codes and names. The engine only needs to know
which account plays each part — "ARO provision", "accretion", "suspense" and so
on. So `account.engine_role` is the join, not the code. A role left unfilled is
reported and its events go to suspense (99999); a role held by two accounts is
reported as a coin toss. **The engine never posts to a hard-coded account code.**

Engine *posting cases* are the economic journals (initial recognition, change of
estimate by remaining life, accretion, settlement true-up then consume, sale,
retire the ARO asset). A downward revision always reduces the provision and the
retirement-cost asset by the full change. If that would take NBV below zero,
accumulated amortization is reversed against amortization expense until NBV is
zero; any remainder of the provision reduction is credited to accretion expense
rather than the asset. A posting *scenario* is the organisation's map of imported
GLs onto those debit and credit roles, per asset class. Do not conflate the two.

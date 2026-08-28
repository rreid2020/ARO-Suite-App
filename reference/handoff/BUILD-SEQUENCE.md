# Build sequence

## Phase 0 — before any schema

1. **Extract the engine** as a standalone, dependency-free library with the
   fixtures in `ENGINE-SPEC.md` §9. Nothing else starts until the golden file
   passes.
2. **Settle framework policy** (layers stored vs derived; optional discounting
   for PSAS). It determines the obligation and layer tables.
3. **Settle the release cut** and the deployment story.

## Phase 1 — foundation

Auth, tenancy, users and roles. The single write path with authority
enforcement, the field-level change log and the audit trail — build these three
*with* the first write, not after. Reporting units, accounting periods and the
period status machine. Reference data: accounts with engine roles, coding block,
posting rules, curves and curve points.

Acceptance: every invariant in `INVARIANTS.md` §2, §3, §7, §8 holds, tested.

## Phase 2 — Mode 1 (recalculation & completeness)

Intake with provenance and hashing. Import declaration and normalisation into
period-stamped events. Register with the column model, views, bulk edit and
paste. Recalculation against source figures. Tiered materiality, variance
causes, the completeness pack and the signed statement. Excel export with
self-contained formulas.

This is the smallest thing that is worth money on its own.

## Phase 3 — Mode 3 (audit)

Freeze with versioning and diff. Independent assumptions held alongside the
client's, attributed input by input. Sampling (MUS / stratified / random) with
method, size and seed logged. Tickmarks and exception memos. Request list
generated from what the engine actually needs.

Mostly reuse — Mode 3 is Mode 1 with authority set to read.

## Phase 4 — Mode 2 (module of record)

Layers and the retirement cost asset. Journal batches, posting, suspense, GL
import. Sub-ledger to GL reconciliation. Close calendar and the year-end lock
sequence. Multi-currency, translation reserve and consolidation. Opening balance
conversion and the match/link load. Roll-forward and the disclosure note.

## Phase 5 — productisation gates

**SaaS:** tested engine library · backend with auth, multi-tenancy and storage ·
immutable audit trail · SOC 2 Type II · penetration test · methodology document ·
EULA/MSA with a liability cap.

**On-premise, in addition:** container/Helm packaging · offline install ·
licence keys · version upgrade path · support SLA.

## Deliberately deferred

Exception check definitions as configurable data · source-template cloning ·
custom fields on the register · a fifth reporting framework (real request, but
engine work rather than a text field) · API integration into audit platforms
(the eventual moat, longest sales cycle, needs a platform partner).

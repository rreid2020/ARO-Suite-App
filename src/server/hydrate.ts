import type { PrismaClient } from '@prisma/client';
import type { AuthorityMode, Domain } from '../core/authority';
import type {
  Account, AppState, CodingSegment, Extract, Framework, Freeze, JournalBatch, JournalLine,
  Obligation, PostingRule, ReportingUnit, Sample, Settlement, Signature, Tenant, TenantSettings,
  Tickmark, User, UnitData,
} from '../core/types';
import type { AttestedGate } from '../core/gates';
import type { Period } from '../core/periods';
import type { Curve } from '../engine/curve';
import type { CostLine, Revision } from '../engine/derive';
import type { ObligationEvent } from '../engine/rollforward';
import type { AuditEvent, ChangeEntry } from '../core/writePath';
import { emptyAppState } from '../core/emptyState';
import { DOMAINS } from '../core/authority';

export async function hydrateAppState(prisma: PrismaClient, tenantIds: string[]): Promise<AppState> {
  const state = emptyAppState();
  if (!tenantIds.length) return state;

  const tenants = await prisma.tenant.findMany({
    where: { id: { in: tenantIds } },
    include: {
      members: { include: { user: true } },
      settings: true,
      authority: true,
      accounts: true,
      segments: true,
      postingRules: true,
      curves: { include: { points: { orderBy: { termYears: 'asc' } } } },
      units: {
        include: {
          assumptions: true,
          periods: { orderBy: [{ fiscalYear: 'asc' }, { no: 'asc' }] },
          obligations: { include: { costLines: true, revisions: true, events: true, settlements: true } },
          extracts: true,
          batches: { include: { lines: { orderBy: { ord: 'asc' } } } },
          freezes: { include: { samples: true, tickmarks: true } },
          attestedGates: true,
          signatures: true,
        },
      },
      changeLog: { orderBy: { at: 'desc' }, take: 5000 },
      auditEvents: { orderBy: { at: 'desc' }, take: 5000 },
    },
  });

  for (const t of tenants) {
    const tenant: Tenant = {
      id: t.id,
      name: t.name,
      kind: t.kind as Tenant['kind'],
      env: t.env,
      domain: t.domain,
      createdAt: t.createdAt.toISOString(),
      custom: t.custom,
    };
    state.tenants.push(tenant);

    for (const m of t.members) {
      const user: User = {
        id: m.user.id,
        tenantId: t.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        mfa: m.mfa as User['mfa'],
        isOwner: m.isOwner,
        lastSeen: m.lastSeen?.toISOString(),
      };
      state.users.push(user);
    }

    const settings: TenantSettings = t.settings
      ? {
          accounts: t.accounts.map(mapAccount),
          segments: t.segments.map(mapSegment),
          postingRules: t.postingRules.map(mapRule),
          frameworks: t.settings.frameworks as unknown as Framework[],
          defaults: t.settings.defaults as TenantSettings['defaults'],
          retentionYears: t.settings.retentionYears,
          legalHold: t.settings.legalHold,
          sso: t.settings.sso,
          scim: t.settings.scim,
        }
      : {
          accounts: t.accounts.map(mapAccount),
          segments: t.segments.map(mapSegment),
          postingRules: t.postingRules.map(mapRule),
          frameworks: [],
          defaults: {
            inflation: 0.025,
            contingency: 0.1,
            dayCount: '30/360 US (DAYS360)',
            termConvention: 'Round up to whole year (SAP)',
            calendarType: 'Monthly (12)',
          },
          retentionYears: 7,
          legalHold: false,
          sso: false,
          scim: false,
        };
    state.settings[t.id] = settings;

    const auth = {} as Record<Domain, AuthorityMode>;
    for (const d of DOMAINS) {
      const row = t.authority.find((a) => a.domain === d.id);
      auth[d.id] = (row?.mode as AuthorityMode) ?? 'We own it';
    }
    state.authority[t.id] = auth;

    state.curves[t.id] = t.curves.map((c): Curve => ({
      id: c.id,
      name: c.name,
      currency: c.currency,
      source: c.source,
      basis: c.basis,
      interpolation: c.interpolation as Curve['interpolation'],
      extrapolation: c.extrapolation as Curve['extrapolation'],
      asAt: c.asAt,
      isDraft: c.isDraft,
      points: c.points.map((p) => ({ term: p.termYears, rate: p.rate })),
    }));

    const units: ReportingUnit[] = t.units.map((u) => {
      const a = u.assumptions;
      return {
        id: u.id,
        tenantId: u.tenantId,
        entity: u.entity,
        client: u.client,
        fyEnd: u.fyEnd,
        currency: u.currency,
        sector: u.sector,
        partnerUserId: u.partnerUserId,
        frameworkId: u.frameworkId,
        jurisdiction: u.jurisdiction,
        calendarType: u.calendarType as ReportingUnit['calendarType'],
        latePolicy: u.latePolicy as ReportingUnit['latePolicy'],
        status: u.status,
        stage: u.stage,
        inflation: a?.inflation ?? 0.025,
        contingency: a?.contingency ?? 0.1,
        curveId: a?.curveId ?? '',
        priorCurveId: a?.priorCurveId ?? undefined,
        priorInflation: a?.priorInflation ?? undefined,
        revaluedOn: a?.revaluedOn ?? undefined,
        termConvention: a?.termConvention ?? 'Round up to whole year (SAP)',
        materialityUsd: a?.materialityUsd ?? 0,
        materialityPct: a?.materialityPct ?? 0,
        extrapolationPolicy: a?.extrapolationPolicy ?? 'flat-last',
        dayCount: u.dayCount,
      };
    });
    state.units[t.id] = units;

    for (const u of t.units) {
      const freezeTickmarks = u.freezes.flatMap((f) => f.tickmarks);
      const data: UnitData = {
        obligations: u.obligations.map(mapObligation),
        events: u.obligations.flatMap((o) => o.events.map(mapEvent)),
        extracts: u.extracts.map(mapExtract),
        batches: u.batches.map(mapBatch),
        settlements: u.obligations.flatMap((o) => o.settlements.map(mapSettlement)),
        freezes: u.freezes.map(mapFreeze),
        samples: u.freezes.flatMap((f) => f.samples.map(mapSample)),
        tickmarks: freezeTickmarks.map(mapTickmark),
        signatures: u.signatures.map(mapSignature),
        periods: u.periods.map(mapPeriod),
        attestedGates: u.attestedGates.map(mapGate),
        glTotal: u.glTotal,
        conversionAgreed: u.conversionAgreed,
        noteGenerated: u.noteGenerated,
        yearLocked: u.yearLocked,
      };
      state.data[u.id] = data;
    }

    for (const c of t.changeLog) {
      state.chg.push({
        id: c.id,
        tenantId: c.tenantId,
        unitId: c.reportingUnitId ?? undefined,
        record: c.record,
        recordLabel: c.recordLabel,
        field: c.field,
        before: c.oldValue,
        after: c.newValue,
        actor: c.actor,
        at: c.at.toISOString(),
        restoredFrom: c.restoredFrom ?? undefined,
      });
    }
    for (const a of t.auditEvents) {
      state.log.push({
        id: a.id,
        tenantId: a.tenantId,
        unitId: a.reportingUnitId ?? undefined,
        actor: a.actor,
        action: a.action,
        kind: a.kind as AuditEvent['kind'],
        detail: a.detail,
        at: a.at.toISOString(),
      });
    }
  }

  state.chg.sort((a, b) => b.at.localeCompare(a.at));
  state.log.sort((a, b) => b.at.localeCompare(a.at));
  return state;
}

function mapAccount(a: { id: string; tenantId: string; code: string; name: string; className: string; engineRole: string; requiredSegments: unknown }): Account {
  return {
    id: a.id, tenantId: a.tenantId, code: a.code, name: a.name, cls: a.className,
    engineRole: a.engineRole, requiredSegments: a.requiredSegments as string[],
  };
}

function mapSegment(s: { id: string; tenantId: string; ord: number; name: string; required: boolean; permitted: unknown }): CodingSegment {
  return { id: s.id, tenantId: s.tenantId, ord: s.ord, name: s.name, required: s.required, permitted: s.permitted as string[] };
}

function mapRule(r: { id: string; tenantId: string; eventType: string; debitRole: string; creditRole: string; engineEmitted: boolean }): PostingRule {
  return { id: r.id, tenantId: r.tenantId, eventType: r.eventType, debitRole: r.debitRole, creditRole: r.creditRole, engineEmitted: r.engineEmitted };
}

function mapObligation(o: {
  id: string; ref: string; description: string; costEstimateDate: string; settlementDate: string; payload: unknown;
  costLines: { id: string; description: string; qty: number; unitRate: number; source: string | null }[];
  revisions: { id: string; kind: string; amount: number | null; newDate: string | null; effectiveDate: string; reason: string; evidenceRef: string | null; createdBy: string | null; createdAt: Date }[];
}): Obligation {
  const extra = (o.payload && typeof o.payload === 'object') ? o.payload as Record<string, unknown> : {};
  const lines: CostLine[] = o.costLines.map((l) => ({
    id: l.id, description: l.description, qty: l.qty, rate: l.unitRate, source: l.source ?? undefined,
  }));
  const adj: Revision[] = o.revisions.map((r) => ({
    id: r.id,
    kind: r.kind as Revision['kind'],
    amount: r.amount ?? undefined,
    to: r.newDate ?? undefined,
    date: r.effectiveDate,
    reason: r.reason,
    evidence: r.evidenceRef ?? undefined,
    createdBy: r.createdBy ?? undefined,
    createdAt: r.createdAt.toISOString(),
  }));
  return {
    ...extra,
    id: o.id,
    ref: o.ref,
    description: o.description,
    costEstimateDate: o.costEstimateDate,
    settlementDate: o.settlementDate,
    lines,
    adj,
  };
}

function mapEvent(e: { id: string; obligationId: string; periodId: string; type: string; eventDate: string; amount: number; derived: boolean; sourceRowRef: string | null; note: string | null }): ObligationEvent {
  return {
    id: e.id, obligationId: e.obligationId, periodId: e.periodId,
    type: e.type as ObligationEvent['type'], date: e.eventDate, amount: e.amount,
    derived: e.derived || undefined, sourceRowRef: e.sourceRowRef ?? undefined, note: e.note ?? undefined,
  };
}

function mapExtract(e: {
  id: string; reportingUnitId: string; kind: string; filename: string; hash: string; rows: number;
  receivedAt: Date; declared: string; targetPeriodId: string; acceptedAt: Date | null; template: string; templateValidated: boolean;
}): Extract {
  return {
    id: e.id, unitId: e.reportingUnitId, kind: e.kind, filename: e.filename, hash: e.hash, rows: e.rows,
    receivedAt: e.receivedAt.toISOString(), declared: e.declared as Extract['declared'],
    targetPeriodId: e.targetPeriodId, acceptedAt: e.acceptedAt?.toISOString(),
    template: e.template, templateValidated: e.templateValidated,
  };
}

function mapBatch(b: {
  id: string; reportingUnitId: string; periodId: string; number: string; status: string;
  approvedBy: string | null; postedBy: string | null; reversedBy: string | null; postedAt: Date | null; reverses: string | null;
  lines: { ord: number; accountId: string; coding: unknown; debit: number; credit: number; obligationId: string | null; eventId: string | null; suspense: boolean }[];
}): JournalBatch {
  const lines: JournalLine[] = b.lines.map((l) => ({
    ord: l.ord, accountId: l.accountId, coding: l.coding as Record<string, string>,
    debit: l.debit, credit: l.credit, obligationId: l.obligationId ?? undefined,
    eventId: l.eventId ?? undefined, suspense: l.suspense || undefined,
  }));
  return {
    id: b.id, unitId: b.reportingUnitId, periodId: b.periodId, number: b.number,
    status: b.status as JournalBatch['status'],
    approvedBy: b.approvedBy ?? undefined, postedBy: b.postedBy ?? undefined,
    reversedBy: b.reversedBy ?? undefined, postedAt: b.postedAt?.toISOString(),
    lines, reverses: b.reverses ?? undefined,
  };
}

function mapSettlement(s: { id: string; obligationId: string; kind: string; pct: number; actualCost: number; settledOn: string; posted: boolean }): Settlement {
  return { id: s.id, obligationId: s.obligationId, kind: s.kind as Settlement['kind'], pct: s.pct, actualCost: s.actualCost, settledOn: s.settledOn, posted: s.posted };
}

function mapFreeze(f: { id: string; reportingUnitId: string; version: number; hash: string; population: number; total: number; createdAt: Date; createdBy: string; rows: unknown }): Freeze {
  return {
    id: f.id, unitId: f.reportingUnitId, version: f.version, hash: f.hash, population: f.population, total: f.total,
    createdAt: f.createdAt.toISOString(), createdBy: f.createdBy,
    rows: f.rows as Freeze['rows'],
  };
}

function mapSample(s: { id: string; freezeId: string; method: string; size: number; seed: number; createdBy: string; createdAt: Date; picked: unknown }): Sample {
  return {
    id: s.id, freezeId: s.freezeId, method: s.method as Sample['method'], size: s.size, seed: s.seed,
    createdBy: s.createdBy, createdAt: s.createdAt.toISOString(), picked: s.picked as string[],
  };
}

function mapTickmark(t: { id: string; obligationId: string; freezeId: string; preparer: string | null; reviewer: string | null; markedAt: Date | null; note: string | null }): Tickmark {
  return {
    id: t.id, obligationId: t.obligationId, freezeId: t.freezeId,
    preparer: t.preparer ?? undefined, reviewer: t.reviewer ?? undefined,
    markedAt: t.markedAt?.toISOString(), note: t.note ?? undefined,
  };
}

function mapSignature(s: { stage: string; by: string; at: Date; recalcStamp: string }): Signature {
  return { stage: s.stage as Signature['stage'], by: s.by, at: s.at.toISOString(), recalcStamp: s.recalcStamp };
}

function mapPeriod(p: { id: string; reportingUnitId: string; no: number; fiscalYear: number; code: string; starts: string; ends: string; status: string }): Period {
  return { id: p.id, unitId: p.reportingUnitId, no: p.no, fiscalYear: p.fiscalYear, code: p.code, starts: p.starts, ends: p.ends, status: p.status as Period['status'] };
}

function mapGate(g: { id: string; label: string; attestedBy: string | null; attestedAt: Date | null; note: string }): AttestedGate {
  return {
    id: g.id, label: g.label, kind: 'attested',
    attestedBy: g.attestedBy ?? undefined, attestedAt: g.attestedAt?.toISOString(), note: g.note,
  };
}

export type { ChangeEntry };

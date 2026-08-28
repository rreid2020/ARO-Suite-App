import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppState, Obligation, ReportingUnit, UnitData } from '../core/types';
import type { AuditEvent, ChangeEntry } from '../core/writePath';
import { DOMAINS } from '../core/authority';

const CORE_OBLIGATION = new Set([
  'id', 'ref', 'description', 'costEstimateDate', 'settlementDate', 'lines', 'adj',
]);

export async function persistAppState(
  prisma: PrismaClient,
  state: AppState,
  allowedTenantIds: string[],
  ownerUserId?: string,
): Promise<void> {
  const allowed = new Set(allowedTenantIds);
  // Only persist tenants the caller already belongs to. New tenants go through POST /api/tenants.
  const persistable = state.tenants.filter((t) => allowed.has(t.id));
  const persistIds = new Set(persistable.map((t) => t.id));

  await prisma.$transaction(async (tx) => {
    for (const tenant of persistable) {

      await tx.tenant.upsert({
        where: { id: tenant.id },
        create: {
          id: tenant.id, name: tenant.name, kind: tenant.kind, env: tenant.env,
          domain: tenant.domain, custom: tenant.custom ?? false, createdAt: new Date(tenant.createdAt),
        },
        update: { name: tenant.name, kind: tenant.kind, env: tenant.env, domain: tenant.domain, custom: tenant.custom ?? false },
      });

      const settings = state.settings[tenant.id];
      if (settings) {
        await tx.tenantSettings.upsert({
          where: { tenantId: tenant.id },
          create: {
            tenantId: tenant.id,
            defaults: settings.defaults as Prisma.InputJsonValue,
            frameworks: settings.frameworks as unknown as Prisma.InputJsonValue,
            retentionYears: settings.retentionYears,
            legalHold: settings.legalHold,
            sso: settings.sso,
            scim: settings.scim,
          },
          update: {
            defaults: settings.defaults as Prisma.InputJsonValue,
            frameworks: settings.frameworks as unknown as Prisma.InputJsonValue,
            retentionYears: settings.retentionYears,
            legalHold: settings.legalHold,
            sso: settings.sso,
            scim: settings.scim,
          },
        });

        await replaceAccounts(tx, tenant.id, settings.accounts);
        await replaceSegments(tx, tenant.id, settings.segments);
        await replaceRules(tx, tenant.id, settings.postingRules);
      }

      const authority = state.authority[tenant.id];
      if (authority) {
        for (const d of DOMAINS) {
          await tx.authority.upsert({
            where: { tenantId_domain: { tenantId: tenant.id, domain: d.id } },
            create: { tenantId: tenant.id, domain: d.id, mode: authority[d.id] },
            update: { mode: authority[d.id] },
          });
        }
      }

      const tenantUsers = state.users.filter((u) => u.tenantId === tenant.id);
      for (const u of tenantUsers) {
        await tx.appUser.upsert({
          where: { id: u.id },
          create: { id: u.id, name: u.name, email: u.email },
          update: { name: u.name, email: u.email },
        });
        await tx.membership.upsert({
          where: { tenantId_userId: { tenantId: tenant.id, userId: u.id } },
          create: {
            tenantId: tenant.id, userId: u.id, role: u.role, mfa: u.mfa,
            isOwner: u.isOwner ?? false, lastSeen: u.lastSeen ? new Date(u.lastSeen) : null,
          },
          update: {
            role: u.role, mfa: u.mfa, isOwner: u.isOwner ?? false,
            lastSeen: u.lastSeen ? new Date(u.lastSeen) : null,
          },
        });
      }

      if (ownerUserId) {
        const already = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: tenant.id, userId: ownerUserId } },
        });
        if (!already) {
          await tx.membership.create({
            data: { tenantId: tenant.id, userId: ownerUserId, role: 'partner', isOwner: true },
          });
        }
      }

      await replaceCurves(tx, tenant.id, state.curves[tenant.id] ?? []);
      await replaceUnits(tx, tenant.id, state.units[tenant.id] ?? [], state.data);
    }

    await appendChanges(tx, state.chg.filter((c) => persistIds.has(c.tenantId)));
    await appendAudit(tx, state.log.filter((a) => persistIds.has(a.tenantId)));
  }, { timeout: 120_000, maxWait: 15_000 });
}

async function replaceAccounts(tx: Prisma.TransactionClient, tenantId: string, accounts: AppState['settings'][string]['accounts']) {
  const keep = new Set(accounts.map((a) => a.id));
  await tx.account.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });
  for (const a of accounts) {
    await tx.account.upsert({
      where: { id: a.id },
      create: {
        id: a.id, tenantId, code: a.code, name: a.name, className: a.cls,
        engineRole: a.engineRole, requiredSegments: a.requiredSegments,
      },
      update: {
        code: a.code, name: a.name, className: a.cls,
        engineRole: a.engineRole, requiredSegments: a.requiredSegments,
      },
    });
  }
}

async function replaceSegments(tx: Prisma.TransactionClient, tenantId: string, segments: AppState['settings'][string]['segments']) {
  const keep = new Set(segments.map((s) => s.id));
  await tx.codingSegment.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });
  for (const s of segments) {
    await tx.codingSegment.upsert({
      where: { id: s.id },
      create: { id: s.id, tenantId, ord: s.ord, name: s.name, required: s.required, permitted: s.permitted },
      update: { ord: s.ord, name: s.name, required: s.required, permitted: s.permitted },
    });
  }
}

async function replaceRules(tx: Prisma.TransactionClient, tenantId: string, rules: AppState['settings'][string]['postingRules']) {
  const keep = new Set(rules.map((r) => r.id));
  await tx.postingRule.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });
  for (const r of rules) {
    await tx.postingRule.upsert({
      where: { id: r.id },
      create: {
        id: r.id, tenantId, eventType: r.eventType, debitRole: r.debitRole,
        creditRole: r.creditRole, engineEmitted: r.engineEmitted,
      },
      update: { eventType: r.eventType, debitRole: r.debitRole, creditRole: r.creditRole, engineEmitted: r.engineEmitted },
    });
  }
}

async function replaceCurves(tx: Prisma.TransactionClient, tenantId: string, curves: AppState['curves'][string]) {
  const keep = new Set(curves.map((c) => c.id));
  await tx.curve.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });
  for (const c of curves) {
    await tx.curve.upsert({
      where: { tenantId_id: { tenantId, id: c.id } },
      create: {
        tenantId, id: c.id, name: c.name, currency: c.currency, source: c.source, basis: c.basis,
        interpolation: c.interpolation, extrapolation: c.extrapolation, asAt: c.asAt, isDraft: c.isDraft ?? false,
      },
      update: {
        name: c.name, currency: c.currency, source: c.source, basis: c.basis,
        interpolation: c.interpolation, extrapolation: c.extrapolation, asAt: c.asAt, isDraft: c.isDraft ?? false,
      },
    });
    await tx.curvePoint.deleteMany({ where: { tenantId, curveId: c.id } });
    if (c.points.length) {
      await tx.curvePoint.createMany({
        data: c.points.map((p) => ({ tenantId, curveId: c.id, termYears: p.term, rate: p.rate })),
      });
    }
  }
}

async function replaceUnits(
  tx: Prisma.TransactionClient,
  tenantId: string,
  units: ReportingUnit[],
  data: Record<string, UnitData>,
) {
  const keep = new Set(units.map((u) => u.id));
  await tx.reportingUnit.deleteMany({ where: { tenantId, id: { notIn: [...keep] } } });

  for (const u of units) {
    await tx.reportingUnit.upsert({
      where: { id: u.id },
      create: {
        id: u.id, tenantId, entity: u.entity, client: u.client, fyEnd: u.fyEnd, currency: u.currency,
        sector: u.sector, partnerUserId: u.partnerUserId, frameworkId: u.frameworkId, jurisdiction: u.jurisdiction,
        calendarType: u.calendarType, latePolicy: u.latePolicy, status: u.status, stage: u.stage, dayCount: u.dayCount,
        glTotal: data[u.id]?.glTotal ?? null,
        conversionAgreed: data[u.id]?.conversionAgreed ?? false,
        noteGenerated: data[u.id]?.noteGenerated ?? false,
        yearLocked: data[u.id]?.yearLocked ?? false,
      },
      update: {
        entity: u.entity, client: u.client, fyEnd: u.fyEnd, currency: u.currency, sector: u.sector,
        partnerUserId: u.partnerUserId, frameworkId: u.frameworkId, jurisdiction: u.jurisdiction,
        calendarType: u.calendarType, latePolicy: u.latePolicy, status: u.status, stage: u.stage, dayCount: u.dayCount,
        glTotal: data[u.id]?.glTotal ?? null,
        conversionAgreed: data[u.id]?.conversionAgreed ?? false,
        noteGenerated: data[u.id]?.noteGenerated ?? false,
        yearLocked: data[u.id]?.yearLocked ?? false,
      },
    });
    await tx.assumptions.upsert({
      where: { reportingUnitId: u.id },
      create: {
        reportingUnitId: u.id, inflation: u.inflation, contingency: u.contingency, curveId: u.curveId,
        priorCurveId: u.priorCurveId ?? null, priorInflation: u.priorInflation ?? null, revaluedOn: u.revaluedOn ?? null,
        termConvention: u.termConvention, materialityUsd: u.materialityUsd, materialityPct: u.materialityPct,
        extrapolationPolicy: u.extrapolationPolicy,
      },
      update: {
        inflation: u.inflation, contingency: u.contingency, curveId: u.curveId,
        priorCurveId: u.priorCurveId ?? null, priorInflation: u.priorInflation ?? null, revaluedOn: u.revaluedOn ?? null,
        termConvention: u.termConvention, materialityUsd: u.materialityUsd, materialityPct: u.materialityPct,
        extrapolationPolicy: u.extrapolationPolicy,
      },
    });
    await persistUnitData(tx, u.id, data[u.id]);
  }
}

async function persistUnitData(tx: Prisma.TransactionClient, unitId: string, unit: UnitData | undefined) {
  if (!unit) return;

  const keepPeriods = unit.periods.map((p) => p.id);
  await tx.period.deleteMany({ where: { reportingUnitId: unitId, id: { notIn: keepPeriods } } });
  for (const p of unit.periods) {
    await tx.period.upsert({
      where: { id: p.id },
      create: {
        id: p.id, reportingUnitId: unitId, no: p.no, fiscalYear: p.fiscalYear, code: p.code,
        starts: p.starts, ends: p.ends, status: p.status,
      },
      update: { no: p.no, fiscalYear: p.fiscalYear, code: p.code, starts: p.starts, ends: p.ends, status: p.status },
    });
  }

  const keepObl = unit.obligations.map((o) => o.id);
  await tx.obligation.deleteMany({ where: { reportingUnitId: unitId, id: { notIn: keepObl } } });
  for (const o of unit.obligations) await upsertObligation(tx, unitId, o);

  const existingEvents = await tx.obligationEvent.findMany({
    where: { obligation: { reportingUnitId: unitId } },
    select: { id: true },
  });
  const haveEvent = new Set(existingEvents.map((e) => e.id));
  const newEvents = unit.events.filter((e) => !haveEvent.has(e.id));
  if (newEvents.length) {
    await tx.obligationEvent.createMany({
      data: newEvents.map((e) => ({
        id: e.id, obligationId: e.obligationId, periodId: e.periodId, type: e.type,
        eventDate: e.date, amount: e.amount, derived: e.derived ?? false,
        sourceRowRef: e.sourceRowRef ?? null, note: e.note ?? null,
      })),
      skipDuplicates: true,
    });
  }

  await tx.settlement.deleteMany({
    where: { obligation: { reportingUnitId: unitId }, id: { notIn: unit.settlements.map((s) => s.id) } },
  });
  for (const s of unit.settlements) {
    await tx.settlement.upsert({
      where: { id: s.id },
      create: {
        id: s.id, obligationId: s.obligationId, kind: s.kind, pct: s.pct,
        actualCost: s.actualCost, settledOn: s.settledOn, posted: s.posted,
      },
      update: { kind: s.kind, pct: s.pct, actualCost: s.actualCost, settledOn: s.settledOn, posted: s.posted },
    });
  }

  await tx.extract.deleteMany({
    where: { reportingUnitId: unitId, id: { notIn: unit.extracts.map((e) => e.id) } },
  });
  for (const e of unit.extracts) {
    await tx.extract.upsert({
      where: { id: e.id },
      create: {
        id: e.id, reportingUnitId: unitId, kind: e.kind, filename: e.filename, hash: e.hash, rows: e.rows,
        receivedAt: new Date(e.receivedAt), declared: e.declared, targetPeriodId: e.targetPeriodId,
        acceptedAt: e.acceptedAt ? new Date(e.acceptedAt) : null, template: e.template, templateValidated: e.templateValidated,
      },
      update: {
        kind: e.kind, filename: e.filename, hash: e.hash, rows: e.rows, receivedAt: new Date(e.receivedAt),
        declared: e.declared, targetPeriodId: e.targetPeriodId,
        acceptedAt: e.acceptedAt ? new Date(e.acceptedAt) : null, template: e.template, templateValidated: e.templateValidated,
      },
    });
  }

  const posted = await tx.journalBatch.findMany({
    where: { reportingUnitId: unitId, status: 'Posted' },
    select: { id: true },
  });
  const postedIds = new Set(posted.map((b) => b.id));

  await tx.journalBatch.deleteMany({
    where: {
      reportingUnitId: unitId,
      id: { notIn: unit.batches.map((b) => b.id) },
      status: { not: 'Posted' },
    },
  });

  for (const b of unit.batches) {
    if (postedIds.has(b.id)) continue;
    await tx.journalBatch.upsert({
      where: { id: b.id },
      create: {
        id: b.id, reportingUnitId: unitId, periodId: b.periodId, number: b.number, status: b.status,
        approvedBy: b.approvedBy ?? null, postedBy: b.postedBy ?? null, reversedBy: b.reversedBy ?? null,
        postedAt: b.postedAt ? new Date(b.postedAt) : null, reverses: b.reverses ?? null,
      },
      update: {
        periodId: b.periodId, number: b.number, status: b.status,
        approvedBy: b.approvedBy ?? null, postedBy: b.postedBy ?? null, reversedBy: b.reversedBy ?? null,
        postedAt: b.postedAt ? new Date(b.postedAt) : null, reverses: b.reverses ?? null,
      },
    });
    await tx.journalLine.deleteMany({ where: { batchId: b.id } });
    if (b.lines.length) {
      await tx.journalLine.createMany({
        data: b.lines.map((l) => ({
          batchId: b.id, ord: l.ord, accountId: l.accountId, coding: l.coding as Prisma.InputJsonValue,
          debit: l.debit, credit: l.credit, obligationId: l.obligationId ?? null,
          eventId: l.eventId ?? null, suspense: l.suspense ?? false,
        })),
      });
    }
  }

  await tx.freeze.deleteMany({
    where: { reportingUnitId: unitId, id: { notIn: unit.freezes.map((f) => f.id) } },
  });
  for (const f of unit.freezes) {
    await tx.freeze.upsert({
      where: { id: f.id },
      create: {
        id: f.id, reportingUnitId: unitId, version: f.version, hash: f.hash, population: f.population,
        total: f.total, createdAt: new Date(f.createdAt), createdBy: f.createdBy, rows: f.rows as Prisma.InputJsonValue,
      },
      update: {
        version: f.version, hash: f.hash, population: f.population, total: f.total,
        createdBy: f.createdBy, rows: f.rows as Prisma.InputJsonValue,
      },
    });
  }

  await tx.sample.deleteMany({
    where: { freeze: { reportingUnitId: unitId }, id: { notIn: unit.samples.map((s) => s.id) } },
  });
  for (const s of unit.samples) {
    await tx.sample.upsert({
      where: { id: s.id },
      create: {
        id: s.id, freezeId: s.freezeId, method: s.method, size: s.size, seed: s.seed,
        createdBy: s.createdBy, createdAt: new Date(s.createdAt), picked: s.picked,
      },
      update: { method: s.method, size: s.size, seed: s.seed, createdBy: s.createdBy, picked: s.picked },
    });
  }

  await tx.tickmark.deleteMany({
    where: { freeze: { reportingUnitId: unitId }, id: { notIn: unit.tickmarks.map((t) => t.id) } },
  });
  for (const t of unit.tickmarks) {
    await tx.tickmark.upsert({
      where: { id: t.id },
      create: {
        id: t.id, obligationId: t.obligationId, freezeId: t.freezeId, preparer: t.preparer ?? null,
        reviewer: t.reviewer ?? null, markedAt: t.markedAt ? new Date(t.markedAt) : null, note: t.note ?? null,
      },
      update: {
        preparer: t.preparer ?? null, reviewer: t.reviewer ?? null,
        markedAt: t.markedAt ? new Date(t.markedAt) : null, note: t.note ?? null,
      },
    });
  }

  await tx.signature.deleteMany({ where: { reportingUnitId: unitId } });
  if (unit.signatures.length) {
    await tx.signature.createMany({
      data: unit.signatures.map((s) => ({
        reportingUnitId: unitId, stage: s.stage, by: s.by, at: new Date(s.at), recalcStamp: s.recalcStamp,
      })),
    });
  }

  await tx.attestedGate.deleteMany({
    where: { reportingUnitId: unitId, id: { notIn: unit.attestedGates.map((g) => g.id) } },
  });
  for (const g of unit.attestedGates) {
    await tx.attestedGate.upsert({
      where: { id: g.id },
      create: {
        id: g.id, reportingUnitId: unitId, label: g.label, attestedBy: g.attestedBy ?? null,
        attestedAt: g.attestedAt ? new Date(g.attestedAt) : null, note: g.note,
      },
      update: {
        label: g.label, attestedBy: g.attestedBy ?? null,
        attestedAt: g.attestedAt ? new Date(g.attestedAt) : null, note: g.note,
      },
    });
  }
}

async function upsertObligation(tx: Prisma.TransactionClient, unitId: string, o: Obligation) {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!CORE_OBLIGATION.has(k)) payload[k] = v;
  }
  await tx.obligation.upsert({
    where: { id: o.id },
    create: {
      id: o.id, reportingUnitId: unitId, ref: o.ref, description: o.description,
      costEstimateDate: o.costEstimateDate, settlementDate: o.settlementDate, payload: payload as Prisma.InputJsonValue,
    },
    update: {
      ref: o.ref, description: o.description, costEstimateDate: o.costEstimateDate,
      settlementDate: o.settlementDate, payload: payload as Prisma.InputJsonValue,
    },
  });
  await tx.costLine.deleteMany({ where: { obligationId: o.id } });
  if (o.lines?.length) {
    await tx.costLine.createMany({
      data: o.lines.map((l) => ({
        id: l.id.startsWith(o.id) ? l.id : `${o.id}-${l.id}`, obligationId: o.id, description: l.description, qty: l.qty, unitRate: l.rate, source: l.source ?? null,
      })),
    });
  }
  await tx.revision.deleteMany({ where: { obligationId: o.id } });
  if (o.adj?.length) {
    await tx.revision.createMany({
      data: o.adj.map((r) => ({
        id: r.id, obligationId: o.id, kind: r.kind, amount: r.amount ?? null, newDate: r.to ?? null,
        effectiveDate: r.date, reason: r.reason, evidenceRef: r.evidence ?? null, createdBy: r.createdBy ?? null,
        createdAt: r.createdAt ? new Date(r.createdAt) : undefined,
      })),
    });
  }
}

export async function appendChanges(tx: Prisma.TransactionClient | PrismaClient, entries: ChangeEntry[]) {
  if (!entries.length) return;
  await tx.changeLog.createMany({
    data: entries.map((c) => ({
      id: c.id, tenantId: c.tenantId, reportingUnitId: c.unitId ?? null, record: c.record,
      recordLabel: c.recordLabel, field: c.field,
      oldValue: (c.before ?? null) as Prisma.InputJsonValue,
      newValue: (c.after ?? null) as Prisma.InputJsonValue,
      actor: c.actor, at: new Date(c.at), restoredFrom: c.restoredFrom ?? null,
    })),
    skipDuplicates: true,
  });
}

export async function appendAudit(tx: Prisma.TransactionClient | PrismaClient, entries: AuditEvent[]) {
  if (!entries.length) return;
  await tx.auditEvent.createMany({
    data: entries.map((a) => ({
      id: a.id, tenantId: a.tenantId, reportingUnitId: a.unitId ?? null,
      actor: a.actor, action: a.action, kind: a.kind, detail: a.detail, at: new Date(a.at),
    })),
    skipDuplicates: true,
  });
}

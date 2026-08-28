-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "custom" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "mfa" TEXT NOT NULL DEFAULT 'Not enrolled',
    "isOwner" BOOLEAN NOT NULL DEFAULT false,
    "lastSeen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_settings" (
    "tenantId" TEXT NOT NULL,
    "defaults" JSONB NOT NULL,
    "frameworks" JSONB NOT NULL,
    "retentionYears" INTEGER NOT NULL DEFAULT 7,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "sso" BOOLEAN NOT NULL DEFAULT false,
    "scim" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "authority" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "authority_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporting_unit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "fyEnd" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "partnerUserId" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "calendarType" TEXT NOT NULL,
    "latePolicy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "dayCount" TEXT NOT NULL,
    "glTotal" DOUBLE PRECISION,
    "conversionAgreed" BOOLEAN NOT NULL DEFAULT false,
    "noteGenerated" BOOLEAN NOT NULL DEFAULT false,
    "yearLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reporting_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assumptions" (
    "reportingUnitId" TEXT NOT NULL,
    "inflation" DOUBLE PRECISION NOT NULL,
    "contingency" DOUBLE PRECISION NOT NULL,
    "curveId" TEXT NOT NULL,
    "priorCurveId" TEXT,
    "priorInflation" DOUBLE PRECISION,
    "revaluedOn" TEXT,
    "termConvention" TEXT NOT NULL,
    "materialityUsd" DOUBLE PRECISION NOT NULL,
    "materialityPct" DOUBLE PRECISION NOT NULL,
    "extrapolationPolicy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assumptions_pkey" PRIMARY KEY ("reportingUnitId")
);

-- CreateTable
CREATE TABLE "curve" (
    "tenantId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "interpolation" TEXT NOT NULL,
    "extrapolation" TEXT NOT NULL,
    "asAt" TEXT NOT NULL,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "curve_pkey" PRIMARY KEY ("tenantId","id")
);

-- CreateTable
CREATE TABLE "curve_point" (
    "tenantId" TEXT NOT NULL,
    "curveId" TEXT NOT NULL,
    "termYears" DOUBLE PRECISION NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "curve_point_pkey" PRIMARY KEY ("tenantId","curveId","termYears")
);

-- CreateTable
CREATE TABLE "obligation" (
    "id" TEXT NOT NULL,
    "reportingUnitId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "costEstimateDate" TEXT NOT NULL,
    "settlementDate" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "obligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_line" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unitRate" DOUBLE PRECISION NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revision" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DOUBLE PRECISION,
    "newDate" TEXT,
    "effectiveDate" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceRef" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "layer" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "aroseOn" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "lifeYears" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "layer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "obligation_event" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "eventDate" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "derived" BOOLEAN NOT NULL DEFAULT false,
    "sourceRowRef" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "obligation_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pct" DOUBLE PRECISION NOT NULL,
    "actualCost" DOUBLE PRECISION NOT NULL,
    "settledOn" TEXT NOT NULL,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "period" (
    "id" TEXT NOT NULL,
    "reportingUnitId" TEXT NOT NULL,
    "no" INTEGER NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "starts" TEXT NOT NULL,
    "ends" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "engineRole" TEXT NOT NULL,
    "requiredSegments" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coding_segment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "permitted" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coding_segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posting_rule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "debitRole" TEXT NOT NULL,
    "creditRole" TEXT NOT NULL,
    "engineEmitted" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posting_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_batch" (
    "id" TEXT NOT NULL,
    "reportingUnitId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "approvedBy" TEXT,
    "postedBy" TEXT,
    "reversedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "reverses" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_line" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "coding" JSONB NOT NULL,
    "debit" DOUBLE PRECISION NOT NULL,
    "credit" DOUBLE PRECISION NOT NULL,
    "obligationId" TEXT,
    "eventId" TEXT,
    "suspense" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extract" (
    "id" TEXT NOT NULL,
    "reportingUnitId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "declared" TEXT NOT NULL,
    "targetPeriodId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "template" TEXT NOT NULL,
    "templateValidated" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "freeze" (
    "id" TEXT NOT NULL,
    "reportingUnitId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "population" INTEGER NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "rows" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "freeze_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample" (
    "id" TEXT NOT NULL,
    "freezeId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "picked" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickmark" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "freezeId" TEXT NOT NULL,
    "preparer" TEXT,
    "reviewer" TEXT,
    "markedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickmark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature" (
    "id" TEXT NOT NULL,
    "reportingUnitId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "recalcStamp" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attested_gate" (
    "id" TEXT NOT NULL,
    "reportingUnitId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "attestedBy" TEXT,
    "attestedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attested_gate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_log" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportingUnitId" TEXT,
    "record" TEXT NOT NULL,
    "recordLabel" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "restoredFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reportingUnitId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_name_idx" ON "tenant"("name");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_clerkUserId_key" ON "app_user"("clerkUserId");

-- CreateIndex
CREATE INDEX "app_user_email_idx" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "membership_userId_idx" ON "membership"("userId");

-- CreateIndex
CREATE INDEX "membership_tenantId_idx" ON "membership"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_tenantId_userId_key" ON "membership"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "authority_tenantId_idx" ON "authority"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "authority_tenantId_domain_key" ON "authority"("tenantId", "domain");

-- CreateIndex
CREATE INDEX "reporting_unit_tenantId_idx" ON "reporting_unit"("tenantId");

-- CreateIndex
CREATE INDEX "curve_tenantId_idx" ON "curve"("tenantId");

-- CreateIndex
CREATE INDEX "obligation_reportingUnitId_idx" ON "obligation"("reportingUnitId");

-- CreateIndex
CREATE INDEX "cost_line_obligationId_idx" ON "cost_line"("obligationId");

-- CreateIndex
CREATE INDEX "revision_obligationId_idx" ON "revision"("obligationId");

-- CreateIndex
CREATE INDEX "layer_obligationId_idx" ON "layer"("obligationId");

-- CreateIndex
CREATE INDEX "obligation_event_obligationId_idx" ON "obligation_event"("obligationId");

-- CreateIndex
CREATE INDEX "obligation_event_periodId_idx" ON "obligation_event"("periodId");

-- CreateIndex
CREATE INDEX "settlement_obligationId_idx" ON "settlement"("obligationId");

-- CreateIndex
CREATE INDEX "period_reportingUnitId_idx" ON "period"("reportingUnitId");

-- CreateIndex
CREATE INDEX "account_tenantId_idx" ON "account"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "account_tenantId_code_key" ON "account"("tenantId", "code");

-- CreateIndex
CREATE INDEX "coding_segment_tenantId_idx" ON "coding_segment"("tenantId");

-- CreateIndex
CREATE INDEX "posting_rule_tenantId_idx" ON "posting_rule"("tenantId");

-- CreateIndex
CREATE INDEX "journal_batch_reportingUnitId_idx" ON "journal_batch"("reportingUnitId");

-- CreateIndex
CREATE INDEX "journal_batch_periodId_idx" ON "journal_batch"("periodId");

-- CreateIndex
CREATE INDEX "journal_line_batchId_idx" ON "journal_line"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_line_batchId_ord_key" ON "journal_line"("batchId", "ord");

-- CreateIndex
CREATE INDEX "extract_reportingUnitId_idx" ON "extract"("reportingUnitId");

-- CreateIndex
CREATE INDEX "freeze_reportingUnitId_idx" ON "freeze"("reportingUnitId");

-- CreateIndex
CREATE INDEX "sample_freezeId_idx" ON "sample"("freezeId");

-- CreateIndex
CREATE INDEX "tickmark_obligationId_idx" ON "tickmark"("obligationId");

-- CreateIndex
CREATE INDEX "tickmark_freezeId_idx" ON "tickmark"("freezeId");

-- CreateIndex
CREATE INDEX "signature_reportingUnitId_idx" ON "signature"("reportingUnitId");

-- CreateIndex
CREATE INDEX "attested_gate_reportingUnitId_idx" ON "attested_gate"("reportingUnitId");

-- CreateIndex
CREATE INDEX "change_log_tenantId_at_idx" ON "change_log"("tenantId", "at");

-- CreateIndex
CREATE INDEX "change_log_reportingUnitId_idx" ON "change_log"("reportingUnitId");

-- CreateIndex
CREATE INDEX "audit_event_tenantId_at_idx" ON "audit_event"("tenantId", "at");

-- CreateIndex
CREATE INDEX "audit_event_reportingUnitId_idx" ON "audit_event"("reportingUnitId");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority" ADD CONSTRAINT "authority_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporting_unit" ADD CONSTRAINT "reporting_unit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assumptions" ADD CONSTRAINT "assumptions_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curve" ADD CONSTRAINT "curve_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curve_point" ADD CONSTRAINT "curve_point_tenantId_curveId_fkey" FOREIGN KEY ("tenantId", "curveId") REFERENCES "curve"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obligation" ADD CONSTRAINT "obligation_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_line" ADD CONSTRAINT "cost_line_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "obligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revision" ADD CONSTRAINT "revision_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "obligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layer" ADD CONSTRAINT "layer_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "obligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obligation_event" ADD CONSTRAINT "obligation_event_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "obligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "obligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "period" ADD CONSTRAINT "period_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coding_segment" ADD CONSTRAINT "coding_segment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posting_rule" ADD CONSTRAINT "posting_rule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_batch" ADD CONSTRAINT "journal_batch_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_batch" ADD CONSTRAINT "journal_batch_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "period"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "journal_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extract" ADD CONSTRAINT "extract_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extract" ADD CONSTRAINT "extract_targetPeriodId_fkey" FOREIGN KEY ("targetPeriodId") REFERENCES "period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freeze" ADD CONSTRAINT "freeze_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "sample_freezeId_fkey" FOREIGN KEY ("freezeId") REFERENCES "freeze"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickmark" ADD CONSTRAINT "tickmark_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "obligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickmark" ADD CONSTRAINT "tickmark_freezeId_fkey" FOREIGN KEY ("freezeId") REFERENCES "freeze"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attested_gate" ADD CONSTRAINT "attested_gate_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_reportingUnitId_fkey" FOREIGN KEY ("reportingUnitId") REFERENCES "reporting_unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;


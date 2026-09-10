/**
 * Reporting-unit setup — Unit settings, chart of accounts, posting rules,
 * periods & close, opening register.
 *
 * Company setup only names the entity, year end and currency. Each unit then
 * confirms its own framework, measurement assumptions, discount table, chart,
 * posting, fiscal calendar and the opening register (master TCA listing plus
 * obligations, linked by asset number) before Prepare.
 * The chart and posting rules are the tenant's GL; every unit on the tenant
 * sees the same list.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useStore, useTenant, useUnit } from '../../core/store';
import { canConfigureTenant, canEdit, canReverse } from '../../core/authority';
import { completeUnitSetup, publishedCurves, unitNeedsDiscountCurve, unitSetupComplete, updateReportingUnit } from '../../core/createUnit';
import { loadOpeningRegister, lockOpeningBlocked, obligationColumnNames, openingAccumAmortTotal, openingArcTotal, openingAroCostTotal, openingLocked, openingProvisionTotal, openingTemplateDataRows, openingTemplateHeaders, openingTemplateNotes, parseOpeningRegister } from '../../core/openingLoad';
import { loadTcaListing, lockOpeningBalances, openingObligations, openingTcaListing, parseTcaListing, setTcaAssetStatus, setTcaScope, tcaAccumAmortTotal, tcaAcquisitionCostTotal, tcaByObligationId, tcaColumnNames, tcaNbvTotal, tcaReconciled, tcaScopingGaps, tcaTemplateDataRows, tcaTemplateHeaders, tcaTemplateNotes } from '../../core/tcaListing';
import { stepsFor } from '../../core/nav';
import { CALENDAR_TYPES, CalendarType } from '../../core/periods';
import { hasProvisionMapping, postingRulesReady } from '../../core/posting';
import { curveOptionLabel } from '../../engine/curve';
import { frameworkPolicy } from '../../engine/framework';
import { unitHasUsableCurve } from '../../core/setup';
import type { TcaAsset, TcaAssetStatus, TcaScope } from '../../core/types';
import { Block, ConventionSelects, Empty, Field, currency, parseNumber, SheetTable, Stats } from '../components';
import { download, S } from '../../xlsx/write';
import { ChartOfAccounts, PostingRulesPanel } from './chartSetup';
import { groupOpeningRows, moneyFooter, obligationExtractColumns, obligationMoneyTotals, registerColumns, registerMoneyTotals, tcaListingColumns, tcaMoneyTotals } from './openingListings';
import { listingSheet, listingWorkbookName } from './listingExport';

export function UnitSetup() {
  const { state, ui, setUi, apply } = useStore();
  const tenant = useTenant()!;
  const unit = useUnit()!;
  const editable = canEdit(ui.role);
  const frameworks = state.settings[tenant.id].frameworks;
  const published = publishedCurves(state, tenant.id).filter((c) => c.currency === unit.currency);
  const current = (state.curves[tenant.id] ?? []).find((c) => c.id === unit.curveId);
  const options = current && !published.some((c) => c.id === current.id) ? [current, ...published] : published;
  const confirmed = unitSetupComplete(state, unit);
  const [inflation, setInflation] = useState(String((unit.inflation * 100).toFixed(2)));
  const [contingency, setContingency] = useState(String((unit.contingency * 100).toFixed(2)));
  const discountingOptional = frameworkPolicy(unit.frameworkId).discounting === 'optional';
  const needsCurve = unitNeedsDiscountCurve(unit);
  const curveReady = unitHasUsableCurve(state, tenant.id, unit.curveId);
  const canContinueToChart = !needsCurve || curveReady;

  useEffect(() => {
    setInflation(String((unit.inflation * 100).toFixed(2)));
    setContingency(String((unit.contingency * 100).toFixed(2)));
  }, [unit.id, unit.inflation, unit.contingency]);

  const patch = (detail: string, next: Parameters<typeof updateReportingUnit>[3]) => {
    apply('Change unit settings', 'admin', detail, (s) => {
      updateReportingUnit(s, tenant.id, unit.id, next);
    });
  };

  const continueToChart = () => {
    if (needsCurve && !curveReady) {
      apply('Confirm unit settings', 'refused',
        `${unit.entity} needs a published discount curve before the chart of accounts.`, () => {});
      return;
    }
    setUi({ screen: 'unit-chart', tab: '', sub: '' });
  };

  return (
    <>
      <Block
        kicker="Reporting unit"
        title={`${unit.entity} · ${unit.currency} · year ending ${unit.fyEnd}`}
        note="Entity, year end and currency stay on company setup. Framework, assumptions and the discount table belong to this unit. Chart, posting, periods and the opening register are the next steps — the organisation's GL is shared with the other reporting units on this tenant."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
          <Field label="Framework" help="The reporting framework this unit measures under. Company setup holds the catalogue; this pick belongs to the unit.">
            <select className="input" value={unit.frameworkId} disabled={!editable}
              onChange={(e) => {
                const name = frameworks.find((f) => f.id === e.target.value)?.name ?? e.target.value;
                patch(`${unit.entity} now measures under ${name}.`, { frameworkId: e.target.value });
              }}>
              {frameworks.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              {!frameworks.some((f) => f.id === unit.frameworkId) && (
                <option value={unit.frameworkId}>{unit.frameworkId}</option>
              )}
            </select>
          </Field>
          {discountingOptional && (
            <Field label="Discount this reporting unit" help="PS 3280 permits an undiscounted measurement. Turning discounting off also drops inflation, and the provision is the cost at current prices.">
              <select className="input" value={unit.discount === false ? 'No' : 'Yes'} disabled={!editable}
                onChange={(e) => patch(
                  e.target.value === 'No'
                    ? `${unit.entity} is measured undiscounted. Inflation is not applied.`
                    : `${unit.entity} is discounted at the current rate.`,
                  { discount: e.target.value === 'Yes' },
                )}>
                <option>Yes</option>
                <option>No</option>
              </select>
            </Field>
          )}
          <Field label="Fiscal calendar" help="This unit's period grid. Changing it rebuilds the calendar from the year end. Periods & close is the next Setup step after posting.">
            <select className="input" value={unit.calendarType} disabled={!editable}
              onChange={(e) => patch(`${unit.entity} calendar set to ${e.target.value}.`, { calendarType: e.target.value as CalendarType })}>
              {CALENDAR_TYPES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Inflation / escalation rate (%)" help="Escalates the cost estimate from its price date to the year end, and on to settlement. Enter 2.5 for 2.5%.">
            <input className="input num" name="inflation" inputMode="decimal" value={inflation} disabled={!editable}
              onChange={(e) => setInflation(e.target.value)}
              onBlur={() => {
                if (!editable) return;
                const inf = (Number(inflation) || 0) / 100;
                if (inf === unit.inflation) return;
                patch(`Inflation for ${unit.entity} set to ${inflation}%.`, { inflation: inf });
              }} />
          </Field>
          <Field label="Contingency (% of direct cost)" help="Applied once, before escalation, so it applies to the revised figure including any cost revisions.">
            <input className="input num" name="contingency" inputMode="decimal" value={contingency} disabled={!editable}
              onChange={(e) => setContingency(e.target.value)}
              onBlur={() => {
                if (!editable) return;
                const con = (Number(contingency) || 0) / 100;
                if (con === unit.contingency) return;
                patch(`Contingency for ${unit.entity} set to ${contingency}%.`, { contingency: con });
              }} />
          </Field>
          <Field label="Discount curve" help={needsCurve
            ? 'The published table this unit looks the discount rate up from. The library lives in company setup; the assignment is this unit\'s.'
            : 'Not used while this reporting unit is measured undiscounted. Assign a table if you turn discounting on.'}>
            <select className="input" value={unit.curveId} disabled={!editable || !options.length}
              onChange={(e) => {
                const next = options.find((c) => c.id === e.target.value);
                patch(next
                  ? `Assigned ${curveOptionLabel(next)} to ${unit.entity}.`
                  : `Cleared the discount curve on ${unit.entity}.`,
                { curveId: e.target.value });
              }}>
              {!options.length && <option value="">No published {unit.currency} table in the library</option>}
              {options.length > 0 && !unit.curveId && <option value="">— not assigned —</option>}
              {options.map((c) => <option key={c.id} value={c.id}>{curveOptionLabel(c)}</option>)}
            </select>
          </Field>
          <ConventionSelects
            dayCount={unit.dayCount}
            termConvention={unit.termConvention}
            disabled={!editable}
            onDayCount={(value) => patch(`Day count for ${unit.entity} set to ${value}.`, { dayCount: value })}
            onTermConvention={(value) => patch(`Settlement term rounding for ${unit.entity} set to ${value}.`, { termConvention: value })}
          />
        </div>
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          {needsCurve && !curveReady && (
            <div className="muted" style={{ fontSize: 12.5 }}>
              Assign a published discount curve from the company library to continue to the chart of accounts.
            </div>
          )}
          {confirmed ? (
            <div className="note-panel">Unit settings confirmed. You can still change them here; they stay on this reporting unit.</div>
          ) : (
            <button className="btn btn-primary" type="button" disabled={!editable || !canContinueToChart} onClick={continueToChart}>
              Continue to chart of accounts
            </button>
          )}
        </div>
      </Block>
    </>
  );
}

export function UnitChart() {
  const { state, ui, setUi } = useStore();
  const tenant = useTenant()!;
  const allowed = canConfigureTenant(ui.role);
  const mapped = hasProvisionMapping(state.settings[tenant.id], tenant.id);

  return (
    <>
      <ChartOfAccounts />
      <UnitContinue
        allowed={allowed}
        canContinue={mapped}
        blocked="Map ARO provision on a posting scenario so journals have a liability GL."
        label="Continue to posting rules"
        onContinue={() => setUi({ screen: 'unit-posting', tab: '', sub: '' })}
      />
    </>
  );
}

export function UnitPosting() {
  const { state, ui, setUi } = useStore();
  const tenant = useTenant()!;
  const unit = useUnit()!;
  const allowed = canConfigureTenant(ui.role);
  const mapped = hasProvisionMapping(state.settings[tenant.id], tenant.id);
  const rulesReady = postingRulesReady(state.settings[tenant.id]);
  const confirmed = unitSetupComplete(state, unit);
  const canContinue = mapped && rulesReady;

  const blocked = !mapped
    ? 'Map ARO provision on a posting scenario so journals have a liability GL.'
    : 'Restore the engine posting rules so every generated event has a debit and a credit role.';

  return (
    <>
      <PostingRulesPanel />
      {confirmed ? (
        <div className="note-panel" style={{ marginTop: 16 }}>Unit setup confirmed. You can still change posting here; it is the organisation's GL, shared with the other reporting units on this tenant.</div>
      ) : (
        <UnitContinue
          allowed={allowed}
          canContinue={canContinue}
          blocked={blocked}
          label="Continue to periods & close"
          onContinue={() => setUi({ screen: 'periods', tab: '', sub: '' })}
        />
      )}
    </>
  );
}

const OPENING_TABS = [
  { id: 'tca', label: 'Master TCA listing', kicker: 'Population', tone: 'g-aro-asset' },
  { id: 'obligations', label: 'Obligation and ARO Asset Listing', kicker: 'Conversion', tone: 'g-obligation' },
  { id: 'register', label: 'Register', kicker: 'Holistic', tone: 'g-dates' },
  { id: 'grouped', label: 'Grouped Postings', kicker: 'Posting', tone: 'g-movement' },
] as const;

type OpeningTabId = (typeof OPENING_TABS)[number]['id'];
type GroupedSubId = 'class' | 'type';

function openingTabOf(tab: string | undefined): OpeningTabId {
  if (tab === 'classes') return 'grouped';
  if (tab === 'trial') return 'obligations';
  if (OPENING_TABS.some((t) => t.id === tab)) return tab as OpeningTabId;
  return 'tca';
}

export function UnitOpening() {
  const { state, ui, setUi, apply, write } = useStore();
  const tenant = useTenant()!;
  const unit = useUnit()!;
  const data = state.data[unit.id];
  const allowed = canConfigureTenant(ui.role);
  const editable = canEdit(ui.role);
  const confirmed = unitSetupComplete(state, unit);
  const fileRef = useRef<HTMLInputElement>(null);
  const tcaFileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState('');
  const [tcaPaste, setTcaPaste] = useState('');
  const [importing, setImporting] = useState((data?.obligations.length ?? 0) === 0);
  const [tcaImporting, setTcaImporting] = useState((data?.tcaAssets.length ?? 0) === 0);
  const [report, setReport] = useState<string[] | null>(null);
  const [tcaReport, setTcaReport] = useState<string[] | null>(null);
  const [glProv, setGlProv] = useState(data?.openingGlProvision != null ? currency(data.openingGlProvision, unit.currency) : '');
  const [glAroCost, setGlAroCost] = useState(data?.openingGlAroCost != null ? currency(data.openingGlAroCost, unit.currency) : '');
  const [glAroAccum, setGlAroAccum] = useState(data?.openingGlAroAccum != null ? currency(data.openingGlAroAccum, unit.currency) : '');
  const [glTcaCost, setGlTcaCost] = useState(data?.openingGlTcaCost != null ? currency(data.openingGlTcaCost, unit.currency) : '');
  const [glTcaAccum, setGlTcaAccum] = useState(data?.openingGlTcaAccum != null ? currency(data.openingGlTcaAccum, unit.currency) : '');

  useEffect(() => {
    if (data?.openingGlProvision != null) setGlProv(currency(data.openingGlProvision, unit.currency));
  }, [data?.openingGlProvision, unit.currency]);
  useEffect(() => {
    if (data?.openingGlAroCost != null) setGlAroCost(currency(data.openingGlAroCost, unit.currency));
  }, [data?.openingGlAroCost, unit.currency]);
  useEffect(() => {
    if (data?.openingGlAroAccum != null) setGlAroAccum(currency(data.openingGlAroAccum, unit.currency));
  }, [data?.openingGlAroAccum, unit.currency]);
  useEffect(() => {
    if (data?.openingGlTcaCost != null) setGlTcaCost(currency(data.openingGlTcaCost, unit.currency));
  }, [data?.openingGlTcaCost, unit.currency]);
  useEffect(() => {
    if (data?.openingGlTcaAccum != null) setGlTcaAccum(currency(data.openingGlTcaAccum, unit.currency));
  }, [data?.openingGlTcaAccum, unit.currency]);

  const openingTca = data ? openingTcaListing(data) : [];
  const openingOb = data ? openingObligations(data) : [];
  const frozen = !!data?.openingSnapshot;
  const locked = openingLocked(data);
  const tcaLocked = locked || frozen;
  const provTotal = openingProvisionTotal(data?.events ?? []);
  const aroCostTotal = openingAroCostTotal(openingOb);
  const accumTotal = openingAccumAmortTotal(openingOb);
  const arcTotal = openingArcTotal(openingOb);
  const tcaCostTotal = tcaAcquisitionCostTotal(openingTca);
  const tcaAccumTotal = tcaAccumAmortTotal(openingTca);
  const tcaNbvSum = tcaNbvTotal(openingTca);
  const provDiff = data?.openingGlProvision == null ? null : provTotal - data.openingGlProvision;
  const aroCostDiff = data?.openingGlAroCost == null ? null : aroCostTotal - data.openingGlAroCost;
  const aroAccumDiff = data?.openingGlAroAccum == null ? null : accumTotal - data.openingGlAroAccum;
  const glAroNbv = data?.openingGlAroCost == null || data?.openingGlAroAccum == null
    ? null
    : data.openingGlAroCost - data.openingGlAroAccum;
  const aroNbvDiff = glAroNbv == null ? null : arcTotal - glAroNbv;
  const tcaCostDiff = data?.openingGlTcaCost == null ? null : tcaCostTotal - data.openingGlTcaCost;
  const tcaAccumDiff = data?.openingGlTcaAccum == null ? null : tcaAccumTotal - data.openingGlTcaAccum;
  const glTcaNbv = data?.openingGlTcaCost == null || data?.openingGlTcaAccum == null
    ? null
    : data.openingGlTcaCost - data.openingGlTcaAccum;
  const tcaNbvDiff = glTcaNbv == null ? null : tcaNbvSum - glTcaNbv;
  const firstPrepare = stepsFor(tenant.kind).find((s) => s.phase === 'Prepare')?.id ?? 'scope';
  const extraNames = obligationColumnNames(openingOb);
  const tcaExtras = tcaColumnNames(openingTca);
  const tcaByObl = tcaByObligationId(openingTca, openingOb);
  const tcaRecon = data
    ? tcaReconciled({ tcaAssets: openingTca, openingGlTcaCost: data.openingGlTcaCost ?? null, openingGlTcaAccum: data.openingGlTcaAccum ?? null })
    : { ok: false, detail: '' };
  const lockBlocked = data ? lockOpeningBlocked(data) : 'Load the opening extract first.';
  const gaps = tcaScopingGaps(openingTca, openingOb);
  const inScopeAssets = openingTca.filter((a) => a.scope === 'In scope').length;
  const outScopeAssets = openingTca.filter((a) => a.scope === 'Scoped out').length;
  const classes = state.settings[tenant.id].aroAssetClasses ?? [];

  const tab = openingTabOf(ui.tab);
  const groupedSub: GroupedSubId = ui.sub === 'type' ? 'type' : 'class';
  const paneTone = OPENING_TABS.find((t) => t.id === tab)?.tone ?? 'g-aro-asset';
  const tabMeta: Record<OpeningTabId, string> = {
    tca: gaps.undecided.length
      ? `${openingTca.length} assets · ${gaps.undecided.length} undecided`
      : `${openingTca.length} asset${openingTca.length === 1 ? '' : 's'}`,
    obligations: `${openingOb.length} obligation${openingOb.length === 1 ? '' : 's'}`,
    register: openingOb.length === 0
      ? 'Load both listings'
      : `${openingOb.length} rows · ${openingTca.length} TCA`,
    grouped: openingOb.length === 0
      ? 'Load obligations first'
      : groupedSub === 'type' ? 'By obligation type' : 'By asset class',
  };

  const load = (text: string, filename: string) => {
    if (tcaLocked) {
      apply('Load opening register', 'refused',
        'The conversion extract is frozen. Load an updated master TCA listing on ARO scoping.', () => {});
      setReport(['The conversion extract is frozen. Load an updated master TCA listing on ARO scoping.']);
      return;
    }
    const parsed = parseOpeningRegister(text);
    if (parsed.problems.length || !parsed.rows.length) {
      apply('Load opening register', 'refused', parsed.problems[0] ?? 'Nothing was loaded.', () => {});
      setReport([
        'Nothing was loaded. Fix the errors below and load the file again.',
        ...parsed.problems,
      ]);
      return;
    }
    if (!data?.periods[0]) {
      const msg = `${unit.entity} needs a fiscal calendar before the opening register can load. Open Periods & close, generate the calendar, then load this file again.`;
      apply('Load opening register', 'refused', msg, () => {});
      setReport([msg]);
      return;
    }
    apply('Load opening register', 'import',
      `Loaded ${parsed.rows.length} opening obligation${parsed.rows.length === 1 ? '' : 's'} from ${filename}.`,
      (s) => { loadOpeningRegister(s, tenant.id, unit.id, parsed, { filename, text }); });
    setReport([`Loaded ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} from ${filename}.`]);
    setPaste('');
    setImporting(false);
    setUi({ tab: 'obligations' });
  };

  const loadTca = (text: string, filename: string) => {
    if (tcaLocked) {
      apply('Load master TCA listing', 'refused',
        'The conversion master TCA listing is frozen. Load an updated listing on ARO scoping.', () => {});
      setTcaReport(['The conversion master TCA listing is frozen. Load an updated listing on ARO scoping.']);
      return;
    }
    const parsed = parseTcaListing(text);
    if (parsed.problems.length || !parsed.rows.length) {
      apply('Load master TCA listing', 'refused', parsed.problems[0] ?? 'Nothing was loaded.', () => {});
      setTcaReport([
        'Nothing was loaded. Fix the errors below and load the file again.',
        ...parsed.problems,
      ]);
      return;
    }
    if (!data?.periods[0]) {
      const msg = `${unit.entity} needs a fiscal calendar before the master TCA listing can load. Open Periods & close, generate the calendar, then load this file again.`;
      apply('Load master TCA listing', 'refused', msg, () => {});
      setTcaReport([msg]);
      return;
    }
    apply('Load master TCA listing', 'import',
      `Loaded ${parsed.rows.length} TCA asset${parsed.rows.length === 1 ? '' : 's'} from ${filename}.`,
      (s) => { loadTcaListing(s, tenant.id, unit.id, parsed, { filename, text }); });
    setTcaReport([`Loaded ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} from ${filename}.`]);
    setTcaPaste('');
    setTcaImporting(false);
    setUi({ tab: 'tca' });
  };

  const changeTcaScope = (asset: TcaAsset, status: string, reason: string) => {
    if (tcaLocked) {
      apply('Change asset scoping', 'refused', 'The conversion listing is frozen. Scope go-forward assets on ARO scoping.', () => {});
      return;
    }
    const next = setTcaScope(asset, status as TcaScope, reason, data?.obligations ?? []);
    if (typeof next === 'string') {
      apply('Change asset scoping', 'refused', next, () => {});
      return;
    }
    write<TcaAsset>({
      domain: 'register', record: asset.id, recordLabel: `${asset.assetNumber} scoping`,
      before: asset, after: next, action: 'Change asset scoping',
      apply: (s, v) => {
        const l = s.data[unit.id].tcaAssets;
        const i = l.findIndex((x) => x.id === asset.id);
        if (i >= 0) l[i] = v;
      },
    });
  };

  const changeTcaStatus = (asset: TcaAsset, status: TcaAssetStatus) => {
    if (tcaLocked) {
      apply('Change TCA asset status', 'refused', 'The conversion listing is frozen. Change go-forward status on ARO scoping.', () => {});
      return;
    }
    const next = setTcaAssetStatus(asset, status);
    write<TcaAsset>({
      domain: 'register', record: asset.id, recordLabel: `${asset.assetNumber} asset status`,
      before: asset, after: next, action: 'Change TCA asset status',
      apply: (s, v) => {
        const l = s.data[unit.id].tcaAssets;
        const i = l.findIndex((x) => x.id === asset.id);
        if (i >= 0) l[i] = v;
      },
    });
  };

  const recordGl = (kind: 'provision' | 'aroCost' | 'aroAccum' | 'tcaCost' | 'tcaAccum', raw: string) => {
    if (locked) {
      apply('Record opening GL totals', 'refused',
        'Opening balances are locked, so the opening GL totals cannot change.', () => {});
      return;
    }
    const n = parseNumber(raw);
    if (!Number.isFinite(n)) return;
    const label =
      kind === 'provision' ? `opening GL provision of ${currency(n, unit.currency)}`
      : kind === 'aroCost' ? `opening GL ARO acquisition cost of ${currency(n, unit.currency)}`
      : kind === 'aroAccum' ? `opening GL ARO accumulated amortization of ${currency(n, unit.currency)}`
      : kind === 'tcaCost' ? `opening GL TCA acquisition cost of ${currency(n, unit.currency)}`
      : `opening GL TCA accumulated amortization of ${currency(n, unit.currency)}`;
    apply('Record opening GL totals', 'write', `Recorded ${label}.`, (s) => {
      const d = s.data[unit.id];
      if (kind === 'provision') d.openingGlProvision = n;
      else if (kind === 'aroCost') d.openingGlAroCost = n;
      else if (kind === 'aroAccum') d.openingGlAroAccum = n;
      else if (kind === 'tcaCost') d.openingGlTcaCost = n;
      else d.openingGlTcaAccum = n;
      if (d.openingGlAroCost != null && d.openingGlAroAccum != null) {
        d.openingGlArc = d.openingGlAroCost - d.openingGlAroAccum;
      }
    });
    if (kind === 'provision') setGlProv(currency(n, unit.currency));
    else if (kind === 'aroCost') setGlAroCost(currency(n, unit.currency));
    else if (kind === 'aroAccum') setGlAroAccum(currency(n, unit.currency));
    else if (kind === 'tcaCost') setGlTcaCost(currency(n, unit.currency));
    else setGlTcaAccum(currency(n, unit.currency));
  };

  const formatGlField = (raw: string, set: (v: string) => void) => {
    const n = parseNumber(raw);
    if (raw.trim() && Number.isFinite(n)) set(currency(n, unit.currency));
  };

  const exportTemplate = () => {
    const extras = extraNames;
    const headers = openingTemplateHeaders(extras);
    const dataRows = openingTemplateDataRows(openingOb, data?.events ?? [], extras, state.settings[tenant.id].aroAssetClasses);
    const moneyIdx = new Set(
      headers.map((h, i) => (
        ['Estimated cost', 'Opening provision', 'ARO acquisition cost', 'ARO asset', 'Accumulated amortization', 'Opening future value'].includes(h) ? i : -1
      )).filter((i) => i >= 0),
    );
    const file = `${unit.entity.replace(/\W+/g, '-')}-obligation-and-aro-asset-listing.xlsx`;
    download(file, [
      {
        name: 'Obligation & ARO Asset Listing',
        freeze: 1,
        cols: headers.map((h, i) => (i === 0 ? 22 : Math.min(24, Math.max(14, h.length + 3)))),
        rows: [
          headers.map((h) => ({ v: h, s: S.head })),
          ...dataRows.map((row) => row.map((v, i) => (
            typeof v === 'number' && moneyIdx.has(i) ? { v, s: S.money } : v
          ))),
        ],
      },
      {
        name: 'Notes',
        cols: [36, 88],
        rows: openingTemplateNotes().map((row, i) => (
          i === 0 ? [{ v: row[0], s: S.title }] : row
        )),
      },
    ]);
  };

  const exportTcaTemplate = () => {
    const extras = tcaExtras;
    const headers = tcaTemplateHeaders(extras);
    const dataRows = tcaTemplateDataRows(openingTca, extras);
    const moneyIdx = new Set(
      headers.map((h, i) => (
        ['Acquisition cost', 'Accumulated amortization', 'Net book value'].includes(h) ? i : -1
      )).filter((i) => i >= 0),
    );
    const file = `${unit.entity.replace(/\W+/g, '-')}-master-tca-listing.xlsx`;
    download(file, [
      {
        name: 'Master TCA listing',
        freeze: 1,
        cols: headers.map((h, i) => (i === 0 ? 22 : Math.min(24, Math.max(14, h.length + 3)))),
        rows: [
          headers.map((h) => ({ v: h, s: S.head })),
          ...dataRows.map((row) => row.map((v, i) => (
            typeof v === 'number' && moneyIdx.has(i) ? { v, s: S.money } : v
          ))),
        ],
      },
      {
        name: 'Notes',
        cols: [36, 88],
        rows: tcaTemplateNotes().map((row, i) => (
          i === 0 ? [{ v: row[0], s: S.title }] : row
        )),
      },
    ]);
  };

  const exportListings = () => {
    const events = data?.events ?? [];
    const tcaCols = tcaListingColumns({
      extras: tcaExtras,
      obligations: openingOb,
      currency: unit.currency,
      calendarType: unit.calendarType,
      editable: false,
      locked: true,
      onScope: () => {},
    });
    const obligationCols = obligationExtractColumns({
      events,
      extras: extraNames,
      classes,
      currency: unit.currency,
      calendarType: unit.calendarType,
    });
    const combinedCols = registerColumns({
      events,
      extras: extraNames,
      tcaExtras,
      tcaByObl,
      classes,
      currency: unit.currency,
      calendarType: unit.calendarType,
    });
    download(listingWorkbookName(unit.entity, 'opening-listings'), [
      listingSheet({
        name: 'Master TCA listing',
        title: `${unit.entity} — Conversion master TCA listing`,
        columns: tcaCols,
        rows: openingTca,
        totals: tcaMoneyTotals(openingTca),
      }),
      listingSheet({
        name: 'Obligation listing',
        title: `${unit.entity} — Conversion obligation and ARO asset listing`,
        columns: obligationCols,
        rows: openingOb,
        totals: obligationMoneyTotals(openingOb, events),
      }),
      listingSheet({
        name: 'Combined listing',
        title: `${unit.entity} — Conversion combined listing`,
        columns: combinedCols,
        rows: openingOb,
        totals: registerMoneyTotals(openingOb, events, tcaByObl),
      }),
    ]);
  };

  return (
    <>
    <div className="posting-tabs" role="tablist" aria-label="Opening register">
      {OPENING_TABS.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
          className={`posting-tab g-tone ${t.tone}${tab === t.id ? ' is-on' : ''}`}
          onClick={() => setUi({ tab: t.id, sub: t.id === 'grouped' ? groupedSub : '' })}>
          <span className="kicker">{t.kicker}</span>
          <span className="posting-tab-label">{t.label}</span>
          <span className="posting-tab-meta">{tabMeta[t.id]}</span>
        </button>
      ))}
    </div>

    {tab === 'tca' && (
      <Block
        className={`posting-pane g-tone ${paneTone}`}
        kicker="Master TCA listing"
        title={openingTca.length === 0 ? 'Load the organisation\'s tangible capital assets' : `${openingTca.length} asset${openingTca.length === 1 ? '' : 's'} on the conversion listing`}
        note={frozen
          ? 'This is the conversion listing frozen when opening balances were locked. Load an updated master TCA listing on ARO scoping. Those go-forward changes do not rewrite this page.'
          : 'This is the completeness population at conversion. Assets that appear as TCA asset number on the obligation and ARO asset listing are in scope. Mark every remaining row so nothing is left unmarked. Asset status is Active, Unproductive or Disposed. Acquisition cost and accumulated amortization recon to the opening GL; net book value is listing cost minus listing accum.'}
        actions={
          <>
            <button className="btn btn-secondary btn-sm" type="button" onClick={exportListings}>
              Export listings to Excel
            </button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={exportTcaTemplate}>
              Export TCA template
            </button>
            {allowed && !tcaLocked && (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setTcaImporting((v) => !v)}>
                {tcaImporting ? 'Cancel import' : 'Load TCA listing'}
              </button>
            )}
          </>
        }
      >
        {tcaImporting && allowed && !tcaLocked && (
          <div style={{ marginBottom: 16, padding: 12, background: 'var(--color-surface)' }}>
            <Field label="Paste or import the master TCA listing" help="Export the Excel template first. Load by saving the Master TCA listing sheet as CSV, or copy that sheet (header row included) and paste it here. TCA asset number is required and must be unique.">
              <textarea className="input" rows={7} value={tcaPaste} onChange={(e) => setTcaPaste(e.target.value)}
                placeholder={'TCA asset number,Description,TCA asset class,Acquisition date,Acquisition cost,Accumulated amortization,Net book value,Total UL,Expired UL,Site,Asset status\nAS-10001,Well 14-23 pad,Wells,2008-06-15,2100000,800000,1300000,25,10,North,Active'} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" type="button" disabled={!tcaPaste.trim()}
                  onClick={() => loadTca(tcaPaste, 'pasted block')}>Load pasted listing</button>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => tcaFileRef.current?.click()}>Choose file</button>
                <input ref={tcaFileRef} type="file" accept=".csv,.tsv,.txt,.xlsx" style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (/\.xlsx$/i.test(f.name)) {
                      apply('Load master TCA listing', 'refused',
                        'Save the Master TCA listing sheet as CSV, or copy that sheet and paste it here. An Excel workbook is not loaded as-is.',
                        () => {});
                      e.target.value = '';
                      return;
                    }
                    f.text().then((t) => loadTca(t, f.name));
                    e.target.value = '';
                  }} />
              </div>
            </Field>
          </div>
        )}
        {tcaReport && tcaReport.length > 0 && (
          <div className="note-panel" style={{ marginBottom: 14, borderLeftColor: tcaReport[0]?.startsWith('Nothing was loaded') || tcaReport[0]?.includes('needs a fiscal calendar') ? 'var(--bad)' : undefined }}>
            {tcaReport.map((r, i) => <div key={i}>{r}</div>)}
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>Recon</div>
          <Stats items={[
            { label: 'TCA assets', value: String(openingTca.length) },
            { label: 'In scope', value: String(inScopeAssets) },
            { label: 'Out of scope', value: String(outScopeAssets) },
            { label: 'Undecided', value: String(gaps.undecided.length), tone: gaps.undecided.length ? 'warn' : 'ok' },
            { label: 'Listing acquisition cost', value: currency(tcaCostTotal, unit.currency) },
            { label: 'GL acquisition cost', value: data?.openingGlTcaCost == null ? 'Not received' : currency(data.openingGlTcaCost, unit.currency) },
            { label: 'Cost difference', value: tcaCostDiff == null ? '—' : currency(tcaCostDiff, unit.currency), tone: tcaCostDiff == null ? 'warn' : Math.abs(tcaCostDiff) <= 0.005 ? 'ok' : 'bad' },
            { label: 'Listing accum. amortization', value: currency(tcaAccumTotal, unit.currency) },
            { label: 'GL accum. amortization', value: data?.openingGlTcaAccum == null ? 'Not received' : currency(data.openingGlTcaAccum, unit.currency) },
            { label: 'Accum. difference', value: tcaAccumDiff == null ? '—' : currency(tcaAccumDiff, unit.currency), tone: tcaAccumDiff == null ? 'warn' : Math.abs(tcaAccumDiff) <= 0.005 ? 'ok' : 'bad' },
            { label: 'Listing NBV', value: currency(tcaNbvSum, unit.currency) },
            { label: 'GL NBV', value: glTcaNbv == null ? '—' : currency(glTcaNbv, unit.currency) },
            { label: 'NBV difference', value: tcaNbvDiff == null ? '—' : currency(tcaNbvDiff, unit.currency), tone: tcaNbvDiff == null ? 'warn' : Math.abs(tcaNbvDiff) <= 0.005 ? 'ok' : 'bad' },
          ]} />
          {gaps.orphanObligations.length > 0 && (
            <div className="note-panel" style={{ marginTop: 12, marginBottom: 12, borderLeftColor: 'var(--bad)' }}>
              {gaps.orphanObligations.length} obligation{gaps.orphanObligations.length === 1 ? '' : 's'} name a TCA asset number that is not on the master TCA listing. Add those assets to the listing before locking.
            </div>
          )}
          {editable && !locked && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: '0 0 260px' }}>
                <Field label="Opening GL TCA acquisition cost" help="The total on the TCA / PPE cost accounts from the opening trial balance.">
                  <input className="input num" inputMode="decimal" value={glTcaCost}
                    onChange={(e) => setGlTcaCost(e.target.value)}
                    onBlur={() => formatGlField(glTcaCost, setGlTcaCost)}
                    placeholder={`e.g. ${currency(5_120_000, unit.currency)}`} />
                </Field>
              </div>
              <button className="btn btn-primary btn-sm" type="button" disabled={!glTcaCost.trim()}
                onClick={() => recordGl('tcaCost', glTcaCost)}>Record cost</button>
              <div style={{ flex: '0 0 260px' }}>
                <Field label="Opening GL TCA accumulated amortization" help="The total accumulated amortization of the tangible capital assets from the opening trial balance.">
                  <input className="input num" inputMode="decimal" value={glTcaAccum}
                    onChange={(e) => setGlTcaAccum(e.target.value)}
                    onBlur={() => formatGlField(glTcaAccum, setGlTcaAccum)}
                    placeholder={`e.g. ${currency(1_800_000, unit.currency)}`} />
                </Field>
              </div>
              <button className="btn btn-primary btn-sm" type="button" disabled={!glTcaAccum.trim()}
                onClick={() => recordGl('tcaAccum', glTcaAccum)}>Record accum.</button>
            </div>
          )}
          {!tcaRecon.ok && <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>{tcaRecon.detail}</div>}
        </div>
        {(openingTca.length) === 0 ? (
          <Empty>No master listing yet. Load the organisation's TCA / PPE extract so every obligation can link by TCA asset number.</Empty>
        ) : (
          <SheetTable
            rows={openingTca}
            rowKey={(a) => a.id}
            noun="assets"
            columns={tcaListingColumns({
              extras: tcaExtras,
              obligations: openingOb,
              currency: unit.currency,
              calendarType: unit.calendarType,
              editable: editable && !tcaLocked,
              locked: tcaLocked,
              onScope: changeTcaScope,
              onStatus: tcaLocked ? undefined : changeTcaStatus,
            })}
            footer={moneyFooter(
              tcaListingColumns({ extras: tcaExtras, obligations: openingOb, currency: unit.currency, calendarType: unit.calendarType, editable: editable && !tcaLocked, locked: tcaLocked, onScope: changeTcaScope, onStatus: tcaLocked ? undefined : changeTcaStatus }),
              tcaMoneyTotals(openingTca),
              unit.currency,
            )}
          />
        )}
      </Block>
    )}

    {tab === 'obligations' && (
      <Block
        className={`posting-pane g-tone ${paneTone}`}
        kicker="Obligation and ARO Asset Listing"
        title={openingOb.length === 0 ? 'Load existing obligations and opening balances' : `${openingOb.length} obligation${openingOb.length === 1 ? '' : 's'} on the listing`}
        note={frozen
          ? 'These are the conversion obligations frozen when opening balances were locked. New in-year obligations created from ARO scoping appear on ARO scoping and the ARO Register, not here.'
          : 'Each row is an obligation from the conversion extract. ARO asset number, description, acquisition date, class, acquisition cost, accumulated amortization, NBV and useful life are the extract\'s ARO asset columns. Lock opening balances here once both listings agree to their GL totals.'}
        actions={
          <>
            <button className="btn btn-secondary btn-sm" type="button" onClick={exportListings}>
              Export listings to Excel
            </button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={exportTemplate}>
              Export template
            </button>
            {allowed && !tcaLocked && (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setImporting((v) => !v)}>
                {importing ? 'Cancel import' : 'Load extract'}
              </button>
            )}
          </>
        }
      >
        {importing && allowed && !tcaLocked && (
          <div style={{ marginBottom: 16, padding: 12, background: 'var(--color-surface)' }}>
            <Field label="Paste or import the opening register" help="Export the Excel template first. Load by saving the Obligation & ARO Asset Listing sheet as CSV, or copy that sheet (header row included) and paste it here. Every required field must be filled — if anything needed is missing or invalid, nothing is loaded and you will see how to fix each error. ARO acquisition cost is NBV plus accumulated amortization. Remaining useful life is Total UL minus Expired UL after a successful load.">
              <textarea className="input" rows={7} value={paste} onChange={(e) => setPaste(e.target.value)}
                placeholder={'Obligation Number,Description,Obligation type,Basis,Site,Region,Cost estimate date,Expected settlement,Estimated cost,Opening future value,Opening provision,TCA asset number,ARO asset number,ARO Asset Description,Asset acquisition date,ARO asset class code,ARO asset class name,ARO acquisition cost,Accumulated amortization,ARO asset,Total UL,Expired UL,Remaining UL\nARO-0001,Well abandonment,Wells,Legal,North,AB,2026-12-31,2038-06-30,1500000,2100000,1200000,AS-10001,ARO-10001,Well 14-23 pad,2008-06-15,11010,Buildings,1200000,400000,800000,25,10,15'} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" type="button" disabled={!paste.trim()}
                  onClick={() => load(paste, 'pasted block')}>Load pasted extract</button>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => fileRef.current?.click()}>Choose file</button>
                <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx" style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (/\.xlsx$/i.test(f.name)) {
                      apply('Load opening register', 'refused',
                        'Save the Obligation & ARO Asset Listing sheet as CSV, or copy that sheet and paste it here. An Excel workbook is not loaded as-is.',
                        () => {});
                      e.target.value = '';
                      return;
                    }
                    f.text().then((t) => load(t, f.name));
                    e.target.value = '';
                  }} />
              </div>
            </Field>
          </div>
        )}
        {report && report.length > 0 && (
          <div className="note-panel" style={{ marginBottom: 14, borderLeftColor: report[0]?.startsWith('Nothing was loaded') || report[0]?.includes('needs a fiscal calendar') ? 'var(--bad)' : undefined }}>
            {report.map((r, i) => <div key={i}>{r}</div>)}
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>Recon</div>
          <Stats items={[
            { label: 'Listing provision', value: currency(provTotal, unit.currency) },
            { label: 'GL provision', value: data?.openingGlProvision == null ? 'Not received' : currency(data.openingGlProvision, unit.currency) },
            { label: 'Provision difference', value: provDiff == null ? '—' : currency(provDiff, unit.currency), tone: provDiff == null ? 'warn' : Math.abs(provDiff) <= 0.005 ? 'ok' : 'bad' },
            { label: 'Listing ARO acquisition cost', value: currency(aroCostTotal, unit.currency) },
            { label: 'GL ARO acquisition cost', value: data?.openingGlAroCost == null ? 'Not received' : currency(data.openingGlAroCost, unit.currency) },
            { label: 'Cost difference', value: aroCostDiff == null ? '—' : currency(aroCostDiff, unit.currency), tone: aroCostDiff == null ? 'warn' : Math.abs(aroCostDiff) <= 0.005 ? 'ok' : 'bad' },
            { label: 'Listing ARO accum. amortization', value: currency(accumTotal, unit.currency) },
            { label: 'GL ARO accum. amortization', value: data?.openingGlAroAccum == null ? 'Not received' : currency(data.openingGlAroAccum, unit.currency) },
            { label: 'Accum. difference', value: aroAccumDiff == null ? '—' : currency(aroAccumDiff, unit.currency), tone: aroAccumDiff == null ? 'warn' : Math.abs(aroAccumDiff) <= 0.005 ? 'ok' : 'bad' },
            { label: 'Listing ARO NBV', value: currency(arcTotal, unit.currency) },
            { label: 'GL ARO NBV', value: glAroNbv == null ? '—' : currency(glAroNbv, unit.currency) },
            { label: 'NBV difference', value: aroNbvDiff == null ? '—' : currency(aroNbvDiff, unit.currency), tone: aroNbvDiff == null ? 'warn' : Math.abs(aroNbvDiff) <= 0.005 ? 'ok' : 'bad' },
          ]} />
          {editable && !locked && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: '0 0 260px' }}>
                <Field label="Opening GL provision" help="The total on the ARO provision account(s) from the opening trial balance.">
                  <input className="input num" inputMode="decimal" value={glProv}
                    onChange={(e) => setGlProv(e.target.value)}
                    onBlur={() => formatGlField(glProv, setGlProv)}
                    placeholder={`e.g. ${currency(5_120_000, unit.currency)}`} />
                </Field>
              </div>
              <button className="btn btn-primary btn-sm" type="button" disabled={!glProv.trim()}
                onClick={() => recordGl('provision', glProv)}>Record provision</button>
              <div style={{ flex: '0 0 260px' }}>
                <Field label="Opening GL ARO acquisition cost" help="The total gross retirement-cost-asset (acquisition cost) from the opening trial balance.">
                  <input className="input num" inputMode="decimal" value={glAroCost}
                    onChange={(e) => setGlAroCost(e.target.value)}
                    onBlur={() => formatGlField(glAroCost, setGlAroCost)}
                    placeholder={`e.g. ${currency(3_400_000, unit.currency)}`} />
                </Field>
              </div>
              <button className="btn btn-primary btn-sm" type="button" disabled={!glAroCost.trim()}
                onClick={() => recordGl('aroCost', glAroCost)}>Record cost</button>
              <div style={{ flex: '0 0 260px' }}>
                <Field label="Opening GL ARO accumulated amortization" help="The total accumulated amortization of the retirement cost asset from the opening trial balance.">
                  <input className="input num" inputMode="decimal" value={glAroAccum}
                    onChange={(e) => setGlAroAccum(e.target.value)}
                    onBlur={() => formatGlField(glAroAccum, setGlAroAccum)}
                    placeholder={`e.g. ${currency(1_800_000, unit.currency)}`} />
                </Field>
              </div>
              <button className="btn btn-primary btn-sm" type="button" disabled={!glAroAccum.trim()}
                onClick={() => recordGl('aroAccum', glAroAccum)}>Record accum.</button>
            </div>
          )}
          {locked ? (
            <div className="note-panel" style={{ marginTop: 16 }}>
              Opening balances are locked. The converted provision, ARO asset, accumulated amortization, useful life and opening future value will not change. In-year activity is reported on Roll-forward & disclosure. An updated master TCA listing is loaded on ARO scoping and does not rewrite this conversion listing.
            </div>
          ) : editable && (
            <div style={{ marginTop: 16 }}>
              {lockBlocked && <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>{lockBlocked}</div>}
              <button className="btn btn-primary btn-sm" type="button" disabled={!!lockBlocked}
                onClick={() => apply('Lock opening balances', 'admin',
              'Opening balances were locked. The converted figures will not change. In-year activity is reported on Roll-forward & disclosure. Go-forward TCA listing changes belong on ARO scoping.',
              (s) => { lockOpeningBalances(s.data[unit.id]); })}>
                Lock opening balances
              </button>
            </div>
          )}
          {locked && canReverse(ui.role) && (
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-secondary btn-sm" type="button"
                onClick={() => apply('Unlock opening balances', 'reverse',
                  'Opening balances were unlocked. The year-end lock sequence will stop at the conversion gate until they are locked again. The conversion listings stay as they were at lock.',
                  (s) => { s.data[unit.id].conversionAgreed = false; })}>
                Unlock opening balances
              </button>
            </div>
          )}
          {locked && !canReverse(ui.role) && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>Unlocking opening balances is an engagement partner action.</div>
          )}
        </div>
        {(openingOb.length) === 0 ? (
          <Empty>No obligations yet. Load the opening extract to establish the existing population and balances.</Empty>
        ) : (
          <SheetTable
            rows={openingOb}
            rowKey={(o) => o.id}
            noun="obligations"
            columns={obligationExtractColumns({
              events: data.events,
              extras: extraNames,
              classes,
              currency: unit.currency,
              calendarType: unit.calendarType,
            })}
            footer={moneyFooter(
              obligationExtractColumns({
                events: data.events,
                extras: extraNames,
                classes,
                currency: unit.currency,
                calendarType: unit.calendarType,
              }),
              obligationMoneyTotals(openingOb, data.events),
              unit.currency,
            )}
          />
        )}
      </Block>
    )}

    {tab === 'register' && (
      <Block
        className={`posting-pane g-tone ${paneTone}`}
        kicker="Register"
        title="Master TCA listing joined to the obligation and ARO asset listing"
        note={frozen
          ? 'Conversion rows only, joined to the frozen master TCA listing. Obligation, ARO asset and master TCA listing columns are colour-coded. In-year obligations created after lock are on ARO scoping and the ARO Register.'
          : 'One row per obligation, with the linked TCA fields beside it. Obligation, ARO asset and master TCA listing columns are colour-coded. TCA cost totals count each linked asset once. Grouped Postings uses these same columns.'}
        actions={
          <button className="btn btn-secondary btn-sm" type="button" onClick={exportListings}>
            Export listings to Excel
          </button>
        }
      >
        {(openingOb.length) === 0 ? (
          <Empty>Load the obligation and ARO asset listing and the master TCA listing to see the merged register.</Empty>
        ) : (
          <SheetTable
            rows={openingOb}
            rowKey={(o) => o.id}
            noun="rows"
            columns={registerColumns({
              events: data.events,
              extras: extraNames,
              tcaExtras,
              tcaByObl,
              classes,
              currency: unit.currency,
              calendarType: unit.calendarType,
            })}
            footer={moneyFooter(
              registerColumns({
                events: data.events,
                extras: extraNames,
                tcaExtras,
                tcaByObl,
                classes,
                currency: unit.currency,
                calendarType: unit.calendarType,
              }),
              registerMoneyTotals(openingOb, data.events, tcaByObl),
              unit.currency,
            )}
          />
        )}
      </Block>
    )}

    {tab === 'grouped' && (
      <Block
        className={`posting-pane g-tone ${paneTone}`}
        kicker="Grouped Postings"
        title="The register, grouped"
        note="Same columns as Register. Obligation, ARO asset and master TCA listing columns are colour-coded. By asset class groups on ARO asset class. By obligation type groups on the extract type; empty type is No type."
        actions={
          <button className="btn btn-secondary btn-sm" type="button" onClick={exportListings}>
            Export listings to Excel
          </button>
        }
      >
        <div className="posting-subtabs" role="tablist" aria-label="Grouped postings">
          <button type="button" role="tab" aria-selected={groupedSub === 'class'}
            className={`posting-subtab${groupedSub === 'class' ? ' is-on' : ''}`}
            onClick={() => setUi({ tab: 'grouped', sub: 'class' })}>
            By Asset Class
          </button>
          <button type="button" role="tab" aria-selected={groupedSub === 'type'}
            className={`posting-subtab${groupedSub === 'type' ? ' is-on' : ''}`}
            onClick={() => setUi({ tab: 'grouped', sub: 'type' })}>
            By Obligation Type
          </button>
        </div>
        {(openingOb.length) === 0 ? (
          <Empty>Load the obligation and ARO asset listing first. Grouped postings use the same rows as Register.</Empty>
        ) : groupOpeningRows(openingOb, groupedSub, classes).map((group) => {
          const cols = registerColumns({
            events: data.events,
            extras: extraNames,
            tcaExtras,
            tcaByObl,
            classes,
            currency: unit.currency,
            calendarType: unit.calendarType,
          });
          return (
            <div key={group.key} style={{ marginBottom: 22 }}>
              <div className="kicker" style={{ marginBottom: 6 }}>{group.label} · {group.rows.length} obligation{group.rows.length === 1 ? '' : 's'}</div>
              <SheetTable
                rows={group.rows}
                rowKey={(o) => o.id}
                noun="rows"
                columns={cols}
                footer={moneyFooter(
                  cols,
                  registerMoneyTotals(group.rows, data.events, tcaByObl),
                  unit.currency,
                )}
              />
            </div>
          );
        })}
      </Block>
    )}


      {confirmed ? (
        <div className="note-panel" style={{ marginTop: 16 }}>
          {locked
            ? 'Unit setup confirmed. Opening balances are locked.'
            : 'Unit setup confirmed. You can still reload the extract until opening balances are locked; matching references update rather than duplicating rows.'}
        </div>
      ) : (
        <UnitContinue
          allowed={allowed}
          canContinue
          blocked=""
          label="Continue to Prepare"
          onContinue={() => {
            apply('Confirm unit setup', 'admin',
              `${unit.entity} unit setup confirmed. The opening register is ready for Prepare.`,
              (s) => { completeUnitSetup(s, tenant.id, unit.id); });
            setUi({ screen: firstPrepare, tab: '', sub: '' });
          }}
        />
      )}
    </>
  );
}

function UnitContinue({
  allowed, canContinue, blocked, label, onContinue,
}: {
  allowed: boolean;
  canContinue: boolean;
  blocked: string;
  label: string;
  onContinue: () => void;
}) {
  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      {!canContinue && <div className="muted" style={{ fontSize: 12.5 }}>{blocked}</div>}
      <button className="btn btn-primary" type="button" disabled={!allowed || !canContinue} onClick={onContinue}>
        {label}
      </button>
    </div>
  );
}

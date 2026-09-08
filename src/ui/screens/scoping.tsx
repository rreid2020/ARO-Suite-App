/**
 * ARO scoping — go-forward master TCA listing after opening lock.
 *
 * Conversion population stays on Opening register. An updated listing is
 * loaded here, compared to the ARO register, and acted on: scope new assets,
 * create linked obligations, flag unproductive ARO assets, retire disposed TCAs.
 */

import React, { useRef, useState } from 'react';
import { useStore, useTenant, useUnit, useUnitData } from '../../core/store';
import { canEdit } from '../../core/authority';
import { obligationColumnNames } from '../../core/openingLoad';
import { openPeriod } from '../../core/periodClose';
import {
  conversionListingsFrozen,
  loadCurrentTcaListing,
  openingTcaListing,
  parseTcaListing,
  setTcaAssetStatus,
  setTcaScope,
  tcaByObligationId,
  tcaColumnNames,
  tcaScopingGaps,
  tcaTemplateDataRows,
  tcaTemplateHeaders,
  tcaTemplateNotes,
} from '../../core/tcaListing';
import {
  applyCreateObligation,
  applyDisposeLinkedAro,
  applyTcaStatusToAro,
  applyUnproductiveFlags,
  planTcaSync,
  suggestedAroAssetNumber,
  tcaAssetByNumber,
  uniqueObligationRef,
  type TcaSyncAction,
} from '../../core/tcaSync';
import { parseNumber } from '../../core/format';
import { evaluateNewAroLifeDraft, suggestedSettlementDate, tcaUlText, withSettlementFromRemaining } from '../../core/usefulLife';
import type { EstimateColumn, TcaAsset, TcaAssetStatus, TcaScope } from '../../core/types';
import { isValidDate, maskDateInput, priorYearEnd } from '../../engine/dates';
import {
  Block, Empty, Field, NewAroEstimate, NewAroLifeFields, NewAroSettlementFields, DEFAULT_ESTIMATE_COLUMNS, currency, emptyEstimateLine, estimateHasCost, estimatePayload, SheetTable, Stats,
} from '../components';
import type { EstimateLineDraft, EstimateMode } from '../components';
import { moneyFooter, obligationColumnKeys, obligationExtractColumns, obligationMoneyTotals, tcaListingColumns, tcaMoneyTotals } from './openingListings';
import { download, S } from '../../xlsx/write';

const SCOPING_TABS = [
  { id: 'tca', label: 'Master TCA listing', kicker: 'Current', tone: 'g-aro-asset' },
  { id: 'actions', label: 'Keep ARO in sync', kicker: 'Actions', tone: 'g-movement' },
  { id: 'register', label: 'Obligation and ARO Asset Listing', kicker: 'Go-forward', tone: 'g-obligation' },
] as const;

type ScopingTabId = (typeof SCOPING_TABS)[number]['id'];

function scopingTabOf(tab: string | undefined): ScopingTabId {
  if (SCOPING_TABS.some((t) => t.id === tab)) return tab as ScopingTabId;
  return 'tca';
}

function kindLabel(kind: TcaSyncAction['kind']): string {
  if (kind === 'scope-undecided') return 'Needs scoping';
  if (kind === 'create-obligation') return 'Create obligation';
  if (kind === 'mark-unproductive') return 'Flag unproductive';
  if (kind === 'mark-productive') return 'Restore productive use';
  if (kind === 'dispose-aro') return 'Retire ARO';
  return 'Not on latest file';
}

export function Scope() {
  const { state, ui, setUi, write, apply } = useStore();
  const tenant = useTenant()!;
  const unit = useUnit()!;
  const data = useUnitData()!;
  const editable = canEdit(ui.role);
  const goForward = conversionListingsFrozen(data);
  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState('');
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<string[] | null>(null);
  const [createFor, setCreateFor] = useState<string | null>(null);
  const [disposeFor, setDisposeFor] = useState<string | null>(null);
  const open = openPeriod(data);
  const [create, setCreate] = useState({
    ref: '', description: '', costEstimateDate: priorYearEnd(unit.fyEnd),
    settlementDate: '', aroseOn: open?.ends ?? '', aroAssetNumber: '',
    assetAcquisitionDate: '', totalUl: '', expiredUl: '',
    estimateMode: 'single' as EstimateMode, estimateLines: [emptyEstimateLine()] as EstimateLineDraft[],
    estimateColumns: DEFAULT_ESTIMATE_COLUMNS as EstimateColumn[],
  });
  const [settledOn, setSettledOn] = useState(open?.ends ?? '');

  const assets = data.tcaAssets ?? [];
  const openingTca = openingTcaListing(data);
  const gaps = tcaScopingGaps(assets, data.obligations);
  const actions = planTcaSync(data);
  const inScope = assets.filter((a) => a.scope === 'In scope').length;
  const out = assets.filter((a) => a.scope === 'Scoped out');
  const tcaExtras = tcaColumnNames(assets);
  const classes = state.settings[tenant.id].aroAssetClasses ?? [];
  const extraNames = obligationColumnNames(data.obligations);
  const tab = scopingTabOf(ui.tab);
  const paneTone = SCOPING_TABS.find((t) => t.id === tab)?.tone ?? 'g-aro-asset';
  const tabMeta: Record<ScopingTabId, string> = {
    tca: `${assets.length} asset${assets.length === 1 ? '' : 's'}`,
    actions: actions.length ? `${actions.length} to review` : 'In sync',
    register: `${data.obligations.length} obligation${data.obligations.length === 1 ? '' : 's'}`,
  };

  const loadTca = (text: string, filename: string) => {
    if (!goForward) {
      apply('Load current TCA listing', 'refused',
        'Lock opening balances before loading an updated master TCA listing. Conversion population is loaded on Opening register.', () => {});
      setReport(['Lock opening balances on Opening register before loading an updated listing here.']);
      return;
    }
    const parsed = parseTcaListing(text);
    if (parsed.problems.length || !parsed.rows.length) {
      apply('Load current TCA listing', 'refused', parsed.problems[0] ?? 'Nothing was loaded.', () => {});
      setReport(['Nothing was loaded. Fix the errors below and load the file again.', ...parsed.problems]);
      return;
    }
    apply('Load current TCA listing', 'import',
      `Loaded ${parsed.rows.length} TCA asset${parsed.rows.length === 1 ? '' : 's'} from ${filename} onto the current listing. The conversion listing on Opening register was not changed.`,
      (s) => { loadCurrentTcaListing(s, tenant.id, unit.id, parsed, { filename, text }); });
    const snapshotCount = openingTca.length;
    setReport([
      `Loaded ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} from ${filename} onto the current listing.`,
      `Opening register still holds ${snapshotCount} conversion TCA row${snapshotCount === 1 ? '' : 's'}.`,
    ]);
    setPaste('');
    setImporting(false);
    setUi({ tab: 'tca' });
  };

  const changeTcaScope = (asset: TcaAsset, status: string, reason: string) => {
    if (!goForward) {
      apply('Change asset scoping', 'refused', 'Scope the conversion population on Opening register until opening balances are locked.', () => {});
      return;
    }
    const next = setTcaScope(asset, status as TcaScope, reason, data.obligations);
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
    if (!goForward) {
      apply('Change TCA asset status', 'refused', 'Change conversion status on Opening register until opening balances are locked.', () => {});
      return;
    }
    const next = setTcaAssetStatus(asset, status);
    write<TcaAsset>({
      domain: 'register', record: asset.id, recordLabel: `${asset.assetNumber} asset status`,
      before: asset, after: next, action: 'Change TCA asset status',
      apply: (s, v) => {
        const d = s.data[unit.id];
        const l = d.tcaAssets;
        const i = l.findIndex((x) => x.id === asset.id);
        if (i >= 0) l[i] = v;
        applyTcaStatusToAro(d, v);
      },
    });
  };

  const exportTcaTemplate = () => {
    const extras = tcaExtras;
    const headers = tcaTemplateHeaders(extras);
    const dataRows = tcaTemplateDataRows(assets, extras);
    const moneyIdx = new Set(
      headers.map((h, i) => (
        ['Acquisition cost', 'Accumulated amortization', 'Net book value'].includes(h) ? i : -1
      )).filter((i) => i >= 0),
    );
    const file = `${unit.entity.replace(/\W+/g, '-')}-current-master-tca-listing.xlsx`;
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

  const startCreate = (action: TcaSyncAction) => {
    const asset = tcaAssetByNumber(data.tcaAssets, action.assetNumber);
    const costEstimateDate = priorYearEnd(unit.fyEnd);
    const assetAcquisitionDate = asset?.acquisitionDate ?? '';
    const totalUl = tcaUlText(asset?.totalUl);
    const expiredUl = tcaUlText(asset?.expiredUl);
    const life = evaluateNewAroLifeDraft({
      totalUlText: totalUl,
      expiredUlText: expiredUl,
      tca: asset,
      assetAcquisitionDate,
      costEstimateDate,
      settlementDate: '',
      dayCount: unit.dayCount,
    });
    setDisposeFor(null);
    setCreateFor(action.id);
    setCreate({
      ref: uniqueObligationRef(data.obligations, `ARO-${action.assetNumber}`),
      description: action.description,
      costEstimateDate,
      settlementDate: suggestedSettlementDate(costEstimateDate, life.remainingUl, unit.dayCount),
      aroseOn: open?.ends ?? '',
      aroAssetNumber: suggestedAroAssetNumber(data.obligations, action.assetNumber),
      assetAcquisitionDate,
      totalUl,
      expiredUl,
      estimateMode: 'single',
      estimateLines: [emptyEstimateLine()],
      estimateColumns: DEFAULT_ESTIMATE_COLUMNS,
    });
    setUi({ tab: 'actions' });
  };

  const submitCreate = (action: TcaSyncAction) => {
    const asset = tcaAssetByNumber(data.tcaAssets, action.assetNumber);
    if (!asset) {
      apply('Create linked obligation', 'refused', `${action.assetNumber} is not on the current listing.`, () => {});
      return;
    }
    const input = {
      ref: create.ref,
      description: create.description,
      ...estimatePayload(create.estimateLines, create.estimateColumns),
      costEstimateDate: create.costEstimateDate,
      settlementDate: create.settlementDate,
      aroseOn: create.aroseOn,
      assetAcquisitionDate: create.assetAcquisitionDate,
      aroAssetNumber: create.aroAssetNumber.trim() || undefined,
      totalUl: create.totalUl.trim() === '' ? undefined : parseNumber(create.totalUl),
      expiredUl: create.expiredUl.trim() === '' ? undefined : parseNumber(create.expiredUl),
    };
    const probe = applyCreateObligation(structuredClone(state), tenant.id, unit.id, asset, input);
    if (typeof probe === 'string') {
      apply('Create linked obligation', 'refused', probe, () => {});
      return;
    }
    apply('Create linked obligation', 'write',
      `Created ${input.ref} linked to ${asset.assetNumber} and posted initial recognition ${currency(probe.amount, unit.currency)} in ${probe.periodCode}.`,
      (s) => {
        const live = tcaAssetByNumber(s.data[unit.id].tcaAssets, action.assetNumber);
        if (live) applyCreateObligation(s, tenant.id, unit.id, live, input);
      });
    setCreateFor(null);
  };

  const submitFlag = (action: TcaSyncAction) => {
    apply('Sync ARO productive use', 'write',
      action.kind === 'mark-productive'
        ? `Restored productive use on ARO assets linked to ${action.assetNumber}.`
        : `Flagged ARO assets linked to ${action.assetNumber} as not in productive use.`,
      (s) => { applyUnproductiveFlags(s.data[unit.id], action); });
  };

  const submitDispose = (action: TcaSyncAction) => {
    const probeState = structuredClone(state);
    const probe = applyDisposeLinkedAro(probeState, tenant.id, unit.id, action, settledOn);
    if (!probe.startsWith('Retired')) {
      apply('Retire linked ARO', 'refused', probe, () => {});
      return;
    }
    apply('Retire linked ARO', 'write', probe, (s) => {
      applyDisposeLinkedAro(s, tenant.id, unit.id, action, settledOn);
    });
    setDisposeFor(null);
  };

  const createPanel = (action: TcaSyncAction) => {
    const asset = tcaAssetByNumber(data.tcaAssets, action.assetNumber);
    const listingAcq = asset?.acquisitionDate ?? '';
    const life = evaluateNewAroLifeDraft({
      totalUlText: create.totalUl,
      expiredUlText: create.expiredUl,
      tca: asset,
      assetAcquisitionDate: create.assetAcquisitionDate,
      costEstimateDate: create.costEstimateDate,
      settlementDate: create.settlementDate,
      dayCount: unit.dayCount,
    });
    const canPost = create.ref.trim()
      && estimateHasCost(create.estimateLines, create.estimateColumns)
      && isValidDate(create.assetAcquisitionDate)
      && isValidDate(create.costEstimateDate)
      && isValidDate(create.settlementDate)
      && isValidDate(create.aroseOn)
      && !life.issue;
    return (
      <>
        <div className="kicker" style={{ marginBottom: 8 }}>New obligation for {action.assetNumber}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
          <Field label="Obligation number"><input className="input" value={create.ref} onChange={(e) => setCreate({ ...create, ref: e.target.value })} /></Field>
          <Field label="Description"><input className="input" value={create.description} onChange={(e) => setCreate({ ...create, description: e.target.value })} /></Field>
          <Field
            label="ARO asset acquisition date"
            help="The date the obligating event occurred. Defaults from the linked TCA's acquisition date on the master listing. Change it when the obligation arose on a different date. Catch-up amortization is PV × expired UL / total UL, measured from this date."
            hint={!isValidDate(create.assetAcquisitionDate) && !isValidDate(listingAcq)
              ? 'No acquisition date on the master TCA listing. Enter the date the obligating event occurred.'
              : isValidDate(listingAcq) && create.assetAcquisitionDate === listingAcq
                ? `Defaulted from the TCA acquisition date (${listingAcq}). Change it if the obligating event occurred on a different date.`
                : isValidDate(listingAcq) && create.assetAcquisitionDate !== listingAcq
                  ? `TCA acquisition date on the listing is ${listingAcq}.`
                  : undefined}
          >
            <input className="input" value={create.assetAcquisitionDate} onChange={(e) => {
              const assetAcquisitionDate = maskDateInput(e.target.value);
              setCreate((v) => withSettlementFromRemaining(v, { ...v, assetAcquisitionDate }, unit.dayCount, asset, asset));
            }} placeholder="YYYY-MM-DD" />
          </Field>
          <Field
            label="Cost estimate date"
            help={`The price date of the cost build-up. Defaults to the prior financial year end. This year ends ${unit.fyEnd}.`}
          >
            <input className="input" value={create.costEstimateDate} onChange={(e) => {
              const costEstimateDate = maskDateInput(e.target.value);
              setCreate((v) => withSettlementFromRemaining(v, { ...v, costEstimateDate }, unit.dayCount, asset, asset));
            }} placeholder="YYYY-MM-DD" />
          </Field>
          <NewAroSettlementFields
            settlementDate={create.settlementDate}
            yearsToSettlement={life.yearsToSettlement}
            remainingUl={life.remainingUl}
            issue={life.issue}
            suggested={suggestedSettlementDate(create.costEstimateDate, life.remainingUl, unit.dayCount)}
            onSettlementDate={(settlementDate) => setCreate((v) => ({ ...v, settlementDate }))}
          />
          <Field label="Effective date"><input className="input" value={create.aroseOn} onChange={(e) => setCreate({ ...create, aroseOn: maskDateInput(e.target.value) })} placeholder="YYYY-MM-DD" /></Field>
          <Field label="ARO asset number"><input className="input" value={create.aroAssetNumber} onChange={(e) => setCreate({ ...create, aroAssetNumber: e.target.value })} /></Field>
          <NewAroLifeFields
            totalUl={create.totalUl}
            expiredUl={create.expiredUl}
            tca={asset}
            assetAcquisitionDate={create.assetAcquisitionDate}
            costEstimateDate={create.costEstimateDate}
            settlementDate={create.settlementDate}
            dayCount={unit.dayCount}
            onTotalUl={(totalUl) => setCreate((v) => withSettlementFromRemaining(v, { ...v, totalUl }, unit.dayCount, asset, asset))}
            onExpiredUl={(expiredUl) => setCreate((v) => withSettlementFromRemaining(v, { ...v, expiredUl }, unit.dayCount, asset, asset))}
          />
          <NewAroEstimate
            mode={create.estimateMode}
            lines={create.estimateLines}
            columns={create.estimateColumns}
            currencyCode={unit.currency}
            templates={state.settings[tenant.id]?.costEstimateTemplates}
            onMode={(estimateMode) => setCreate((v) => ({ ...v, estimateMode }))}
            onLines={(estimateLines) => setCreate((v) => ({ ...v, estimateLines }))}
            onColumns={(estimateColumns) => setCreate((v) => ({ ...v, estimateColumns }))}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary btn-sm" type="button" disabled={!canPost} onClick={() => submitCreate(action)}>Post new ARO</button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setCreateFor(null)}>Cancel</button>
        </div>
      </>
    );
  };

  const disposePanel = (action: TcaSyncAction) => (
    <>
      <div className="kicker" style={{ marginBottom: 8 }}>Retire ARO for disposed TCA {action.assetNumber}</div>
      <div style={{ maxWidth: 260 }}>
        <Field label="Effective date" help="Must fall in the open period. Posts the related-asset-sold case: extinguish remaining provision and retire the ARO asset.">
          <input className="input" value={settledOn} onChange={(e) => setSettledOn(maskDateInput(e.target.value))} placeholder="YYYY-MM-DD" />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => submitDispose(action)}>Retire linked ARO</button>
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => setDisposeFor(null)}>Cancel</button>
      </div>
    </>
  );

  return (
    <>
      <div className="posting-tabs" role="tablist" aria-label="ARO scoping">
        {SCOPING_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
            className={`posting-tab g-tone ${t.tone}${tab === t.id ? ' is-on' : ''}`}
            onClick={() => setUi({ tab: t.id, sub: '' })}>
            <span className="kicker">{t.kicker}</span>
            <span className="posting-tab-label">{t.label}</span>
            <span className="posting-tab-meta">{tabMeta[t.id]}</span>
          </button>
        ))}
      </div>

      <Stats items={[
        { label: 'TCA assets', value: String(assets.length) },
        { label: 'In scope', value: String(inScope) },
        { label: 'Out of scope', value: String(out.length) },
        { label: 'Undecided', value: String(gaps.undecided.length), tone: gaps.undecided.length ? 'warn' : 'ok' },
        { label: 'Actions', value: String(actions.length), tone: actions.length ? 'warn' : 'ok' },
      ]} />

      {tab === 'tca' && (
        <Block
          className={`posting-pane g-tone ${paneTone}`}
          kicker="Master TCA listing"
          title={goForward
            ? (assets.length === 0 ? 'Load the current tangible capital assets' : `${assets.length} asset${assets.length === 1 ? '' : 's'} on the current listing`)
            : 'Conversion scoping is on Opening register'}
          note={goForward
            ? 'This is the current master TCA listing. Load an updated extract when the organisation\'s PPE population changes. New rows are scoped here. In-scope assets without an obligation need a linked obligation and ARO asset. Unproductive and Disposed status keep the ARO register in step. Opening register stays the conversion snapshot.'
            : 'Lock opening balances first. Until then, the conversion population is scoped on Opening register so go-forward changes cannot rewrite the opening listing.'}
          actions={
            <>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setUi({ screen: 'unit-opening', tab: '', sub: '' })}>
                Open opening register
              </button>
              {goForward && (
                <>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={exportTcaTemplate}>
                    Export TCA template
                  </button>
                  {editable && (
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => setImporting((v) => !v)}>
                      {importing ? 'Cancel import' : 'Load updated listing'}
                    </button>
                  )}
                </>
              )}
            </>
          }
        >
          {importing && editable && goForward && (
            <div style={{ marginBottom: 16, padding: 12, background: 'var(--color-surface)' }}>
              <Field label="Paste or import the updated master TCA listing" help="Same template as Opening register. Existing TCA asset numbers are updated; new numbers are added as Undecided unless the file has a Scope column. The conversion listing on Opening register is not changed.">
                <textarea className="input" rows={7} value={paste} onChange={(e) => setPaste(e.target.value)}
                  placeholder={'TCA asset number,Description,TCA asset class,Acquisition date,Acquisition cost,Accumulated amortization,Net book value,Total UL,Expired UL,Site,Asset status\nAS-10001,Well 14-23 pad,Wells,2008-06-15,2100000,800000,1300000,25,10,North,Active'} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary btn-sm" type="button" disabled={!paste.trim()}
                    onClick={() => loadTca(paste, 'pasted block')}>Load pasted listing</button>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => fileRef.current?.click()}>Choose file</button>
                  <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx" style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (/\.xlsx$/i.test(f.name)) {
                        apply('Load current TCA listing', 'refused',
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
          {report && report.length > 0 && (
            <div className="note-panel" style={{ marginBottom: 14, borderLeftColor: report[0]?.startsWith('Nothing was loaded') || report[0]?.startsWith('Lock opening') ? 'var(--bad)' : undefined }}>
              {report.map((r, i) => <div key={i}>{r}</div>)}
            </div>
          )}
          {assets.length === 0 ? (
            <Empty>{goForward
              ? 'No current master TCA listing yet. Export the template, fill the organisation\'s current population, and load it here.'
              : 'No master TCA listing yet. Load it on Opening register, lock opening balances, then return here for go-forward changes.'}</Empty>
          ) : (
            <SheetTable
              rows={assets}
              rowKey={(a) => a.id}
              noun="assets"
              columns={tcaListingColumns({
                extras: tcaExtras,
                obligations: data.obligations,
                currency: unit.currency,
                calendarType: unit.calendarType,
                editable: editable && goForward,
                locked: !goForward,
                onScope: changeTcaScope,
                onStatus: goForward ? changeTcaStatus : undefined,
              })}
              footer={moneyFooter(
                tcaListingColumns({ extras: tcaExtras, obligations: data.obligations, currency: unit.currency, calendarType: unit.calendarType, editable: editable && goForward, locked: !goForward, onScope: changeTcaScope, onStatus: goForward ? changeTcaStatus : undefined }).map((c) => c.key),
                tcaMoneyTotals(assets),
                unit.currency,
              )}
            />
          )}
          {gaps.orphanObligations.length > 0 && (
            <div className="note-panel" style={{ marginTop: 12, borderLeftColor: 'var(--bad)' }}>
              {gaps.orphanObligations.length} obligation{gaps.orphanObligations.length === 1 ? '' : 's'} name a TCA asset number that is not on this listing. Add those assets to the current listing.
            </div>
          )}
        </Block>
      )}

      {tab === 'actions' && (
        <Block
          className={`posting-pane g-tone ${paneTone}`}
          kicker="Keep ARO in sync"
          title={actions.length === 0 ? 'The current listing and the ARO register are in step' : `${actions.length} action${actions.length === 1 ? '' : 's'} to keep the ARO register in step`}
          note="Compared against existing obligations and ARO assets. Creating an obligation posts initial recognition into the open period. Disposing a TCA retires remaining provision and the ARO asset as a related-asset sale. Unproductive flags stop later estimate changes from hitting the ARO asset."
        >
          {!goForward ? (
            <Empty>Lock opening balances on Opening register before go-forward sync actions are taken here.</Empty>
          ) : actions.length === 0 ? (
            <Empty>Nothing to do. New TCA rows, Unproductive and Disposed status, and in-scope assets without an obligation will appear here after the next listing load or status change.</Empty>
          ) : (
            <SheetTable
              rows={actions}
              rowKey={(a) => a.id}
              noun="actions"
              columns={[
                { key: 'kind', header: 'Action', value: (a) => kindLabel(a.kind), cell: (a) => kindLabel(a.kind) },
                { key: 'assetNumber', header: 'TCA asset number', value: (a) => a.assetNumber, cell: (a) => a.assetNumber },
                { key: 'description', header: 'Description', value: (a) => a.description, tdStyle: { whiteSpace: 'normal', maxWidth: 240 }, cell: (a) => a.description },
                { key: 'detail', header: 'What to do', value: (a) => a.detail, tdStyle: { whiteSpace: 'normal', maxWidth: 420 }, cell: (a) => a.detail },
                { key: 'do', header: 'Do', cell: (a) => {
                  if (!editable) return null;
                  if (a.kind === 'scope-undecided' || a.kind === 'dropped') {
                    return <span className="muted">Mark the listing</span>;
                  }
                  if (a.kind === 'create-obligation') {
                    const open = createFor === a.id;
                    return (
                      <button
                        className={open ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
                        type="button"
                        aria-expanded={open}
                        onClick={() => (open ? setCreateFor(null) : startCreate(a))}
                      >
                        {open ? 'Close' : 'Create obligation'}
                      </button>
                    );
                  }
                  if (a.kind === 'mark-unproductive' || a.kind === 'mark-productive') {
                    return <button className="btn btn-primary btn-sm" type="button" onClick={() => submitFlag(a)}>Apply</button>;
                  }
                  if (a.kind === 'dispose-aro') {
                    const disposeOpen = disposeFor === a.id;
                    return (
                      <button
                        className={disposeOpen ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
                        type="button"
                        aria-expanded={disposeOpen}
                        onClick={() => {
                          if (disposeOpen) { setDisposeFor(null); return; }
                          setCreateFor(null);
                          setDisposeFor(a.id);
                          setSettledOn(open?.ends ?? '');
                          setUi({ tab: 'actions' });
                        }}
                      >
                        {disposeOpen ? 'Close' : 'Retire ARO'}
                      </button>
                    );
                  }
                  return null;
                } },
              ]}
              expand={(a) => {
                if (createFor === a.id) return createPanel(a);
                if (disposeFor === a.id) return disposePanel(a);
                return null;
              }}
            />
          )}
        </Block>
      )}

      {tab === 'register' && (
        <Block
          className={`posting-pane g-tone ${paneTone}`}
          kicker="Obligation and ARO Asset Listing"
          title="Current ARO register"
          note="Every obligation on this reporting unit, including rows created after conversion. Opening register still shows only the conversion population. Edit identity, useful life and productive-use on the ARO Register."
          actions={
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => setUi({ screen: 'register', tab: '', sub: '' })}>
              Open ARO Register
            </button>
          }
        >
          {data.obligations.length === 0 ? (
            <Empty>No obligations yet.</Empty>
          ) : (
            <SheetTable
              rows={data.obligations}
              rowKey={(o) => o.id}
              noun="obligations"
              columns={obligationExtractColumns({
                events: data.events,
                extras: extraNames,
                classes,
                currency: unit.currency,
                calendarType: unit.calendarType,
                tcaByObl: tcaByObligationId(assets, data.obligations),
              })}
              footer={moneyFooter(
                obligationColumnKeys(obligationExtractColumns({
                  events: data.events,
                  extras: extraNames,
                  classes,
                  currency: unit.currency,
                  calendarType: unit.calendarType,
                  tcaByObl: tcaByObligationId(assets, data.obligations),
                })),
                obligationMoneyTotals(data.obligations, data.events),
                unit.currency,
              )}
            />
          )}
        </Block>
      )}
    </>
  );
}

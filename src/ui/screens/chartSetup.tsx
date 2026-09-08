/**
 * Chart of accounts, coding block and posting rules — reporting-unit setup
 * steps. The organisation's GL is tenant-scoped: every unit on the tenant
 * sees the same chart and posting scenarios.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useStore, useTenant } from '../../core/store';
import { canConfigureTenant } from '../../core/authority';
import { ENGINE_POSTING_CASES } from '../../engine/postingCases';
import { ACCOUNT_CLASSES, ENGINE_EVENT_TYPES, ENGINE_POSTING_RULES, ENGINE_ROLES } from '../../seed';
import { importAssetClassesFromListing, parseAssetListing, patchAssetClass, deleteAssetClass } from '../../core/assetListing';
import { classLabel } from '../../core/assetClass';
import { accountIdsInUse, chartColumnNames, deleteAccount, deleteUnusedAccounts, importChartOfAccounts, parseChartText } from '../../core/chartImport';
import { accountTypeOf } from '../../core/accountType';
import { addPostingRule, assignScenarioRole, completedRoleCount, deletePostingRule, prefillUnassignedFromChart, renamePostingRuleEvent, scenarioRoleGaps, setRoleComplete } from '../../core/posting';
import type { Account, PostingScenario } from '../../core/types';
import { AccountPicker, Block, Dot, Empty, Field, SheetTable, Tag } from '../components';

export function ChartOfAccounts() {
  const { state, ui, apply } = useStore();
  const tenant = useTenant()!;
  const admin = canConfigureTenant(ui.role);
  const accounts = state.settings[tenant.id].accounts;
  const [draft, setDraft] = useState({ code: '', name: '', cls: 'Liability' });
  const [importing, setImporting] = useState(accounts.length === 0);
  const [paste, setPaste] = useState('');
  const [report, setReport] = useState<string[] | null>(null);

  const loadChart = (text: string, filename: string) => {
    const parsed = parseChartText(text);
    if (!parsed.rows.length) {
      setReport(parsed.problems.length ? parsed.problems : ['No account rows could be read.']);
      return;
    }
    const preview = structuredClone(state);
    const result = importChartOfAccounts(preview, tenant.id, parsed);
    apply('Import chart of accounts', 'import',
      `Loaded ${parsed.rows.length} account${parsed.rows.length === 1 ? '' : 's'} from ${filename} so journals post to the organisation's own GLs.`,
      (s) => { importChartOfAccounts(s, tenant.id, parsed); });
    const lines = [
      `${result.added} added, ${result.updated} updated, ${result.removed} removed from ${filename}.`,
    ];
    if (result.segmentsUpdated.length) {
      lines.push(`Coding segments taken from the file: ${result.segmentsUpdated.join(', ')}. Permitted values are the distinct codes in those columns.`);
    }
    lines.push(...result.problems);
    setReport(lines);
    setPaste('');
    setImporting(false);
  };

  const add = () => {
    if (!admin || !draft.code.trim() || !draft.name.trim()) return;
    const code = draft.code.trim();
    if (accounts.some((a) => a.code === code)) {
      apply('Add account', 'refused', `Account ${code} is already on this chart.`, () => {});
      return;
    }
    apply('Add account', 'admin', `Added account ${code} ${draft.name.trim()}.`, (s) => {
      const row: Account = {
        id: `acc-${Date.now().toString(36)}`,
        tenantId: tenant.id,
        code,
        name: draft.name.trim(),
        cls: draft.cls,
        engineRole: '',
        requiredSegments: s.settings[tenant.id].segments.filter((seg) => seg.required).map((seg) => seg.name),
        columns: {},
      };
      s.settings[tenant.id].accounts.push(row);
    });
    setDraft({ code: '', name: '', cls: 'Liability' });
  };

  const used = accountIdsInUse(state, tenant.id);
  const unusedCount = accounts.filter((a) => !used.has(a.id)).length;
  const extraCols = chartColumnNames(accounts, state.settings[tenant.id].segments);

  const removeOne = (acc: Account) => {
    if (!admin) return;
    const preview = deleteAccount(structuredClone(state), tenant.id, acc.id);
    if (!preview.ok) {
      apply('Delete account', 'refused', preview.reason, () => {});
      return;
    }
    apply('Delete account', 'admin', `Removed ${acc.code} ${acc.name} from the chart.`, (s) => {
      deleteAccount(s, tenant.id, acc.id);
    });
  };

  const removeUnused = () => {
    if (!admin || unusedCount === 0) return;
    const whole = unusedCount === accounts.length;
    const ok = window.confirm(whole
      ? `Remove all ${accounts.length} GLs from this chart? None of them appear on a journal.`
      : `Remove ${unusedCount} unused GL${unusedCount === 1 ? '' : 's'}? ${accounts.length - unusedCount} remain because a journal still posts to them.`);
    if (!ok) return;
    apply('Delete unused accounts', 'admin',
      whole
        ? `Removed the chart of ${accounts.length} GLs. None were on a journal.`
        : `Removed ${unusedCount} unused GL${unusedCount === 1 ? '' : 's'}. ${accounts.length - unusedCount} remain because a journal still posts to them.`,
      (s) => { deleteUnusedAccounts(s, tenant.id); });
    setImporting(whole);
  };

  const accountCount = accounts.length === 1 ? '1 imported GL' : `${accounts.length} imported GLs`;

  return (
    <>
      <Block
        kicker="Chart of accounts"
        title={accounts.length ? `${accountCount} ready for posting scenarios` : 'Import the organisation\'s chart'}
        note={`${accountCount} fill posting-scenario pickers — the official list stays in their financial management system. This chart is shared with every reporting unit on the tenant. Every column from the import is kept on the GL, including headings this organisation uses that another will not. Extra columns also become the coding block. A GL can be deleted only when no journal posts to it. Re-import the same file if extra columns are blank (charts loaded before extra columns were stored).`}
        actions={admin && (
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {unusedCount > 0 && (
              <button className="btn btn-secondary btn-sm" type="button" onClick={removeUnused}>
                {unusedCount === accounts.length ? 'Delete chart' : `Delete ${unusedCount} unused GL${unusedCount === 1 ? '' : 's'}`}
              </button>
            )}
            <button className="btn btn-primary btn-sm" type="button" onClick={() => setImporting((v) => !v)}>
              {importing ? 'Cancel import' : 'Import chart'}
            </button>
          </span>
        )}
      >
        {importing && admin && (
          <div style={{ marginBottom: 16, padding: 12, background: 'var(--color-surface)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Field label="Paste or import the organisation's chart" help="Columns: account code, name, class (Asset, Liability, Equity, Income, Expense). A header row is read when present. Further columns (company, cost centre, account type, …) are stored on each GL and shown on this table — the headings are the organisation's, not a fixed layout. Those extra columns also become coding segments with those values permitted. An optional Engine role column maps a GL onto an engine part. Matching codes update name, class and extra columns and keep the role already assigned. Accounts not in the file are removed unless a journal still posts to them.">
              <textarea className="input" rows={7} value={paste} onChange={(e) => setPaste(e.target.value)}
                placeholder={'Code,Name,Class,Company,Cost centre\n22500,ARO provision,Liability,1000,CC-100\n16100,Retirement cost asset,Asset,1000,CC-100'} />
            </Field>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" type="button" disabled={!paste.trim()}
                onClick={() => loadChart(paste, 'pasted block')}>Load pasted chart</button>
              <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                Import .csv / .tsv / .txt
                <input type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    f.text().then((t) => loadChart(t, f.name));
                    e.target.value = '';
                  }} />
              </label>
            </div>
          </div>
        )}
        {report && (
          <div className="note-panel" style={{ marginBottom: 12 }}>
            <ul style={{ margin: 0, paddingLeft: 16 }}>{report.map((r, i) => <li key={i}>{r}</li>)}</ul>
          </div>
        )}
        {accounts.length === 0 && (
          <Empty>Import the organisation's chart so posting scenarios have GLs to choose from, or add a missing account below.</Empty>
        )}
        {accounts.length > 0 && (
          <SheetTable
            rows={accounts}
            rowKey={(a) => a.id}
            noun="GLs"
            columns={[
              { key: 'code', header: 'Code', value: (a) => a.code, cell: (a) => a.code },
              { key: 'name', header: 'Name', value: (a) => a.name, tdStyle: { maxWidth: 280, whiteSpace: 'normal' }, cell: (a) => a.name },
              { key: 'cls', header: 'Account type', value: (a) => accountTypeOf(a), cell: (a) => accountTypeOf(a) || '—' },
              ...extraCols.map((name) => ({
                key: `col:${name}`,
                header: name,
                value: (a: Account) => a.columns?.[name] ?? '',
                tdStyle: { maxWidth: 180, whiteSpace: 'normal' as const },
                cell: (a: Account) => a.columns?.[name] || <span className="muted">—</span>,
              })),
              { key: 'use', header: 'On a journal', value: (a) => used.has(a.id) ? 'Yes' : 'No', cell: (a) => (
                used.has(a.id) ? <Tag kind="warn">On a journal</Tag> : <span className="muted">Unused</span>
              ) },
              { key: 'act', header: '', cell: (a) => {
                const blocked = used.has(a.id);
                return (
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    disabled={!admin || blocked}
                    title={blocked ? `${a.code} is on a journal and cannot be deleted.` : `Remove ${a.code} from this chart.`}
                    onClick={() => removeOne(a)}
                  >Delete</button>
                );
              } },
            ]}
          />
        )}
        {admin && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 16, padding: 12, background: 'var(--color-surface)' }}>
            <div style={{ flex: '0 0 110px' }}><Field label="Code"><input className="input" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} /></Field></div>
            <div style={{ flex: '1 1 200px' }}><Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field></div>
            <div style={{ flex: '0 0 130px' }}><Field label="Class">
              <select className="input" value={draft.cls} onChange={(e) => setDraft({ ...draft, cls: e.target.value })}>
                {ACCOUNT_CLASSES.map((c) => <option key={c}>{c}</option>)}
              </select></Field></div>
            <button className="btn btn-primary btn-sm" type="button" disabled={!draft.code.trim() || !draft.name.trim()} onClick={add}>Add missing GL</button>
          </div>
        )}
      </Block>
      <CodingBlock />
    </>
  );
}

export function CodingBlock() {
  const { state, ui, apply } = useStore();
  const tenant = useTenant()!;
  const admin = canConfigureTenant(ui.role);
  const segments = [...state.settings[tenant.id].segments].sort((a, b) => a.ord - b.ord);
  const [draft, setDraft] = useState({ name: '', required: true, permitted: '' });

  const parsePermitted = (raw: string) => raw.split(/[,;]/).map((v) => v.trim()).filter(Boolean);

  return (
    <Block kicker="Coding block" title={`${segments.length} segment${segments.length === 1 ? '' : 's'}`}
      note="Segments the organisation requires on a posting — company, cost centre, project. Importing a chart with extra columns creates or updates these and fills permitted values from the file so they align with the official chart. Empty permitted values means any value is accepted.">
      {segments.length === 0 ? (
        <Empty>No coding segments yet. Add Company, cost centre or whatever the chart requires.</Empty>
      ) : (
        <SheetTable
          rows={segments}
          rowKey={(seg) => seg.id}
          noun="segments"
          columns={[
            { key: 'ord', header: 'Order', kind: 'number', thClassName: 'num', tdClassName: 'num', value: (seg) => seg.ord, cell: (seg) => seg.ord },
            { key: 'name', header: 'Segment', value: (seg) => seg.name, cell: (seg) => (
              <input className="input" defaultValue={seg.name} disabled={!admin} style={{ minHeight: 26, fontSize: 11.5, minWidth: 140 }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (!v || v === seg.name) return;
                  apply('Rename coding segment', 'admin', `Segment renamed to ${v}.`,
                    (s) => { s.settings[tenant.id].segments.find((y) => y.id === seg.id)!.name = v; });
                }} />
            ) },
            { key: 'req', header: 'Required', value: (seg) => seg.required ? 'Yes' : 'No', cell: (seg) => (
              <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} value={seg.required ? 'Yes' : 'No'} disabled={!admin}
                onChange={(e) => apply('Change segment required', 'admin',
                  `${seg.name} is now ${e.target.value === 'Yes' ? 'required' : 'optional'}.`,
                  (s) => { s.settings[tenant.id].segments.find((y) => y.id === seg.id)!.required = e.target.value === 'Yes'; })}>
                <option>Yes</option><option>No</option>
              </select>
            ) },
            { key: 'perm', header: 'Permitted values', value: (seg) => seg.permitted.join(', ') || 'any', cell: (seg) => (
              <input className="input" defaultValue={seg.permitted.join(', ')} disabled={!admin} style={{ minHeight: 26, fontSize: 11.5, minWidth: 180 }}
                key={`${seg.id}-perm-${seg.permitted.join('|')}`}
                placeholder="any"
                onBlur={(e) => {
                  const next = parsePermitted(e.target.value);
                  apply('Change permitted values', 'admin',
                    next.length ? `${seg.name} permitted values set.` : `${seg.name} now accepts any value.`,
                    (s) => { s.settings[tenant.id].segments.find((y) => y.id === seg.id)!.permitted = next; });
                }} />
            ) },
            { key: 'act', header: '', cell: (seg) => (
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost btn-sm" disabled={!admin || seg.ord <= 1}
                  onClick={() => apply('Reorder coding segment', 'admin', `Moved ${seg.name} up.`, (s) => {
                    const list = s.settings[tenant.id].segments;
                    const prev = list.find((y) => y.ord === seg.ord - 1);
                    const cur = list.find((y) => y.id === seg.id);
                    if (!prev || !cur) return;
                    prev.ord += 1;
                    cur.ord -= 1;
                  })}>Up</button>
                <button className="btn btn-ghost btn-sm" disabled={!admin}
                  onClick={() => apply('Delete coding segment', 'admin', `Removed segment ${seg.name}.`,
                    (s) => {
                      s.settings[tenant.id].segments = s.settings[tenant.id].segments
                        .filter((y) => y.id !== seg.id)
                        .map((y, i) => ({ ...y, ord: i + 1 }));
                    })}>Delete</button>
              </span>
            ) },
          ]}
        />
      )}
      {admin && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 16, padding: 12, background: 'var(--color-surface)' }}>
          <div style={{ flex: '1 1 180px' }}><Field label="Segment"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field></div>
          <div style={{ flex: '0 0 120px' }}><Field label="Required">
            <select className="input" value={draft.required ? 'Yes' : 'No'} onChange={(e) => setDraft({ ...draft, required: e.target.value === 'Yes' })}>
              <option>Yes</option><option>No</option>
            </select></Field></div>
          <div style={{ flex: '1 1 200px' }}><Field label="Permitted values" help="Comma-separated. Leave blank for any.">
            <input className="input" value={draft.permitted} onChange={(e) => setDraft({ ...draft, permitted: e.target.value })} />
          </Field></div>
          <button className="btn btn-primary btn-sm" type="button" disabled={!draft.name.trim()}
            onClick={() => {
              apply('Add coding segment', 'admin', `Added coding segment ${draft.name.trim()}.`, (s) => {
                const nextOrd = Math.max(0, ...s.settings[tenant.id].segments.map((y) => y.ord)) + 1;
                s.settings[tenant.id].segments.push({
                  id: `seg-${Date.now().toString(36)}`,
                  tenantId: tenant.id,
                  ord: nextOrd,
                  name: draft.name.trim(),
                  required: draft.required,
                  permitted: parsePermitted(draft.permitted),
                });
              });
              setDraft({ name: '', required: true, permitted: '' });
            }}>Add segment</button>
        </div>
      )}
    </Block>
  );
}

const POSTING_TABS = [
  { id: 'cases', label: 'Engine cases', kicker: 'Journals', tone: 'g-obligation' },
  { id: 'rules', label: 'Posting rules', kicker: 'Debit / credit', tone: 'g-movement' },
  { id: 'classes', label: 'Asset classes', kicker: 'Register', tone: 'g-aro-asset' },
  { id: 'gls', label: 'Scenario GLs', kicker: 'Chart map', tone: 'g-dates' },
] as const;

type PostingTabId = (typeof POSTING_TABS)[number]['id'];

export function PostingRulesPanel() {
  const { state, ui, apply, setUi } = useStore();
  const tenant = useTenant()!;
  const admin = canConfigureTenant(ui.role);
  const settings = state.settings[tenant.id];
  const rules = settings.postingRules;
  const classes = settings.aroAssetClasses ?? [];
  const scenarios = settings.postingScenarios ?? [];
  const roleTotal = ENGINE_ROLES.length;
  const scenariosComplete = scenarios.filter((s) => completedRoleCount(s) === roleTotal).length;
  const tab: PostingTabId = POSTING_TABS.some((t) => t.id === ui.tab) ? ui.tab as PostingTabId : 'cases';
  const paneTone = POSTING_TABS.find((t) => t.id === tab)?.tone ?? 'g-obligation';
  const missing = ENGINE_EVENT_TYPES.filter((t) => !rules.some((r) => r.eventType === t));
  const [draft, setDraft] = useState({ eventType: '', debitRole: 'Retirement cost asset', creditRole: 'ARO provision' });
  const catalogRows = ENGINE_POSTING_CASES.flatMap((c) => {
    const primary = {
      key: c.id, label: c.label, when: c.trigger,
      debitRole: c.debitRole, creditRole: c.creditRole, eventType: c.eventType, companion: false,
    };
    const extra = (c.companions ?? []).map((l, i) => ({
      key: `${c.id}:${l.eventType}:${i}`, label: c.label, when: l.when,
      debitRole: l.debitRole, creditRole: l.creditRole, eventType: l.eventType, companion: true,
    }));
    return [primary, ...extra];
  });

  const restore = () => {
    apply('Restore engine posting rules', 'admin',
      `Restored posting rules for ${missing.join(', ')}. Debit and credit roles can still be remapped.`,
      (s) => {
        for (const [eventType, debitRole, creditRole] of ENGINE_POSTING_RULES) {
          if (s.settings[tenant.id].postingRules.some((r) => r.eventType === eventType)) continue;
          s.settings[tenant.id].postingRules.push({
            id: `pr-${Date.now().toString(36)}-${eventType}`,
            tenantId: tenant.id,
            eventType,
            debitRole,
            creditRole,
            engineEmitted: true,
          });
        }
      });
  };

  const addRule = () => {
    const preview = structuredClone(state.settings[tenant.id]);
    const err = addPostingRule(preview, tenant.id, draft);
    if (err) {
      apply('Add posting rule', 'refused', err, () => {});
      return;
    }
    apply('Add posting rule', 'admin', `Added posting rule for ${draft.eventType.trim()}.`,
      (s) => { addPostingRule(s.settings[tenant.id], tenant.id, draft); });
    setDraft({ eventType: '', debitRole: 'Retirement cost asset', creditRole: 'ARO provision' });
  };

  const renameEvent = (id: string, previous: string, next: string) => {
    if (next.trim() === previous) return;
    const preview = structuredClone(state.settings[tenant.id]);
    const err = renamePostingRuleEvent(preview, id, next);
    if (err) {
      apply('Rename posting rule', 'refused', err, () => {});
      return;
    }
    apply('Rename posting rule', 'admin', `Posting rule ${previous} is now ${next.trim()}.`,
      (s) => { renamePostingRuleEvent(s.settings[tenant.id], id, next); });
  };

  const removeRule = (id: string, eventType: string, engineEmitted: boolean) => {
    const warn = engineEmitted
      ? `Delete the ${eventType} posting rule? The engine still emits that event; without a rule it falls to suspense.`
      : `Delete the ${eventType} posting rule?`;
    if (!window.confirm(warn)) return;
    apply('Delete posting rule', 'admin', `Removed posting rule for ${eventType}.`,
      (s) => { deletePostingRule(s.settings[tenant.id], id); });
  };

  const tabMeta: Record<PostingTabId, string> = {
    cases: `${ENGINE_POSTING_CASES.length} cases · ${catalogRows.length} lines`,
    rules: missing.length ? `${missing.length} engine event${missing.length === 1 ? '' : 's'} missing` : `${rules.length} rule${rules.length === 1 ? '' : 's'}`,
    classes: classes.length ? `${classes.length} class${classes.length === 1 ? '' : 'es'}` : 'None yet',
    gls: scenarios.length ? `${scenariosComplete} of ${scenarios.length} complete` : 'Standard ARO',
  };

  return (
    <>
    <div className="posting-tabs" role="tablist" aria-label="Posting rules">
      {POSTING_TABS.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
          className={`posting-tab g-tone ${t.tone}${tab === t.id ? ' is-on' : ''}`}
          onClick={() => setUi({ tab: t.id })}>
          <span className="kicker">{t.kicker}</span>
          <span className="posting-tab-label">{t.label}</span>
          <span className="posting-tab-meta">{tabMeta[t.id]}</span>
        </button>
      ))}
    </div>
    {tab === 'cases' && (
    <Block className={`posting-pane g-tone ${paneTone}`} kicker="Engine posting cases" title={`${ENGINE_POSTING_CASES.length} cases · ${catalogRows.length} journal lines`}
      note="Debit and credit here are the journal as it posts. Several cases share one event (all settlements use settlement). Companion lines are indented. A negative amount does not only reverse the figure — it also swaps the two GLs on that event's rule. Assign this organisation's GLs on the posting scenario, not here.">
      <SheetTable
        rows={catalogRows}
        rowKey={(r) => r.key}
        noun="cases"
        columns={[
          { key: 'label', header: 'Case', value: (r) => r.label, cell: (r) => (
            <span style={r.companion ? { paddingLeft: 16, color: 'var(--color-neutral-600)' } : undefined}>{r.companion ? '↳ ' : ''}{r.label}</span>
          ) },
          { key: 'when', header: 'When it applies', value: (r) => r.when, cell: (r) => r.when },
          { key: 'debit', header: 'Debit as posted', value: (r) => r.debitRole, cell: (r) => r.debitRole },
          { key: 'credit', header: 'Credit as posted', value: (r) => r.creditRole, cell: (r) => r.creditRole },
          { key: 'event', header: 'Event / rule', value: (r) => r.eventType, cell: (r) => r.eventType },
        ]}
      />
    </Block>
    )}
    {tab === 'rules' && (
    <Block className={`posting-pane g-tone ${paneTone}`} kicker="Posting rules" title={`${rules.length} rule${rules.length === 1 ? '' : 's'} · ${ENGINE_EVENT_TYPES.length} engine events`}
      note="Debit and credit on a rule are the accounts for a positive amount. When the engine posts a negative amount, those two GLs swap: the credit account is debited and the debit account is credited. An event with no rule fails into suspense. Assign imported GLs on the posting scenario for each asset class.">
      {missing.length > 0 && admin && (
        <div className="note-panel" style={{ marginBottom: 12, borderLeftColor: 'var(--warn)' }}>
          Missing engine events: {missing.join(', ')}. Restore them so generated journals have somewhere to post, or add a rule with that event name.
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-primary btn-sm" type="button" onClick={restore}>Restore engine posting rules</button>
          </div>
        </div>
      )}
      {rules.length === 0 ? (
        <Empty>No posting rules. Add a rule or restore the engine set so generated events have somewhere to post.</Empty>
      ) : (
        <SheetTable
          rows={rules}
          rowKey={(r) => r.id}
          noun="rules"
          columns={[
            { key: 'event', header: 'Event', value: (r) => r.eventType, cell: (r) => (
              <input className="input" style={{ minHeight: 26, fontSize: 11.5, fontFamily: 'var(--font-heading)', fontWeight: 800 }}
                defaultValue={r.eventType} key={`${r.id}:${r.eventType}`} disabled={!admin}
                onBlur={(e) => renameEvent(r.id, r.eventType, e.target.value)} />
            ) },
            { key: 'debit', header: 'Debit (positive amount)', value: (r) => r.debitRole, cell: (r) => (
              <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} value={r.debitRole} disabled={!admin}
                onChange={(e) => apply('Change posting debit', 'admin',
                  `${r.eventType} now debits ${e.target.value}.`,
                  (s) => { s.settings[tenant.id].postingRules.find((y) => y.id === r.id)!.debitRole = e.target.value; })}>
                {ENGINE_ROLES.map((role) => <option key={role}>{role}</option>)}
              </select>
            ) },
            { key: 'credit', header: 'Credit (positive amount)', value: (r) => r.creditRole, cell: (r) => (
              <select className="input" style={{ minHeight: 26, fontSize: 11.5 }} value={r.creditRole} disabled={!admin}
                onChange={(e) => apply('Change posting credit', 'admin',
                  `${r.eventType} now credits ${e.target.value}.`,
                  (s) => { s.settings[tenant.id].postingRules.find((y) => y.id === r.id)!.creditRole = e.target.value; })}>
                {ENGINE_ROLES.map((role) => <option key={role}>{role}</option>)}
              </select>
            ) },
            { key: 'neg', header: 'If amount is negative', value: () => 'Swaps debit and credit', cell: () => 'Swaps debit and credit' },
            { key: 'emitted', header: 'Emitted by the engine', value: (r) => r.engineEmitted ? 'Yes' : 'No', cell: (r) => r.engineEmitted ? 'Yes' : 'No' },
            { key: 'act', header: '', cell: (r) => (
              <button className="btn btn-ghost btn-sm" type="button" disabled={!admin}
                title={`Remove the ${r.eventType} posting rule.`}
                onClick={() => removeRule(r.id, r.eventType, r.engineEmitted)}>Delete</button>
            ) },
          ]}
        />
      )}
      {admin && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 16, padding: 12, background: 'var(--color-surface)' }}>
          <div style={{ flex: '1 1 160px' }}>
            <Field label="Event">
              <input className="input" value={draft.eventType} onChange={(e) => setDraft({ ...draft, eventType: e.target.value })}
                placeholder="e.g. impairment"
                onKeyDown={(e) => { if (e.key === 'Enter' && draft.eventType.trim()) addRule(); }} />
            </Field>
          </div>
          <div style={{ flex: '0 0 200px' }}>
            <Field label="Debit (positive amount)">
              <select className="input" value={draft.debitRole} onChange={(e) => setDraft({ ...draft, debitRole: e.target.value })}>
                {ENGINE_ROLES.map((role) => <option key={role}>{role}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ flex: '0 0 200px' }}>
            <Field label="Credit (positive amount)">
              <select className="input" value={draft.creditRole} onChange={(e) => setDraft({ ...draft, creditRole: e.target.value })}>
                {ENGINE_ROLES.map((role) => <option key={role}>{role}</option>)}
              </select>
            </Field>
          </div>
          <button className="btn btn-primary btn-sm" type="button" disabled={!draft.eventType.trim()} onClick={addRule}>Add posting rule</button>
        </div>
      )}
    </Block>
    )}
    {(tab === 'classes' || tab === 'gls') && (
      <PostingScenariosPanel key={tenant.id} pane={tab} paneTone={paneTone} />
    )}
    </>
  );
}

function PostingScenariosPanel({ pane, paneTone }: { pane: 'classes' | 'gls'; paneTone: string }) {
  const { state, ui, apply, setUi } = useStore();
  const tenant = useTenant()!;
  const admin = canConfigureTenant(ui.role);
  const settings = state.settings[tenant.id];
  const scenarios = settings.postingScenarios ?? [];
  const classes = settings.aroAssetClasses ?? [];
  const accounts = settings.accounts;
  const preferred = scenarios.find((s) => s.isDefault)?.id ?? scenarios[0]?.id ?? '';
  const [picked, setPicked] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [paste, setPaste] = useState('');
  const [draftClass, setDraftClass] = useState({ code: '', name: '' });
  const [report, setReport] = useState<string[] | null>(null);
  const activeId = picked && scenarios.some((s) => s.id === picked) ? picked : preferred;
  const active = scenarios.find((s) => s.id === activeId) ?? scenarios[0];
  const classScenarios = scenarios.filter((s) => !s.isDefault).length;
  const roleTotal = ENGINE_ROLES.length;
  const scenariosComplete = scenarios.filter((s) => completedRoleCount(s) === roleTotal).length;
  const shared = classes.filter((c) => {
    const scn = scenarios.find((s) => s.id === c.scenarioId);
    if (!scn || scn.isDefault) return true;
    return classes.filter((x) => x.scenarioId === c.scenarioId).length > 1;
  });
  const ordered = [...scenarios].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  const filledKey = useRef('');
  useEffect(() => {
    if (!admin || accounts.length === 0 || scenarios.length === 0) return;
    const preview = structuredClone(settings);
    const n = prefillUnassignedFromChart(preview, tenant.id);
    if (n === 0) return;
    const key = `${tenant.id}:${accounts.length}:${scenarios.length}`;
    if (filledKey.current === key) return;
    filledKey.current = key;
    apply('Pre-fill posting scenarios from chart', 'admin',
      `Matched ${n} unassigned engine role${n === 1 ? '' : 's'} to imported GLs.`,
      (s) => { prefillUnassignedFromChart(s.settings[tenant.id], tenant.id); });
  }, [admin, accounts.length, scenarios.length, tenant.id]);

  const sorted = [...accounts].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const loadClasses = (text: string, filename: string) => {
    const parsed = parseAssetListing(text);
    if (!parsed.classes.length) {
      setReport(parsed.problems.length ? parsed.problems : ['No asset class names could be read.']);
      return;
    }
    const preview = structuredClone(state);
    const result = importAssetClassesFromListing(preview.settings[tenant.id], tenant.id, parsed);
    apply('Add asset classes', 'import',
      `Added ${parsed.classes.length} asset class${parsed.classes.length === 1 ? '' : 'es'} from ${filename} and created a posting scenario for each.`,
      (s) => { importAssetClassesFromListing(s.settings[tenant.id], tenant.id, parsed); });
    const lines = [
      `${result.added} class${result.added === 1 ? '' : 'es'} added, ${result.split} split onto ${result.split === 1 ? 'its own scenario' : 'their own scenarios'}, ${result.kept} already had a dedicated scenario (${filename}).`,
    ];
    lines.push(...result.problems);
    setReport(lines);
    setPaste('');
    setDraftClass({ code: '', name: '' });
    setImporting(false);
    const first = parsed.classes[0];
    const after = preview.settings[tenant.id];
    const focus = after.aroAssetClasses.find((c) => (c.code ?? '').toLowerCase() === first.code.toLowerCase() && first.code)
      ?? after.aroAssetClasses.find((c) => c.name.toLowerCase() === first.name.toLowerCase())
      ?? after.aroAssetClasses.find((c) => c.name.toLowerCase() === first.label.toLowerCase());
    if (focus) {
      setPicked(focus.scenarioId);
      setUi({ tab: 'gls' });
    }
  };

  const renameClass = (id: string, field: 'code' | 'name', previous: string, next: string) => {
    if (next.trim() === previous) return;
    const preview = structuredClone(state);
    const err = patchAssetClass(preview, tenant.id, id, { [field]: next });
    if (err) {
      apply('Rename asset class', 'refused', err, () => {});
      return;
    }
    apply('Rename asset class', 'admin',
      field === 'code' ? `Asset class code ${previous || '—'} is now ${next.trim() || '—'}.` : `Asset class ${previous} is now ${next.trim()}.`,
      (s) => { patchAssetClass(s, tenant.id, id, { [field]: next }); });
  };

  const removeClass = (id: string, name: string, scenarioId: string) => {
    if (!window.confirm(`Delete asset class ${name}? Obligations in that class will use the default posting scenario.`)) return;
    apply('Delete asset class', 'admin', `Removed asset class ${name}.`,
      (s) => { deleteAssetClass(s, tenant.id, id); });
    if (picked === scenarioId) setPicked(preferred);
  };

  return pane === 'classes' ? (
    <Block className={`posting-pane g-tone ${paneTone}`} kicker="Asset classes" title={classScenarios
      ? `${classScenarios} asset class${classScenarios === 1 ? '' : 'es'} · ${scenariosComplete} of ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} complete`
      : 'Enter the organisation\'s asset classes'}
      note="Enter or import asset classes as a code and a name — the same two fields as ARO asset class on the register. Each class gets its own posting scenario. An obligation posts through the scenario that matches its class code or name. Obligations with no class use Standard ARO."
      actions={admin && (
        <button className="btn btn-primary btn-sm" type="button" onClick={() => setImporting((v) => !v)}>
          {importing ? 'Cancel import' : 'Import asset classes'}
        </button>
      )}
    >
      {importing && admin && (
        <div style={{ marginBottom: 16, padding: 12, background: 'var(--color-surface)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Paste or import asset classes" help="Two columns: asset class code and asset class name. One name per line is also fine. A header of Asset class / ANLKL is read when present.">
            <textarea className="input" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)}
              placeholder={'11010,Buildings\n11040,Works'} />
          </Field>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" type="button" disabled={!paste.trim()}
              onClick={() => loadClasses(paste, 'pasted classes')}>Load pasted classes</button>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
              Import .csv / .tsv / .txt
              <input type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  f.text().then((t) => loadClasses(t, f.name));
                  e.target.value = '';
                }} />
            </label>
          </div>
        </div>
      )}
      {admin && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16, padding: 12, background: 'var(--color-surface)' }}>
          <div style={{ flex: '0 0 140px' }}>
            <Field label="Asset class code">
              <input className="input" value={draftClass.code} onChange={(e) => setDraftClass({ ...draftClass, code: e.target.value })}
                placeholder="e.g. 11010" onKeyDown={(e) => {
                  if (e.key === 'Enter' && (draftClass.code.trim() || draftClass.name.trim())) {
                    loadClasses([draftClass.code, draftClass.name].filter((v) => v.trim()).join(','), 'entered class');
                  }
                }} />
            </Field>
          </div>
          <div style={{ flex: '1 1 220px' }}>
            <Field label="Asset class name">
              <input className="input" value={draftClass.name} onChange={(e) => setDraftClass({ ...draftClass, name: e.target.value })}
                placeholder="e.g. Buildings" onKeyDown={(e) => {
                  if (e.key === 'Enter' && (draftClass.code.trim() || draftClass.name.trim())) {
                    loadClasses([draftClass.code, draftClass.name].filter((v) => v.trim()).join(','), 'entered class');
                  }
                }} />
            </Field>
          </div>
          <button className="btn btn-primary btn-sm" type="button" disabled={!draftClass.code.trim() && !draftClass.name.trim()}
            onClick={() => loadClasses([draftClass.code, draftClass.name].filter((v) => v.trim()).join(','), 'entered class')}>Add asset class</button>
        </div>
      )}
      {classes.length > 0 && (
        <div style={{ marginBottom: 16 }}>
        <SheetTable
          rows={[...classes].sort((a, b) => classLabel(a).localeCompare(classLabel(b), undefined, { numeric: true }))}
          rowKey={(c) => c.id}
          noun="asset classes"
          columns={[
            { key: 'code', header: 'Asset class code', value: (c) => c.code ?? '', cell: (c) => (
              <input className="input" style={{ minHeight: 26, fontSize: 11.5 }}
                defaultValue={c.code ?? ''} key={`${c.id}:code:${c.code ?? ''}`} disabled={!admin}
                onBlur={(e) => renameClass(c.id, 'code', c.code ?? '', e.target.value)} />
            ) },
            { key: 'name', header: 'Asset class name', value: (c) => c.name, cell: (c) => (
              <input className="input" style={{ minHeight: 26, fontSize: 11.5 }}
                defaultValue={c.name} key={`${c.id}:name:${c.name}`} disabled={!admin}
                onBlur={(e) => renameClass(c.id, 'name', c.name, e.target.value)} />
            ) },
            { key: 'scenario', header: 'Posting scenario', value: (c) => scenarios.find((s) => s.id === c.scenarioId)?.name ?? '—',
              cell: (c) => (
                <button className="btn btn-ghost btn-sm" type="button"
                  title="Open this class's posting scenario GLs."
                  onClick={() => { setPicked(c.scenarioId); setUi({ tab: 'gls' }); }}>
                  {scenarios.find((s) => s.id === c.scenarioId)?.name ?? '—'}
                </button>
              ) },
            { key: 'act', header: '', cell: (c) => (
              <button className="btn btn-ghost btn-sm" type="button" disabled={!admin}
                title={`Remove ${classLabel(c)}.`}
                onClick={() => removeClass(c.id, classLabel(c), c.scenarioId)}>Delete</button>
            ) },
          ]}
        />
        </div>
      )}
      {report && (
        <div className="note-panel" style={{ marginBottom: 12 }}>
          <ul style={{ margin: 0, paddingLeft: 16 }}>{report.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}
      {shared.length > 0 && (
        <div className="note-panel" style={{ marginBottom: 12, borderLeftColor: 'var(--warn)' }}>
          These register classes still share Standard ARO: {shared.map((c) => classLabel(c)).join(', ')}.
          {admin && (
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-primary btn-sm" type="button"
                onClick={() => loadClasses(shared.map((c) => classLabel(c)).join('\n'), 'shared classes')}>
                Create a scenario for each
              </button>
            </div>
          )}
        </div>
      )}
      {classScenarios === 0 && classes.length === 0 && (
        <Empty>Add or import asset classes so each class gets a posting scenario. Until then, every obligation uses Standard ARO.</Empty>
      )}
    </Block>
  ) : (
    <Block className={`posting-pane g-tone ${paneTone}`} kicker="Scenario GLs" title={active
      ? `${active.name}${active.isDefault ? ' (default)' : ''} · ${completedRoleCount(active)} of ${roleTotal} roles complete`
      : 'Assign imported GLs to engine roles'}
      note="Each posting scenario maps engine roles to this organisation's GLs. An obligation posts through the scenario for its ARO asset class. Obligations with no class use Standard ARO.">
      {accounts.length === 0 && (
        <Empty>Import the chart of accounts first so a scenario has GLs to pick.</Empty>
      )}
      {scenarios.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {ordered.map((s) => {
            const done = completedRoleCount(s);
            const on = s.id === active?.id;
            return (
              <button key={s.id} type="button"
                className={`btn btn-sm posting-scenario-chip g-tone ${s.isDefault ? 'g-obligation' : 'g-aro-asset'}${on ? ' is-on' : ''}`}
                onClick={() => setPicked(s.id)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Dot tone={done === roleTotal ? 'ok' : done > 0 ? 'warn' : 'idle'} />
                {s.name}{s.isDefault ? ' (default)' : ''}
                <span style={{ fontWeight: 600, opacity: 0.8 }}>{done}/{roleTotal}</span>
                {done === roleTotal && <Tag kind="accent">Complete</Tag>}
              </button>
            );
          })}
        </div>
      )}
      {active && (
        <>
          {admin && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              <Field label="Scenario name">
                <input className="input" defaultValue={active.name} key={active.id}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (!v || v === active.name) return;
                    apply('Rename posting scenario', 'admin', `Posting scenario renamed to ${v}.`,
                      (s) => { s.settings[tenant.id].postingScenarios.find((x) => x.id === active.id)!.name = v; });
                  }} />
              </Field>
              {!active.isDefault && (
                <button className="btn btn-secondary btn-sm" type="button"
                  onClick={() => apply('Set default posting scenario', 'admin',
                    `${active.name} is now the default posting scenario.`, (s) => {
                      for (const x of s.settings[tenant.id].postingScenarios) x.isDefault = x.id === active.id;
                    })}>Make default</button>
              )}
              {scenarios.length > 1 && !active.isDefault && (
                <button className="btn btn-ghost btn-sm" type="button"
                  onClick={() => {
                    const linked = classes.filter((c) => c.scenarioId === active.id).map((c) => c.name);
                    apply('Delete posting scenario', 'admin',
                      linked.length
                        ? `Removed posting scenario ${active.name} and asset class ${linked.join(', ')}.`
                        : `Removed posting scenario ${active.name}.`,
                      (s) => {
                        const st = s.settings[tenant.id];
                        st.aroAssetClasses = st.aroAssetClasses.filter((c) => c.scenarioId !== active.id);
                        st.postingScenarios = st.postingScenarios.filter((x) => x.id !== active.id);
                      });
                    setPicked(scenarios.find((x) => x.id !== active.id)?.id ?? '');
                  }}>Delete</button>
              )}
            </div>
          )}
          <SheetTable
            rows={ENGINE_ROLES.map((role) => ({
              role,
              account: accounts.find((a) => a.id === active.accounts[role]) ?? null,
              complete: (active.completedRoles ?? []).includes(role),
            }))}
            rowKey={(r) => r.role}
            noun="engine roles"
            columns={[
              { key: 'role', header: 'Engine role', value: (r) => r.role, cell: (r) => <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{r.role}</span> },
              { key: 'gl', header: 'GL account', value: (r) => r.account ? `${r.account.code} ${r.account.name}` : 'unassigned', cell: (r) => (
                <AccountPicker
                  accounts={sorted}
                  value={r.account?.id ?? ''}
                  disabled={!admin}
                  ariaLabel={`${active.name}: GL account for ${r.role}`}
                  onChange={(accountId) => {
                    const acc = accounts.find((a) => a.id === accountId);
                    apply('Change posting scenario GL', 'admin',
                      acc
                        ? `${active.name}: ${r.role} now posts to ${acc.code} ${acc.name}.`
                        : `${active.name}: ${r.role} is unassigned.`,
                      (s) => { assignScenarioRole(s.settings[tenant.id], active.id, r.role, accountId); });
                  }}
                />
              ) },
              { key: 'cls', header: 'Account type', value: (r) => r.account ? accountTypeOf(r.account) : 'unassigned', cell: (r) => (r.account ? accountTypeOf(r.account) : '') || '—' },
              { key: 'status', header: 'Status', value: (r) => r.complete ? 'Complete' : 'In progress', cell: (r) => (
                <select
                  className="input"
                  style={{ minHeight: 26, fontSize: 11.5, minWidth: 120 }}
                  value={r.complete ? 'Complete' : 'In progress'}
                  disabled={!admin || (!r.account && !r.complete)}
                  aria-label={`${active.name}: status for ${r.role}`}
                  onChange={(e) => {
                    const complete = e.target.value === 'Complete';
                    if (complete && !r.account) {
                      apply('Mark posting role complete', 'refused',
                        `Assign a GL to ${r.role} on ${active.name} before marking it complete.`, () => {});
                      return;
                    }
                    apply('Mark posting role complete', 'admin',
                      complete
                        ? `${active.name}: ${r.role} marked complete.`
                        : `${active.name}: ${r.role} marked in progress.`,
                      (s) => { setRoleComplete(s.settings[tenant.id], active.id, r.role, complete); });
                  }}
                >
                  <option>In progress</option>
                  <option>Complete</option>
                </select>
              ) },
            ]}
          />
          <ScenarioCoverage scenario={active} />
        </>
      )}
    </Block>
  );
}

function ScenarioCoverage({ scenario }: { scenario: PostingScenario }) {
  const { state } = useStore();
  const tenant = useTenant()!;
  const settings = state.settings[tenant.id];
  const gaps = scenarioRoleGaps(scenario, settings);
  const suspense = accountInScenarioLocal(settings, scenario);
  const done = completedRoleCount(scenario);
  const mark = `${done} of ${ENGINE_ROLES.length} roles on ${scenario.name} marked complete.`;
  if (!gaps.length) {
    return <div className="note-panel" style={{ marginTop: 12 }}>Every engine role in {scenario.name} has an imported GL. {mark}</div>;
  }
  return (
    <div className="note-panel" style={{ marginTop: 12, borderLeftColor: 'var(--warn)' }}>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {gaps.map((role) => (
          <li key={role}>
            "{role}" is unassigned in {scenario.name}. Its events will go to {suspense ? `suspense (${suspense.code})` : 'suspense once that role is assigned'}.
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 8 }}>{mark}</div>
    </div>
  );
}

function accountInScenarioLocal(settings: { accounts: Account[]; postingScenarios: PostingScenario[] }, scenario: PostingScenario) {
  const id = scenario.accounts['Suspense'];
  return settings.accounts.find((a) => a.id === id) ?? settings.accounts.find((a) => a.engineRole === 'Suspense');
}

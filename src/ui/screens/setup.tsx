/**
 * Company setup — a guided, persisted workflow that precedes reporting-unit
 * measurement. Progress is stored on the tenant and derived from live data, so
 * a refresh resumes at the first incomplete step.
 *
 * Steps start with reporting units (entity, year end, currency), then people,
 * authority, the framework catalogue, measurement defaults, cost-estimate
 * templates and the curve library. Chart of accounts and posting rules are
 * confirmed on the reporting unit, before Prepare.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useStore, useTenant } from '../../core/store';
import { canConfigureTenant } from '../../core/authority';
import { assignMissingCurves } from '../../core/createUnit';
import { CALENDAR_TYPES, CalendarType } from '../../core/periods';
import { FIRM_SETUP_ALIASES } from '../../core/nav';
import { SETUP_STEPS, SetupStepId, canOpenStep, nextSetupStep, patchSetup, setupProgress } from '../../core/setup';
import {
  addEstimateColumn, amountFormula, draftToTemplateLine,
  emptyCostEstimateTemplate, emptyEstimateColumn, emptyEstimateLine, isSystemEstimateColumn,
  lineAmount, normalizeEstimateColumns, patchEstimateLine, removeEstimateColumn,
  renameEstimateColumn, templateLineToDraft, type EstimateLineDraft,
} from '../../core/costEstimate';
import type { CostEstimateTemplate, EstimateColumn, EstimateColumnKind } from '../../core/types';
import { Block, Field, ConventionSelects, Tag, num } from '../components';
import { Authority, Curves, Frameworks, Units, Users } from './tenant';

export function Setup() {
  const { state, ui, setUi, apply } = useStore();
  const tenant = useTenant()!;
  const progress = useMemo(() => setupProgress(state, tenant.id), [state, tenant.id]);
  const alias = FIRM_SETUP_ALIASES[ui.screen];
  const [step, setStep] = useState<SetupStepId>(alias ?? progress.firstIncomplete ?? progress.current);
  const allowed = canConfigureTenant(ui.role);

  useEffect(() => {
    if (alias) {
      setStep(alias);
      return;
    }
    setStep(progress.firstIncomplete ?? progress.current);
  }, [alias, tenant.id]);

  const go = (id: SetupStepId) => {
    if (!canOpenStep(progress, id)) return;
    if (alias) setUi({ screen: 'setup' });
    setStep(id);
    apply('Resume setup', 'admin', `Returned to ${SETUP_STEPS.find((s) => s.id === id)!.label}.`, (s) => {
      s.settings[tenant.id].setup = patchSetup(s.settings[tenant.id].setup, { current: id });
    });
  };

  const continueTo = (from: SetupStepId) => {
    const next = nextSetupStep(from);
    if (!next) return;
    apply('Continue company setup', 'admin', `Moved on to ${SETUP_STEPS.find((s) => s.id === next)!.label}.`, (s) => {
      s.settings[tenant.id].setup = patchSetup(s.settings[tenant.id].setup, { current: next });
    });
    setStep(next);
  };

  return (
    <>
      <Block
        kicker="Company setup"
        title={progress.complete ? 'Setup is complete' : 'Setup is in progress'}
        note="Progress is saved as you go. Ready on reporting units means a published discount curve is assigned to at least one unit — a unit can exist before that, and you can still continue. Ready on the other steps means that step has what the engine needs; it does not mean you have finished reviewing it."
      >
        <nav aria-label="Setup progress" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SETUP_STEPS.map((s, i) => {
            const ready = progress.ready[s.id];
            const active = step === s.id;
            const open = canOpenStep(progress, s.id);
            return (
              <button
                key={s.id}
                type="button"
                className={`btn btn-${active ? 'primary' : 'secondary'} btn-sm`}
                disabled={!open}
                aria-current={active ? 'step' : undefined}
                title={open ? s.purpose : 'Complete the earlier steps first'}
                onClick={() => go(s.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{String(i + 1).padStart(2, '0')}</span>
                {s.label}
                {ready && <Tag kind="accent">Ready</Tag>}
              </button>
            );
          })}
        </nav>
      </Block>

      {!allowed && (
        <div className="note-panel" style={{ marginBottom: 16, borderLeftColor: 'var(--warn)' }}>
          An engagement partner or firm admin has to complete company setup. The role switcher at the foot of the sidebar is a demo control — switch to Engagement partner to continue.
        </div>
      )}

      {step === 'unit' && (
        <>
          <Units />
          <StepActions
            allowed={allowed}
            canContinue={(state.units[tenant.id] ?? []).length > 0}
            blocked="Create a reporting unit to continue."
            onContinue={() => continueTo('unit')}
          />
        </>
      )}
      {step === 'users' && (
        <>
          <Users />
          <StepActions
            allowed={allowed}
            canContinue={progress.ready.users}
            blocked="Invite an engagement partner. With none, nothing could ever be signed off."
            onContinue={() => continueTo('users')}
          />
        </>
      )}
      {step === 'authority' && (
        <>
          <Authority />
          <StepActions allowed={allowed} canContinue={progress.ready.authority} blocked="Every domain needs an authority mode." onContinue={() => continueTo('authority')} />
        </>
      )}
      {step === 'frameworks' && (
        <>
          <Frameworks />
          <StepActions allowed={allowed} canContinue={progress.ready.frameworks} blocked="Pick the default framework a new reporting unit inherits." onContinue={() => continueTo('frameworks')} />
        </>
      )}
      {step === 'defaults' && <DefaultsStep allowed={allowed} onContinue={() => { setStep('estimates'); }} />}
      {step === 'estimates' && (
        <>
          <EstimatesStep allowed={allowed} />
          <StepActions
            allowed={allowed}
            canContinue
            blocked=""
            onContinue={() => continueTo('estimates')}
          />
        </>
      )}
      {step === 'curve' && (
        <>
          <Curves />
          <StepActions
            allowed={allowed}
            canContinue={progress.ready.curve}
            blocked="Create a curve and load at least one published point."
            onContinue={() => {
              apply('Confirm discount curve', 'admin', 'Discount curve confirmed for company setup.', (s) => {
                assignMissingCurves(s, tenant.id);
                s.settings[tenant.id].setup = patchSetup(s.settings[tenant.id].setup, { current: 'curve' });
              });
            }}
          />
        </>
      )}
    </>
  );
}

function DefaultsStep({ allowed, onContinue }: { allowed: boolean; onContinue: () => void }) {
  const { state, apply } = useStore();
  const tenant = useTenant()!;
  const d = state.settings[tenant.id].defaults;
  const [inflation, setInflation] = useState(String((d.inflation * 100).toFixed(2)));
  const [contingency, setContingency] = useState(String((d.contingency * 100).toFixed(2)));

  const save = (advance: boolean) => {
    const inf = (Number(inflation) || 0) / 100;
    const con = (Number(contingency) || 0) / 100;
    apply(advance ? 'Confirm measurement defaults' : 'Save measurement defaults', 'admin',
      `Default inflation ${(inf * 100).toFixed(2)}%, contingency ${(con * 100).toFixed(2)}%.`,
      (s) => {
        const st = s.settings[tenant.id];
        st.defaults.inflation = inf;
        st.defaults.contingency = con;
        st.setup = patchSetup(st.setup, {
          current: advance ? 'estimates' : 'defaults',
          defaultsConfirmedAt: st.setup?.defaultsConfirmedAt ?? new Date().toISOString(),
        });
      });
    if (advance) onContinue();
  };

  return (
    <Block kicker="Measurement defaults" title="Starting values for a new reporting unit"
        note="Inflation, contingency, the fiscal calendar, day count and settlement term rounding are starting values for a new reporting unit. Each unit then confirms or changes its own on Unit settings, then chart and posting, before Prepare. Saving here does not rewrite units you have already opened.">
      <form onSubmit={(e) => { e.preventDefault(); if (allowed) save(true); }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
          <Field label="Inflation / escalation rate (%)" help="Escalates the cost estimate from its price date to the reporting date, and on to settlement. Enter 2.5 for 2.5%.">
            <input className="input num" name="inflation" inputMode="decimal" value={inflation} disabled={!allowed}
              onChange={(e) => setInflation(e.target.value)}
              onBlur={() => allowed && save(false)} />
          </Field>
          <Field label="Contingency (% of direct cost)" help="Applied once, before escalation, so it applies to the revised figure including any cost revisions.">
            <input className="input num" name="contingency" inputMode="decimal" value={contingency} disabled={!allowed}
              onChange={(e) => setContingency(e.target.value)}
              onBlur={() => allowed && save(false)} />
          </Field>
          <Field label="Fiscal calendar" help="Copied onto a new reporting unit. The fiscal calendar then belongs to that unit, not to the tenant.">
            <select className="input" name="calendarType" value={d.calendarType} disabled={!allowed}
              onChange={(e) => apply('Change default calendar', 'admin', `Default calendar set to ${e.target.value}.`, (s) => {
                s.settings[tenant.id].defaults.calendarType = e.target.value as CalendarType;
              })}>
              {CALENDAR_TYPES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <ConventionSelects
            dayCount={d.dayCount}
            termConvention={d.termConvention}
            disabled={!allowed}
            onDayCount={(value) => apply('Change default day count', 'admin', `Default day count set to ${value}.`, (s) => {
              s.settings[tenant.id].defaults.dayCount = value;
            })}
            onTermConvention={(value) => apply('Change default term convention', 'admin', `Default settlement term rounding set to ${value}.`, (s) => {
              s.settings[tenant.id].defaults.termConvention = value;
            })}
          />
        </div>
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" type="submit" disabled={!allowed}>Save &amp; continue</button>
        </div>
      </form>
    </Block>
  );
}

function EstimatesStep({ allowed }: { allowed: boolean }) {
  const { state, apply } = useStore();
  const tenant = useTenant()!;
  const templates = state.settings[tenant.id].costEstimateTemplates ?? [];
  const [openId, setOpenId] = useState<string>(templates[0]?.id ?? '');
  const open = templates.find((t) => t.id === openId);
  const [name, setName] = useState(open?.name ?? '');
  const [columns, setColumns] = useState<EstimateColumn[]>(normalizeEstimateColumns(open?.columns));
  const [lines, setLines] = useState<EstimateLineDraft[]>(
    (open?.lines ?? [{ description: '', qty: 1, rate: null }]).map((l) => (
      templateLineToDraft(l, undefined, normalizeEstimateColumns(open?.columns))
    )),
  );
  const [newColName, setNewColName] = useState('');
  const [newColKind, setNewColKind] = useState<Exclude<EstimateColumnKind, 'currency'>>('number');

  const load = (t: CostEstimateTemplate | undefined) => {
    const cols = normalizeEstimateColumns(t?.columns);
    setOpenId(t?.id ?? '');
    setName(t?.name ?? '');
    setColumns(cols);
    setLines((t?.lines ?? [{ description: '', qty: 1, rate: null }]).map((l) => templateLineToDraft(l, undefined, cols)));
    setNewColName('');
    setNewColKind('number');
  };

  const persist = (next: CostEstimateTemplate[], detail: string, selectId?: string) => {
    apply('Edit cost estimate templates', 'admin', detail, (s) => {
      s.settings[tenant.id].costEstimateTemplates = next;
    });
    const selected = next.find((t) => t.id === (selectId ?? openId)) ?? next[0];
    load(selected);
  };

  const saveDraft = (
    nextName: string,
    nextColumns: EstimateColumn[],
    nextLines: EstimateLineDraft[],
    detail: string,
  ) => {
    if (!open) return;
    const updated: CostEstimateTemplate = {
      ...open,
      name: nextName.trim() || 'Untitled template',
      columns: nextColumns,
      lines: nextLines.map((l) => draftToTemplateLine(l, nextColumns)),
    };
    persist(templates.map((t) => (t.id === open.id ? updated : t)), detail);
  };

  const saveOpen = () => {
    if (!open) return;
    saveDraft(name, columns, lines, `Saved template ${name.trim() || 'Untitled template'}.`);
  };

  const patchLine = (i: number, id: string, value: string) => {
    setLines(lines.map((l, j) => (j === i ? patchEstimateLine(l, id, value) : l)));
  };

  const formula = amountFormula(columns);

  return (
    <Block
      kicker="Cost estimate templates"
      title={templates.length === 0 ? 'No templates yet' : `${templates.length} template${templates.length === 1 ? '' : 's'}`}
      note="Reusable cost build-ups for a new ARO on any reporting unit. Add columns so the amount is the product of every numeric or percent factor — for example Rate / SQ.M × # of Sq. M × contamination %. A one-line template fills single-line mode; two or more lines fill multi-line mode. Leave a factor blank when it is entered at posting. Templates are optional."
      actions={
        allowed ? (
          <button
            className="btn btn-primary btn-sm"
            type="button"
            onClick={() => {
              const created = emptyCostEstimateTemplate(tenant.id);
              persist([...templates, created], 'Added a cost estimate template.', created.id);
            }}
          >
            Add template
          </button>
        ) : undefined
      }
    >
      {templates.length === 0 ? (
        <div className="muted">
          Add a template to pre-fill a cost build-up when posting a new ARO. Description, quantity and unit rate are the starting columns; add more factors to match how the organisation estimates.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`btn btn-sm ${openId === t.id ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => { saveOpen(); load(t); }}
              >
                {t.name || 'Untitled'}
              </button>
            ))}
          </div>
          {open && (
            <>
              <div style={{ maxWidth: 360, marginBottom: 12 }}>
                <Field label="Template name">
                  <input
                    className="input"
                    value={name}
                    disabled={!allowed}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => allowed && saveOpen()}
                  />
                </Field>
              </div>
              {allowed && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
                  <div style={{ flex: '1 1 180px', maxWidth: 260 }}>
                    <Field label="New column" help="Number and percent columns multiply into the line amount. Text does not.">
                      <input
                        className="input"
                        value={newColName}
                        placeholder="Contamination %"
                        onChange={(e) => setNewColName(e.target.value)}
                      />
                    </Field>
                  </div>
                  <div style={{ flex: '1 1 220px', maxWidth: 280 }}>
                    <Field label="Type">
                      <select
                        className="input"
                        value={newColKind}
                        onChange={(e) => setNewColKind(e.target.value as Exclude<EstimateColumnKind, 'currency'>)}
                      >
                        <option value="number">Number — multiplies the amount</option>
                        <option value="percent">Percent — multiplies as a fraction</option>
                        <option value="text">Text — not in the amount</option>
                      </select>
                    </Field>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={!newColName.trim()}
                    onClick={() => {
                      const added = addEstimateColumn(
                        columns,
                        emptyEstimateColumn(newColKind, newColName),
                        lines,
                      );
                      setColumns(added.columns);
                      setLines(added.lines);
                      setNewColName('');
                      saveDraft(name, added.columns, added.lines, `Added column ${newColName.trim()}.`);
                    }}
                  >
                    Add column
                  </button>
                </div>
              )}
              <div className="field">
                <label><span>Cost lines</span></label>
                <div className="scroll-x">
                  <table className="table" style={{ minWidth: Math.max(560, columns.length * 150 + 180) }}>
                    <thead>
                      <tr>
                        {columns.map((c) => (
                          <th key={c.id} className={c.kind === 'text' ? undefined : 'num'}>
                            <input
                              className="input"
                              value={c.label}
                              disabled={!allowed}
                              aria-label={`${c.label} column name`}
                              onChange={(e) => setColumns(renameEstimateColumn(columns, c.id, e.target.value))}
                              onBlur={() => allowed && saveOpen()}
                            />
                            {allowed && !isSystemEstimateColumn(c.id) && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                style={{ marginTop: 4 }}
                                onClick={() => {
                                  const next = removeEstimateColumn(columns, c.id, lines);
                                  setColumns(next.columns);
                                  setLines(next.lines);
                                  saveDraft(name, next.columns, next.lines, `Removed column ${c.label}.`);
                                }}
                              >
                                Remove column
                              </button>
                            )}
                          </th>
                        ))}
                        <th className="num">Amount</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l, i) => {
                        const amount = lineAmount(l, columns);
                        return (
                          <tr key={i}>
                            {columns.map((c) => (
                              <td key={c.id} className={c.kind === 'text' ? undefined : 'num'}>
                                <input
                                  className={c.kind === 'text' ? 'input' : 'input num'}
                                  inputMode={c.kind === 'text' ? undefined : 'decimal'}
                                  value={c.id === 'description' ? l.description : c.id === 'qty' ? l.qty : c.id === 'rate' ? l.rate : (l.extra?.[c.id] ?? '')}
                                  disabled={!allowed}
                                  placeholder={
                                    c.id === 'description' ? `Cost line ${i + 1}`
                                      : c.kind === 'percent' ? 'e.g. 25'
                                        : c.id === 'rate' ? 'Optional' : undefined
                                  }
                                  onChange={(e) => patchLine(i, c.id, e.target.value)}
                                  onBlur={() => allowed && saveOpen()}
                                />
                              </td>
                            ))}
                            <td className="num muted">{Number.isFinite(amount) ? num(amount, 2) : '—'}</td>
                            <td>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={!allowed || lines.length === 1}
                                onClick={() => {
                                  const next = lines.filter((_, j) => j !== i);
                                  setLines(next);
                                  saveDraft(name, columns, next, 'Removed a template line.');
                                }}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {allowed && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ marginTop: 8 }}
                    onClick={() => {
                      const next = [...lines, emptyEstimateLine(columns)];
                      setLines(next);
                      saveDraft(name, columns, next, 'Added a template line.');
                    }}
                  >
                    Add line
                  </button>
                )}
                <div style={{ marginTop: 4, fontSize: 11 }} className="muted">
                  Amount = {formula}. Percent columns are entered as 25 for 25%.
                  {lines.length <= 1
                    ? ' One line fills single-line mode on a new ARO.'
                    : ` ${lines.length} lines fill multi-line mode.`}
                </div>
              </div>
              {allowed && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ marginTop: 12 }}
                  onClick={() => {
                    if (!window.confirm(`Delete template ${open.name || 'Untitled'}?`)) return;
                    persist(templates.filter((t) => t.id !== open.id), `Deleted template ${open.name || 'Untitled'}.`);
                  }}
                >
                  Delete template
                </button>
              )}
            </>
          )}
        </>
      )}
    </Block>
  );
}

function StepActions({
  allowed, canContinue, blocked, onContinue,
}: {
  allowed: boolean;
  canContinue: boolean;
  blocked: string;
  onContinue: () => void;
}) {
  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      {!canContinue && <div className="muted" style={{ fontSize: 12.5 }}>{blocked}</div>}
      <button className="btn btn-primary" type="button" disabled={!allowed || !canContinue} onClick={onContinue}>
        Save &amp; continue
      </button>
    </div>
  );
}

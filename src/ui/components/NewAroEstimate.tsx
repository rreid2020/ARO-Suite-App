/**
 * Single-line or multi-line cost estimate entry for a new ARO.
 *
 * Columns come from the tenant template (or the default description / qty /
 * unit rate). Factor columns multiply into the line amount. Direct cost is
 * the sum of those amounts. Single line is one row with no add or remove.
 */

import React, { useState } from 'react';
import {
  amountFormula,
  applyCostEstimateTemplate,
  DEFAULT_ESTIMATE_COLUMNS,
  emptyEstimateLine,
  estimateHasCost,
  estimatePayload,
  lineAmount,
  linesForMode,
  patchEstimateLine,
  type EstimateLineDraft,
  type EstimateMode,
} from '../../core/costEstimate';
import type { CostEstimateTemplate, EstimateColumn } from '../../core/types';
import { currency, parseNumber } from '../../core/format';

export {
  DEFAULT_ESTIMATE_COLUMNS,
  emptyEstimateLine,
  estimateHasCost,
  estimatePayload,
  lineAmount,
  linesForMode,
};
export type { EstimateLineDraft, EstimateMode };

export function NewAroEstimate({
  mode,
  lines,
  columns = DEFAULT_ESTIMATE_COLUMNS,
  currencyCode,
  templates,
  onMode,
  onLines,
  onColumns,
}: {
  mode: EstimateMode;
  lines: EstimateLineDraft[];
  columns?: EstimateColumn[];
  currencyCode: string;
  templates?: CostEstimateTemplate[];
  onMode: (mode: EstimateMode) => void;
  onLines: (lines: EstimateLineDraft[]) => void;
  onColumns?: (columns: EstimateColumn[]) => void;
}) {
  const [templateId, setTemplateId] = useState('');
  const cols = columns.length ? columns : DEFAULT_ESTIMATE_COLUMNS;
  const shown = linesForMode(mode, lines, cols);
  const catalogue = templates ?? [];

  const switchMode = (next: EstimateMode) => {
    if (next === mode) return;
    onLines(linesForMode(next, next === 'single' ? shown.slice(0, 1) : shown, cols));
    onMode(next);
  };

  const patchLine = (i: number, id: string, value: string) => {
    onLines(shown.map((l, j) => (j === i ? patchEstimateLine(l, id, value) : l)));
  };

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const template = catalogue.find((t) => t.id === id);
    if (!template) return;
    const applied = applyCostEstimateTemplate(template, currencyCode);
    onMode(applied.mode);
    onLines(applied.lines);
    onColumns?.(applied.columns);
  };

  const total = shown.reduce((s, l) => {
    const a = lineAmount(l, cols);
    return s + (Number.isFinite(a) ? a : 0);
  }, 0);
  const allowAddRemove = mode === 'multi';
  const formula = amountFormula(cols);

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="kicker" style={{ marginRight: 4 }}>Cost estimate</span>
        <button
          type="button"
          className={`btn btn-sm ${mode === 'single' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => switchMode('single')}
        >
          Single line
        </button>
        <button
          type="button"
          className={`btn btn-sm ${mode === 'multi' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => switchMode('multi')}
        >
          Multi-line
        </button>
        {catalogue.length > 0 && (
          <select
            className="input"
            style={{ minHeight: 28, fontSize: 12, width: 'auto', minWidth: 200 }}
            value={templateId}
            aria-label="Cost estimate template"
            onChange={(e) => applyTemplate(e.target.value)}
          >
            <option value="">Template…</option>
            {catalogue.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
      </div>
      <div className="field">
        <label><span>Cost build-up</span></label>
        <div className="scroll-x">
          <table className="table" style={{ minWidth: Math.max(560, cols.length * 140 + 140) }}>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.id} className={c.kind === 'text' ? undefined : 'num'}>{c.label}</th>
                ))}
                <th className="num">Amount</th>
                {allowAddRemove && <th />}
              </tr>
            </thead>
            <tbody>
              {shown.map((l, i) => {
                const amount = lineAmount(l, cols);
                return (
                  <tr key={i}>
                    {cols.map((c) => (
                      <td key={c.id} className={c.kind === 'text' ? undefined : 'num'}>
                        <input
                          className={c.kind === 'text' ? 'input' : 'input num'}
                          inputMode={c.kind === 'text' ? undefined : 'decimal'}
                          value={c.id === 'description' ? l.description : c.id === 'qty' ? l.qty : c.id === 'rate' ? l.rate : (l.extra?.[c.id] ?? '')}
                          placeholder={
                            c.id === 'description' ? `Cost line ${i + 1}`
                              : c.kind === 'percent' ? 'e.g. 25'
                                : c.id === 'rate' ? '' : undefined
                          }
                          onChange={(e) => patchLine(i, c.id, e.target.value)}
                          onBlur={c.kind === 'currency' ? () => {
                            const n = parseNumber(c.id === 'rate' ? l.rate : (l.extra?.[c.id] ?? ''));
                            if (Number.isFinite(n)) patchLine(i, c.id, currency(n, currencyCode));
                          } : undefined}
                        />
                      </td>
                    ))}
                    <td className="num">{Number.isFinite(amount) ? currency(amount, currencyCode) : '—'}</td>
                    {allowAddRemove && (
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={shown.length === 1}
                          onClick={() => onLines(shown.filter((_, j) => j !== i))}
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={cols.length} className="muted">Direct cost</td>
                <td className="num">{currency(total, currencyCode)}</td>
                {allowAddRemove && (
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => onLines([...shown, emptyEstimateLine(cols)])}
                    >
                      Add line
                    </button>
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
        <div style={{ marginTop: 4, fontSize: 11 }} className="muted">
          {mode === 'single'
            ? `One row: ${formula}. Switch to multi-line to add further rows. Direct cost is the amount.`
            : `Each row is ${formula}. Direct cost is the sum of the amounts. Percent columns are entered as 25 for 25%.`}
        </div>
      </div>
    </div>
  );
}

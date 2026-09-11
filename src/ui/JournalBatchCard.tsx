/**
 * Journal status, GL totals and approve/post actions — used on the transaction
 * expand and on Journal batches so both screens run the same workflow.
 */

import React from 'react';
import { canEdit } from '../core/authority';
import {
  applyJournalBatchStatus, journalBatchTransitionAudit, journalBatchTransitionRefusal,
  summariseByAccount,
} from '../core/periodClose';
import { useStore, useUnit, useUnitData } from '../core/store';
import type { JournalBatch } from '../core/types';
import { currency } from '../core/format';
import { Empty, SheetTable, Stats, Tag } from './components';

export function journalStatusKind(status: JournalBatch['status']): 'accent' | 'warn' | 'bad' {
  if (status === 'Posted') return 'accent';
  if (status === 'Reversed') return 'bad';
  return 'warn';
}

export function JournalStatusTag({ status }: { status: JournalBatch['status'] }) {
  return <Tag kind={journalStatusKind(status)}>{status}</Tag>;
}

export function useJournalBatchAct() {
  const { ui, apply } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;

  return (b: JournalBatch, to: JournalBatch['status']) => {
    const period = data.periods.find((p) => p.id === b.periodId);
    const action = to === 'Posted' ? 'Post batch' : to === 'Reversed' ? 'Reverse batch' : 'Approve batch';
    const blocked = journalBatchTransitionRefusal(b, to, { role: ui.role, period });
    if (blocked) {
      apply(action, 'refused', blocked, () => {});
      return;
    }
    const audit = journalBatchTransitionAudit(b, to, period?.code);
    apply(audit.action, audit.kind, audit.detail, (s) => {
      applyJournalBatchStatus(s, unit.id, b.id, to, ui.userName);
    });
  };
}

export function JournalBatchActions({ batch }: { batch: JournalBatch }) {
  const { ui } = useStore();
  const act = useJournalBatchAct();
  return (
    <>
      {batch.status === 'Draft' && canEdit(ui.role) && (
        <button className="btn btn-secondary btn-sm" onClick={() => act(batch, 'Approved')}>Approve</button>
      )}
      {batch.status === 'Approved' && (
        <button className="btn btn-primary btn-sm" onClick={() => act(batch, 'Posted')}>Post</button>
      )}
      {batch.status === 'Posted' && (
        <button className="btn btn-secondary btn-sm" onClick={() => act(batch, 'Reversed')}>Reverse</button>
      )}
    </>
  );
}

export function JournalBatchCard({ batch }: { batch: JournalBatch | undefined }) {
  const { setUi, state } = useStore();
  const unit = useUnit()!;
  const data = useUnitData()!;
  const accounts = state.settings[unit.tenantId]?.accounts ?? [];

  if (!batch) {
    return <Empty>No journal has been created for this posting yet.</Empty>;
  }

  const period = data.periods.find((p) => p.id === batch.periodId);
  const dr = batch.lines.reduce((s, l) => s + l.debit, 0);
  const cr = batch.lines.reduce((s, l) => s + l.credit, 0);
  const glRows = summariseByAccount(batch.lines).sort((a, b) => {
    const ac = accounts.find((x) => x.id === a.accountId)?.code ?? a.accountId;
    const bc = accounts.find((x) => x.id === b.accountId)?.code ?? b.accountId;
    return ac.localeCompare(bc, undefined, { numeric: true });
  });
  const accountLabel = (accountId: string) => {
    const a = accounts.find((x) => x.id === accountId);
    return a ? `${a.code} ${a.name}` : accountId;
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ marginRight: 'auto' }}>
          <div className="kicker">Journal</div>
          <button type="button" className="btn btn-ghost btn-sm"
            aria-label={`Open journal batch ${batch.number}`}
            style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, paddingLeft: 0, paddingRight: 0, textDecoration: 'underline', textUnderlineOffset: 3, fontSize: 16 }}
            onClick={() => setUi({ screen: 'batches', tab: '', sub: batch.id })}>
            {batch.number}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <JournalStatusTag status={batch.status} />
          <JournalBatchActions batch={batch} />
        </div>
      </div>
      <Stats items={[
        { label: 'Status', value: batch.status, tone: batch.status === 'Posted' ? 'ok' : batch.status === 'Reversed' ? 'bad' : 'warn' },
        { label: 'Period', value: period?.code ?? '—' },
        { label: 'Debits', value: currency(dr, unit.currency) },
        { label: 'Credits', value: currency(cr, unit.currency) },
        { label: 'Approved by', value: batch.approvedBy ?? '—' },
        { label: 'Posted by', value: batch.postedBy ?? '—' },
      ]} />
      {glRows.length > 0 && (
        <SheetTable
          rows={glRows}
          rowKey={(row) => row.accountId}
          noun="accounts"
          columns={[
            {
              key: 'account', header: 'Account',
              value: (row) => accountLabel(row.accountId),
              tdStyle: { fontFamily: 'var(--font-heading)', fontWeight: 800 },
              cell: (row) => row.suspense
                ? <Tag kind="bad">{accountLabel(row.accountId)}</Tag>
                : accountLabel(row.accountId),
            },
            {
              key: 'debit', header: 'Debit', kind: 'number', thClassName: 'num', tdClassName: 'num',
              value: (row) => row.debit, cell: (row) => row.debit ? currency(row.debit, unit.currency) : '',
            },
            {
              key: 'credit', header: 'Credit', kind: 'number', thClassName: 'num', tdClassName: 'num',
              value: (row) => row.credit, cell: (row) => row.credit ? currency(row.credit, unit.currency) : '',
            },
          ]}
        />
      )}
    </div>
  );
}

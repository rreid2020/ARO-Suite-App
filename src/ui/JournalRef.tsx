import React from 'react';
import { useStore } from '../core/store';
import { journalBatchForEvent } from '../core/registerBooks';
import type { JournalBatch } from '../core/types';

/** Clickable posting JV# that opens the journal batch. */
export function JournalRef({ eventId, batches }: { eventId: string; batches: JournalBatch[] }) {
  const { setUi } = useStore();
  const batch = journalBatchForEvent(eventId, batches);
  if (!batch) return <span className="muted">—</span>;
  return (
    <button type="button" className="btn btn-ghost btn-sm"
      aria-label={`Open journal batch ${batch.number}`}
      style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, paddingLeft: 0, paddingRight: 0, textDecoration: 'underline', textUnderlineOffset: 3 }}
      onClick={() => setUi({ screen: 'batches', tab: '', sub: batch.id })}>
      {batch.number}
    </button>
  );
}

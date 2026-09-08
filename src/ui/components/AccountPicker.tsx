/**
 * Searchable GL picker. Native <select> cannot filter a 40-row chart as the
 * user types; this combobox matches code, name, class and extra chart columns.
 */

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ACCOUNT_CLASSES } from '../../seed';
import type { Account } from '../../core/types';

function haystack(a: Account): string {
  return `${a.code} ${a.name} ${a.cls} ${Object.values(a.columns ?? {}).join(' ')}`.toLowerCase();
}

function matches(a: Account, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const h = haystack(a);
  return words.every((w) => h.includes(w));
}

function labelOf(a: Account | undefined): string {
  return a ? `${a.code} — ${a.name}` : '';
}

export function AccountPicker({
  accounts, value, disabled, onChange, ariaLabel,
}: {
  accounts: Account[];
  value: string;
  disabled?: boolean;
  onChange: (accountId: string) => void;
  ariaLabel: string;
}) {
  const uid = useId();
  const listId = `gl-list-${uid.replace(/:/g, '')}`;
  const selected = accounts.find((a) => a.id === value);
  const label = labelOf(selected);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(label);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) setQuery(label);
  }, [open, label]);

  const shown = useMemo(() => {
    const q = open ? query : '';
    const filtering = open && q.trim() !== '' && q !== label;
    const rows = filtering ? accounts.filter((a) => matches(a, q)) : accounts;
    return rows;
  }, [accounts, open, query, label]);

  const options = useMemo(() => {
    const rows: { id: string; label: string; group?: string }[] = [{ id: '', label: '— unassigned —' }];
    for (const cls of ACCOUNT_CLASSES) {
      const group = shown.filter((a) => a.cls === cls);
      for (const a of group) rows.push({ id: a.id, label: `${a.code} — ${a.name}`, group: cls });
    }
    const other = shown.filter((a) => !(ACCOUNT_CLASSES as readonly string[]).includes(a.cls));
    for (const a of other) rows.push({ id: a.id, label: `${a.code} — ${a.name}`, group: a.cls || 'Other' });
    return rows;
  }, [shown]);

  useEffect(() => {
    const idx = options.findIndex((o) => o.id === value);
    setActive(idx >= 0 ? idx : 0);
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const onPtr = (e: PointerEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPtr);
    return () => document.removeEventListener('pointerdown', onPtr);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !panelRef.current || !inputRef.current) return;
    const panel = panelRef.current;
    const r = inputRef.current.getBoundingClientRect();
    const width = Math.max(r.width, 280);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    panel.style.width = `${width}px`;
    panel.style.left = `${left}px`;
    let top = r.bottom + 4;
    panel.style.top = `${top}px`;
    const box = panel.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8) {
      top = Math.max(8, r.top - box.height - 4);
      panel.style.top = `${top}px`;
    }
  }, [open, options.length]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      e.currentTarget.blur();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((i) => Math.min(options.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const hit = options[active];
      if (hit) pick(hit.id);
    }
  };

  let lastGroup = '';

  return (
    <div ref={wrapRef} className="account-picker">
      <input
        ref={inputRef}
        className="input"
        style={{ minHeight: 26, fontSize: 11.5, minWidth: 280 }}
        value={open ? query : (label || '')}
        placeholder="— unassigned —"
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onFocus={(e) => {
          if (disabled) return;
          setOpen(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      {open && createPortal(
        <div ref={panelRef} className="account-picker-menu" id={listId} role="listbox">
          {options.length === 1 && query.trim() && query !== label ? (
            <div className="account-picker-empty">No GLs match “{query.trim()}”.</div>
          ) : options.map((o, i) => {
            const showGroup = o.group && o.group !== lastGroup;
            if (o.group) lastGroup = o.group;
            return (
              <React.Fragment key={o.id || 'none'}>
                {showGroup && <div className="account-picker-group">{o.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={o.id === value}
                  className={`account-picker-opt${i === active ? ' is-active' : ''}${o.id === value ? ' is-current' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o.id)}
                >{o.label}</button>
              </React.Fragment>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

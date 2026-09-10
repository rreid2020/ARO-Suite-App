/** CSS tone class for a table group heading, column, or row. */
export function groupToneSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}

export function groupToneClass(name: string, start = false, extra?: string): string {
  return [`g-tone g-${groupToneSlug(name)}`, start ? 'g-start' : '', extra].filter(Boolean).join(' ');
}

export function columnGroupSpans(groups: (string | undefined)[]): { group: string; span: number }[] {
  const out: { group: string; span: number }[] = [];
  for (const g of groups) {
    const name = g ?? '';
    const last = out[out.length - 1];
    if (last && last.group === name) last.span += 1;
    else out.push({ group: name, span: 1 });
  }
  return out;
}

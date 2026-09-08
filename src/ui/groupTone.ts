/** CSS tone class for a table group heading, column, or row. */
export function groupToneSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}

export function groupToneClass(name: string, start = false, extra?: string): string {
  return [`g-tone g-${groupToneSlug(name)}`, start ? 'g-start' : '', extra].filter(Boolean).join(' ');
}

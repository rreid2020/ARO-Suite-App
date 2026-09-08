/**
 * A minimal .xlsx reader — the counterpart to `write.ts`.
 *
 * Ported from `xlsx-read.js` in the prototype. Dependency-free and streaming
 * through the platform's own `DecompressionStream`, which matters for more than
 * bundle size: the client's extract is opened in the page and **never leaves
 * the machine**. An auditor can run the tool on data they are not allowed to
 * upload anywhere.
 *
 * It reads values, not formatting, and it is deliberately forgiving — SAP
 * exports lead with cover tabs, merge title rows above the headers and quote
 * dates as serials. What it cannot guess it reports, so the import screen can
 * ask rather than silently mapping the wrong column.
 */

const dec = new TextDecoder();

interface ZipEntry {
  method: number;
  data: Uint8Array;
}

/**
 * Read the central directory of a zip. `.xlsx` is a zip of XML parts, and the
 * four we need are named in the spec, so there is no need to inflate the rest.
 */
function unzip(buf: Uint8Array): Record<string, ZipEntry> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a zip file — is this really an .xlsx?');

  const count = dv.getUint16(end + 10, true);
  const files: Record<string, ZipEntry> = {};
  let p = dv.getUint32(end + 16, true);

  for (let k = 0; k < count; k++) {
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const localHeader = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.slice(p + 46, p + 46 + nameLen));
    // The local header repeats the name and extra fields at its own lengths,
    // which need not match the central directory's — read them, don't assume.
    const localNameLen = dv.getUint16(localHeader + 26, true);
    const localExtraLen = dv.getUint16(localHeader + 28, true);
    const start = localHeader + 30 + localNameLen + localExtraLen;
    files[name] = { method, data: buf.slice(start, start + csize) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function entryText(entry: ZipEntry | undefined): Promise<string> {
  if (!entry) return '';
  if (entry.method === 0) return dec.decode(entry.data);
  const stream = new Blob([entry.data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

/** "BF12" → 57. Column letters only; the row number is discarded. */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Excel serial → ISO date, 1900 system.
 *
 * The epoch is 30 Dec 1899 rather than the 31st because Excel believes 1900 was
 * a leap year. That is a bug Lotus 1-2-3 shipped in 1983 and every spreadsheet
 * since has reproduced for compatibility; anchoring two days early absorbs it
 * for every date after Feb 1900, which is every date a client extract carries.
 *
 * Returns '' for anything outside the serial range, so a text column that
 * happens to hold numbers cannot be silently read as dates.
 */
export function serialToIso(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return '';
  const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 864e5;
  return new Date(ms).toISOString().slice(0, 10);
}

/** An ISO date already, or an Excel serial. '' when it is neither. */
export function cellToIso(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : serialToIso(raw);
}

export interface SheetHeader {
  index: number;
  label: string;
}

export interface ReadSheet {
  sheetName: string;
  headers: SheetHeader[];
  /** Index of the row the headers were taken from. */
  headerRow: number;
  /** Raw cell values, aligned to `headers` by column position. */
  rows: string[][];
}

function unescapeXml(s: string): string {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    // Ampersand last: unescaping it first would let "&amp;lt;" become "<".
    .replace(/&amp;/g, '&');
}

export interface ReadOptions {
  /** Hard stop on rows parsed. Guards against a pathological file. */
  maxRows?: number;
}

/**
 * Read the most substantial worksheet out of an .xlsx.
 *
 * Two guesses are made here, and both are surfaced rather than hidden:
 *
 * - **Which sheet.** The one with the most rows. SAP exports routinely lead
 *   with a cover or parameter tab, and taking sheet 1 would read the run
 *   parameters as data. The name is returned so the import screen can show
 *   which one was taken.
 * - **Which row holds the headers.** The first row within the top 30 carrying
 *   three or more non-numeric labels. Extracts put a title, a run date and a
 *   blank line above the grid; a fixed row 1 would read those as column names.
 */
export async function readSheet(bytes: Uint8Array, opts: ReadOptions = {}): Promise<ReadSheet> {
  const maxRows = opts.maxRows ?? 200000;
  const files = unzip(bytes);

  const workbook = await entryText(files['xl/workbook.xml']);
  const names = [...workbook.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*>/g)].map((m) => unescapeXml(m[1]));

  const sheetPaths = Object.keys(files)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  if (!sheetPaths.length) throw new Error('No worksheets found in this workbook.');

  const sharedXml = await entryText(files['xl/sharedStrings.xml']);
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''),
  );

  let best: { path: string; xml: string; count: number } | null = null;
  for (const path of sheetPaths) {
    const xml = await entryText(files[path]);
    const count = (xml.match(/<row[\s>]/g) || []).length;
    if (!best || count > best.count) best = { path, xml, count };
  }
  if (!best) throw new Error('No worksheets found in this workbook.');

  const parsed: string[][] = [];
  let width = 0;
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
  let m: RegExpExecArray | null;

  while ((m = rowRe.exec(best.xml)) && parsed.length < maxRows) {
    const cells: string[] = [];
    let c: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((c = cellRe.exec(m[1]))) {
      const type = (c[2].match(/t="([^"]+)"/) || [])[1];
      let v: string | undefined = (c[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (type === 'inlineStr') v = (c[3].match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      if (type === 's' && v != null) v = shared[Number(v)];
      cells[colIndex(c[1])] = v == null ? '' : unescapeXml(v);
    }
    // Empty cells are omitted from the XML entirely, leaving array holes that
    // would read as undefined downstream.
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    if (cells.length > width) width = cells.length;
    parsed.push(cells);
  }

  let headerRow = 0;
  for (let i = 0; i < Math.min(parsed.length, 30); i++) {
    const labels = parsed[i].filter((v) => v !== '' && Number.isNaN(Number(v)));
    if (labels.length >= 3) {
      headerRow = i;
      break;
    }
  }

  const headers: SheetHeader[] = [];
  for (let i = 0; i < width; i++) {
    const label = String((parsed[headerRow] && parsed[headerRow][i]) || '').replace(/\s+/g, ' ').trim();
    headers.push({ index: i, label: label || `(column ${i + 1})` });
  }

  return {
    sheetName: names[sheetPaths.indexOf(best.path)] || best.path,
    headers,
    headerRow,
    rows: parsed.slice(headerRow + 1).filter((r) => r.some((v) => v !== '')),
  };
}

/**
 * Find the column matching a list of keyword groups, best match first.
 *
 * Groups are tried in order of preference and every word in a group must appear
 * in the header, so `[['cost','estimate'], ['cost']]` prefers "Cost estimate
 * (REP04)" over "Cost centre" but will still settle for the latter if nothing
 * better exists. Among equally-ranked hits the shortest label wins: "Settlement
 * date" beats "Settlement date last changed by".
 *
 * Returns -1 when nothing matches, which the import screen shows as "not found"
 * against a column picker rather than guessing.
 */
export function findColumn(headers: SheetHeader[], groups: string[][]): number {
  let bestIdx = -1;
  let bestScore = 0;
  for (const h of headers) {
    const label = h.label.toLowerCase();
    for (let g = 0; g < groups.length; g++) {
      if (groups[g].every((w) => label.includes(w))) {
        const score = (groups.length - g) * 100 - label.length;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = h.index;
        }
        break;
      }
    }
  }
  return bestIdx;
}

/** The column keyword groups for each extract the recalculation tool reads. */
export const COLUMN_HINTS = {
  rep04: {
    id: [['obligation', 'no'], ['aro', 'obligation'], ['obligation'], ['asset', 'no']],
    cost: [['cost', 'estimate'], ['cost']],
    costEstimateDate: [['cost', 'estimate', 'date'], ['price', 'key'], ['valid'], ['date']],
  },
  rep06: {
    id: [['obligation', 'no'], ['aro', 'obligation'], ['obligation'], ['asset', 'no']],
    settlementDate: [['settlement', 'date'], ['settlement'], ['current', 'end', 'date'], ['end', 'date'], ['retirement', 'date']],
    fv: [['fv', 'obligation'], ['future', 'value'], ['fv']],
    pv: [['pv', 'obligation'], ['present', 'value'], ['pv']],
  },
  curve: {
    validOn: [['valid', 'on'], ['valid'], ['as', 'of'], ['date']],
    term: [['term']],
    rate: [['interest', 'rate'], ['rate']],
  },
} as const;

export type ExtractKind = keyof typeof COLUMN_HINTS;

/** Auto-map an extract's columns. Every field resolves to an index or -1. */
export function autoMap(kind: ExtractKind, headers: SheetHeader[]): Record<string, number> {
  const hints = COLUMN_HINTS[kind] as Record<string, readonly (readonly string[])[]>;
  const map: Record<string, number> = {};
  for (const key of Object.keys(hints)) {
    map[key] = findColumn(headers, hints[key].map((g) => [...g]));
  }
  return map;
}

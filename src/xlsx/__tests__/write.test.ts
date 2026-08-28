/**
 * INVARIANTS §9: "Variance formulas in exports stay self-contained and
 * paste-ready — a workbook must recalculate in Excel with no external
 * references."
 *
 * The writer emits a *stored* (uncompressed) zip, so the test can unpack it
 * without a zip library and read the sheet XML directly.
 */

import { describe, expect, it } from 'vitest';
import { build, colName, dateSerial, S, Sheet } from '../write';

/** Minimal reader for the stored zip the writer produces. */
async function unzip(blob: Blob): Promise<Map<string, string>> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  let i = 0;
  while (i + 4 <= buf.length && view.getUint32(i, true) === 0x04034b50) {
    const method = view.getUint16(i + 8, true);
    const size = view.getUint32(i + 18, true);
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const name = dec.decode(buf.subarray(i + 30, i + 30 + nameLen));
    const start = i + 30 + nameLen + extraLen;
    expect(method, `${name} must be stored, not deflated`).toBe(0);
    out.set(name, dec.decode(buf.subarray(start, start + size)));
    i = start + size;
  }
  return out;
}

const sheet: Sheet = {
  name: 'Register',
  freeze: 1,
  cols: [14, 30, 16],
  rows: [
    [{ v: 'Reference', s: S.head }, { v: 'Settlement', s: S.head }, { v: 'Provision', s: S.head }],
    ['ARO-0001', { v: '2032-06-30', t: 'd' }, { v: 1234.56, s: S.money }],
    ['ARO-0002', { v: '2035-12-31', t: 'd' }, { f: 'C2*1.05', s: S.money }],
    [{ v: 'Total', s: S.bold }, null, { f: 'SUM(C2:C3)', s: S.money }],
  ],
};

describe('xlsx writer', () => {
  it('produces a workbook with the parts Excel requires', async () => {
    const files = await unzip(build([sheet]));
    for (const part of [
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
    ]) {
      expect(files.has(part), `missing ${part}`).toBe(true);
    }
  });

  it('writes formulas as formulas, not as baked values', async () => {
    const files = await unzip(build([sheet]));
    const xml = files.get('xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('<f>C2*1.05</f>');
    expect(xml).toContain('<f>SUM(C2:C3)</f>');
  });

  it('keeps every formula self-contained — no external or cross-workbook references', async () => {
    const files = await unzip(build([sheet]));
    const xml = files.get('xl/worksheets/sheet1.xml')!;
    const formulas = [...xml.matchAll(/<f>(.*?)<\/f>/g)].map((m) => m[1]);
    expect(formulas.length).toBeGreaterThan(0);
    for (const f of formulas) {
      // `[1]Sheet!A1` is an external workbook link; `'C:\…'` is a file path.
      expect(f, `external reference in ${f}`).not.toMatch(/\[\d+\]/);
      expect(f, `file path in ${f}`).not.toMatch(/[A-Za-z]:\\/);
      expect(f, `http reference in ${f}`).not.toMatch(/https?:/i);
    }
    expect(xml).not.toContain('externalLink');
  });

  it('forces a full recalculation on load, so the formulas produce values', async () => {
    const files = await unzip(build([sheet]));
    expect(files.get('xl/workbook.xml')).toContain('fullCalcOnLoad="1"');
  });

  it('freezes the header and sets the column widths asked for', async () => {
    const xml = (await unzip(build([sheet]))).get('xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('width="30"');
  });

  it('escapes text so a description with an ampersand cannot break the XML', async () => {
    const odd: Sheet = { name: 'S', rows: [['Well & pipe <removal> "A"']] };
    const xml = (await unzip(build([odd]))).get('xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('Well &amp; pipe &lt;removal&gt; &quot;A&quot;');
  });

  it('writes dates as 1900-system serials, matching Excel', () => {
    // The epoch is 1899-12-30, which absorbs Excel's phantom 29 February 1900
    // (the "Lotus quirk") so every date from 1 March 1900 onward agrees with
    // Excel exactly. Dates before that are off by one and are not representable
    // correctly in either system; no ARO date lands there.
    expect(dateSerial('1900-03-01')).toBe(61);
    expect(dateSerial('2000-01-01')).toBe(36526);
    expect(dateSerial('2025-12-31')).toBe(46022);
    expect(dateSerial('2032-06-30')).toBe(48395);
    expect(dateSerial('not a date')).toBeNull();
  });

  it('names columns the way Excel does past Z', () => {
    expect(colName(0)).toBe('A');
    expect(colName(25)).toBe('Z');
    expect(colName(26)).toBe('AA');
    expect(colName(51)).toBe('AZ');
    expect(colName(701)).toBe('ZZ');
  });

  it('omits empty cells rather than writing blanks', async () => {
    const xml = (await unzip(build([sheet]))).get('xl/worksheets/sheet1.xml')!;
    // Row 4 has a null in column B, so B4 must not appear at all.
    expect(xml).not.toContain('r="B4"');
  });
});

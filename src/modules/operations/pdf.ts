/**
 * A plain printed document as a PDF: text and simple tables in Helvetica, top to bottom, with page
 * breaks and a footer, the company's logo at the top and its watermark under every page (#71).
 * No library: enough for a trip sheet or a driver statement sent with an e-mail.
 */

export type PdfBlock =
  | { kind: 'title'; text: string }
  | { kind: 'subtitle'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'facts'; rows: Array<[string, string]> }
  | { kind: 'table'; columns: Array<{ label: string; width: number; align?: 'right' }>; rows: string[][] }
  | { kind: 'signatures'; labels: string[] }
  /** A company picture field (#97): its name, then the photo, at most 150 points tall. A JPEG, as the logo is. */
  | { kind: 'picture'; label: string; jpeg: Buffer };

export interface PdfLayout {
  paperSize?: 'A4' | 'A5' | 'Letter';
  orientation?: 'portrait' | 'landscape';
  footerText?: string;
  /** The company's logo for documents: a JPEG (the screens convert any upload to one). */
  logo?: Buffer | null;
  /** Drawn under each page's content: the company's text or logo, faint, at an angle. */
  watermark?: { text?: string | null; logo?: boolean; opacity: number; angle: number } | null;
  /** A test installation: every page says so, across the middle and at the top. */
  testMark?: boolean;
}

/** A JPEG's pixel size, from its start-of-frame marker; null when the bytes are not a JPEG we can place. */
export function jpegSize(jpeg: Buffer): { width: number; height: number; components: number } | null {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) { i += 1; continue; }
    const marker = jpeg[i + 1]!;
    // Baseline, extended and progressive frames carry the size; the others are skipped by their length.
    if (marker >= 0xc0 && marker <= 0xc3) return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7), components: jpeg[i + 9] ?? 3 };
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return null;
}

const PAPER: Record<NonNullable<PdfLayout['paperSize']>, [number, number]> = { A4: [595, 842], A5: [420, 595], Letter: [612, 792] };
const MARGIN = 40;
const FOOTER = 28;

/** Helvetica's widths, near enough for wrapping and right-aligning: in thousandths of the font size. */
function charWidth(c: string): number {
  if (/[ il.,:;|!'\-()[\]/fjtI]/.test(c)) return 300;
  if (/[mwMW@%]/.test(c)) return 850;
  if (/[0-9]/.test(c)) return 556;
  if (/[A-Z]/.test(c)) return 670;
  return 520;
}
const widthOf = (text: string, size: number) => [...text].reduce((w, c) => w + charWidth(c), 0) * size / 1000;

function fit(text: string, size: number, max: number): string {
  if (widthOf(text, size) <= max) return text;
  let out = text;
  while (out.length > 1 && widthOf(`${out}…`, size) > max) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

function wrap(text: string, size: number, max: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size) <= max || !line) line = next;
      else { lines.push(line); line = word; }
    }
    lines.push(fit(line, size, max));
  }
  return lines;
}

/** WinAnsi characters the standard fonts have beyond Latin-1; anything else prints as "?". */
const WIN_ANSI: Record<string, number> = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };
function pdfString(text: string): string {
  let out = '(';
  for (const c of text) {
    const code = c.codePointAt(0)!;
    if (c === '(' || c === ')' || c === '\\') out += `\\${c}`;
    else if (code >= 32 && code < 127) out += c;
    else {
      const byte = WIN_ANSI[c] ?? (code >= 160 && code <= 255 ? code : 63);
      out += `\\${byte.toString(8).padStart(3, '0')}`;
    }
  }
  return `${out})`;
}

export function renderPdf(blocks: PdfBlock[], layout: PdfLayout = {}): Buffer {
  const [w, h] = (() => {
    const [a, b] = PAPER[layout.paperSize ?? 'A4'];
    return layout.orientation === 'landscape' ? [b, a] : [a, b];
  })();
  const usable = w - 2 * MARGIN;
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = 0;
  const newPage = () => { ops = []; pages.push(ops); y = h - MARGIN; };
  const room = (needed: number) => { if (y - needed < MARGIN + FOOTER) newPage(); };
  const text = (x: number, size: number, bold: boolean, value: string) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td ${pdfString(value)} Tj ET`);
  // A line under the text just written.
  const rule = (weight = 0.5) => { ops.push(`${weight} w ${MARGIN} ${(y - 3).toFixed(1)} m ${w - MARGIN} ${(y - 3).toFixed(1)} l S`); y -= 3; };
  newPage();
  const pictures: Array<{ jpeg: Buffer; width: number; height: number; components: number }> = [];

  // The logo, top right of the first page, at most 34 points tall and 140 wide.
  const logoSize = layout.logo ? jpegSize(layout.logo) : null;
  if (logoSize) {
    const scale = Math.min(34 / logoSize.height, 140 / logoSize.width);
    const lw = logoSize.width * scale;
    const lh = logoSize.height * scale;
    ops.push(`q ${lw.toFixed(1)} 0 0 ${lh.toFixed(1)} ${(w - MARGIN - lw).toFixed(1)} ${(h - MARGIN - lh + 8).toFixed(1)} cm /Im1 Do Q`);
  }

  for (const block of blocks) {
    switch (block.kind) {
      case 'title':
        room(24); y -= 18; text(MARGIN, 16, true, fit(block.text, 16, usable)); y -= 6; break;
      case 'subtitle':
        for (const line of wrap(block.text, 9, usable)) { room(12); y -= 11; text(MARGIN, 9, false, line); }
        y -= 4; break;
      case 'heading':
        room(40); y -= 18; text(MARGIN, 11, true, fit(block.text, 11, usable)); rule(); y -= 2; break;
      case 'text':
        for (const line of wrap(block.text, 9, usable)) { room(12); y -= 12; text(MARGIN, 9, false, line); }
        break;
      case 'facts': {
        const labelW = Math.min(150, usable * 0.32);
        for (const [label, value] of block.rows) {
          const lines = wrap(value || '—', 9, usable - labelW);
          room(12 * lines.length);
          y -= 12; text(MARGIN, 9, true, fit(label, 9, labelW - 8));
          lines.forEach((line, i) => { if (i) y -= 12; text(MARGIN + labelW, 9, false, line); });
        }
        break;
      }
      case 'table': {
        const total = block.columns.reduce((s, c) => s + c.width, 0);
        const widths = block.columns.map((c) => (c.width / total) * usable);
        const row = (cells: string[], bold: boolean) => {
          let x = MARGIN;
          cells.forEach((cell, i) => {
            const width = widths[i] ?? 0;
            const value = fit(cell ?? '', 8.5, width - 6);
            const right = block.columns[i]?.align === 'right';
            text(right ? x + width - 6 - widthOf(value, 8.5) : x, 8.5, bold, value);
            x += width;
          });
        };
        const header = () => { y -= 12; row(block.columns.map((c) => c.label), true); rule(0.3); };
        room(30); header();
        if (!block.rows.length) { room(12); y -= 12; text(MARGIN, 8.5, false, 'None'); }
        for (const cells of block.rows) {
          if (y - 12 < MARGIN + FOOTER) { newPage(); header(); }
          y -= 12; row(cells, false);
        }
        break;
      }
      case 'picture': {
        const size = jpegSize(block.jpeg);
        if (!size) break;
        const scale = Math.min(150 / size.height, Math.min(260, usable) / size.width, 1);
        const [pw, ph] = [size.width * scale, size.height * scale];
        room(ph + 22); y -= 14; text(MARGIN, 9, true, fit(block.label, 9, usable)); y -= ph + 4;
        pictures.push({ jpeg: block.jpeg, ...size });
        ops.push(`q ${pw.toFixed(1)} 0 0 ${ph.toFixed(1)} ${MARGIN} ${y.toFixed(1)} cm /Im${pictures.length + 1} Do Q`);
        break;
      }
      case 'signatures': {
        if (!block.labels.length) break;
        const per = Math.min(3, block.labels.length);
        const width = usable / per;
        for (let i = 0; i < block.labels.length; i += per) {
          room(54); y -= 42;
          block.labels.slice(i, i + per).forEach((label, j) => {
            const x = MARGIN + j * width;
            ops.push(`0.5 w ${x.toFixed(1)} ${y.toFixed(1)} m ${(x + width - 16).toFixed(1)} ${y.toFixed(1)} l S`);
            y -= 10; text(x, 8, false, fit(label, 8, width - 16)); y += 10;
          });
          y -= 10;
        }
        break;
      }
    }
  }

  // Under each page's content: the watermark, then the test mark; drawn first so the text stays on top.
  const under: string[] = [];
  const rad = ((layout.watermark?.angle ?? 35) * Math.PI) / 180;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  const across = (value: string, size: number, opacityName: string) => {
    const tw = widthOf(value, size);
    // Centre the rotated text on the page.
    const x = w / 2 - (cos * tw) / 2;
    const y0 = h / 2 - (sin * tw) / 2;
    under.push(`q /${opacityName} gs 0.35 g BT /F2 ${size} Tf ${cos.toFixed(4)} ${sin.toFixed(4)} ${(-sin).toFixed(4)} ${cos.toFixed(4)} ${x.toFixed(1)} ${y0.toFixed(1)} Tm ${pdfString(value)} Tj ET Q`);
  };
  if (layout.watermark?.text) across(layout.watermark.text, Math.min(72, (w * 0.8) / Math.max(1, widthOf(layout.watermark.text, 1))), 'GS1');
  else if (layout.watermark?.logo && logoSize) {
    const scale = Math.min((w * 0.6) / logoSize.width, (h * 0.4) / logoSize.height);
    const lw = logoSize.width * scale;
    const lh = logoSize.height * scale;
    under.push(`q /GS1 gs ${lw.toFixed(1)} 0 0 ${lh.toFixed(1)} ${((w - lw) / 2).toFixed(1)} ${((h - lh) / 2).toFixed(1)} cm /Im1 Do Q`);
  }
  if (layout.testMark) across('TEST COPY', 64, 'GS2');
  pages.forEach((page, i) => {
    page.unshift(...under);
    if (layout.testMark) page.push(`BT /F2 8 Tf ${MARGIN} ${h - 22} Td ${pdfString('Test copy: not a real document')} Tj ET`);
    const footer = `${layout.footerText ? `${layout.footerText}  ·  ` : ''}Page ${i + 1} of ${pages.length}`;
    page.push(`BT /F1 7.5 Tf ${MARGIN} ${MARGIN - 8} Td ${pdfString(fit(footer, 7.5, usable))} Tj ET`);
  });

  // Objects: 1 catalog, 2 page tree, 3–4 fonts, 5–6 transparency (watermark, test mark), 7 the logo image,
  // then a page and its content stream for each page.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 8 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  const opacity = Math.min(0.5, Math.max(0.03, layout.watermark?.opacity ?? 0.08));
  objects[5] = `<< /Type /ExtGState /ca ${opacity} /CA ${opacity} >>`;
  objects[6] = '<< /Type /ExtGState /ca 0.12 /CA 0.12 >>';
  // A JPEG is binary; latin1 keeps every byte as one character, so string length is still the byte count.
  objects[7] = logoSize && layout.logo
    ? `<< /Type /XObject /Subtype /Image /Width ${logoSize.width} /Height ${logoSize.height} /ColorSpace /${logoSize.components === 1 ? 'DeviceGray' : logoSize.components === 4 ? 'DeviceCMYK' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${layout.logo.length} >>\nstream\n${layout.logo.toString('latin1')}\nendstream`
    : '<< >>';
  // Pictures follow the pages: Im2, Im3… after the logo's Im1.
  const pictureIds = pictures.map((_, i) => 8 + pages.length * 2 + i);
  const image = (p: { jpeg: Buffer; width: number; height: number; components: number }) => `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /${p.components === 1 ? 'DeviceGray' : p.components === 4 ? 'DeviceCMYK' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n${p.jpeg.toString('latin1')}\nendstream`;
  pictures.forEach((p, i) => { objects[pictureIds[i]!] = image(p); });
  const xobjects = [...(logoSize ? ['/Im1 7 0 R'] : []), ...pictureIds.map((id, i) => `/Im${i + 2} ${id} 0 R`)];
  const resources = `/Font << /F1 3 0 R /F2 4 0 R >> /ExtGState << /GS1 5 0 R /GS2 6 0 R >>${xobjects.length ? ` /XObject << ${xobjects.join(' ')} >>` : ''}`;
  pages.forEach((page, i) => {
    const stream = page.join('\n');
    objects[pageIds[i]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << ${resources} >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  // Everything above is ASCII (other characters are octal escapes), so string length is the byte count.
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

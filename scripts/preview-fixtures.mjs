import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import sharp from 'sharp';

/** Synthetic documents for the isolated viewer harness; never personal files. */
export async function previewFixtures() {
  const fixtures = [];
  const add = (path, bytes, mime = '') => fixtures.push({ path, mime, base64: Buffer.from(bytes).toString('base64') });
  const illustration = '<svg width="720" height="420" xmlns="http://www.w3.org/2000/svg"><rect width="720" height="420" fill="#101c32"/><circle cx="530" cy="200" r="120" fill="#5be1cc"/><path d="M80 300 Q360 0 630 300" fill="none" stroke="#a694ff" stroke-width="5"/><text x="48" y="85" fill="#eef5ff" font-family="sans-serif" font-size="30">Kepler observatory</text><text x="48" y="365" fill="#a8bada" font-family="sans-serif" font-size="20">Synthetic preview fixture / no personal data</text></svg>';
  const png = await sharp(Buffer.from(illustration)).png().toBuffer();
  add('notes/orbit.png', png, 'image/png');
  add('notes/orbit.jpg', await sharp(png).jpeg().toBuffer(), 'image/jpeg');
  add('notes/orbit.webp', await sharp(png).webp().toBuffer(), 'image/webp');
  add('notes/README.md', '# The Kepler observatory\n\nA **local reading room** for your files. This document is fictional.\n\n## Tonight’s notes\n\n- Follow the quiet signal\n- Compare readings across the valley\n- Return to your ship\n\n![Synthetic orbital illustration](orbit.png)\n\n| Signal | Intensity |\n| --- | ---: |\n| Blue | 0.84 |\n| Amber | 0.61 |\n\n```js\nconst mission = { name: "Kepler", local: true };\n```\n\n[Read the next note](next.md)\n');
  add('notes/next.md', '# The next note\n\nA scoped local link reached this file.');
  add('notes/security.md', '# Resource policy\n\n<script>window.__unsafe = true</script>\n<img src="https://preview-canary.invalid/image.png" onerror="window.__unsafe=true">\n![remote](https://preview-canary.invalid/markdown.png)\n![escape](../../outside.png)\n![local](orbit.png)\n\n[unsafe](javascript:alert(1))\n<iframe src="https://preview-canary.invalid/frame"></iframe>');
  add('notes/snippet.js', '// A navigation example, displayed without execution.\nexport function approach(distance, speed = 24) {\n  return Math.min(1, Math.max(0, distance / 60)) * speed;\n}\nwindow.__unsafe = true;\n');
  add('notes/raw.html', '<!doctype html><script>window.__unsafe=true</script><h1>HTML source only</h1><img src="https://preview-canary.invalid/html.png">');
  add('notes/active.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__unsafe=true"><script>window.__unsafe=true</script><image href="https://preview-canary.invalid/svg.png"/></svg>');
  add('notes/empty.txt', '');
  add('notes/large.txt', 'A long plain-text line that should remain bounded.\n'.repeat(7000));
  add('data/precise.json', '{"observatory":"Kepler","id":900719925474099312345,"ratio":1.2300e+99,"enabled":true,"samples":[0.61,0.84]}');
  add('data/events.jsonl', '{"id":9007199254740993,"event":"arrival"}\n{"id":9007199254740995,"event":"landing"}\n');
  add('data/broken.json', '{"unfinished":');
  add('data/signals.csv', 'id,name,intensity\n' + Array.from({ length: 115 }, (_, i) => `${String(i).padStart(5, '0')},"Signal ${i}, blue",${(.5 + i / 1000).toFixed(4)}`).join('\n'));
  add('data/signals.tsv', 'identifier\tnote\n00123\t"a\tb"\n');
  add('data/broken.csv', 'one,two\n"unterminated');

  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Observatory field report</w:t></w:r></w:p><w:p><w:r><w:t>A synthetic DOCX document with a heading, readable paragraphs, and an embedded illustration.</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="1" name="Orbit"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:t>Files are read locally and remain unchanged.</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>');
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/orbit.png"/></Relationships>');
  zip.file('word/media/orbit.png', png);
  add('office/report.docx', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  add('office/broken.docx', 'not a DOCX');
  add('office/encrypted.docx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  fixtures.push({ path: 'office/oversized.docx', size: 13 * 1024 * 1024 });

  const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([['Identifier', 'Reading', 'Computed'], ['00123', 0.84, 1.68], ['00124', 0.61, 1.22]]);
  sheet.C2 = { t: 'n', f: 'B2*2', v: 1.68 };
  XLSX.utils.book_append_sheet(book, sheet, 'Signals');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Notes'], ['Second sheet confirmed'], ['<script>plain cell text</script>']]), 'Notes');
  for (const format of ['xlsx', 'xls', 'ods']) add(`office/signals.${format}`, XLSX.write(book, { type: 'buffer', bookType: format }));
  const dense = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(dense, XLSX.utils.aoa_to_sheet(Array.from({ length: 10000 }, (_, i) => [i, `Observation ${i}`, i / 1000, `signal-${i % 99}`, 'synthetic', i * 7])), 'Large');
  add('office/dense.xlsx', XLSX.write(dense, { type: 'buffer', bookType: 'xlsx', compression: true }));
  add('office/unknown.pptx', 'unsupported presentation');
  add('media/report.pdf', syntheticPDF(), 'application/pdf');
  add('media/broken.pdf', 'not a pdf', 'application/pdf');
  add('media/tone.wav', syntheticWAV(), 'audio/wav');
  return fixtures;
}

function syntheticPDF() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>', '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>', '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [index, title] of [[3, 'Kepler field report'], [5, 'Second page - observation notes']]) {
    const stream = `BT /F1 24 Tf 50 710 Td (${title}) Tj /F1 12 Tf 0 -40 Td (Synthetic local PDF preview. No personal data.) Tj ET`;
    objects[index] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

function syntheticWAV() {
  const frames = 8000, buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 2000), 44 + i * 2);
  return buffer;
}

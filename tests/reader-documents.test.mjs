import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { inspectZIP, validateZIP } from '../public/readers/zip.js';
import { ZIP_LIMITS } from '../public/readers/limits.js';
import { parseDocument, validImage } from '../public/readers/documents.worker.js';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwRkAAAAASUVORK5CYII=', 'base64'));
const xml = body => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;
async function docx(body, images = false) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>');
  zip.file('word/document.xml', xml(body));
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>');
  if (images) {
    zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>');
    zip.file('word/media/image.png', png);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
function workbook(format, rows = [['id', 'value'], ['00123', 12.5]]) {
  const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet.C2 = { t: 'n', f: 'B2*2', v: 25 }; sheet.D2 = { t: 'n', f: 'B2*3' }; sheet['!ref'] = `A1:D${Math.max(2, rows.length)}`;
  XLSX.utils.book_append_sheet(book, sheet, 'First');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Second sheet'], ['<b>plain text</b>']]), 'Second');
  return XLSX.write(book, { type: 'array', bookType: format });
}

test('DOCX semantic preview includes headings and text without invoking a browser or network', async () => {
  const bytes = await docx('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Observatory</w:t></w:r></w:p><w:p><w:r><w:t>Readable &amp; local</w:t></w:r></w:p>');
  const result = await parseDocument({ bytes, format: 'docx' });
  assert.equal(result.type, 'document');
  assert.match(result.html, /<h1>Observatory<\/h1>/);
  assert.match(result.html, /Readable &amp; local/);
  assert.deepEqual(result.images, []);
});

test('DOCX raster images remain parser-owned bytes with inert placeholders', async () => {
  const image = '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="1" name="sample"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const result = await parseDocument({ bytes: await docx(image, true), format: 'docx' });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mime, 'image/png');
  assert.deepEqual(result.images[0].bytes, png);
  assert.match(result.html, /space-drift-image:0/);
  assert.equal(validImage(new TextEncoder().encode('<svg onload="bad"/>'), 'image/svg+xml'), false);
  assert.equal(validImage(new TextEncoder().encode('not a png'), 'image/png'), false);
  const huge = png.slice(); new DataView(huge.buffer).setUint32(16, 100000);
  assert.equal(validImage(huge, 'image/png'), false, 'compressed raster dimensions also have a bound');
});

test('DOCX bounds generated HTML complexity before it reaches the DOM sanitizer', async () => {
  const manyParagraphs = Array.from({ length: 6001 }, (_, index) => `<w:p><w:r><w:t>Observation ${index}</w:t></w:r></w:p>`).join('');
  await assert.rejects(parseDocument({ bytes: await docx(manyParagraphs), format: 'docx' }), /too large or complex/);
  const longText = Array.from({ length: 26000 }, (_, index) => `Observation ${index}: synthetic field notes for this bounded preview. `).join('');
  await assert.rejects(parseDocument({ bytes: await docx(`<w:p><w:r><w:t>${longText}</w:t></w:r></w:p>`), format: 'docx' }), /too large or complex/);
});

test('XLSX, XLS and ODS expose sheet values while formulas are never evaluated', async () => {
  for (const format of ['xlsx', 'xls', 'ods']) {
    const bytes = workbook(format), result = await parseDocument({ bytes, format });
    assert.deepEqual(result.sheets, ['First', 'Second']);
    assert.equal(result.rows[1][0], '00123');
    assert.equal(result.rows[1][1], '12.5');
    if (format !== 'xls') {
      assert.equal(result.rows[1][2].formula, 'B2*2');
      assert.equal(result.rows[1][2].text, '25');
    }
    const second = await parseDocument({ bytes, format, sheet: 1 });
    assert.equal(second.selected, 1);
    assert.equal(second.rows[1][0], '<b>plain text</b>');
  }
  const xlsx = await parseDocument({ bytes: workbook('xlsx'), format: 'xlsx' });
  assert.match(xlsx.rows[1][3].text, /saved result unavailable/);
});

test('Workbook rows are bounded and truncation is disclosed', async () => {
  const rows = Array.from({ length: 1005 }, (_, i) => [`item-${i}`, i]);
  const result = await parseDocument({ bytes: workbook('xlsx', rows), format: 'xlsx' });
  assert.equal(result.rows.length, 1000);
  assert.match(result.warning, /limited/);
});

test('ZIP checks declared bounds, encryption, malformed records and actual inflated length', async () => {
  const archive = await docx('<w:p><w:r><w:t>Test</w:t></w:r></w:p>');
  assert.ok((await validateZIP(archive)).includes('word/document.xml'));
  assert.throws(() => inspectZIP(archive, { ...ZIP_LIMITS, entries: 1 }), /entries/);
  assert.throws(() => inspectZIP(archive, { ...ZIP_LIMITS, expanded: 10 }), /expanded/);
  assert.throws(() => inspectZIP(archive.subarray(0, archive.length - 1)), /directory/);
  const encrypted = archive.slice(), view = new DataView(encrypted.buffer);
  const end = encrypted.length - 22, central = view.getUint32(end + 16, true);
  view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true);
  assert.throws(() => inspectZIP(encrypted), /encrypted/);
  const zip = new JSZip(); zip.file('payload.xml', 'A'.repeat(4096));
  const bomb = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  assert.throws(() => inspectZIP(bomb, { ...ZIP_LIMITS, ratio: 2 }), /ratio/);
  const mismatch = bomb.slice(), mismatchView = new DataView(mismatch.buffer);
  const mismatchCentral = mismatchView.getUint32(mismatch.length - 22 + 16, true);
  mismatchView.setUint32(mismatchCentral + 24, 1, true);
  await assert.rejects(validateZIP(mismatch), /[Ee]xpanded|[Ii]nvalid/);
});

test('Wrong, unsupported and encrypted document inputs fail explicitly', async () => {
  await assert.rejects(parseDocument({ bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), format: 'docx' }), /Encrypted or invalid/);
  await assert.rejects(parseDocument({ bytes: await docx('<w:p/>'), format: 'xlsx' }), /not an XLSX/);
  await assert.rejects(parseDocument({ bytes: new Uint8Array([1, 2, 3]), format: 'xls' }), /not an XLS/);
  await assert.rejects(parseDocument({ bytes: new Uint8Array([1]), format: 'pptx' }), /not supported/);
});

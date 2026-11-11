/**
 * EXIF capture-date reader tests for photo-desk/js/exif.js.
 *
 * Builds minimal JPEG and PNG files with hand-written EXIF blocks, so the
 * parser is checked without needing a camera. Run with:
 *   node testing/exif.test.js
 */
'use strict';

const assert = require('node:assert');
const { read, parseExifDate } = require('../photo-desk/js/exif.js');

/** Build a TIFF/EXIF block containing DateTimeOriginal (and optionally DateTime). */
function buildTiff(options) {
  const littleEndian = options.littleEndian !== false;
  const dateTime = options.dateTime || null;
  const dateTimeOriginal = options.dateTimeOriginal || null;

  const entries = [];
  let ifd0EntryCount = 0;

  // IFD0: optional DateTime + ExifIFD pointer.
  if (dateTime) ifd0EntryCount += 1;
  if (dateTimeOriginal) ifd0EntryCount += 1;

  const ifd0Offset = 8;
  const ifd0Size = 2 + ifd0EntryCount * 12 + 4;
  const exifIfdOffset = ifd0Offset + ifd0Size;
  const exifIfdSize = dateTimeOriginal ? 2 + 1 * 12 + 4 : 0;

  // ASCII values live after the IFDs.
  const dataOffset = exifIfdOffset + exifIfdSize;
  const chunks = [];
  let cursor = dataOffset;

  const pushString = (text) => {
    const bytes = Buffer.from(`${text}\0`, 'ascii');
    const offset = cursor;
    chunks.push(bytes);
    cursor += bytes.length;
    return { offset, length: bytes.length };
  };

  const dateTimeValue = dateTime ? pushString(dateTime) : null;
  const dateTimeOriginalValue = dateTimeOriginal ? pushString(dateTimeOriginal) : null;

  const totalSize = cursor;
  const buffer = Buffer.alloc(totalSize);

  if (littleEndian) {
    buffer.write('II', 0, 'ascii');
    buffer.writeUInt16LE(0x002a, 2);
    buffer.writeUInt32LE(ifd0Offset, 4);
  } else {
    buffer.write('MM', 0, 'ascii');
    buffer.writeUInt16BE(0x002a, 2);
    buffer.writeUInt32BE(ifd0Offset, 4);
  }

  const write16 = (value, offset) => littleEndian ? buffer.writeUInt16LE(value, offset) : buffer.writeUInt16BE(value, offset);
  const write32 = (value, offset) => littleEndian ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);

  let entryOffset = ifd0Offset + 2;
  write16(ifd0EntryCount, ifd0Offset);

  const writeAsciiEntry = (tag, value) => {
    write16(tag, entryOffset);
    write16(2, entryOffset + 2);
    write32(value.length, entryOffset + 4);
    write32(value.offset, entryOffset + 8);
    entryOffset += 12;
  };

  if (dateTime) writeAsciiEntry(0x0132, dateTimeValue);

  if (dateTimeOriginal) {
    write16(0x8769, entryOffset);
    write16(4, entryOffset + 2);
    write32(1, entryOffset + 4);
    write32(exifIfdOffset, entryOffset + 8);
    entryOffset += 12;
  }

  write32(0, ifd0Offset + 2 + ifd0EntryCount * 12);

  if (dateTimeOriginal) {
    write16(1, exifIfdOffset);
    write16(0x9003, exifIfdOffset + 2);
    write16(2, exifIfdOffset + 4);
    write32(dateTimeOriginalValue.length, exifIfdOffset + 6);
    write32(dateTimeOriginalValue.offset, exifIfdOffset + 10);
    write32(0, exifIfdOffset + 14);
  }

  const dataChunk = Buffer.concat(chunks);
  dataChunk.copy(buffer, dataOffset);

  return buffer;
}

/** Wrap a TIFF block in a JPEG APP1 segment. */
function buildJpeg(tiff) {
  const exifHeader = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const length = exifHeader.length + 2;

  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(length, 2);

  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    exifHeader,
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** Wrap a TIFF block in a PNG eXIf chunk. */
function buildPng(tiff) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const chunk = Buffer.alloc(4 + 4 + tiff.length + 4);
  chunk.writeUInt32BE(tiff.length, 0);
  chunk.write('eXIf', 4, 'ascii');
  tiff.copy(chunk, 8);

  return Buffer.concat([signature, chunk]);
}

function run() {
  // Date parsing.
  assert.strictEqual(parseExifDate('2026:11:07 14:32:10'), '2026-11-07T14:32:10');
  assert.strictEqual(parseExifDate('2026-11-07 14:32:10'), '2026-11-07T14:32:10');
  assert.strictEqual(parseExifDate('0000:00:00 00:00:00'), null, 'invalid dates are rejected');
  assert.strictEqual(parseExifDate('2026:13:07 14:32:10'), null, 'bad month rejected');
  assert.strictEqual(parseExifDate('not a date'), null);

  // JPEG, little endian, DateTimeOriginal present.
  const little = read(buildJpeg(buildTiff({ dateTimeOriginal: '2026:11:07 14:32:10' })));
  assert.deepStrictEqual(little, { takenAt: '2026-11-07T14:32:10', raw: '2026:11:07 14:32:10', tag: 'DateTimeOriginal' });

  // JPEG, big endian.
  const big = read(buildJpeg(buildTiff({ dateTimeOriginal: '2025:03:01 09:05:00', littleEndian: false })));
  assert.strictEqual(big.takenAt, '2025-03-01T09:05:00');

  // Falls back to IFD0 DateTime when the Exif sub-IFD is absent.
  const fallback = read(buildJpeg(buildTiff({ dateTime: '2024:12:24 18:00:00' })));
  assert.strictEqual(fallback.takenAt, '2024-12-24T18:00:00');
  assert.strictEqual(fallback.tag, 'DateTime');

  // DateTimeOriginal wins over DateTime.
  const preferred = read(buildJpeg(buildTiff({ dateTime: '2024:01:01 00:00:00', dateTimeOriginal: '2026:11:07 14:32:10' })));
  assert.strictEqual(preferred.takenAt, '2026-11-07T14:32:10');

  // PNG eXIf chunk.
  const png = read(buildPng(buildTiff({ dateTimeOriginal: '2026:11:08 08:00:00' })));
  assert.strictEqual(png.takenAt, '2026-11-08T08:00:00');

  // No EXIF at all.
  assert.strictEqual(read(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.strictEqual(read(new Uint8Array(0)), null);
  assert.strictEqual(read(null), null);

  // Truncated EXIF must not throw.
  const truncated = buildJpeg(buildTiff({ dateTimeOriginal: '2026:11:07 14:32:10' })).slice(0, 40);
  assert.doesNotThrow(() => read(truncated));

  console.log('EXIF capture-date tests passed (11 checks).');
}

try {
  run();
} catch (error) {
  console.error('EXIF capture-date tests FAILED:', error.message);
  process.exitCode = 1;
}

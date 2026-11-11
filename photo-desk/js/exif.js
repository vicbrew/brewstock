/**
 * Minimal EXIF reader for capture dates.
 *
 * Reads DateTimeOriginal (0x9003), falling back to DateTimeDigitized (0x9004)
 * and then DateTime (0x0132). Supports JPEG (APP1 "Exif") and PNG (eXIf) —
 * the formats a camera or phone is likely to produce. Other formats return null.
 *
 * EXIF timestamps carry no time zone, so the value is returned as a naive local
 * ISO string ("2026-11-07T14:32:10"). That sorts correctly as plain text.
 *
 * Loaded as a classic script in the photo desk (window.BrewstockExif) and via
 * require() by testing/exif.test.js.
 */
(function (root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BrewstockExif = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TAG_DATE_TIME = 0x0132;
  const TAG_EXIF_IFD = 0x8769;
  const TAG_DATE_TIME_ORIGINAL = 0x9003;
  const TAG_DATE_TIME_DIGITIZED = 0x9004;
  const ASCII_TYPE = 2;

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
  }

  function parseExifDate(text) {
    if (typeof text !== 'string') return null;

    const match = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hours = Number(match[4]);
    const minutes = Number(match[5]);
    const seconds = Number(match[6]);

    if (year < 1900 || year > 2200) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hours > 23 || minutes > 59 || seconds > 59) return null;

    const pad = (value) => String(value).padStart(2, '0');
    return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  function readIfdEntries(view, littleEndian, ifdOffset) {
    if (ifdOffset <= 0 || ifdOffset + 2 > view.byteLength) return null;

    const count = view.getUint16(ifdOffset, littleEndian);
    if (count === 0 || ifdOffset + 2 + count * 12 > view.byteLength) return null;

    const entries = new Map();

    for (let index = 0; index < count; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      const tag = view.getUint16(entryOffset, littleEndian);
      const type = view.getUint16(entryOffset + 2, littleEndian);
      const valueCount = view.getUint32(entryOffset + 4, littleEndian);
      const valueOffset = view.getUint32(entryOffset + 8, littleEndian);
      entries.set(tag, { type, count: valueCount, valueOffset, entryOffset });
    }

    return entries;
  }

  function asciiFromEntry(view, entry) {
    if (!entry || entry.type !== ASCII_TYPE || entry.count === 0) return null;

    // Values of four bytes or fewer are stored inline in the entry itself.
    const start = entry.count <= 4 ? entry.entryOffset + 8 : entry.valueOffset;
    if (start < 0 || start + entry.count > view.byteLength) return null;

    let text = '';

    for (let index = 0; index < entry.count; index += 1) {
      const code = view.getUint8(start + index);
      if (code === 0) break;
      text += String.fromCharCode(code);
    }

    return text.trim() || null;
  }

  function readTiff(bytes, tiffStart, tiffLength) {
    if (tiffStart < 0 || tiffLength < 8 || tiffStart + tiffLength > bytes.length) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset + tiffStart, tiffLength);

    let littleEndian;
    if (view.getUint16(0) === 0x4949) littleEndian = true;
    else if (view.getUint16(0) === 0x4d4d) littleEndian = false;
    else return null;

    if (view.getUint16(2, littleEndian) !== 0x002a) return null;

    const ifd0Offset = view.getUint32(4, littleEndian);
    const ifd0 = readIfdEntries(view, littleEndian, ifd0Offset);
    if (!ifd0) return null;

    const dateTime = asciiFromEntry(view, ifd0.get(TAG_DATE_TIME));

    let dateTimeOriginal = null;
    let dateTimeDigitized = null;

    const exifEntry = ifd0.get(TAG_EXIF_IFD);
    if (exifEntry && exifEntry.type === 4) {
      const exifIfd = readIfdEntries(view, littleEndian, exifEntry.valueOffset);
      if (exifIfd) {
        dateTimeOriginal = asciiFromEntry(view, exifIfd.get(TAG_DATE_TIME_ORIGINAL));
        dateTimeDigitized = asciiFromEntry(view, exifIfd.get(TAG_DATE_TIME_DIGITIZED));
      }
    }

    const candidates = [
      { raw: dateTimeOriginal, tag: 'DateTimeOriginal' },
      { raw: dateTimeDigitized, tag: 'DateTimeDigitized' },
      { raw: dateTime, tag: 'DateTime' },
    ];

    for (const candidate of candidates) {
      const takenAt = parseExifDate(candidate.raw);
      if (takenAt) return { takenAt, raw: candidate.raw, tag: candidate.tag };
    }

    return null;
  }

  function findJpegTiff(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

    let offset = 2;

    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = bytes[offset + 1];

      if (marker === 0xff) {
        offset += 1;
        continue;
      }

      // Standalone markers carry no length.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }

      // Start of scan: image data follows, no more metadata segments.
      if (marker === 0xda || marker === 0xd9) break;

      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2) break;

      if (marker === 0xe1) {
        const payload = offset + 4;
        const isExif = bytes[payload] === 0x45
          && bytes[payload + 1] === 0x78
          && bytes[payload + 2] === 0x69
          && bytes[payload + 3] === 0x66
          && bytes[payload + 4] === 0x00
          && bytes[payload + 5] === 0x00;

        if (isExif) {
          return { start: payload + 6, length: length - 2 - 6 };
        }
      }

      offset += 2 + length;
    }

    return null;
  }

  function findPngExif(bytes) {
    if (bytes.length < 16) return null;

    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let index = 0; index < signature.length; index += 1) {
      if (bytes[index] !== signature[index]) return null;
    }

    let offset = 8;

    while (offset + 8 <= bytes.length) {
      const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);

      if (type === 'eXIf') {
        return { start: offset + 8, length };
      }

      if (type === 'IEND') break;

      offset += 12 + length;
    }

    return null;
  }

  /**
   * @param {ArrayBuffer|Uint8Array} input first bytes of an image file
   * @returns {{takenAt: string, raw: string, tag: string}|null}
   */
  function read(input) {
    const bytes = toBytes(input);
    if (!bytes || bytes.length < 24) return null;

    const tiff = findJpegTiff(bytes) || findPngExif(bytes);
    if (!tiff) return null;

    try {
      return readTiff(bytes, tiff.start, tiff.length);
    } catch (_error) {
      // Truncated or unusual metadata: treat as "no date" rather than failing.
      return null;
    }
  }

  return { read, parseExifDate };
});

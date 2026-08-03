/**
 * Minimal ZIP write/read for WikiFlip backups (no external binaries).
 * Supports stored and deflated entries; skips zip-slip paths.
 */

import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * @param {Map<string, Buffer|Uint8Array|string> | Record<string, Buffer|Uint8Array|string>} files
 * @returns {Buffer}
 */
export function createZip(files) {
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [rawName, rawData] of entries) {
    const name = normalizeZipPath(rawName);
    if (!name) continue;
    const data = Buffer.isBuffer(rawData)
      ? rawData
      : typeof rawData === 'string'
        ? Buffer.from(rawData, 'utf8')
        : Buffer.from(rawData);

    const nameBuf = Buffer.from(name, 'utf8');
    const checksum = crc32(data);
    let method = METHOD_DEFLATE;
    let payload = deflateRawSync(data, { level: 6 });
    if (payload.length >= data.length) {
      method = METHOD_STORE;
      payload = data;
    }

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(checksum >>> 0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum >>> 0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDir, end]);
}

/**
 * @param {Buffer|Uint8Array} buffer
 * @returns {Map<string, Buffer>} path → file bytes (directories omitted)
 */
export function extractZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const eocd = findEndOfCentralDirectory(buf);
  if (!eocd) throw new Error('Not a valid ZIP archive (missing end of central directory).');

  const count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (cdOffset + 46 > buf.length || buf.readUInt32LE(cdOffset) !== SIG_CENTRAL) {
      throw new Error('Corrupt ZIP central directory.');
    }
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const uncompSize = buf.readUInt32LE(cdOffset + 24);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8');
    const safeName = normalizeZipPath(name);

    cdOffset += 46 + nameLen + extraLen + commentLen;

    if (!safeName || safeName.endsWith('/')) continue;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`Corrupt ZIP local header for ${safeName}.`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === METHOD_STORE) {
      data = Buffer.from(compressed);
    } else if (method === METHOD_DEFLATE) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${safeName}.`);
    }

    if (uncompSize && data.length !== uncompSize) {
      // Some writers leave size 0 in local headers; trust inflated length.
    }
    out.set(safeName, data);
  }

  return out;
}

/** Reject absolute paths, drive letters, and .. traversal. */
export function normalizeZipPath(name) {
  let n = String(name ?? '').replace(/\\/g, '/');
  // Drop zip absolute / leading drive noise
  n = n.replace(/^\/+/, '').replace(/^[a-zA-Z]:\//, '');
  if (!n || n.includes('\0')) return '';
  const parts = [];
  for (const part of n.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return ''; // zip-slip
    parts.push(part);
  }
  // Skip AppleDouble / Finder noise
  if (parts[0] === '__MACOSX' || parts.some((p) => p === '.DS_Store')) return '';
  return parts.join('/');
}

function findEndOfCentralDirectory(buf) {
  // EOCD is at least 22 bytes; comment can add up to 64k.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_END) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) return i;
      // tolerate trailing junk only if comment length fits remaining
      if (i + 22 + commentLen <= buf.length) return i;
    }
  }
  return -1;
}

// Downloads chosen files out of a large remote .zip without downloading the whole archive: reads its
// central directory, then fetches each wanted entry's bytes with HTTP range requests and inflates
// them (Node's own zlib). USGS's statewide packages are 0.2–1 GB, mostly attribute tables the map
// doesn't need; this takes only the geometry.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function range(url, start, end) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (response.status !== 206 && response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      // A server that ignores the range sends the whole file: keep the asked-for slice.
      return response.status === 200 ? bytes.subarray(start, end + 1) : bytes;
    } catch (error) {
      if (attempt === 3) throw new Error(`${url} bytes ${start}-${end}: ${error.message}`);
      await sleep(5000 * (attempt + 1));
    }
  }
}

/** The archive's entries: name, compression method, sizes, and where each one's local header sits. */
export async function listRemoteZip(url) {
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new Error(`${url}: HTTP ${head.status}`);
  const size = Number(head.headers.get('content-length'));
  const tailLength = Math.min(size, 1 << 20);
  const tail = await range(url, size - tailLength, size - 1);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === END_OF_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`${url} is not a zip archive`);
  let count = tail.readUInt16LE(end + 10);
  let dirSize = tail.readUInt32LE(end + 12);
  let dirOffset = tail.readUInt32LE(end + 16);
  if ((dirOffset === 0xffffffff || count === 0xffff) && end >= 20 && tail.readUInt32LE(end - 20) === ZIP64_LOCATOR) {
    const recordOffset = Number(tail.readBigUInt64LE(end - 20 + 8));
    const record = await range(url, recordOffset, recordOffset + 55);
    count = Number(record.readBigUInt64LE(32));
    dirSize = Number(record.readBigUInt64LE(40));
    dirOffset = Number(record.readBigUInt64LE(48));
  }
  const dir = await range(url, dirOffset, dirOffset + dirSize - 1);
  const entries = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    if (dir.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error(`${url}: bad directory entry`);
    const method = dir.readUInt16LE(at + 10);
    let compressedSize = dir.readUInt32LE(at + 20);
    let size = dir.readUInt32LE(at + 24);
    const nameLength = dir.readUInt16LE(at + 28);
    const extraLength = dir.readUInt16LE(at + 30);
    const commentLength = dir.readUInt16LE(at + 32);
    let localOffset = dir.readUInt32LE(at + 42);
    const name = dir.toString('utf8', at + 46, at + 46 + nameLength);
    // Past 4 GB, the sizes and offset are in the zip64 extra field, in this order, when maxed out.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = dir.readUInt16LE(extra);
      const length = dir.readUInt16LE(extra + 2);
      if (id === 1) {
        let p = extra + 4;
        if (size === 0xffffffff) { size = Number(dir.readBigUInt64LE(p)); p += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(dir.readBigUInt64LE(p)); p += 8; }
        if (localOffset === 0xffffffff) localOffset = Number(dir.readBigUInt64LE(p));
      }
      extra += 4 + length;
    }
    entries.push({ name, method, compressedSize, size, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Saves the archive's entries whose names pass `wanted` into `outDir` (flattened to their base names),
 * keeping files already there. Returns the saved files' paths.
 */
export async function fetchZipEntries(url, wanted, outDir, log = console.log) {
  mkdirSync(outDir, { recursive: true });
  const saved = [];
  for (const entry of (await listRemoteZip(url)).filter((e) => wanted(e.name))) {
    const path = join(outDir, entry.name.split('/').pop());
    saved.push(path);
    if (existsSync(path)) continue;
    // The local header's own name and extra lengths can differ from the directory's: read it first.
    const header = await range(url, entry.localOffset, entry.localOffset + 29);
    if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new Error(`${url}: bad local header for ${entry.name}`);
    const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = entry.compressedSize ? await range(url, start, start + entry.compressedSize - 1) : Buffer.alloc(0);
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = inflateRawSync(raw);
    else throw new Error(`${entry.name} uses unsupported compression ${entry.method}`);
    writeFileSync(`${path}.partial`, data);
    renameSync(`${path}.partial`, path);
    log(`  ${entry.name} (${(data.length / 1e6).toFixed(0)} MB)`);
  }
  return saved;
}

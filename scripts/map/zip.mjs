// Reads files out of a .zip archive (the government datasets come zipped), with Node's own zlib.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** The archive's files: name → a function returning the file's bytes. */
export function readZip(path) {
  const data = readFileSync(path);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i -= 1) {
    if (data.readUInt32LE(i) === END_OF_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`${path} is not a zip archive`);
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    if (data.readUInt32LE(offset) !== DIRECTORY_ENTRY) throw new Error(`${path}: bad directory entry`);
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    files.set(name, () => {
      if (data.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new Error(`${path}: bad header for ${name}`);
      const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
      const raw = data.subarray(start, start + compressedSize);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`${path}: ${name} uses unsupported compression ${method}`);
    });
  }
  return files;
}

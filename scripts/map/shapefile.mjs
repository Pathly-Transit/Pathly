// Reads ESRI shapefiles (the format the Census Bureau publishes TIGER/Line in): shapes from .shp,
// attributes from .dbf. Coordinates are longitude/latitude (NAD83, within a meter of WGS84 here).
import { readZip } from './zip.mjs';

const NULL = 0;
const POINT = 1;
const POLYLINE = 3;
const POLYGON = 5;
const MULTIPOINT = 8;

/** The attribute table: one plain object per record, values as trimmed strings (numbers as numbers). */
function readDbf(buffer) {
  const count = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  for (let offset = 32; offset < headerLength - 1 && buffer[offset] !== 0x0d; offset += 32) {
    const nameEnd = buffer.indexOf(0, offset);
    fields.push({
      name: buffer.toString('latin1', offset, Math.min(nameEnd < 0 ? offset + 11 : nameEnd, offset + 11)),
      type: String.fromCharCode(buffer[offset + 11]),
      length: buffer[offset + 16],
    });
  }
  const decoder = new TextDecoder('utf-8');
  const records = new Array(count);
  for (let r = 0; r < count; r += 1) {
    let offset = headerLength + r * recordLength + 1; // past the deletion flag
    const record = {};
    for (const field of fields) {
      const text = decoder.decode(buffer.subarray(offset, offset + field.length)).trim();
      record[field.name] = field.type === 'N' || field.type === 'F' ? (text === '' ? null : Number(text)) : text;
      offset += field.length;
    }
    records[r] = record;
  }
  return records;
}

/** Each shape as { type: 'point' | 'line' | 'polygon', parts: flat [x, y, ...] arrays } or null. */
function readShp(buffer) {
  const shapes = [];
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const contentLength = buffer.readInt32BE(offset + 4) * 2;
    const start = offset + 8;
    offset = start + contentLength;
    // Z and M variants (11–28) carry the same x/y layout first; 31 (multipatch) isn't used here.
    const rawType = buffer.readInt32LE(start);
    const baseType = rawType === 31 ? -1 : rawType % 10;
    if (baseType === NULL) {
      shapes.push(null);
    } else if (baseType === POINT) {
      shapes.push({ type: 'point', parts: [[buffer.readDoubleLE(start + 4), buffer.readDoubleLE(start + 12)]] });
    } else if (baseType === MULTIPOINT) {
      const n = buffer.readInt32LE(start + 36);
      const parts = [];
      for (let i = 0; i < n; i += 1) parts.push([buffer.readDoubleLE(start + 40 + 16 * i), buffer.readDoubleLE(start + 48 + 16 * i)]);
      shapes.push({ type: 'point', parts });
    } else if (baseType === POLYLINE || baseType === POLYGON) {
      const partCount = buffer.readInt32LE(start + 36);
      const pointCount = buffer.readInt32LE(start + 40);
      const pointsAt = start + 44 + 4 * partCount;
      const parts = [];
      for (let p = 0; p < partCount; p += 1) {
        const from = buffer.readInt32LE(start + 44 + 4 * p);
        const to = p + 1 < partCount ? buffer.readInt32LE(start + 48 + 4 * p) : pointCount;
        const part = new Array((to - from) * 2);
        for (let i = from, j = 0; i < to; i += 1, j += 2) {
          part[j] = buffer.readDoubleLE(pointsAt + 16 * i);
          part[j + 1] = buffer.readDoubleLE(pointsAt + 16 * i + 8);
        }
        parts.push(part);
      }
      shapes.push({ type: baseType === POLYGON ? 'polygon' : 'line', parts });
    } else {
      shapes.push(null);
    }
  }
  return shapes;
}

/** Every record in the shapefile inside a zip: { shape, props }. */
export function readShapefileZip(path) {
  const files = readZip(path);
  const find = (extension) => [...files.keys()].find((name) => name.toLowerCase().endsWith(extension));
  const shp = find('.shp');
  const dbf = find('.dbf');
  if (!shp || !dbf) throw new Error(`${path} has no shapefile`);
  const shapes = readShp(files.get(shp)());
  const records = readDbf(files.get(dbf)());
  return shapes.map((shape, i) => ({ shape, props: records[i] ?? {} }));
}

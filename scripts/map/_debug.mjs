import { readShapefileZip } from './shapefile.mjs';
import { shapePolygons } from './sources.mjs';
import { dissolve } from './dissolve.mjs';
import { ringAreaMeters, ringBounds } from './geometry.mjs';
const G = process.argv[2];
const water = [];
for (const f of ['36119', '36005', '09190', '09120', '36079', '36087', '36071', '36027', '36061', '36081', '36059', '09170', '34003', '34017', '34013', '09110', '09140', '09160'])
  for (const { shape } of readShapefileZip(`${G}/county/tl_2025_${f}_areawater.zip`)) if (shape) water.push(...shapePolygons(shape.parts));
const states = readShapefileZip(`${G}/tiger/tl_2025_us_state.zip`).filter(({ props }) => ['36', '09', '34'].includes(props.STATEFP)).flatMap(({ shape }) => shapePolygons(shape.parts));
const land = dissolve(states, water);
console.log('polygons', land.polygons.length, 'open', land.open);
for (const polygon of land.polygons) {
  const outer = ringAreaMeters(polygon[0]);
  if (outer < 1e9) continue;
  const holes = polygon.slice(1).map((h) => ({ area: ringAreaMeters(h), box: ringBounds(h), n: h.length / 2 })).sort((a, b) => b.area - a.area).slice(0, 6);
  console.log('outer km2', (outer / 1e6).toFixed(0), 'holes', polygon.length - 1, holes.map((h) => `${(h.area / 1e6).toFixed(1)}km2 n=${h.n} [${h.box.west.toFixed(2)},${h.box.south.toFixed(2)},${h.box.east.toFixed(2)},${h.box.north.toFixed(2)}]`).join(' | '));
}

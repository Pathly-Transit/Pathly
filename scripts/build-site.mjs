// Puts pathly.web.app together in dist/site: the landing page and privacy policy (website/) at the
// root, the web app's export (mobile/dist, built with baseUrl /app) under /app, and the base map's
// tiles and label fonts (maptiles/, from `npm run map:build` and `npm run map:fonts`) under /map,
// where every Pathly map, web and native, loads them from.
// Run `npm run build:web` first, or use `npm run build:site`, which does both.
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'site');
const app = join(root, 'mobile', 'dist');

if (!existsSync(join(app, 'index.html'))) {
  console.error('mobile/dist has no web build. Run `npm run build:web` first.');
  process.exit(1);
}

const map = join(root, 'maptiles');
if (!existsSync(join(map, 'tiles', '0', '0', '0.pbf')) || !existsSync(join(map, 'fonts', 'Nunito-Regular', '0-255.pbf'))) {
  console.error('maptiles/ has no map. Build it first: `npm run map:download -- <data-dir>`, `npm run map:build -- <data-dir>`, and `npm run map:fonts` (see scripts/build-map.mjs).');
  process.exit(1);
}

// Only a map built from public data alone (scripts/build-map.mjs marks it) ships: no OpenStreetMap
// or other source that would need a credit on the map.
let metadata = null;
try {
  metadata = JSON.parse(readFileSync(join(map, 'metadata.json'), 'utf8'));
} catch {
  // Missing or unreadable: treated as not public-only.
}
if (metadata?.publicDataOnly !== true) {
  console.error('maptiles/ wasn\'t built from public data alone (its metadata.json has no `publicDataOnly`): it may hold OpenStreetMap data. Rebuild it with `npm run map:build -- <data-dir>`.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'website'), out, { recursive: true });
cpSync(app, join(out, 'app'), { recursive: true });
cpSync(join(map, 'tiles'), join(out, 'map', 'tiles'), { recursive: true });
cpSync(join(map, 'fonts'), join(out, 'map', 'fonts'), { recursive: true });
console.log('Site ready in dist/site (landing at /, app at /app, privacy at /privacy, map at /map).');

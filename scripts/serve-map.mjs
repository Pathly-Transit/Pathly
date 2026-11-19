#!/usr/bin/env node
// Serves the base map built in maptiles/ (tiles and label fonts) from this computer, for
// development before it's published with the site (pathly.web.app/map) or to try a fresh build.
// `npm run dev` starts it on its own whenever maptiles/ has a map. Alone (for `expo run:android`,
// say): `npm run map:serve`, then start Expo with the two EXPO_PUBLIC_ settings it prints.
//
// It listens on the local network, not just this computer, so the web app, emulators, and phones
// on the same Wi-Fi all reach it.
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_DIR = join(root, 'maptiles');

/** Whether maptiles/ has a built map (tiles and fonts). */
export function hasLocalMap() {
  return existsSync(join(MAP_DIR, 'tiles', '0', '0', '0.pbf')) && existsSync(join(MAP_DIR, 'fonts', 'Nunito-Regular', '0-255.pbf'));
}

/** This computer's address on the local network, or localhost when it has none. */
function networkAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return 'localhost';
}

/** Starts the server; resolves with it and the tile and font URLs the app should use. */
export function startMapServer(port = Number(process.env.MAP_PORT) || 8090) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
      const file = normalize(join(MAP_DIR, path));
      if (!file.startsWith(MAP_DIR + sep) || !file.endsWith('.pbf') || !existsSync(file)) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'application/x-protobuf');
      response.setHeader('Cache-Control', 'no-cache');
      createReadStream(file).pipe(response);
    });
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const base = `http://${networkAddress()}:${port}`;
      resolve({ server, base, tilesUrl: `${base}/tiles/{z}/{x}/{y}.pbf`, glyphsUrl: `${base}/fonts/{fontstack}/{range}.pbf` });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!hasLocalMap()) {
    console.error('maptiles/ has no map yet. Build it: npm run map:download -- <data-dir>, npm run map:build -- <data-dir>, npm run map:fonts');
    process.exit(1);
  }
  const { base, tilesUrl, glyphsUrl } = await startMapServer();
  console.log(`Serving maptiles/ at ${base}. Start Expo with:\n  EXPO_PUBLIC_MAP_TILES_URL=${tilesUrl}\n  EXPO_PUBLIC_MAP_GLYPHS_URL=${glyphsUrl}`);
}

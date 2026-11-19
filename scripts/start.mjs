#!/usr/bin/env node
// Pre-flight for the Expo dev server: makes sure dependencies are installed and
// in sync with package-lock.json, removes files Expo generates when it is run
// from the repo root by mistake, serves the base map from maptiles/ when one is
// built there, then starts Expo from the mobile workspace.
//
// Usage: npm start [-- <expo start args>]   e.g. npm start -- --clear
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasLocalMap, startMapServer } from './serve-map.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = join(root, 'mobile');
const isWindows = process.platform === 'win32';

function run(cmd, args, cwd = root) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWindows });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function mtime(path) {
  return existsSync(path) ? statSync(path).mtimeMs : 0;
}

// 1. Expo writes a tsconfig.json when started from the repo root; it doesn't belong there.
const strayTsconfig = join(root, 'tsconfig.json');
if (existsSync(strayTsconfig)) {
  console.log('[start] Removing stray root tsconfig.json (created by running Expo outside mobile/)');
  rmSync(strayTsconfig);
}

// 2. Install when node_modules is missing or older than the lockfile / manifests.
const installMarker = join(root, 'node_modules', '.package-lock.json');
const manifests = ['package.json', 'package-lock.json', 'mobile/package.json', 'firebase/functions/package.json'];
const newestManifest = Math.max(...manifests.map((file) => mtime(join(root, file))));
const needsInstall =
  !existsSync(join(root, 'node_modules', 'expo')) || mtime(installMarker) < newestManifest;

if (needsInstall) {
  console.log('[start] Dependencies are missing or out of date, running npm install...');
  run('npm', ['install']);
} else {
  console.log('[start] Dependencies up to date.');
}

// 3. Warn (don't modify package.json) if Expo SDK package versions drift.
console.log('[start] Checking Expo SDK package versions...');
const check = spawnSync('npx', ['expo', 'install', '--check'], {
  cwd: mobile,
  stdio: 'inherit',
  shell: isWindows,
  env: { ...process.env, CI: '1' },
});
if (check.status !== 0) {
  console.warn('[start] Some packages don\'t match the Expo SDK. Fix with: cd mobile && npx expo install --fix');
}

// 4. The base map: published with the site (pathly.web.app/map). When maptiles/ has a
// map built, serve that instead (it may not be published yet, or be a newer build),
// unless EXPO_PUBLIC_MAP_TILES_URL already points the app somewhere.
const env = { ...process.env };
let mapServer = null;
if (!process.env.EXPO_PUBLIC_MAP_TILES_URL && hasLocalMap()) {
  try {
    const { server, base, tilesUrl, glyphsUrl } = await startMapServer();
    mapServer = server;
    env.EXPO_PUBLIC_MAP_TILES_URL = tilesUrl;
    env.EXPO_PUBLIC_MAP_GLYPHS_URL = glyphsUrl;
    console.log(`[start] Serving the base map from maptiles/ at ${base} (if maps stay blank after this address changes, restart with: npm start -- --clear)`);
  } catch (error) {
    console.warn(`[start] Couldn't serve maptiles/ (${error.message}); maps will load from pathly.web.app/map.`);
  }
} else if (!process.env.EXPO_PUBLIC_MAP_TILES_URL) {
  console.log('[start] No map built in maptiles/; maps load from pathly.web.app/map (see scripts/build-map.mjs).');
}

// 5. Start Expo from the mobile workspace so it uses mobile/index.ts as the entry.
// expo-dev-client is installed, which makes Expo default to development-build mode
// (its QR code can't be opened by Expo Go). Default to Expo Go unless asked otherwise.
// (Started alongside, not blocking, so the map server keeps answering.)
const args = process.argv.slice(2);
const wantsDevClient = args.includes('--dev-client');
const expo = spawn('npx', ['expo', 'start', ...(wantsDevClient ? [] : ['--go']), ...args], { cwd: mobile, stdio: 'inherit', shell: isWindows, env });
expo.on('exit', (code) => {
  mapServer?.close();
  process.exit(code ?? 0);
});

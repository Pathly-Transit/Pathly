import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// EAS CLI's archive copier uses this same gitignore-pattern matcher. An .easignore
// replaces .gitignore, so dropping even one existing exclusion can upload local inputs.
const ignore = createRequire(import.meta.url)('ignore');
const gitRules = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
const easRules = readFileSync(new URL('../.easignore', import.meta.url), 'utf8');
const archive = ignore().add(easRules);

test('EAS archive rules preserve the complete Git ignore baseline', () => {
  assert.ok(easRules.startsWith(gitRules), 'copy new .gitignore protections into .easignore before adding EAS-only exclusions');
});

test('native source archives exclude private release material, local audits and backend data', () => {
  for (const path of [
    'mobile/.env', 'mobile/.env.production', 'mobile/.env.testflight.local',
    'firebase/functions/.env.pathly-b7f0f', 'firebase/functions/.secret.local',
    'mobile/.credentials/private-input.txt', 'mobile/.credentials/nested/key-without-extension',
    'mobile/upload-key.p8', 'mobile/signing.p12', 'mobile/app.mobileprovision',
    'mobile/credentials.json', 'mobile/play-service-account.json', 'mobile/google-services.json',
    'mobile/GoogleService-Info.plist', 'firebase/functions/private.service-account.json',
    'firebase/functions/pathly-firebase-adminsdk-private.json',
    'docs/release-qa/2026-11-21/ios-android-audit/evidence/screenshot.png',
    'docs/release-qa/2026-11-12/assessment 2.md',
    '.agents/skills/local/SKILL.md', '.claude/settings.local.json', '.codex/session.json',
    'mobile/.scratch/archive.txt', 'scratch/receipt.json',
    'firebase/functions/static_data/lirr/stop_times.txt',
    'firebase/functions/static_data/subway/derived/routing.bin',
    'firebase/functions/static_data/walking/manifest.json',
    'firebase/functions/lib/index.js', 'node_modules/react/index.js',
    'mobile/.expo/settings.json', 'mobile/dist/index.html', 'maptiles/tiles/14/tile.pbf',
    'mobile/src/data/rideSnapshot 2.ts',
  ]) assert.equal(archive.ignores(path), true, `${path} must not be uploaded with the app source`);
});

test('native source archives retain Metro startup configuration and workspace install inputs', () => {
  for (const path of [
    'package.json', 'package-lock.json', '.nvmrc', '.easignore',
    'mobile/package.json', 'firebase/functions/package.json',
    'mobile/metro.config.js', 'mobile/app.config.js', 'mobile/eas.json', 'mobile/index.ts',
    'mobile/App.tsx', 'mobile/src/data/rideSnapshot.ts', 'mobile/src/background/tripAlerts.native.ts',
    'mobile/src/map/MapCanvas.native.tsx', 'mobile/assets/icon.png',
    'mobile/.env.example', 'scripts/adminEmails.cjs',
  ]) assert.equal(archive.ignores(path), false, `${path} is required or intentionally safe in the app source archive`);
});

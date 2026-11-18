#!/usr/bin/env node
// Presence-only release checks: never print credential or client-key values.
import { createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = resolve(root, 'mobile');
const require = createRequire(import.meta.url);
const firebaseKeys = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
];

function configured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function substitute(value, env) {
  return typeof value === 'string' && value.startsWith('$') ? env[value.slice(1)] : value;
}

export function checkIosRelease({ app, eas, env, store = false, readKey = readFileSync }) {
  const checks = [];
  const check = (ok, label) => checks.push({ status: ok ? 'PASS' : 'FAIL', label });
  const warn = (label) => checks.push({ status: 'WARN', label });
  check(app.ios?.bundleIdentifier === 'com.mpaxos.pathly', 'iOS bundle ID matches the registered com.mpaxos.pathly app');
  check(app.owner === 'pathlyapp' && app.extra?.eas?.projectId === 'deefeb3d-b292-44e7-8e70-64f8f7bf6a87', 'Expo project matches @pathlyapp/pathly');
  const build = eas.build?.production;
  check(build?.distribution === 'store' && build?.environment === 'production' && build?.autoIncrement === true && !build?.ios?.simulator, 'Production profile builds a versioned store artifact');
  for (const key of firebaseKeys) check(configured(env[key]), `${key} is configured locally`);
  check(configured(env.GOOGLE_MAPS_IOS_API_KEY), 'GOOGLE_MAPS_IOS_API_KEY is configured locally');
  check(configured(env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY) || configured(env.EXPO_PUBLIC_GOOGLE_MAPS_WEB_API_KEY), 'Places search key or supported fallback is configured locally');
  const admins = (env.ADMIN_EMAILS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  check(admins.length > 0 && !admins.every((value) => value.toLowerCase() === 'admin@gmail.com'), 'Canonical ADMIN_EMAILS is configured locally');
  if (!configured(env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID)) {
    warn('Native Google login is disabled locally; verify the intended iOS OAuth offering and production configuration');
  } else {
    warn('Native Google OAuth must match the iOS bundle ID and pass installed-device login/reauthentication testing');
  }
  const location = app.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-location');
  check(configured(location?.[1]?.locationWhenInUsePermission), 'Foreground location purpose string is configured');
  warn('Locked-screen navigation progression and get-off alerts require real-device verification; current tracking is foreground');
  if (app.ios?.supportsTablet) warn('iPad is supported: include iPad layout coverage before broad release');

  if (store) {
    const submit = eas.submit?.production?.ios ?? {};
    check(submit.appleTeamId === 'MRANRL5SNC', 'Submission targets the professor\'s Apple team');
    if (env.EXPO_APPLE_TEAM_ID) check(env.EXPO_APPLE_TEAM_ID === submit.appleTeamId, 'Build and submission Apple Team IDs agree');
    check(typeof submit.ascAppId === 'string' && /^\d+$/.test(submit.ascAppId), 'Confirmed numeric ascAppId is set in mobile/eas.json (App Store Connect: App Information, Apple ID)');
    check(/^[A-Z0-9]{10}$/.test(substitute(submit.ascApiKeyId, env) ?? ''), 'App Store Connect API Key ID has the expected format');
    check(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(substitute(submit.ascApiKeyIssuerId, env) ?? ''), 'App Store Connect team-key Issuer ID is configured');
    let validKey = false;
    const keyPath = substitute(submit.ascApiKeyPath, env);
    if (configured(keyPath)) {
      try {
        const key = createPrivateKey(readKey(isAbsolute(keyPath) ? keyPath : resolve(mobile, keyPath)));
        validKey = key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
      } catch {
        // Parse errors can include file contents: deliberately suppress them.
      }
    }
    check(validKey, 'API private-key file is readable and contains a valid P-256 private key');
  }
  return checks;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run ios:preflight -- [--store]\nChecks local iOS/client configuration; --store also checks API submission inputs. Values are never printed.');
    return;
  }
  if (args.some((arg) => arg !== '--store')) {
    console.error('Unknown option. Use npm run ios:preflight -- --help');
    process.exitCode = 2;
    return;
  }
  try {
    const releaseEnv = resolve(mobile, '.env.testflight.local');
    if (existsSync(releaseEnv)) process.loadEnvFile(releaseEnv);
    process.env.NODE_ENV ??= 'production';
    require('@expo/env').load(mobile, { silent: true });
    const { readAdminEmails } = require('./adminEmails.cjs');
    const adminEmails = readAdminEmails()?.value;
    const app = require('../mobile/app.config.js').expo;
    const eas = JSON.parse(readFileSync(resolve(mobile, 'eas.json'), 'utf8'));
    const checks = checkIosRelease({ app, eas, env: { ...process.env, ADMIN_EMAILS: adminEmails }, store: args.includes('--store') });
    console.log('Pathly iOS preflight — local configuration only; no cloud, signing, or device attestation.');
    for (const { status, label } of checks) console.log(`${status} ${label}`);
    const failures = checks.filter(({ status }) => status === 'FAIL').length;
    console.log(`${failures} blocking local check(s). EAS production variables and installed-device behavior must be verified separately.`);
    process.exitCode = failures ? 1 : 0;
  } catch {
    console.error('Unable to inspect local iOS configuration. Install workspace dependencies and check config-file syntax. No configuration values were printed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

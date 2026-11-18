#!/usr/bin/env node
// Keep root commands in the mobile EAS project and load ignored release inputs.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [action, ...args] = process.argv.slice(2);
if (!['build', 'submit'].includes(action)) {
  console.error('Usage: node scripts/ios-eas.mjs build|submit [EAS options]');
  process.exit(2);
}
const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '../mobile');
const releaseEnv = resolve(mobile, '.env.testflight.local');
const originalEnv = { ...process.env };
if (existsSync(releaseEnv)) process.loadEnvFile(releaseEnv);
const env = { ...process.env };
const apiKeys = ['EXPO_ASC_API_KEY_PATH', 'EXPO_ASC_KEY_ID', 'EXPO_ASC_ISSUER_ID'];
if (action === 'build' && !apiKeys.every((key) => env[key]?.trim())) {
  // An incomplete team key can be mistaken for an individual API key. Do not
  // inject a partial local-file setup into a build using existing EAS signing.
  for (const key of apiKeys) {
    if (originalEnv[key] === undefined) delete env[key];
    else env[key] = originalEnv[key];
  }
  if (apiKeys.some((key) => env[key]) && !apiKeys.every((key) => env[key]?.trim())) {
    console.error('Incomplete App Store Connect API credentials in the shell. Supply the team-key Issuer ID or unset the partial EXPO_ASC_* inputs to use existing EAS signing.');
    process.exit(1);
  }
}
if (action === 'submit' && !args.includes('--help') && !args.includes('-h')) {
  const source = args.some((arg) => ['--id', '--path', '--url'].includes(arg) || /^(--id|--path|--url)=.+/.test(arg));
  if (!source || args.includes('--latest')) {
    console.error('Select the exact production build: npm run submit:ios -- --id <EAS-build-id> (or supply --path/--url).');
    process.exit(2);
  }
  if (!apiKeys.every((key) => env[key]?.trim())) {
    console.error('Team API credentials are incomplete. Finish mobile/.env.testflight.local and run npm run ios:preflight -- --store.');
    process.exit(1);
  }
  let appId;
  try {
    appId = JSON.parse(readFileSync(resolve(mobile, 'eas.json'), 'utf8')).submit?.production?.ios?.ascAppId;
  } catch {
    console.error('Unable to read the iOS submission profile in mobile/eas.json.');
    process.exit(1);
  }
  if (typeof appId !== 'string' || !/^\d+$/.test(appId)) {
    console.error('Set the confirmed numeric ascAppId for Sammi\'s existing App Store Connect app in mobile/eas.json before submitting.');
    process.exit(1);
  }
}
const child = spawn('npx', ['--yes', 'eas-cli@27.9.0', action, '--platform', 'ios', '--profile', 'production', ...args], {
  cwd: mobile, env, stdio: 'inherit',
});
child.on('error', () => {
  console.error('Unable to start EAS CLI. Check Node/npm and network access.');
  process.exitCode = 1;
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });

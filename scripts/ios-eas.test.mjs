import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('submission stops before EAS when the existing app ID is unconfirmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pathly-ios-submit-test-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'mobile'));
    copyFileSync(new URL('./ios-eas.mjs', import.meta.url), join(dir, 'scripts/ios-eas.mjs'));
    writeFileSync(join(dir, 'mobile/eas.json'), JSON.stringify({ submit: { production: { ios: {} } } }));
    const result = spawnSync(process.execPath, [join(dir, 'scripts/ios-eas.mjs'), 'submit', '--id', 'chosen-build'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '', EXPO_ASC_API_KEY_PATH: '/private/key.p8', EXPO_ASC_KEY_ID: 'KEY', EXPO_ASC_ISSUER_ID: 'ISSUER' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /confirmed numeric ascAppId/);
    assert.ok(!result.stderr.includes('Unable to start EAS'));
    assert.ok(!result.stderr.includes('/private/key.p8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

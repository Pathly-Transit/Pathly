import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { checkIosRelease } from './ios-preflight.mjs';

function submissionFixture() {
  return {
    app: {},
    env: { KEY: 'ABC123DEF4', ISSUER: '12345678-1234-1234-1234-123456789abc', FILE: '/private/key.p8' },
    eas: { submit: { production: { ios: {
      appleTeamId: 'MRANRL5SNC', ascAppId: '1234567890',
      ascApiKeyId: '$KEY', ascApiKeyIssuerId: '$ISSUER', ascApiKeyPath: '$FILE',
    } } } },
    store: true,
  };
}

test('submission check accepts a real EC key and rejects malformed keys without disclosing values', () => {
  const fixture = submissionFixture();
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const result = checkIosRelease({ ...fixture, readKey: () => pem });
  assert.equal(result.find(({ label }) => label.startsWith('API private-key')).status, 'PASS');
  assert.equal(result.find(({ label }) => label.includes('Issuer ID')).status, 'PASS');
  assert.equal(result.find(({ label }) => label.includes('numeric ascAppId')).status, 'PASS');
  const secret = 'SECRET_PRIVATE_KEY_CONTENT';
  const rejected = checkIosRelease({ ...fixture, readKey: () => { throw new Error(secret); } });
  assert.equal(rejected.find(({ label }) => label.startsWith('API private-key')).status, 'FAIL');
  assert.ok(!JSON.stringify({ result, rejected }).includes(secret));
  assert.ok(!JSON.stringify(result).includes(pem));
  assert.ok(!JSON.stringify(result).includes(fixture.env.ISSUER));
});

test('team-key submission does not pass without issuer or a real numeric app ID', () => {
  const fixture = submissionFixture();
  fixture.env.ISSUER = '';
  fixture.eas.submit.production.ios.ascAppId = '$ASC_APP_ID';
  const result = checkIosRelease({ ...fixture, readKey: () => '' });
  assert.equal(result.find(({ label }) => label.includes('Issuer ID')).status, 'FAIL');
  assert.equal(result.find(({ label }) => label.includes('numeric ascAppId')).status, 'FAIL');
});

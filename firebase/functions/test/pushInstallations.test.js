const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { parsePushInstallationRequest, updatePushInstallation, ownedPushTokens } = require('../lib/pushInstallations');

function database() {
  const docs = new Map();
  const reference = (path) => ({ path });
  const snapshot = (ref) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) });
  const write = (ref, value, merge) => {
    const next = merge ? { ...docs.get(ref.path) } : {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry?.constructor?.name === 'ArrayRemoveTransform') next[key] = (next[key] ?? []).filter((v) => !entry.elements.includes(v));
      else if (entry?.constructor?.name === 'ArrayUnionTransform') next[key] = [...new Set([...(next[key] ?? []), ...entry.elements])];
      else next[key] = entry;
    }
    docs.set(ref.path, next);
  };
  return {
    docs, collection: (name) => ({ doc: (id) => reference(`${name}/${id}`) }),
    getAll: async (...refs) => refs.map(snapshot),
    runTransaction: async (run) => {
      const writes = [];
      const result = await run({ get: async (ref) => snapshot(ref), set: (ref, data, opts) => writes.push(() => write(ref, data, opts?.merge)), update: (ref, data) => writes.push(() => write(ref, data, true)) });
      writes.forEach((apply) => apply());
      return result;
    },
  };
}
const identity = { installationId: 'installation-1234567890', capability: 'a'.repeat(64) };
const tokenA = 'ExponentPushToken[device-token-A]';
const tokenB = 'ExponentPushToken[device-token-B]';
const request = (revision, ownerUid, token) => ({ ...identity, revision, ownerUid, token, retiredTokens: [] });
const ownerPath = (token) => `_pathlyPushTokenOwners/${createHash('sha256').update(token).digest('hex')}`;

test('reassignment removes only this token and preserves the previous account other devices', async () => {
  const db = database();
  db.docs.set('users/A', { pushTokens: ['other-device'] });
  await updatePushInstallation(db, request(1, 'A', tokenA), 'A');
  await updatePushInstallation(db, request(2, 'B', tokenA), 'B');
  assert.deepEqual(db.docs.get('users/A').pushTokens, ['other-device']);
  assert.deepEqual(db.docs.get('users/B').pushTokens, [tokenA]);
  assert.equal(db.docs.get(ownerPath(tokenA)).uid, 'B');
});

test('signed-out cleanup uses the private capability and blocks late registration', async () => {
  const db = database();
  await updatePushInstallation(db, request(1, 'A', tokenA), 'A');
  await updatePushInstallation(db, request(3, null, null), null);
  assert.deepEqual(await updatePushInstallation(db, request(2, 'A', tokenA), 'A'), { applied: false });
  assert.deepEqual(db.docs.get('users/A').pushTokens, []);
  assert.equal(db.docs.get(ownerPath(tokenA)).uid, null);
});

test('a revoke reaching the server before the first registration prevents resurrection', async () => {
  const db = database();
  await updatePushInstallation(db, request(2, null, null), null);
  assert.deepEqual(await updatePushInstallation(db, request(1, 'A', tokenA), 'A'), { applied: false });
  assert.equal(db.docs.has('users/A'), false);
});

test('offline cleanup also tombstones the legacy token when it arrives before initial migration', async () => {
  const db = database();
  db.docs.set('users/A', { pushTokens: [tokenA, 'legacy-other-device'] });
  await updatePushInstallation(db, { ...request(2, null, null), retiredTokens: [tokenA] }, null);
  assert.deepEqual(await ownedPushTokens(db, 'A', [tokenA, 'legacy-other-device']), ['legacy-other-device']);
  assert.deepEqual(await updatePushInstallation(db, request(1, 'A', tokenA), 'A'), { applied: false });
});

test('rotation retires the old token and does not remove another device', async () => {
  const db = database();
  db.docs.set('users/A', { pushTokens: ['other-device'] });
  await updatePushInstallation(db, request(1, 'A', tokenA), 'A');
  await updatePushInstallation(db, request(2, 'A', tokenB), 'A');
  assert.deepEqual(db.docs.get('users/A').pushTokens, ['other-device', tokenB]);
  assert.equal(db.docs.get(ownerPath(tokenA)).uid, null);
});

test('token migration filters stale legacy arrays while preserving unmigrated devices', async () => {
  const db = database();
  db.docs.set('users/A', { pushTokens: [tokenA, 'legacy-other-device'] });
  await updatePushInstallation(db, request(1, 'B', tokenA), 'B');
  assert.deepEqual(await ownedPushTokens(db, 'A', [tokenA, 'legacy-other-device']), ['legacy-other-device']);
  assert.deepEqual(await ownedPushTokens(db, 'B', [tokenA]), [tokenA]);
  await updatePushInstallation(db, request(2, null, null), null);
  assert.deepEqual(await ownedPushTokens(db, 'A', [tokenA]), []);
});

test('an older installation cannot revoke a token now claimed by a new installation', async () => {
  const db = database();
  await updatePushInstallation(db, request(1, 'A', tokenA), 'A');
  await updatePushInstallation(db, { ...request(1, 'B', tokenA), installationId: 'new-installation-123456' }, 'B');
  await updatePushInstallation(db, request(2, null, null), null);
  assert.deepEqual(await ownedPushTokens(db, 'B', [tokenA]), [tokenA]);
});

test('rejects wrong capabilities, stale-account requests and reused revision payloads', async () => {
  const db = database();
  await updatePushInstallation(db, request(1, 'A', tokenA), 'A');
  await assert.rejects(updatePushInstallation(db, { ...request(2, null, null), capability: 'b'.repeat(64) }, null), /Invalid push installation/);
  await assert.rejects(updatePushInstallation(db, request(2, 'A', tokenB), 'B'), /Sign in/);
  await assert.rejects(updatePushInstallation(db, request(1, 'B', tokenA), 'B'), /revision was reused/);
  assert.throws(() => parsePushInstallationRequest({ ...request(2, null, null), revision: NaN }), /Invalid push/);
});

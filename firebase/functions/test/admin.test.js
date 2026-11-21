const assert = require('node:assert/strict');
const test = require('node:test');

const { isAdmin, requireAdmin } = require('../lib/admin');

const auth = (email, verified = true) => ({ uid: 'u1', token: email === undefined ? {} : { email, email_verified: verified } });

test.afterEach(() => {
  delete process.env.ADMIN_EMAILS;
});

test('recognizes the default admin email in any case', () => {
  assert.equal(isAdmin(auth('admin@gmail.com')), true);
  assert.equal(isAdmin(auth('Admin@Gmail.COM')), true);
});

test('rejects other emails, a missing email, and signed-out callers', () => {
  assert.equal(isAdmin(auth('rider@gmail.com')), false);
  assert.equal(isAdmin(auth(undefined)), false);
  assert.equal(isAdmin(null), false);
  assert.throws(() => requireAdmin({ auth: auth('rider@gmail.com') }), { code: 'permission-denied' });
  assert.throws(() => requireAdmin({ auth: null }), { code: 'permission-denied' });
  assert.doesNotThrow(() => requireAdmin({ auth: auth('admin@gmail.com') }));
});

test('reads the configured admin list', () => {
  process.env.ADMIN_EMAILS = 'ops@example.com, qa@example.com';
  assert.equal(isAdmin(auth('qa@example.com')), true);
  assert.equal(isAdmin(auth('admin@gmail.com')), false);
});

test('requires verified email ownership even when the address is allowlisted', () => {
  process.env.ADMIN_EMAILS = 'ops@example.com';
  for (const verified of [false, undefined, null, 'true', 1]) {
    const caller = auth('ops@example.com', verified);
    if (verified === undefined) delete caller.token.email_verified;
    assert.equal(isAdmin(caller), false);
    assert.throws(() => requireAdmin({ auth: caller }), { code: 'permission-denied' });
  }
  assert.equal(isAdmin(auth('OPS@example.com', true)), true);
});

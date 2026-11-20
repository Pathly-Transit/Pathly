const assert = require('node:assert/strict');
const test = require('node:test');

const { alertMessage, alertPushMessage, isPeakTime, sendExpoPushes, wantsAlertsNow } = require('../lib/routeAlerts');

// 2026-10-26 is a Monday; New York is on EDT (UTC-4).
const nyc = (day, hour, minute = 0) => new Date(Date.UTC(2026, 9, day, hour + 4, minute));

test('peak is weekday 6-10 AM and 4-8 PM in New York', () => {
  assert.equal(isPeakTime(nyc(26, 5, 59)), false);
  assert.equal(isPeakTime(nyc(26, 6)), true);
  assert.equal(isPeakTime(nyc(26, 9, 59)), true);
  assert.equal(isPeakTime(nyc(26, 10)), false);
  assert.equal(isPeakTime(nyc(26, 17, 30)), true);
  assert.equal(isPeakTime(nyc(26, 20)), false);
  // Saturday morning rush hour isn't one.
  assert.equal(isPeakTime(nyc(24, 8)), false);
});

test('each setting decides whether to alert now', () => {
  assert.equal(wantsAlertsNow('all', nyc(24, 3)), true);
  assert.equal(wantsAlertsNow('peak', nyc(24, 8)), false);
  assert.equal(wantsAlertsNow('peak', nyc(26, 8)), true);
  assert.equal(wantsAlertsNow('off', nyc(26, 8)), false);
  assert.equal(wantsAlertsNow(undefined, nyc(26, 8)), false);
});

test('the push names the line and says what is wrong', () => {
  assert.deepEqual(
    alertMessage({ agencyId: 'subway', routeId: '1', shortName: '1' }, { id: 'a', header: 'No trains between 96 St and 242 St', description: null }),
    { title: '1 service alert', body: 'No trains between 96 St and 242 St' },
  );
});

const route = { agencyId: 'metronorth', routeId: '1', shortName: 'Hudson' };
const alert = { id: 'a', header: 'Delays near Croton-Harmon' };

test('an alert push is high priority on the app\'s alert channel, one device per message', () => {
  assert.deepEqual(alertPushMessage('ExponentPushToken[x]', route, alert), {
    to: 'ExponentPushToken[x]',
    title: 'Hudson service alert',
    body: 'Delays near Croton-Harmon',
    data: { agencyId: 'metronorth', routeId: '1' },
    sound: 'default',
    priority: 'high',
    channelId: 'default',
  });
});

test('push outcomes come from Expo\'s tickets, not the HTTP status', async () => {
  const messages = ['a', 'b', 'c'].map((token) => alertPushMessage(token, route, alert));
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [
      { status: 'ok', id: '1' },
      { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', message: 'no FCM key', details: { error: 'InvalidCredentials' } },
    ] }),
  });
  assert.deepEqual(await sendExpoPushes(messages, fetchImpl), [
    { status: 'ok' },
    { status: 'error', error: 'DeviceNotRegistered' },
    { status: 'error', error: 'InvalidCredentials' },
  ]);
});

test('a push request that fails counts as failed for each of its messages', async () => {
  const messages = ['a', 'b'].map((token) => alertPushMessage(token, route, alert));
  assert.deepEqual(await sendExpoPushes(messages, async () => ({ ok: false, status: 503 })), [
    { status: 'error', error: 'HTTP 503' },
    { status: 'error', error: 'HTTP 503' },
  ]);
  assert.deepEqual(await sendExpoPushes(messages, async () => { throw new Error('offline'); }), [
    { status: 'error', error: 'RequestFailed' },
    { status: 'error', error: 'RequestFailed' },
  ]);
});

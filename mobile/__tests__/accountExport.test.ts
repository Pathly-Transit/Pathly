import { doc, setDoc } from 'firebase/firestore';
import type { User } from 'firebase/auth';

import { exportUserData } from '../src/data/accountData';
import { db } from '../src/lib/firebase';

it('exports every supported cloud collection for this account, with normalized timestamps and scope', async () => {
  const user = { uid: 'export-owner', email: 'owner@example.com', displayName: 'Rider' } as User;
  const timestamp = { toDate: () => new Date('2026-11-21T20:00:00Z') };
  await setDoc(doc(db, 'users', user.uid), { displayName: 'Rider', pushTokens: ['private-device-routing-token'] });
  for (const name of ['searches', 'prevDests', 'savedLocations', 'savedRoutes', 'alertInbox']) {
    await setDoc(doc(db, 'users', user.uid, name, 'mine'), { name, at: timestamp });
    await setDoc(doc(db, 'users', 'other-account', name, 'theirs'), { name: 'not-mine' });
  }
  const data = await exportUserData(user, new Date('2026-11-21T20:30:00Z'));
  expect(data.schemaVersion).toBe(2);
  expect(data.scope.deviceOnlyData).toBe('not-included');
  expect(data.scope.cloudCollections).toEqual(['searches', 'prevDests', 'savedLocations', 'savedRoutes', 'alertInbox']);
  for (const name of ['searches', 'prevDests', 'savedLocations', 'savedRoutes', 'alertInbox'] as const) {
    expect(data[name]).toEqual([{ id: 'mine', name, at: '2026-11-21T20:00:00.000Z' }]);
  }
  expect(data.profile).toEqual({ displayName: 'Rider' });
  expect(JSON.stringify(data)).not.toContain('private-device-routing-token');
});

it('includes empty collections explicitly', async () => {
  const data = await exportUserData({ uid: 'empty-export', email: null, displayName: null } as User);
  expect(data.savedRoutes).toEqual([]);
  expect(data.alertInbox).toEqual([]);
  expect(data.profile).toBeNull();
});

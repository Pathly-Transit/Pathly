/* global beforeEach */
// Firestore's mock (jest.setup.js) keeps data in memory; start every test with an empty database.
beforeEach(async () => {
  // Saved display settings and preferences live on the device; every test starts with none.
  await require('@react-native-async-storage/async-storage').clear();
  require('./src/lib/routeAlertRegistration').resetRouteAlertRegistrationForTests();
  globalThis.__mockAuthUser.email = 'rider@example.com';
  globalThis.__mockAuthUser.emailVerified = true;
  globalThis.__mockAuthUser.displayName = 'Pathly Rider';
  globalThis.__mockAuthUser.providerData = [{ providerId: 'password' }];
  require('firebase/firestore').__resetMockFirestore();
  // Each test starts as a fresh app session, so it sends its own warm-up when its rider signs in.
  require('./src/data/backendWarmup').resetBackendWarmupForTests();
  require('./src/data/tripPlanning').resetTripPlanCacheForTests();
  require('./src/data/transitLive').clearRouteLiveReads?.();
  // A fresh session may show the location prompt again.
  require('./src/hooks/useCurrentLocation').resetLocationPromptForTests();
  require('expo-location').getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
});

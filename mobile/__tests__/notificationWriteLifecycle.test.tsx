import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { NotificationSettings } from '../src/components/SettingsPages';
import { UserPreferencesProvider } from '../src/data/userPreferences';
import { AppSettingsProvider } from '../src/theme/AppSettings';

let mockUser = { uid: 'alice', isAnonymous: false };
const mockPaused = jest.fn();
const mockAlerts = jest.fn();
const mockRegistration = jest.fn();
const mockRoute = { id: 'suffolk:51', agencyId: 'suffolk', routeId: '51', routeName: 'Route 51', shortName: '51', agencyName: 'Suffolk County Transit', color: '#cc0000', favorite: true, alerts: 'off', direction0: null, direction1: null };
jest.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../src/data/savedRoutes', () => ({
  ...jest.requireActual('../src/data/savedRoutes'),
  setRouteAlertsPaused: (...args: unknown[]) => mockPaused(...args),
  setRouteAlerts: (...args: unknown[]) => mockAlerts(...args),
  subscribeToSavedRoutes: (_uid: string, onChange: (routes: unknown[]) => void) => { onChange([mockRoute]); return () => undefined; },
}));
jest.mock('../src/lib/notifications', () => ({ registerForRouteAlerts: (...args: unknown[]) => mockRegistration(...args) }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const view = (feedback: (message: string) => void) => <AppSettingsProvider><UserPreferencesProvider><NotificationSettings onFeedback={feedback} /></UserPreferencesProvider></AppSettingsProvider>;

beforeEach(() => {
  mockUser = { uid: 'alice', isAnonymous: false };
  mockPaused.mockReset().mockResolvedValue(undefined);
  mockAlerts.mockReset().mockResolvedValue(undefined);
  mockRegistration.mockReset().mockResolvedValue(false);
});
afterEach(() => { jest.restoreAllMocks(); });

it('does not announce saved or register push when the server write fails', async () => {
  const feedback = jest.fn();
  const screen = render(view(feedback));
  mockAlerts.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { fireEvent.press(screen.getByTestId('line-alerts-suffolk:51-all-times')); });
  expect(feedback).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
  expect(feedback).not.toHaveBeenCalledWith(expect.stringContaining('51 alerts: All times'));
  expect(mockRegistration).not.toHaveBeenCalled();
});

it('distinguishes a saved subscription from unsuccessful device registration', async () => {
  const feedback = jest.fn();
  const screen = render(view(feedback));
  await act(async () => { fireEvent.press(screen.getByTestId('line-alerts-suffolk:51-all-times')); });
  expect(mockAlerts).toHaveBeenCalledWith('alice', 'suffolk:51', 'all', undefined);
  expect(feedback).toHaveBeenCalledWith(expect.stringContaining('Preference saved; push notifications are not ready'));
});

it('reports a rejected device preference write instead of a saved server preference', async () => {
  const feedback = jest.fn();
  const screen = render(view(feedback));
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
  await act(async () => { fireEvent(screen.getByTestId('toggle-service-alerts'), 'valueChange', false); });
  expect(mockPaused).not.toHaveBeenCalled();
  expect(feedback).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
  expect(feedback).not.toHaveBeenCalledWith('Notification preferences saved');
});

it('serializes rapid toggle intents and only confirms the final intended server state', async () => {
  const feedback = jest.fn();
  const pending = deferred();
  mockPaused.mockImplementationOnce(() => pending.promise);
  const screen = render(view(feedback));
  fireEvent(screen.getByTestId('toggle-service-alerts'), 'valueChange', false);
  await waitFor(() => expect(mockPaused).toHaveBeenCalledTimes(1));
  fireEvent(screen.getByTestId('toggle-service-alerts'), 'valueChange', true);
  expect(mockPaused).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(); });
  await waitFor(() => expect(mockPaused).toHaveBeenCalledTimes(2));
  expect(mockPaused.mock.calls).toEqual([['alice', true], ['alice', false]]);
  expect(feedback).toHaveBeenCalledTimes(1);
  expect(feedback).toHaveBeenCalledWith(expect.stringContaining('Push notifications are not ready'));
});

it('suppresses previous-account completion feedback and push registration', async () => {
  const feedback = jest.fn();
  const pending = deferred();
  mockPaused.mockImplementationOnce(() => pending.promise);
  const screen = render(view(feedback));
  fireEvent(screen.getByTestId('toggle-service-alerts'), 'valueChange', false);
  await waitFor(() => expect(mockPaused).toHaveBeenCalledTimes(1));
  mockUser = { uid: 'bob', isAnonymous: false };
  screen.rerender(view(feedback));
  await act(async () => { pending.resolve(); });
  expect(feedback).not.toHaveBeenCalled();
  expect(mockRegistration).not.toHaveBeenCalled();
  expect(mockPaused.mock.calls).toEqual([['alice', true]]);
});

it('persists local-only notification switches without changing the server pause flag', async () => {
  const feedback = jest.fn();
  const screen = render(view(feedback));
  await act(async () => { fireEvent(screen.getByTestId('toggle-trip-reminders'), 'valueChange', false); });
  await act(async () => { fireEvent(screen.getByTestId('toggle-disruptions'), 'valueChange', false); });
  expect(mockPaused).not.toHaveBeenCalled();
  expect(mockRegistration).not.toHaveBeenCalled();
  expect(feedback).toHaveBeenCalledWith('Notification preferences saved');
});

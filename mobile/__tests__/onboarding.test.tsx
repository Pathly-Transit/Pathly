import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import type { User } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';

import { ensureUserProfile } from '../src/auth/userProfile';
import { OnboardingScreen } from '../src/components/OnboardingScreen';
import { isNewAccount, useOnboarding } from '../src/hooks/useOnboarding';
import { db } from '../src/lib/firebase';
import { AppSettingsProvider } from '../src/theme/AppSettings';

const mockUser = { uid: 'rider', isAnonymous: false };
jest.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

const asUser = (fields: Record<string, unknown> = {}) => ({
  uid: 'rider',
  isAnonymous: false,
  displayName: null,
  email: 'rider@example.com',
  metadata: { creationTime: new Date(Date.now() - 60_000).toISOString() },
  ...fields,
}) as unknown as User;

describe('onboarding gate', () => {
  it('is for new accounts, not older ones or guests', () => {
    const now = Date.parse('2026-11-03T00:00:00Z');
    expect(isNewAccount(asUser({ metadata: { creationTime: '2026-11-02T00:00:00Z' } }), now)).toBe(true);
    expect(isNewAccount(asUser({ metadata: { creationTime: '2026-09-01T00:00:00Z' } }), now)).toBe(false);
    expect(isNewAccount(asUser({ isAnonymous: true }), now)).toBe(false);
    expect(isNewAccount(null, now)).toBe(false);
  });

  it('shows once for a new profile, and finishing it is kept on the profile', async () => {
    const user = asUser();
    await ensureUserProfile(user);
    const { result } = renderHook(() => useOnboarding(user));
    await waitFor(() => expect(result.current.state).toBe('pending'));
    act(() => result.current.finish());
    expect(result.current.state).toBe('done');
    // Another device (a fresh hook) reads the same profile and skips it.
    const again = renderHook(() => useOnboarding(user));
    await waitFor(() => expect(again.result.current.state).toBe('done'));
  });

  it('skips profiles made before onboarding existed, and older accounts', async () => {
    await setDoc(doc(db, 'users', 'rider'), { displayName: null });
    const { result } = renderHook(() => useOnboarding(asUser()));
    await waitFor(() => expect(result.current.state).toBe('done'));
    const older = renderHook(() => useOnboarding(asUser({ metadata: { creationTime: '2026-01-01T00:00:00Z' } })));
    expect(older.result.current.state).toBe('done');
  });
});

describe('OnboardingScreen', () => {
  const show = (onDone = jest.fn()) => render(<AppSettingsProvider><OnboardingScreen onDone={onDone} /></AppSettingsProvider>);

  it('offers home, work and school, each optional', () => {
    const onDone = jest.fn();
    show(onDone);
    expect(screen.getByTestId('onboarding-home')).toHaveTextContent(/Set your home address/);
    expect(screen.getByTestId('onboarding-school')).toBeTruthy();
    expect(screen.getByTestId('onboarding-done')).toHaveTextContent('Skip for now');
    fireEvent.press(screen.getByTestId('onboarding-done'));
    expect(onDone).toHaveBeenCalled();
  });

  it('searches for the place it was tapped for', () => {
    show();
    fireEvent.press(screen.getByTestId('onboarding-work'));
    expect(screen.getByPlaceholderText('Search for your work address')).toBeTruthy();
  });

  it('shows what is already set, and moves on with Continue', async () => {
    await setDoc(doc(db, 'users', 'rider', 'savedLocations', 'p'), { address: { label: 'Home', name: '12 Elm St', placeId: 'p' }, dateSaved: null });
    show();
    await waitFor(() => expect(screen.getByTestId('onboarding-home')).toHaveTextContent(/12 Elm St/));
    expect(screen.getByTestId('onboarding-done')).toHaveTextContent('Continue');
  });
});

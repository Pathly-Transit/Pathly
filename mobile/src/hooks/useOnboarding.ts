import type { User } from 'firebase/auth';
import { useCallback, useEffect, useState } from 'react';

import { finishOnboarding, subscribeOnboardingPending } from '../auth/userProfile';

/** Long enough to outlast confirming an email; older accounts never wait on their profile. */
const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;
/** A new account whose profile can't be read this long (offline) goes straight in. */
const PROFILE_WAIT_MS = 4000;

export function isNewAccount(user: User | null, now = Date.now()): boolean {
  if (!user || user.isAnonymous) return false;
  const created = Date.parse(user.metadata?.creationTime ?? '');
  return Number.isFinite(created) && now - created < NEW_ACCOUNT_MS;
}

export type OnboardingState = 'loading' | 'pending' | 'done';

/**
 * A just-created account's first-run onboarding, asked once per account (kept on its profile, so a
 * second device doesn't ask again). Guests and older accounts are `done` without reading anything.
 */
export function useOnboarding(user: User | null): { state: OnboardingState; finish: () => void } {
  const uid = user?.uid;
  const eligible = isNewAccount(user);
  // What this session settled for `uid`: once it's done here, a late snapshot can't bring it back.
  const [settled, setSettled] = useState<{ uid: string; state: OnboardingState } | null>(null);

  useEffect(() => {
    if (!eligible || !uid) return undefined;
    let active = true;
    const settle = (state: OnboardingState) => {
      if (!active) return;
      setSettled((current) => (current?.uid === uid && current.state === 'done' ? current : { uid, state }));
    };
    const timer = setTimeout(() => setSettled((current) => (current?.uid === uid ? current : { uid, state: 'done' })), PROFILE_WAIT_MS);
    const unsubscribe = subscribeOnboardingPending(uid, (pending) => {
      if (pending === undefined) return;
      clearTimeout(timer);
      settle(pending ? 'pending' : 'done');
    }, () => settle('done'));
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [eligible, uid]);

  const finish = useCallback(() => {
    if (!uid) return;
    setSettled({ uid, state: 'done' });
    // Offline, Firestore keeps the write and sends it later; a refused one only means asking again.
    finishOnboarding(uid).catch(() => undefined);
  }, [uid]);

  const state: OnboardingState = !eligible || !uid ? 'done' : settled?.uid === uid ? settled.state : 'loading';
  return { state, finish };
}

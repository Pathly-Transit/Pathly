import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { OAuthProvider, reauthenticateWithCredential, revokeAccessToken, signInWithCredential, type User, type UserCredential } from 'firebase/auth';

import { updateDisplayName } from '../data/accountData';
import { auth } from '../lib/firebase';

/**
 * Sign in with Apple (iOS only). Apple requires it alongside Google on iOS (App Store guideline
 * 4.8). Apple's sheet signs a hashed nonce; Firebase checks it against the raw one.
 */

const cancelled = () => Object.assign(new Error('Apple sign-in was cancelled.'), { code: 'auth/user-cancelled' });

/** False on Android, web, and iOS before 13. */
export function isAppleSignInAvailable(): Promise<boolean> {
  return AppleAuthentication.isAvailableAsync().catch(() => false);
}

async function askApple(withScopes: boolean) {
  const rawNonce = Crypto.randomUUID();
  const nonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
  let result: AppleAuthentication.AppleAuthenticationCredential;
  try {
    result = await AppleAuthentication.signInAsync({
      nonce,
      requestedScopes: withScopes ? [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL] : [],
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ERR_REQUEST_CANCELED') throw cancelled();
    throw error;
  }
  if (!result.identityToken) throw new Error('Apple returned no identity token.');
  return { result, credential: new OAuthProvider('apple.com').credential({ idToken: result.identityToken, rawNonce }) };
}

export async function signInWithApple(): Promise<UserCredential> {
  const { result, credential } = await askApple(true);
  const signedIn = await signInWithCredential(auth, credential);
  // Apple shares the rider's name only on their very first sign-in, so keep it then.
  const name = result.fullName ? AppleAuthentication.formatFullName(result.fullName).trim() : '';
  if (name && !signedIn.user.displayName) await updateDisplayName(signedIn.user, name).catch(() => undefined);
  return signedIn;
}

/**
 * Re-confirms an Apple sign-in before deleting the account, then revokes Pathly's Apple tokens,
 * as Apple requires when an account made with Sign in with Apple is deleted (guideline 5.1.1(v)).
 * Revoking needs the Apple key set up in Firebase; a failed revoke doesn't stop the deletion.
 */
export async function reauthenticateWithAppleForDeletion(user: User): Promise<void> {
  const { result, credential } = await askApple(false);
  await reauthenticateWithCredential(user, credential);
  if (result.authorizationCode) await revokeAccessToken(auth, result.authorizationCode).catch(() => undefined);
}

/** Whether the rider joined with Apple (and so confirms with Apple rather than a password). */
export function hasAppleSignIn(user: User): boolean {
  return Boolean(user.providerData?.some((provider) => provider.providerId === 'apple.com'));
}

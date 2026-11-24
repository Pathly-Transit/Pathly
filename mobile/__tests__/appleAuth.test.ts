import { reauthenticateWithCredential, revokeAccessToken, signInWithCredential } from 'firebase/auth';

const mockSignInAsync = jest.fn();
jest.mock('expo-apple-authentication', () => ({
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  formatFullName: (name: { givenName?: string; familyName?: string }) => [name.givenName, name.familyName].filter(Boolean).join(' '),
  isAvailableAsync: jest.fn(() => Promise.resolve(true)),
  signInAsync: (...args: unknown[]) => mockSignInAsync(...args),
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: jest.fn((_algorithm: string, value: string) => Promise.resolve(`hashed:${value}`)),
  randomUUID: () => 'raw-nonce',
}));
const mockUpdateDisplayName = jest.fn(() => Promise.resolve('Ada Lovelace'));
jest.mock('../src/data/accountData', () => ({ updateDisplayName: (...args: unknown[]) => mockUpdateDisplayName(...(args as [])) }));

// eslint-disable-next-line import/first -- loads after the mocks above
import { hasAppleSignIn, reauthenticateWithAppleForDeletion, signInWithApple } from '../src/auth/appleAuth';

const appleResult = { identityToken: 'apple-id-token', authorizationCode: 'apple-code', fullName: { givenName: 'Ada', familyName: 'Lovelace' } };

describe('Sign in with Apple', () => {
  beforeEach(() => jest.clearAllMocks());

  it("signs Apple's hashed nonce and gives Firebase the raw one, keeping the first-time name", async () => {
    mockSignInAsync.mockResolvedValue(appleResult);
    await signInWithApple();
    expect(mockSignInAsync).toHaveBeenCalledWith(expect.objectContaining({ nonce: 'hashed:raw-nonce' }));
    expect(signInWithCredential).toHaveBeenCalledWith(expect.anything(), { providerId: 'apple.com', idToken: 'apple-id-token', rawNonce: 'raw-nonce' });
    expect(mockUpdateDisplayName).toHaveBeenCalledWith(expect.objectContaining({ uid: 'apple-uid' }), 'Ada Lovelace');
  });

  it('reports a closed Apple sheet as cancelled', async () => {
    mockSignInAsync.mockRejectedValue(Object.assign(new Error('canceled'), { code: 'ERR_REQUEST_CANCELED' }));
    await expect(signInWithApple()).rejects.toMatchObject({ code: 'auth/user-cancelled' });
    expect(signInWithCredential).not.toHaveBeenCalled();
  });

  it('re-confirms with Apple and revokes its tokens before deletion', async () => {
    mockSignInAsync.mockResolvedValue(appleResult);
    const user = { uid: 'apple-uid' } as never;
    await reauthenticateWithAppleForDeletion(user);
    expect(reauthenticateWithCredential).toHaveBeenCalledWith(user, { providerId: 'apple.com', idToken: 'apple-id-token', rawNonce: 'raw-nonce' });
    expect(revokeAccessToken).toHaveBeenCalledWith(expect.anything(), 'apple-code');
  });

  it('still deletes when revoking fails', async () => {
    mockSignInAsync.mockResolvedValue(appleResult);
    (revokeAccessToken as jest.Mock).mockRejectedValueOnce(new Error('not configured'));
    await expect(reauthenticateWithAppleForDeletion({ uid: 'apple-uid' } as never)).resolves.toBeUndefined();
  });

  it('knows an Apple account by its provider', () => {
    expect(hasAppleSignIn({ providerData: [{ providerId: 'apple.com' }] } as never)).toBe(true);
    expect(hasAppleSignIn({ providerData: [{ providerId: 'google.com' }] } as never)).toBe(false);
  });
});

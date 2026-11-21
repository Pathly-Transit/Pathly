import { createHash, timingSafeEqual } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

export type PushInstallationRequest = { installationId: string; capability: string; revision: number; token: string | null; ownerUid: string | null; retiredTokens: string[] };
const INSTALLATIONS = '_pathlyPushInstallations';
const TOKENS = '_pathlyPushTokenOwners';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function parsePushInstallationRequest(value: unknown): PushInstallationRequest {
  const data = value as Partial<PushInstallationRequest> | null;
  const retiredTokens = data?.retiredTokens ?? [];
  if (!data || typeof data.installationId !== 'string' || !/^[a-zA-Z0-9-]{20,80}$/.test(data.installationId)
    || typeof data.capability !== 'string' || !/^[a-f0-9]{64}$/.test(data.capability)
    || !Number.isSafeInteger(data.revision) || data.revision! < 1
    || !(data.token === null || (typeof data.token === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[a-zA-Z0-9_-]{4,200}\]$/.test(data.token)))
    || !(data.token === null ? data.ownerUid === null : typeof data.ownerUid === 'string' && data.ownerUid.length > 0 && data.ownerUid.length <= 128)
    || !Array.isArray(retiredTokens) || retiredTokens.length > 4
    || retiredTokens.some((token) => typeof token !== 'string' || !/^(ExponentPushToken|ExpoPushToken)\[[a-zA-Z0-9_-]{4,200}\]$/.test(token))) {
    throw new HttpsError('invalid-argument', 'Invalid push installation.');
  }
  return { ...data, retiredTokens } as PushInstallationRequest;
}

/**
 * Private capability authorizes cleanup even after offline sign-out. Revisions prevent an older
 * registration/revoke finishing after a newer account assignment from changing ownership back.
 * Each transaction touches only this installation's old/new token and their owners' profiles.
 */
export async function updatePushInstallation(firestore: Firestore, request: PushInstallationRequest, uid: string | null): Promise<{ applied: boolean }> {
  if (request.token !== null && (!uid || uid !== request.ownerUid)) throw new HttpsError('unauthenticated', 'Sign in to register alerts.');
  const nextUid = request.token === null ? null : uid;
  const installRef = firestore.collection(INSTALLATIONS).doc(request.installationId);
  const capabilityHash = hash(request.capability);
  return firestore.runTransaction(async (transaction) => {
    const previous = (await transaction.get(installRef)).data();
    if (previous && (typeof previous.capabilityHash !== 'string' || previous.capabilityHash.length !== capabilityHash.length
      || !timingSafeEqual(Buffer.from(previous.capabilityHash), Buffer.from(capabilityHash)))) {
      throw new HttpsError('permission-denied', 'Invalid push installation.');
    }
    if (previous && request.revision < previous.revision) return { applied: false };
    if (previous && request.revision === previous.revision) {
      if (previous.uid !== nextUid || previous.token !== request.token) throw new HttpsError('failed-precondition', 'Push installation revision was reused.');
      return { applied: true };
    }
    const oldToken = typeof previous?.token === 'string' ? previous.token : null;
    const tokenValues = [...new Set([oldToken, request.token, ...request.retiredTokens].filter((token): token is string => token !== null))];
    const ownership = await Promise.all(tokenValues.map(async (token) => {
      const reference = firestore.collection(TOKENS).doc(hash(token));
      return { token, reference, data: (await transaction.get(reference)).data() };
    }));
    const removals = ownership.filter(({ token, data }) => typeof data?.uid === 'string' && (
      token === request.token || data.installationId === request.installationId
    ));
    const owners = new Map(await Promise.all(removals.map(async ({ data }) => {
      const reference = firestore.collection('users').doc(data!.uid);
      return [data!.uid as string, { reference, exists: (await transaction.get(reference)).exists }] as const;
    })));
    for (const { token, data } of removals) {
      const owner = owners.get(data!.uid)!;
      if (owner.exists) transaction.update(owner.reference, { pushTokens: FieldValue.arrayRemove(token) });
    }
    for (const { token, reference, data } of ownership) {
      if (token === request.token || data?.installationId === request.installationId || (!data && request.retiredTokens.includes(token))) {
        transaction.set(reference, { installationId: request.installationId, uid: token === request.token ? nextUid : null });
      }
    }
    if (request.token && nextUid) {
      transaction.set(firestore.collection('users').doc(nextUid), { pushTokens: FieldValue.arrayUnion(request.token) }, { merge: true });
    }
    transaction.set(installRef, { capabilityHash, revision: request.revision, uid: nextUid, token: request.token, updatedAt: FieldValue.serverTimestamp() });
    return { applied: true };
  });
}

/** Legacy devices continue working; once a token is migrated, its private owner/tombstone wins. */
export async function ownedPushTokens(firestore: Firestore, uid: string, values: unknown): Promise<string[]> {
  const tokens = [...new Set(Array.isArray(values) ? values.filter((token): token is string => typeof token === 'string' && token.length <= 240) : [])].slice(0, 200);
  if (tokens.length === 0) return [];
  const records = await firestore.getAll(...tokens.map((token) => firestore.collection(TOKENS).doc(hash(token))));
  return tokens.filter((_, index) => !records[index]!.exists || records[index]!.data()?.uid === uid);
}

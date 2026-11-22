import { act, renderHook } from '@testing-library/react-native';

import { AccountWriteCancelled, useAccountWrites } from '../src/hooks/useAccountWrites';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it('serializes same-key intents while allowing independent writes', async () => {
  const hook = renderHook(() => useAccountWrites('alice'));
  const pending = deferred();
  const actions: string[] = [];
  const first = hook.result.current.run('alerts', async (uid) => { actions.push(`${uid}:off`); await pending.promise; });
  const last = hook.result.current.run('alerts', async (uid) => { actions.push(`${uid}:on`); });
  await hook.result.current.run('favorite', async (uid) => { actions.push(`${uid}:favorite`); });
  expect(actions).toEqual(['alice:off', 'alice:favorite']);
  pending.resolve();
  await Promise.all([first, last]);
  expect(actions).toEqual(['alice:off', 'alice:favorite', 'alice:on']);
  hook.unmount();
});

it('invalidates queued work and late results across accounts, including returning to the same UID', async () => {
  const hook = renderHook(({ uid }: { uid: string }) => useAccountWrites(uid), { initialProps: { uid: 'alice' } });
  const pending = deferred();
  const oldScope = hook.result.current.isCurrent;
  const actions: string[] = [];
  const first = hook.result.current.run('alerts', async () => { await pending.promise; });
  const queued = hook.result.current.run('alerts', async (uid) => { actions.push(`${uid}:stale`); });
  const firstRejected = expect(first).rejects.toBeInstanceOf(AccountWriteCancelled);
  const queuedRejected = expect(queued).rejects.toBeInstanceOf(AccountWriteCancelled);
  act(() => hook.rerender({ uid: 'bob' }));
  await hook.result.current.run('alerts', async (uid) => { actions.push(`${uid}:new`); });
  act(() => hook.rerender({ uid: 'alice' }));
  expect(oldScope()).toBe(false);
  pending.resolve();
  await Promise.all([firstRejected, queuedRejected]);
  expect(actions).toEqual(['bob:new']);
  hook.unmount();
});

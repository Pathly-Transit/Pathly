import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

export class AccountWriteCancelled extends Error {
  constructor() { super('The account changed before this action finished'); }
}

/** Serializes mutations per key and invalidates pending work/feedback on account change. */
export function useAccountWrites(uid: string | undefined) {
  const scope = useMemo(() => ({ uid }), [uid]);
  const activeScope = useRef<typeof scope | null>(scope);
  const queues = useRef(new Map<string, Promise<unknown>>());
  useLayoutEffect(() => {
    activeScope.current = scope;
    queues.current.clear();
    return () => { if (activeScope.current === scope) activeScope.current = null; };
  }, [scope]);
  const isCurrent = useCallback(() => activeScope.current === scope && Boolean(scope.uid), [scope]);
  const run = useCallback(<Value,>(key: string, write: (owner: string) => Promise<Value>, options: { serialize?: boolean } = {}): Promise<Value> => {
    const execute = async () => {
      if (!isCurrent() || !scope.uid) throw new AccountWriteCancelled();
      const result = await write(scope.uid);
      if (!isCurrent()) throw new AccountWriteCancelled();
      return result;
    };
    // Firestore toggle writes already have an ordered offline queue; callers may dispatch an
    // undo immediately rather than wait for a server acknowledgement of the first tap.
    const previous = options.serialize === false ? undefined : queues.current.get(key);
    const task = previous ? previous.catch(() => undefined).then(execute) : execute();
    if (options.serialize === false) return task;
    queues.current.set(key, task);
    const clear = () => { if (queues.current.get(key) === task) queues.current.delete(key); };
    void task.then(clear, clear);
    return task;
  }, [isCurrent, scope]);
  return { run, isCurrent };
}

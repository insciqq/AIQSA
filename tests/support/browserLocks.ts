/** Small in-process Web Locks fixture: independent clients share this manager. */
export function createBrowserLocksFixture(): LockManager {
  type Pending = { name: string; mode: LockMode; signal?: AbortSignal; run(lock: Lock): unknown; resolve(value: unknown): void; reject(reason: unknown): void; abort(): void };
  const held: Array<{ name: string; mode: LockMode }> = [];
  const pending: Pending[] = [];
  function drain() {
    for (const request of [...pending]) {
      if (held.some(lock => lock.name === request.name && (request.mode === "exclusive" || lock.mode === "exclusive"))) continue;
      pending.splice(pending.indexOf(request), 1);
      request.signal?.removeEventListener("abort", request.abort);
      const lock = { name: request.name, mode: request.mode }; held.push(lock);
      const release = () => { held.splice(held.indexOf(lock), 1); queueMicrotask(drain); };
      try { Promise.resolve(request.run(lock)).then(request.resolve, request.reject).finally(release); }
      catch (error) { request.reject(error); release(); }
    }
  }
  return {
    query: async () => ({ held: held.map(lock => ({ ...lock })), pending: pending.map(lock => ({ name: lock.name, mode: lock.mode })) }),
    request: (name: string, options: LockOptions, callback: (lock: Lock) => unknown) => new Promise((resolve, reject) => {
      const request: Pending = { name, mode: options.mode ?? "exclusive", signal: options.signal, run: callback, resolve, reject,
        abort() { const index = pending.indexOf(request); if (index >= 0) pending.splice(index, 1); reject(new DOMException("Aborted", "AbortError")); } };
      if (options.signal?.aborted) { request.abort(); return; }
      options.signal?.addEventListener("abort", request.abort, { once: true });
      pending.push(request); queueMicrotask(drain);
    })
  } as LockManager;
}

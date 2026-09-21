import {
  ARTIFACT_BRIDGE_SCRIPT_OPEN,
  ARTIFACT_STORAGE_LIMITS,
  ARTIFACT_STORAGE_PLACEHOLDER,
  artifactStorageBytes,
  parseArtifactStorageSnapshot,
  type ArtifactStorageMessage,
  type ArtifactStorageSnapshot
} from "@/lib/contracts/artifactRuntime";

export const ARTIFACT_STATE_PREFIX = "aiqsa.artifact.state.";
const INDEX_KEY = `${ARTIFACT_STATE_PREFIX}$index`;
type StoredRecord = { entries: ArtifactStorageSnapshot; touchedAt: number; version: 1 };
type RecordEntry = { key: string; raw: string; touchedAt: number };
type Session = {
  snapshot(): ArtifactStorageSnapshot;
  apply(message: ArtifactStorageMessage, commit?: boolean): boolean;
  flush(): boolean;
  persistent: boolean;
  close(): void;
};

export function privateArtifactStateKey(artifactId: string): string {
  return `${ARTIFACT_STATE_PREFIX}${artifactId}`;
}

export async function publicArtifactStateKey(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${ARTIFACT_STATE_PREFIX}pub.${hex.slice(0, 16)}`;
}

/** Only the unique server bridge receives state; forged/duplicate markers fail closed. */
export function injectArtifactStorageSnapshot(body: string, snapshot: ArtifactStorageSnapshot): string {
  const start = body.indexOf(ARTIFACT_BRIDGE_SCRIPT_OPEN);
  const marker = body.indexOf(ARTIFACT_STORAGE_PLACEHOLDER);
  if (start < 0 || marker < start + ARTIFACT_BRIDGE_SCRIPT_OPEN.length ||
    body.indexOf(ARTIFACT_BRIDGE_SCRIPT_OPEN, start + 1) >= 0 || body.indexOf(ARTIFACT_STORAGE_PLACEHOLDER, marker + 1) >= 0) return body;
  const end = body.indexOf("</script>", start);
  if (end < 0 || marker >= end) return body;
  return body.slice(0, marker) + JSON.stringify(snapshot).replace(/</gu, "\\u003c") + body.slice(marker + ARTIFACT_STORAGE_PLACEHOLDER.length);
}

function decodeRecord(raw: string): StoredRecord {
  if (artifactStorageBytes(raw) > ARTIFACT_STORAGE_LIMITS.maxMapBytes + 512) throw new Error("invalid_artifact_state");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_artifact_state");
  const record = value as Record<string, unknown>;
  const entries = parseArtifactStorageSnapshot(record.entries);
  if (record.version !== 1 || !entries || !Number.isSafeInteger(record.touchedAt) || Number(record.touchedAt) < 0) throw new Error("invalid_artifact_state");
  return { entries, touchedAt: Number(record.touchedAt), version: 1 };
}

/** One bounded owner for this feature's records. Other application storage is never evicted. */
export function createArtifactBrowserStorage(getStorage: () => Storage = () => window.localStorage, now = Date.now,
  externallyActive: () => ReadonlySet<string> = () => new Set()) {
  const active = new Map<string, Set<(succeeded: boolean, retire: boolean, checkGeneration?: boolean) => void>>();
  let listening = false;
  const storageChanged = (event: StorageEvent) => {
    if (event.newValue !== null || event.key !== null && !event.key.startsWith(ARTIFACT_STATE_PREFIX)) return;
    try { if (event.storageArea && event.storageArea !== getStorage()) return; } catch { return; }
    // Another tab's logout/deletion must also fence late writes from this tab.
    const key = event.key === INDEX_KEY ? null : event.key;
    for (const [namespace, views] of [...active]) if (!key || namespace === key) for (const reset of [...views]) reset(false, true, key === null);
  };

  function records(storage: Storage): RecordEntry[] {
    const entries: RecordEntry[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key?.startsWith(ARTIFACT_STATE_PREFIX) || key === INDEX_KEY) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      let touchedAt = 0;
      try { touchedAt = decodeRecord(raw).touchedAt; } catch { /* Corrupt owned records are the first eviction candidates. */ }
      entries.push({ key, raw, touchedAt });
    }
    return entries;
  }

  function index(entries: readonly RecordEntry[], generation: string): string {
    return JSON.stringify({ version: 1, generation, records: entries.map(entry => [entry.key, entry.touchedAt]) });
  }

  function readGeneration(storage: Storage): string | null {
    const raw = storage.getItem(INDEX_KEY);
    if (raw === null) return null;
    if (artifactStorageBytes(raw) > ARTIFACT_STORAGE_LIMITS.maxOriginBytes) throw new Error("invalid_artifact_state");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_artifact_state");
    const header = value as Record<string, unknown>;
    if (header.version !== 1 || typeof header.generation !== "string" || !/^[a-f0-9-]{36}$/u.test(header.generation)) throw new Error("invalid_artifact_state");
    return header.generation;
  }

  function ensureGeneration(storage: Storage): string {
    const current = readGeneration(storage);
    if (current) return current;
    const generation = crypto.randomUUID();
    const entries = records(storage);
    const raw = index(entries, generation);
    const bytes = entries.reduce((sum, entry) => sum + artifactStorageBytes(entry.key) + artifactStorageBytes(entry.raw),
      artifactStorageBytes(INDEX_KEY) + artifactStorageBytes(raw));
    if (entries.length > ARTIFACT_STORAGE_LIMITS.maxRecords || bytes > ARTIFACT_STORAGE_LIMITS.maxOriginBytes) throw new Error("artifact_state_quota");
    storage.setItem(INDEX_KEY, raw);
    return generation;
  }

  function persist(key: string, snapshot: ArtifactStorageSnapshot, generation: string): boolean {
    try {
      const storage = getStorage();
      const raw = JSON.stringify({ version: 1, touchedAt: now(), entries: snapshot } satisfies StoredRecord);
      const entries = records(storage).filter(entry => entry.key !== key);
      entries.push({ key, raw, touchedAt: now() });
      const evicted: string[] = [];
      const bytes = () => entries.reduce((sum, entry) => sum + artifactStorageBytes(entry.key) + artifactStorageBytes(entry.raw),
        artifactStorageBytes(INDEX_KEY) + artifactStorageBytes(index(entries, generation)));
      while (entries.length > ARTIFACT_STORAGE_LIMITS.maxRecords || bytes() > ARTIFACT_STORAGE_LIMITS.maxOriginBytes) {
        const oldest = entries.filter(entry => entry.key !== key && !active.has(entry.key) && !externallyActive().has(entry.key))
          .sort((a, b) => a.touchedAt - b.touchedAt || a.key.localeCompare(b.key))[0];
        if (!oldest) return false;
        entries.splice(entries.indexOf(oldest), 1); evicted.push(oldest.key);
      }
      for (const removed of evicted) storage.removeItem(removed);
      const previous = storage.getItem(key);
      try {
        storage.setItem(key, raw);
        storage.setItem(INDEX_KEY, index(entries, generation));
      } catch {
        // A failed index write cannot leave a new record outside the accepted
        // budget. Keep the previous snapshot where the browser permits it.
        try { if (previous === null) storage.removeItem(key); else storage.setItem(key, previous); }
        catch { try { storage.removeItem(key); } catch {} }
        return false;
      }
      return true;
    } catch { return false; }
  }

  function open(key: string | null, onReset: (retired?: boolean) => void, allowPersistence = true): Session {
    let snapshot: ArtifactStorageSnapshot = [];
    let persistent = key !== null && allowPersistence;
    let generation: string | null = null;
    try {
      const storage = key ? getStorage() : null;
      // Even a viewer that has not written any state needs a logout fence.
      // The coordinating owner performs admission under the origin lock.
      if (storage && allowPersistence) generation = ensureGeneration(storage);
      const raw = key && storage ? storage.getItem(key) : null;
      if (raw !== null) snapshot = decodeRecord(raw).entries;
    } catch { persistent = false; }
    let closed = false;
    let retired = false;
    const reset = (succeeded: boolean, retire: boolean, checkGeneration = false) => {
      if (checkGeneration && generation) {
        // A delayed logout event must not retire a newly admitted viewer.
        try { if (readGeneration(getStorage()) === generation) return; } catch {}
      }
      retired ||= retire;
      snapshot = []; session.persistent = succeeded && key !== null && generation !== null && !retired && allowPersistence;
      // Keep the live host registered for a later explicit Reset, while
      // permanently fencing persistence after logout or artifact deletion.
      onReset(retire);
    };
    const session: Session = {
      persistent,
      snapshot: () => snapshot,
      apply(message, commit = true) {
        if (closed) return false;
        const next = new Map(snapshot);
        if (message.type === "aiqsa_artifact_storage_clear") next.clear();
        else if (message.type === "aiqsa_artifact_storage_remove") next.delete(message.key);
        else next.set(message.key, message.value);
        const checked = parseArtifactStorageSnapshot([...next]);
        if (!checked) return session.persistent;
        snapshot = checked;
        session.persistent = commit && session.flush();
        return session.persistent;
      },
      flush() {
        if (!closed && !retired && allowPersistence && generation) {
          try {
            // Storage events are asynchronous. Check the shared fence while
            // holding the origin lock, before an old tab can recreate state.
            if (readGeneration(getStorage()) !== generation) reset(false, true);
          } catch { session.persistent = false; return false; }
        }
        session.persistent = !closed && !retired && allowPersistence && key !== null && generation !== null && persist(key, snapshot, generation);
        return session.persistent;
      },
      close() {
        if (closed) return;
        closed = true;
        if (key) {
          const views = active.get(key); views?.delete(reset);
          if (!views?.size) active.delete(key);
        }
        if (listening && active.size === 0) { window.removeEventListener("storage", storageChanged); listening = false; }
      }
    };
    if (key) {
      const views = active.get(key) ?? new Set(); views.add(reset); active.set(key, views);
      if (!listening && typeof window !== "undefined") { window.addEventListener("storage", storageChanged); listening = true; }
    }
    return session;
  }

  function clear(key?: string, retire = false): boolean {
    let succeeded = true;
    try {
      const storage = getStorage();
      if (key) storage.removeItem(key);
      else {
        const keys: string[] = [];
        for (let i = 0; i < storage.length; i += 1) {
          const candidate = storage.key(i);
          if (candidate?.startsWith(ARTIFACT_STATE_PREFIX)) keys.push(candidate);
        }
        for (const candidate of keys) storage.removeItem(candidate);
      }
      if (key) {
        const generation = readGeneration(storage);
        // A targeted reset must not impersonate logout for unrelated viewers.
        if (generation) storage.setItem(INDEX_KEY, index(records(storage), generation));
      }
    } catch { succeeded = false; }
    for (const [namespace, views] of [...active]) if (!key || namespace === key) for (const reset of [...views]) reset(succeeded, retire);
    return succeeded;
  }

  return { open, clear };
}

const ORIGIN_LOCK = "aiqsa.artifact.storage";
const VIEW_LOCK = "aiqsa.artifact.viewer:";
type BrowserSession = Omit<Session, "apply" | "flush"> & { apply(message: ArtifactStorageMessage): Promise<boolean> };

/** Hold shared locks for live viewers; serialize all origin writes and viewer
 * admission, so eviction cannot race a newly opened viewer in another tab. */
export function createCoordinatedArtifactBrowserStorage(
  getLocks: () => LockManager | undefined = () => navigator.locks,
  getStorage: () => Storage = () => window.localStorage,
  now = Date.now
) {
  let protectedKeys: ReadonlySet<string> = new Set();
  const core = createArtifactBrowserStorage(getStorage, now, () => protectedKeys);
  function exclusive<T>(locks: LockManager, action: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    return locks.request(ORIGIN_LOCK, { mode: "exclusive", signal: controller.signal }, () => action(controller.signal))
      .finally(() => clearTimeout(deadline));
  }
  function memorySession(key: string | null, onReset: () => void): BrowserSession {
    const session = core.open(key, onReset, false);
    return { get persistent() { return false; }, snapshot: session.snapshot, close: session.close,
      apply: async message => session.apply(message) };
  }

  async function open(key: string | null, onReset: () => void): Promise<BrowserSession> {
    let locks: LockManager | undefined;
    try { locks = getLocks(); } catch { /* Browser policy can deny this API. */ }
    if (!key || !locks) return memorySession(key, onReset);
    const manager = locks;
    let release: (() => void) | undefined;
    let session: Session;
    try {
      session = await exclusive(manager, async signal => {
        await new Promise<void>((resolve, reject) => {
          void manager.request(`${VIEW_LOCK}${key}`, { mode: "shared", signal }, () => new Promise<void>(done => {
            release = done; resolve();
          })).catch(reject);
        });
        return core.open(key, retired => { if (retired) release?.(); onReset(); });
      });
    } catch { release?.(); return memorySession(key, onReset); }
    let closing = false;
    let pendingWrites = 0;
    const finishClose = () => {
      if (closing && pendingWrites === 0) { session.close(); release?.(); }
    };
    return {
      get persistent() { return session.persistent; },
      snapshot: session.snapshot,
      close() { closing = true; finishClose(); },
      async apply(message) {
        if (closing) return false;
        // The shim is synchronous. Keep its accepted map even when browser
        // coordination fails, so a later successful save includes every key.
        session.apply(message, false);
        pendingWrites += 1;
        try {
          return await exclusive(manager, async () => {
            const observed = await manager.query();
            protectedKeys = new Set((observed.held ?? []).flatMap(lock => lock.mode === "shared" && lock.name?.startsWith(VIEW_LOCK) ? [lock.name.slice(VIEW_LOCK.length)] : []));
            return session.flush();
          });
        } catch { session.persistent = false; return false; }
        finally {
          // Switching versions can unmount the host before its origin lock is
          // granted. Drain already accepted writes with their logout fence.
          pendingWrites -= 1; finishClose();
        }
      }
    };
  }

  async function clear(key?: string, retire = false): Promise<boolean> {
    try {
      const locks = getLocks();
      if (locks) return await exclusive(locks, () => core.clear(key, retire));
    } catch { /* Deletion remains best effort when storage coordination fails. */ }
    return core.clear(key, retire);
  }
  return { open, clear };
}

export const artifactBrowserStorage = createCoordinatedArtifactBrowserStorage();
export function resetArtifactSavedState(artifactId: string): Promise<boolean> { return artifactBrowserStorage.clear(privateArtifactStateKey(artifactId)); }
export async function deleteArtifactSavedState(artifactId: string): Promise<void> { await artifactBrowserStorage.clear(privateArtifactStateKey(artifactId), true); }
export async function clearAllArtifactSavedState(): Promise<void> { await artifactBrowserStorage.clear(undefined, true); }

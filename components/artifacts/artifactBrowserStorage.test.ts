import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserLocksFixture } from "@/tests/support/browserLocks";
import { ARTIFACT_BRIDGE_SCRIPT_OPEN, ARTIFACT_STORAGE_LIMITS, ARTIFACT_STORAGE_PLACEHOLDER, artifactStorageBytes } from "@/lib/contracts/artifactRuntime";
import { ARTIFACT_STATE_PREFIX, createArtifactBrowserStorage, createCoordinatedArtifactBrowserStorage, injectArtifactStorageSnapshot, privateArtifactStateKey, publicArtifactStateKey } from "./artifactBrowserStorage";

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return { get length() { return entries.size; }, key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); }, clear: () => entries.clear() };
}
const set = (key: string, value: string) => ({ type: "aiqsa_artifact_storage_set" as const, key, value });
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

describe("artifact browser storage", () => {
  it("drains an accepted write before an immediately opened replacement reads its state", async () => {
    const storage = memoryStorage(); const locks = createBrowserLocksFixture();
    const owner = createCoordinatedArtifactBrowserStorage(() => locks, () => storage);
    const key = privateArtifactStateKey("quick-version-switch");
    const first = await owner.open(key, () => {});
    const pending = first.apply(set("level", "7"));
    first.close(); first.close();
    expect(await first.apply(set("late", "rejected"))).toBe(false);
    const replacement = await owner.open(key, () => {});
    expect(await pending).toBe(true);
    expect(replacement.snapshot()).toEqual([["level", "7"]]);
    replacement.close();
  });
  it("keeps queued writes fenced when another tab logs out before a closing viewer can flush", async () => {
    const storage = memoryStorage(); const locks = createBrowserLocksFixture();
    const owner = createCoordinatedArtifactBrowserStorage(() => locks, () => storage);
    const otherTab = createCoordinatedArtifactBrowserStorage(() => locks, () => storage);
    const view = await owner.open(privateArtifactStateKey("closing-at-logout"), () => {});
    const logout = otherTab.clear(undefined, true);
    const pending = view.apply(set("late", "must not survive"));
    view.close();
    expect(await logout).toBe(true);
    expect(await pending).toBe(false);
    expect(storage.length).toBe(0);
  });
  it("keeps an unrelated empty viewer writable when the last saved artifact is reset in another tab", async () => {
    const storage = memoryStorage(); const locks = createBrowserLocksFixture();
    const firstTab = createCoordinatedArtifactBrowserStorage(() => locks, () => storage);
    const secondTab = createCoordinatedArtifactBrowserStorage(() => locks, () => storage);
    const key = privateArtifactStateKey("last-saved"); const emptyKey = privateArtifactStateKey("empty-view");
    const saved = await firstTab.open(key, () => {});
    const resetEmpty = vi.fn(); const empty = await secondTab.open(emptyKey, resetEmpty);
    expect(await saved.apply(set("score", "1"))).toBe(true);
    const removed: string[] = []; const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = candidate => { removed.push(candidate); removeItem(candidate); };
    expect(await firstTab.clear(key)).toBe(true);
    for (const candidate of removed) window.dispatchEvent(new StorageEvent("storage", { key: candidate, newValue: null }));
    expect(removed).toEqual([key]);
    expect(resetEmpty).not.toHaveBeenCalled();
    expect(empty.persistent).toBe(true);
    expect(await empty.apply(set("score", "2"))).toBe(true);
    expect(storage.getItem(emptyKey)).toContain('"score","2"');
    saved.close(); empty.close();
  });
  it("fences an empty old tab before a delayed logout event, without retiring a new viewer admitted afterward", async () => {
    const storage = memoryStorage(); const locks = createBrowserLocksFixture();
    const firstTab = createCoordinatedArtifactBrowserStorage(() => locks, () => storage);
    const secondTab = createCoordinatedArtifactBrowserStorage(() => locks, () => storage);
    const oldReset = vi.fn(); const newReset = vi.fn(); const key = privateArtifactStateKey("empty-at-logout");
    const old = await secondTab.open(key, oldReset);
    expect(old.persistent).toBe(true);
    expect(await firstTab.clear(undefined, true)).toBe(true);
    expect(storage.length).toBe(0);
    // Deliberately deliver the cross-tab storage event after the pending write.
    expect(await old.apply(set("late", "must not return after logout"))).toBe(false);
    expect(oldReset).toHaveBeenCalledOnce();
    expect(storage.length).toBe(0);
    const fresh = await firstTab.open(privateArtifactStateKey("new-session"), newReset);
    window.dispatchEvent(new StorageEvent("storage", { key: ARTIFACT_STATE_PREFIX + "$index", newValue: null }));
    expect(newReset).not.toHaveBeenCalled();
    expect(await fresh.apply(set("new", "allowed"))).toBe(true);
    expect(await old.apply(set("late-again", "still fenced"))).toBe(false);
    expect(storage.getItem(key)).toBeNull();
    old.close(); fresh.close();
  });
  it("serializes concurrent tabs and protects a different tab's active artifact from eviction", async () => {
    const storage = memoryStorage(); const locks = createBrowserLocksFixture(); let time = 0;
    const seed = createArtifactBrowserStorage(() => storage, () => ++time);
    for (let index = 0; index < 50; index += 1) {
      const view = seed.open(privateArtifactStateKey(String(index)), () => {});
      view.apply(set("level", String(index))); view.close();
    }
    const firstTab = createCoordinatedArtifactBrowserStorage(() => locks, () => storage, () => ++time);
    const secondTab = createCoordinatedArtifactBrowserStorage(() => locks, () => storage, () => ++time);
    const protectedView = await firstTab.open(privateArtifactStateKey("0"), () => {});
    const [first, second] = await Promise.all([
      firstTab.open(privateArtifactStateKey("new-a"), () => {}),
      secondTab.open(privateArtifactStateKey("new-b"), () => {})
    ]);
    expect(await Promise.all([first.apply(set("value", "a")), second.apply(set("value", "b"))])).toEqual([true, true]);
    expect(storage.getItem(privateArtifactStateKey("0"))).not.toBeNull();
    expect(storage.getItem(privateArtifactStateKey("1"))).toBeNull();
    expect(storage.getItem(privateArtifactStateKey("2"))).toBeNull();
    expect(storage.length).toBe(51); // 50 artifact records and their bounded index.
    protectedView.close(); first.close(); second.close();
  });
  it("keeps a full in-memory map through unavailable coordination and retries without losing earlier keys", async () => {
    const storage = memoryStorage(); const locks = createBrowserLocksFixture();
    const query = locks.query.bind(locks);
    locks.query = vi.fn().mockRejectedValueOnce(new DOMException("Denied", "SecurityError")).mockImplementation(query);
    const owner = createCoordinatedArtifactBrowserStorage(() => locks, () => storage);
    const view = await owner.open(privateArtifactStateKey("retry"), () => {});
    expect(await view.apply(set("first", "retained"))).toBe(false);
    expect(view.snapshot()).toEqual([["first", "retained"]]);
    expect(await view.apply(set("second", "saved"))).toBe(true);
    expect(storage.getItem(privateArtifactStateKey("retry"))).toContain('"first","retained"');
    view.close();
    const unsupported = createCoordinatedArtifactBrowserStorage(() => undefined, () => storage);
    const memory = await unsupported.open(privateArtifactStateKey("memory"), () => {});
    expect(memory.persistent).toBe(false);
    expect(await memory.apply(set("only", "memory"))).toBe(false);
    expect(memory.snapshot()).toEqual([["only", "memory"]]);
    expect(storage.getItem(privateArtifactStateKey("memory"))).toBeNull();
    await unsupported.clear(privateArtifactStateKey("memory"));
    expect(memory.snapshot()).toEqual([]); memory.close();
  });
  it("restores an artifact across versions and keeps public and private namespaces distinct without persisting tokens", async () => {
    const digest = vi.fn().mockResolvedValue(new Uint8Array(32).fill(1).buffer);
    vi.stubGlobal("crypto", { randomUUID: crypto.randomUUID.bind(crypto), subtle: { digest } });
    const storage = memoryStorage();
    const owner = createArtifactBrowserStorage(() => storage);
    const key = privateArtifactStateKey("artifact");
    const first = owner.open(key, () => {});
    expect(first.apply(set("level", "7"))).toBe(true); first.close();
    const nextVersion = owner.open(key, () => {});
    expect(nextVersion.snapshot()).toEqual([["level", "7"]]);
    const publicKey = await publicArtifactStateKey("opaque-publication-token");
    expect(publicKey).toMatch(/^aiqsa\.artifact\.state\.pub\.[a-f0-9]{16}$/u);
    expect(publicKey).not.toContain("opaque-publication-token");
    expect(digest).toHaveBeenCalledWith("SHA-256", new TextEncoder().encode("opaque-publication-token"));
    expect(await publicArtifactStateKey("opaque-publication-token")).toBe(publicKey);
    digest.mockResolvedValueOnce(new Uint8Array(32).fill(2).buffer);
    expect(await publicArtifactStateKey("reissued-token")).not.toBe(publicKey);
    const publicView = owner.open(publicKey, () => {});
    expect(publicView.snapshot()).toEqual([]);
    expect(publicView.apply(set("level", "2"))).toBe(true);
    expect(nextVersion.snapshot()).toEqual([["level", "7"]]);
    nextVersion.close(); publicView.close();
  });
  it("counts UTF-16 record keys, values and the index, evicting old inactive records only", () => {
    const storage = memoryStorage(); storage.setItem("another-feature", "keep me");
    let time = 0;
    const owner = createArtifactBrowserStorage(() => storage, () => ++time);
    const activeKey = privateArtifactStateKey("active");
    const active = owner.open(activeKey, () => {});
    active.apply(set("level", "still playing"));
    for (let i = 0; i < 55; i += 1) {
      const session = owner.open(privateArtifactStateKey(`record-${i}`), () => {});
      expect(session.apply(set("value", "x".repeat(16_000)))).toBe(true); session.close();
    }
    expect(storage.getItem(activeKey)).not.toBeNull();
    expect(storage.getItem(privateArtifactStateKey("record-0"))).toBeNull();
    expect(storage.getItem("another-feature")).toBe("keep me");
    let bytes = 0; let count = 0;
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)!;
      if (!key.startsWith(ARTIFACT_STATE_PREFIX)) continue;
      bytes += artifactStorageBytes(key) + artifactStorageBytes(storage.getItem(key)!);
      if (!key.endsWith("$index")) count += 1;
    }
    expect(bytes).toBeLessThanOrEqual(ARTIFACT_STORAGE_LIMITS.maxOriginBytes);
    expect(count).toBeLessThanOrEqual(50);
    active.close();
  });
  it("protects every active map at the origin record limit and keeps rejected persistence in memory", () => {
    const storage = memoryStorage();
    const owner = createArtifactBrowserStorage(() => storage);
    const views = Array.from({ length: 50 }, (_, index) => {
      const view = owner.open(privateArtifactStateKey(String(index)), () => {});
      expect(view.apply(set("a", "b"))).toBe(true); return view;
    });
    const overflow = owner.open(privateArtifactStateKey("overflow"), () => {});
    expect(overflow.apply(set("progress", "still here"))).toBe(false);
    expect(overflow.snapshot()).toEqual([["progress", "still here"]]);
    views[0]!.close();
    expect(overflow.apply(set("progress", "can save now"))).toBe(true);
    views.forEach(view => view.close()); overflow.close();
  });
  it("evicts by the byte budget before reaching the record limit, retaining active games", () => {
    const storage = memoryStorage(); let time = 0;
    const owner = createArtifactBrowserStorage(() => storage, () => ++time);
    const active = owner.open(privateArtifactStateKey("active"), () => {});
    active.apply(set("level", "1"));
    for (let index = 0; index < 10; index += 1) {
      const view = owner.open(privateArtifactStateKey(`large-${index}`), () => {});
      for (let slot = 0; slot < 7; slot += 1) expect(view.apply(set(String(slot), "😀".repeat(8192)))).toBe(true);
      view.close();
    }
    let bytes = 0;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)!;
      bytes += artifactStorageBytes(key) + artifactStorageBytes(storage.getItem(key)!);
    }
    expect(storage.length).toBeLessThan(50);
    expect(bytes).toBeLessThanOrEqual(ARTIFACT_STORAGE_LIMITS.maxOriginBytes);
    expect(storage.getItem(privateArtifactStateKey("large-0"))).toBeNull();
    expect(storage.getItem(privateArtifactStateKey("active"))).not.toBeNull();
    active.close();
  });
  it("survives inaccessible, full or malformed storage and never accepts an oversized map", () => {
    const denied = createArtifactBrowserStorage(() => { throw new DOMException("Denied", "SecurityError"); });
    const view = denied.open(privateArtifactStateKey("a"), () => {});
    expect(view.persistent).toBe(false);
    expect(view.apply(set("safe", "in memory"))).toBe(false);
    expect(view.snapshot()).toEqual([["safe", "in memory"]]);
    const storage = memoryStorage();
    storage.setItem(privateArtifactStateKey("broken"), "{bad");
    const owner = createArtifactBrowserStorage(() => storage);
    const broken = owner.open(privateArtifactStateKey("broken"), () => {});
    expect(broken.persistent).toBe(false); expect(broken.snapshot()).toEqual([]);
    storage.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); };
    expect(broken.apply(set("x", "retained"))).toBe(false);
    expect(broken.snapshot()).toEqual([["x", "retained"]]);
    broken.apply(set("huge", "x".repeat(32_769)));
    expect(broken.snapshot()).toEqual([["x", "retained"]]);
    view.close(); broken.close();
  });
  it("resets live views, and logout removes only artifact records and retires late messages", () => {
    const storage = memoryStorage(); storage.setItem("theme", "dark");
    const owner = createArtifactBrowserStorage(() => storage);
    const key = privateArtifactStateKey("a"); const reset = vi.fn();
    const view = owner.open(key, reset); view.apply(set("level", "3"));
    expect(owner.clear(key)).toBe(true);
    expect(reset).toHaveBeenCalledOnce(); expect(view.snapshot()).toEqual([]);
    expect(view.apply(set("level", "1"))).toBe(true);
    expect(owner.clear(undefined, true)).toBe(true);
    expect(view.apply(set("late", "cannot return"))).toBe(false);
    expect(storage.length).toBe(1); expect(storage.getItem("theme")).toBe("dark");
    view.close();
  });
  it("retires a running view when another browser tab removes its saved state", () => {
    const owner = createArtifactBrowserStorage(() => localStorage);
    const key = privateArtifactStateKey("another-tab"); const reset = vi.fn();
    const view = owner.open(key, reset); view.apply(set("level", "4"));
    localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: null, storageArea: localStorage }));
    expect(reset).toHaveBeenCalledOnce(); expect(view.snapshot()).toEqual([]);
    expect(view.apply(set("late", "not persisted"))).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
    expect(owner.clear(key)).toBe(true);
    expect(reset).toHaveBeenCalledTimes(2); expect(view.snapshot()).toEqual([]);
    expect(view.apply(set("after-reset", "still memory only"))).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
    view.close();
  });
  it("escapes state before placing it only inside the unique server bridge", () => {
    const html = `${ARTIFACT_BRIDGE_SCRIPT_OPEN}const state=${ARTIFACT_STORAGE_PLACEHOLDER};</script><p>Artifact</p>`;
    const snapshot = [["saved", '</script><script>window.stolen=true</script>']] as const;
    const result = injectArtifactStorageSnapshot(html, snapshot);
    expect(result).toContain('\\u003c/script>\\u003cscript>');
    expect(result.match(/<script/gu)).toHaveLength(1);
    expect(injectArtifactStorageSnapshot(html + ARTIFACT_STORAGE_PLACEHOLDER, snapshot)).toBe(html + ARTIFACT_STORAGE_PLACEHOLDER);
    expect(injectArtifactStorageSnapshot(`${ARTIFACT_BRIDGE_SCRIPT_OPEN}</script>${html}`, snapshot)).toBe(`${ARTIFACT_BRIDGE_SCRIPT_OPEN}</script>${html}`);
  });
});

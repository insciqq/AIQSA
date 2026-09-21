import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_STORAGE_PLACEHOLDER } from "../../contracts/artifactRuntime";
import { ARTIFACT_RUNTIME_BRIDGE } from "./runtimeBridge";

function bridge(initial: Array<[string, string]> = []) {
  const postMessage = vi.fn();
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const destination = { scrollIntoView: vi.fn() };
  const document = { addEventListener: (name: string, action: (event: Record<string, unknown>) => void) => listeners.set(name, action),
    getElementById: vi.fn((id: string) => id === "section name" ? destination : null), getElementsByName: vi.fn(() => []) };
  const window = { addEventListener: vi.fn(), scrollTo: vi.fn() } as unknown as Window;
  // Execute the shipped source with isolated browser facades, including its
  // synchronous quota behavior; there are no network or provider calls.
  new Function("window", "document", "parent", "DOMException", "URL", ARTIFACT_RUNTIME_BRIDGE.replace(
    ARTIFACT_STORAGE_PLACEHOLDER, JSON.stringify(initial).replaceAll("<", "\\u003c")
  ))(window, document, { postMessage }, DOMException, URL);
  return { window, document, destination, postMessage, listeners };
}

describe("artifact sandbox bridge", () => {
  it("initializes opaque state synchronously, preserves special keys and keeps sessions private", () => {
    const h = bridge([["__proto__", "</script><script>synthetic()</script>"]]);
    expect(h.window.localStorage.getItem("__proto__")).toBe("</script><script>synthetic()</script>");
    h.window.localStorage.setItem("constructor", "value");
    expect(h.window.localStorage.length).toBe(2);
    expect(h.window.localStorage.key(0)).toBe("__proto__");
    expect(h.postMessage).toHaveBeenCalledWith({ type: "aiqsa_artifact_storage_set", key: "constructor", value: "value" }, "*");
    h.postMessage.mockClear();
    h.window.sessionStorage.setItem("temporary", "private");
    expect(h.window.sessionStorage.getItem("temporary")).toBe("private");
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(Reflect.get(h.document, "cookie")).toBe("");
    Reflect.set(h.document, "cookie", "synthetic=value");
    expect(Reflect.get(h.document, "cookie")).toBe("");
  });

  it("rejects UTF-16/map/count quota before mutating values or notifying the parent", () => {
    const h = bridge();
    const store = h.window.localStorage;
    store.setItem("key", "old"); h.postMessage.mockClear();
    expect(() => store.setItem("key", "🙂".repeat(8193))).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(store.getItem("key")).toBe("old");
    expect(h.postMessage).not.toHaveBeenCalled();
    store.clear();
    for (let i = 0; i < 64; i++) store.setItem(String(i), "");
    expect(() => store.setItem("one-too-many", "")).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(store.length).toBe(64);
    store.clear();
    for (let i = 0; i < 7; i++) store.setItem(String(i), "a".repeat(16384));
    expect(() => store.setItem("eighth", "a".repeat(16384))).toThrow(expect.objectContaining({ name: "QuotaExceededError" }));
    expect(store.length).toBe(7);
  });

  it("mediates clicks, Enter and window.open while leaving fragment links and local downloads usable", () => {
    const h = bridge();
    const event = (href: string, type: string, download = false) => ({ type, key: "Enter", preventDefault: vi.fn(),
      target: { closest: () => ({ getAttribute: () => href, hasAttribute: () => download }) } });
    for (const type of ["click", "keydown"]) {
      const e = event("https://example.invalid/path", type);
      h.listeners.get(type)!(e);
      expect(e.preventDefault).toHaveBeenCalledOnce();
    }
    expect(h.postMessage).toHaveBeenCalledTimes(2);
    expect(h.window.open("mailto:person@example.invalid")).toBeNull();
    expect(h.postMessage).toHaveBeenLastCalledWith({ type: "aiqsa_artifact_open_link", href: "mailto:person@example.invalid" }, "*");
    const fragment = event("#section%20name", "click"); h.listeners.get("click")!(fragment);
    expect(fragment.preventDefault).toHaveBeenCalledOnce();
    expect(h.destination.scrollIntoView).toHaveBeenCalledOnce();
    const top = event("#top", "keydown"); h.listeners.get("keydown")!(top);
    expect(top.preventDefault).toHaveBeenCalledOnce();
    expect(h.window.scrollTo).toHaveBeenCalledWith(0, 0);
    const download = event("blob:null/synthetic", "click", true); h.listeners.get("click")!(download);
    expect(download.preventDefault).not.toHaveBeenCalled();
    const bad = event("/api/private", "click"); h.listeners.get("click")!(bad);
    expect(bad.preventDefault).toHaveBeenCalledOnce();
    h.window.open("javascript:synthetic()");
    expect(h.postMessage).toHaveBeenCalledTimes(3);
  });
});

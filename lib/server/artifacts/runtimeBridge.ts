import { ARTIFACT_STORAGE_LIMITS, ARTIFACT_STORAGE_PLACEHOLDER } from "../../contracts/artifactRuntime";

/** Server-owned code runs before any authored script. The single state marker
 * is filled only by the viewer; shared render caches always retain empty data. */
export const ARTIFACT_RUNTIME_BRIDGE = String.raw`(() => {
  const initial = ${ARTIFACT_STORAGE_PLACEHOLDER};
  const limits = ${JSON.stringify(ARTIFACT_STORAGE_LIMITS)};
  const send = value => { try { parent.postMessage(value, "*"); } catch {} };
  const storage = (entries, persistent) => {
    let values = new Map(entries);
    const api = Object.create(null);
    const fits = next => next.size <= limits.maxKeys &&
      [...next].every(([key, value]) => key.length <= limits.maxKeyCharacters && value.length * 2 <= limits.maxValueBytes) &&
      JSON.stringify([...next]).length * 2 <= limits.maxMapBytes;
    if (!fits(values)) values = new Map();
    Object.defineProperties(api, {
      length: { get: () => values.size },
      getItem: { value: key => values.get(String(key)) ?? null },
      key: { value: index => [...values.keys()][Number(index) >>> 0] ?? null },
      setItem: { value: (key, value) => {
        key = String(key); value = String(value);
        const next = new Map(values); next.set(key, value);
        if (!fits(next)) throw new DOMException("Artifact storage quota exceeded", "QuotaExceededError");
        values = next;
        if (persistent) send({ type: "aiqsa_artifact_storage_set", key, value });
      } },
      removeItem: { value: key => {
        key = String(key); values.delete(key);
        if (persistent) send({ type: "aiqsa_artifact_storage_remove", key });
      } },
      clear: { value: () => {
        values.clear();
        if (persistent) send({ type: "aiqsa_artifact_storage_clear" });
      } }
    });
    return api;
  };
  try { Object.defineProperty(window, "localStorage", { value: storage(initial, true) }); } catch {}
  try { Object.defineProperty(window, "sessionStorage", { value: storage([], false) }); } catch {}
  try { Object.defineProperty(document, "cookie", { get: () => "", set: () => {} }); } catch {}
  const link = value => {
    if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const url = new URL(value);
      return ["http:", "https:", "mailto:"].includes(url.protocol) && url.href.length <= 2048 ? url.href : null;
    } catch { return null; }
  };
  const open = value => { const href = link(value); if (href) send({ type: "aiqsa_artifact_open_link", href }); };
  const intercept = event => {
    if (event.type === "keydown" && event.key !== "Enter") return;
    const target = event.target?.closest?.("a[href]");
    if (!target) return;
    const raw = target.getAttribute("href") || "";
    if (raw.startsWith("#")) {
      // srcdoc resolves relative links against its parent's URL. Scroll here
      // instead of navigating the opaque frame to an application route.
      event.preventDefault();
      let fragment = raw.slice(1);
      try { fragment = decodeURIComponent(fragment); } catch {}
      const destination = document.getElementById(fragment) || document.getElementsByName(fragment)[0];
      if (destination) destination.scrollIntoView();
      else if (!fragment || fragment.toLowerCase() === "top") window.scrollTo(0, 0);
      return;
    }
    // Blob downloads remain local. Other navigation always goes through the host.
    if (target.hasAttribute("download") && /^(blob:|data:)/.test(raw)) return;
    event.preventDefault();
    open(raw);
  };
  document.addEventListener("click", intercept, true);
  document.addEventListener("keydown", intercept, true);
  try { Object.defineProperty(window, "open", { value: value => { open(String(value)); return null; } }); } catch {}
  let reported = false;
  const clean = (value, max) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
  const position = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const report = details => {
    if (reported) return;
    reported = true;
    send({ type: "aiqsa_artifact_runtime_error", ...details });
  };
  window.addEventListener("error", event => report({ kind: "error", message: clean(event.message, 300), line: position(event.lineno), column: position(event.colno) }), { once: true });
  window.addEventListener("unhandledrejection", event => {
    let message = "Unhandled promise rejection";
    try { message = typeof event.reason === "string" ? event.reason : event.reason?.message || message; } catch {}
    report({ kind: "unhandledrejection", message: clean(message, 300), line: 0, column: 0 });
  }, { once: true });
  window.addEventListener("securitypolicyviolation", event => {
    let blocked = "unknown";
    const value = String(event.blockedURI || "");
    if (["inline", "eval"].includes(value)) blocked = value;
    else if (/^(data|blob):/.test(value)) blocked = value.split(":")[0];
    else try { const url = new URL(value); if (/^https?:$/.test(url.protocol)) blocked = url.origin; } catch {}
    report({ kind: "csp", message: "Blocked resource", line: position(event.lineNumber), column: position(event.columnNumber), directive: clean(event.effectiveDirective, 64), blocked: clean(blocked, 128) });
  }, { once: true });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented) send({ type: "aiqsa_artifact_escape" });
  });
})();`;

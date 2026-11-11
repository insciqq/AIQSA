import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientErrorReportRequest } from "../contracts/clientErrors";
import {
  CLIENT_ERROR_PAGE_BUDGET,
  createClientErrorReporter,
  installClientErrorListeners
} from "./clientErrorReporter";

function errorEvent(init: ErrorEventInit): ErrorEvent {
  return new ErrorEvent("error", { cancelable: true, ...init });
}

function rejection(reason: unknown): Event {
  // jsdom has no PromiseRejectionEvent constructor.
  return Object.assign(new Event("unhandledrejection"), { promise: Promise.resolve(), reason });
}

function chunkError(): Error {
  const error = new Error("Loading chunk 4821 failed.\n(missing: https://aiqsa.example/_next/static/chunks/4821.js)");
  error.name = "ChunkLoadError";
  return error;
}

function install() {
  const sent: ClientErrorReportRequest[] = [];
  const reporter = createClientErrorReporter({ pathname: () => "/c/private-chat", send: (report) => sent.push(report) });
  const uninstall = installClientErrorListeners(window, reporter);
  return { reporter, sent, uninstall };
}

describe("client error reporter", () => {
  let uninstall: (() => void) | undefined;
  // Synthetic error events stay inside the test instead of failing the run.
  const swallow = (event: Event) => event.preventDefault();
  beforeEach(() => window.addEventListener("error", swallow));
  afterEach(() => {
    window.removeEventListener("error", swallow);
    uninstall?.();
    uninstall = undefined;
  });

  it("classifies uncaught errors, rejections and stale-deploy chunk failures without their content", () => {
    const h = install();
    uninstall = h.uninstall;
    const origin = window.location.origin;
    window.dispatchEvent(errorEvent({ error: new TypeError("private canary"), filename: `${origin}/_next/static/chunks/app.js`, message: "private canary" }));
    window.dispatchEvent(rejection(new Error("private canary")));
    window.dispatchEvent(rejection(chunkError()));
    window.dispatchEvent(errorEvent({ error: new TypeError("Failed to fetch dynamically imported module: /x.js"), filename: `${origin}/a.js` }));
    const plain = { dom_conflict: false, page_translated: false };
    expect(h.sent).toEqual([
      { kind: "error", pathname: "/c/private-chat", error_name: "TypeError", ...plain },
      { kind: "unhandled_rejection", pathname: "/c/private-chat", error_name: "Error", ...plain },
      { kind: "chunk_load", pathname: "/c/private-chat", error_name: "other", ...plain },
      { kind: "chunk_load", pathname: "/c/private-chat", error_name: "TypeError", ...plain }
    ]);
    expect(JSON.stringify(h.sent)).not.toContain("canary");
  });

  it("ignores extensions, cross-origin scripts, aborted requests and ResizeObserver noise", () => {
    const h = install();
    uninstall = h.uninstall;
    const extension = new Error("boom");
    extension.stack = "Error: boom\n    at chrome-extension://abcdef/content.js:1:1";
    window.dispatchEvent(errorEvent({ error: new Error("x"), filename: "https://cdn.elsewhere.example/lib.js" }));
    window.dispatchEvent(errorEvent({ error: new Error("x"), filename: "moz-extension://abc/script.js" }));
    window.dispatchEvent(errorEvent({ error: extension, filename: "" }));
    window.dispatchEvent(errorEvent({ error: null, filename: "", message: "Script error." }));
    window.dispatchEvent(errorEvent({ error: null, message: "ResizeObserver loop completed with undelivered notifications." }));
    window.dispatchEvent(rejection(new DOMException("The user aborted a request.", "AbortError")));
    window.dispatchEvent(rejection(extension));
    expect(h.sent).toEqual([]);
  });

  it("sends at most one report per error object and stops at the page budget", () => {
    const sent: ClientErrorReportRequest[] = [];
    const reporter = createClientErrorReporter({ pathname: () => undefined, send: (report) => sent.push(report) });
    const error = new Error("same");
    reporter.report("render", error);
    reporter.report("render", error);
    expect(sent).toEqual([{ kind: "render", error_name: "Error", dom_conflict: false, page_translated: false }]);
    for (let index = 0; index < CLIENT_ERROR_PAGE_BUDGET + 3; index += 1) reporter.report("error", new Error(String(index)));
    expect(sent).toHaveLength(CLIENT_ERROR_PAGE_BUDGET);
  });

  it("posts a keepalive same-origin report and ignores a refused one", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      createClientErrorReporter().report("render");
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("/api/client-errors", expect.objectContaining({
        credentials: "same-origin", keepalive: true, method: "POST"
      }));
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        kind: "render", pathname: window.location.pathname, error_name: "other", dom_conflict: false, page_translated: false
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names React's DOM conflicts on a translated page without sending the message", () => {
    const sent: ClientErrorReportRequest[] = [];
    const reporter = createClientErrorReporter({ budget: 10, pathname: () => "/login", send: (report) => sent.push(report) });
    const root = document.documentElement;
    const lang = root.getAttribute("lang");
    try {
      root.classList.add("translated-ltr");
      reporter.report("render", new DOMException(
        "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node. private canary",
        "NotFoundError"
      ));
      root.classList.remove("translated-ltr");
      root.setAttribute("lang", "ru");
      reporter.report("render", new DOMException("Node.removeChild: The node to be removed is not a child of this node", "NotFoundError"));
      root.setAttribute("lang", "en");
      reporter.report("render", new DOMException("The object can not be found here.", "NotFoundError"));
      reporter.report("render", new DOMException("Failed to execute 'appendChild' on 'Node': private canary", "HierarchyRequestError"));
      const custom = new Error("private canary");
      custom.name = "PrivateCanaryError";
      reporter.report("error", custom);
      reporter.report("unhandled_rejection", "private canary");
    } finally {
      root.classList.remove("translated-ltr");
      if (lang === null) root.removeAttribute("lang");
      else root.setAttribute("lang", lang);
    }
    expect(sent).toEqual([
      { kind: "render", pathname: "/login", error_name: "NotFoundError", dom_conflict: true, page_translated: true },
      { kind: "render", pathname: "/login", error_name: "NotFoundError", dom_conflict: true, page_translated: true },
      { kind: "render", pathname: "/login", error_name: "NotFoundError", dom_conflict: true, page_translated: false },
      { kind: "render", pathname: "/login", error_name: "HierarchyRequestError", dom_conflict: true, page_translated: false },
      { kind: "error", pathname: "/login", error_name: "other", dom_conflict: false, page_translated: false },
      { kind: "unhandled_rejection", pathname: "/login", error_name: "other", dom_conflict: false, page_translated: false }
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/canary|insertBefore|removeChild|child of this node/u);
  });

  it("stops listening after cleanup", () => {
    const h = install();
    h.uninstall();
    window.dispatchEvent(errorEvent({ error: new Error("late"), filename: `${window.location.origin}/a.js` }));
    expect(h.sent).toEqual([]);
  });
});

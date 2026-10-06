import {
  CLIENT_ERRORS_PATH,
  CLIENT_ERROR_PATHNAME_MAX_LENGTH,
  type ClientErrorKind,
  type ClientErrorReportRequest
} from "../contracts/clientErrors";

/** Reports one page load may send; later crashes stay local. */
export const CLIENT_ERROR_PAGE_BUDGET = 5;

export type ClientErrorReporter = Readonly<{
  /** Sends at most one report per error object and stays silent past the budget. */
  report(kind: ClientErrorKind, error?: unknown): void;
}>;

const EXTENSION_SOURCE = /\b(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//iu;
const CHUNK_FAILURE = /Loading (?:CSS )?chunk [\w./-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/iu;
const BENIGN_MESSAGE = /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)|^Script error\.?$/iu;

function ownString(value: unknown, key: "message" | "name" | "stack"): string {
  if (!value || typeof value !== "object") return "";
  try {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : "";
  } catch {
    return "";
  }
}

/** A stale-deploy failure: the page asks for a build file the server no longer has. */
export function isChunkLoadError(error: unknown): boolean {
  return ownString(error, "name") === "ChunkLoadError" || CHUNK_FAILURE.test(ownString(error, "message"));
}

export function classifyClientError(error: unknown, fallback: ClientErrorKind): ClientErrorKind {
  return isChunkLoadError(error) ? "chunk_load" : fallback;
}

function isForeignSource(filename: string, origin: string): boolean {
  if (!filename) return false;
  try {
    return new URL(filename, origin).origin !== origin;
  } catch {
    return true;
  }
}

/** Noise the page cannot act on: extensions, cross-origin scripts, ResizeObserver. */
export function isIgnoredErrorEvent(event: Pick<ErrorEvent, "error" | "filename" | "message">, origin: string): boolean {
  const message = typeof event.message === "string" ? event.message : "";
  if (BENIGN_MESSAGE.test(message) || BENIGN_MESSAGE.test(ownString(event.error, "message"))) return true;
  if (isForeignSource(event.filename ?? "", origin)) return true;
  // Opaque cross-origin errors arrive without an error object or a source.
  if (!event.error && !event.filename) return true;
  return EXTENSION_SOURCE.test(ownString(event.error, "stack"));
}

export function isIgnoredRejection(reason: unknown): boolean {
  if (ownString(reason, "name") === "AbortError") return true;
  if (BENIGN_MESSAGE.test(ownString(reason, "message"))) return true;
  return EXTENSION_SOURCE.test(ownString(reason, "stack"));
}

function currentPathname(): string | undefined {
  try {
    const pathname = window.location.pathname;
    return pathname.startsWith("/") && pathname.length <= CLIENT_ERROR_PATHNAME_MAX_LENGTH ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function send(report: ClientErrorReportRequest): void {
  try {
    // keepalive lets a report started just before a reload still arrive.
    // Every outcome, including 401 for a signed-out page, is ignored.
    void fetch(CLIENT_ERRORS_PATH, {
      body: JSON.stringify(report),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      keepalive: true,
      method: "POST"
    }).catch(() => undefined);
  } catch {
    // Reporting never adds a second failure to the page.
  }
}

export function createClientErrorReporter(
  options: Readonly<{ budget?: number; send?: (report: ClientErrorReportRequest) => void; pathname?: () => string | undefined }> = {}
): ClientErrorReporter {
  const budget = options.budget ?? CLIENT_ERROR_PAGE_BUDGET;
  const deliver = options.send ?? send;
  const pathname = options.pathname ?? currentPathname;
  const reported = new WeakSet<object>();
  let sent = 0;
  return Object.freeze({
    report(kind: ClientErrorKind, error?: unknown) {
      if (sent >= budget) return;
      if (error && typeof error === "object") {
        // React and the window can both surface one crash, and development
        // effects run twice; one error object is one report.
        if (reported.has(error)) return;
        reported.add(error);
      }
      sent += 1;
      const path = pathname();
      deliver(path === undefined ? { kind } : { kind, pathname: path });
    }
  });
}

/** The page-wide reporter; its budget lasts until the next full page load. */
export const clientErrorReporter = createClientErrorReporter();

export function installClientErrorListeners(target: Window, reporter: ClientErrorReporter = clientErrorReporter): () => void {
  const onError = (event: ErrorEvent) => {
    if (isIgnoredErrorEvent(event, target.location.origin)) return;
    reporter.report(classifyClientError(event.error, "error"), event.error);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (isIgnoredRejection(event.reason)) return;
    reporter.report(classifyClientError(event.reason, "unhandled_rejection"), event.reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

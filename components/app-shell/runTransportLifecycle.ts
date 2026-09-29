/** A browser wake detaches observation; only the caller's signal represents Stop. */
export function observeRunTransport(stopSignal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("stream_connection_lost", "AbortError"));
  let wasHidden = document.visibilityState === "hidden";
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    // Let already delivered response bytes settle before replacing observation.
    // A frozen fetch/read still loses the race on the next browser task.
    wakeTimer ??= setTimeout(abort, 0);
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") wasHidden = true;
    else if (wasHidden) wake();
  };
  const focus = () => { if (wasHidden && document.visibilityState === "visible") wake(); };
  const pageShow = (event: PageTransitionEvent) => { if (event.persisted) wake(); };
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("resume", wake);
  window.addEventListener("focus", focus);
  window.addEventListener("pageshow", pageShow);
  stopSignal?.addEventListener("abort", abort, { once: true });
  if (stopSignal?.aborted) abort();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(wakeTimer);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("resume", wake);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", pageShow);
      stopSignal?.removeEventListener("abort", abort);
    }
  };
}

/** Fetch, body parsing and reader cancellation can remain pending after abort. */
export async function waitForRunTransport<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let rejectAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(signal.reason ?? new DOMException("stream_connection_lost", "AbortError"));
    signal.addEventListener("abort", rejectAbort, { once: true });
    if (signal.aborted) rejectAbort();
  });
  try {
    const result = await Promise.race([pending, aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", rejectAbort);
  }
}

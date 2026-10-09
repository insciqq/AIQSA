import { RUN_STREAM_KEEPALIVE_MS } from "@/lib/domain/modelRunEvents";

/** Silence after which a returning browser treats its run transport as frozen. */
export const RUN_TRANSPORT_SILENCE_MS = RUN_STREAM_KEEPALIVE_MS * 3;

/** Every settled step through `waitForRunTransport` proves delivery on its signal. */
const transportDelivery = new WeakMap<AbortSignal, () => void>();

/**
 * A browser wake detaches observation; only the caller's signal represents Stop.
 * A frozen page (`resume`, a restored page) detaches at once. A visible return
 * keeps a transport that is still delivering and detaches it once it stays
 * silent, so switching tabs never interrupts a live answer.
 */
export function observeRunTransport(stopSignal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("stream_connection_lost", "AbortError"));
  let wasHidden = document.visibilityState === "hidden";
  let deliveredAt = Date.now();
  let detaching = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const detach = () => {
    if (detaching) return;
    detaching = true;
    clearTimeout(wakeTimer);
    // Let already delivered response bytes settle before replacing observation.
    // A frozen fetch/read still loses the race on the next browser task.
    wakeTimer = setTimeout(abort, 0);
  };
  const watch = () => {
    if (detaching) return;
    clearTimeout(wakeTimer);
    const silence = Date.now() - deliveredAt;
    if (silence >= RUN_TRANSPORT_SILENCE_MS) detach();
    else wakeTimer = setTimeout(watch, RUN_TRANSPORT_SILENCE_MS - silence);
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") wasHidden = true;
    else if (wasHidden) watch();
  };
  const focus = () => { if (wasHidden && document.visibilityState === "visible") watch(); };
  const pageShow = (event: PageTransitionEvent) => { if (event.persisted) detach(); };
  transportDelivery.set(controller.signal, () => { deliveredAt = Date.now(); });
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("resume", detach);
  window.addEventListener("focus", focus);
  window.addEventListener("pageshow", pageShow);
  stopSignal?.addEventListener("abort", abort, { once: true });
  if (stopSignal?.aborted) abort();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(wakeTimer);
      transportDelivery.delete(controller.signal);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("resume", detach);
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
    transportDelivery.get(signal)?.();
    return result;
  } finally {
    signal.removeEventListener("abort", rejectAbort);
  }
}

type PdfWorkerAdmission = {
  active: boolean;
  waiting: Set<() => void>;
};

type PdfWorkerGlobal = typeof globalThis & {
  __aiqsaPdfWorkerAdmission?: PdfWorkerAdmission;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function acquire(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const scope = globalThis as PdfWorkerGlobal;
  const admission = scope.__aiqsaPdfWorkerAdmission ??= { active: false, waiting: new Set() };
  return new Promise((resolve, reject) => {
    let waiting = true;
    const grant = () => {
      waiting = false;
      signal?.removeEventListener("abort", cancel);
      admission.active = true;
      resolve(() => {
        const next = admission.waiting.values().next().value;
        if (next) {
          admission.waiting.delete(next);
          next();
        } else admission.active = false;
      });
    };
    const cancel = () => {
      if (!waiting) return;
      waiting = false;
      admission.waiting.delete(grant);
      signal?.removeEventListener("abort", cancel);
      reject(abortReason(signal!));
    };
    if (admission.active) {
      admission.waiting.add(grant);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    } else grant();
  });
}

/** Canvas/image allocations are outside V8's per-worker heap limit. Share one
 * local PDF worker slot across consumers, including worker termination, before
 * copying input bytes. Remote Vision requests do not hold this memory slot. */
export async function withPdfWorkerAdmission<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const release = await acquire(signal);
  try {
    if (signal?.aborted) throw abortReason(signal);
    return await operation();
  } finally {
    release();
  }
}

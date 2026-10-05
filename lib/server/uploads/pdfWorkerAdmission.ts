type ProcessSlot = {
  active: boolean;
  waiting: Set<() => void>;
};

/** Process-wide slots survive module reloads on the global object. */
type ProcessSlotGlobal = typeof globalThis & {
  __aiqsaPageParserAdmission?: ProcessSlot;
  __aiqsaPdfWorkerAdmission?: ProcessSlot;
};

type ProcessSlotKey = "__aiqsaPageParserAdmission" | "__aiqsaPdfWorkerAdmission";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function acquire(key: ProcessSlotKey, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const scope = globalThis as ProcessSlotGlobal;
  const admission = scope[key] ??= { active: false, waiting: new Set() };
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

async function withProcessSlot<T>(
  key: ProcessSlotKey,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const release = await acquire(key, signal);
  try {
    if (signal?.aborted) throw abortReason(signal);
    return await operation();
  } finally {
    release();
  }
}

/** Canvas/image allocations are outside V8's per-worker heap limit. Share one
 * local PDF worker slot across consumers, including worker termination, before
 * copying input bytes. Isolated spreadsheet/HTML parser processes hold the same
 * slot until their process group exits. Remote Vision requests do not hold it. */
export async function withPdfWorkerAdmission<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return withProcessSlot("__aiqsaPdfWorkerAdmission", operation, signal);
}

/** Fetched-page parser processes take their own slot, also held until their
 * process group exits. A page parse runs under a smaller memory budget and a
 * shorter deadline than a document, so an answer's page read never waits
 * behind document parsing, and a hostile page never holds the document slot.
 * Page parses still run one at a time, bounding their memory to one budget. */
export async function withPageParserAdmission<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return withProcessSlot("__aiqsaPageParserAdmission", operation, signal);
}

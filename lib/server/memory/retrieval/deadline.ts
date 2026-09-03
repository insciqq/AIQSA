import { boundedMemoryAdmissionDeadlineMs } from "../admissionDeadline";

export const MEMORY_INTERACTIVE_SOFT_DEADLINE_MS = 20_000;
export const MEMORY_INTERACTIVE_HARD_DEADLINE_MS = 26_000;
export const MEMORY_SNAPSHOT_OPTIONAL_MAXIMUM_MS = 1_000;
export const MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS = 1_500;
// Query embedding starts beside the control call and keeps its own eight-second
// fence. System Model utilities get a wider measurement window without
// extending embedding or reranker provider budgets.
export const MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS = 8_000;
// The resolver starts from the original-query speculative frontier beside the
// control call. Its child fence is only a provider-execution safety ceiling:
// the final pack boundary never waits for it, while the admission fence and
// terminal-settlement reserve remain authoritative.
export const MEMORY_QUERY_RESOLVER_OPTIONAL_MAXIMUM_MS = 20_000;
export const MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS = 2_000;
export const MEMORY_RERANK_OPTIONAL_MAXIMUM_MS = 4_000;
export const MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS = 20_000;

const MEMORY_ADMISSION_DEADLINE_REASON = Object.freeze({
  code: "memory_admission_deadline_exceeded"
});

export type MemoryRetrievalDeadline = Readonly<{
  canStartOptional(): boolean;
  dispose(): void;
  expired(): boolean;
  outerDeadlineAtMs: number;
  remainingMs(): number;
  signal: AbortSignal;
}>;

export type OptionalMemoryUtilityRole =
  | "CONTROL"
  | "QUERY_EMBED"
  | "QUERY_RESOLVE"
  | "RERANK";

const optionalUtilityBudget = Object.freeze({
  CONTROL: {
    maximumMs: MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS,
    reserveMs: 0
  },
  QUERY_EMBED: {
    maximumMs: MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS,
    reserveMs: 0
  },
  QUERY_RESOLVE: {
    maximumMs: MEMORY_QUERY_RESOLVER_OPTIONAL_MAXIMUM_MS,
    // Governed cancellation settlement must stay inside the hard admission
    // envelope even though the synchronous attachment boundary never waits.
    reserveMs: MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS
  },
  RERANK: {
    maximumMs: MEMORY_RERANK_OPTIONAL_MAXIMUM_MS,
    // Preserve time for authoritative rejoin and the synchronous packer.
    reserveMs: 2_000
  }
} satisfies Record<OptionalMemoryUtilityRole, Readonly<{
  maximumMs: number;
  reserveMs: number;
}>>);

export function createMemoryRetrievalDeadline(
  parentSignal: AbortSignal | undefined,
  options: Readonly<{
    admissionDeadlineMs?: number;
    clock?: () => number;
    existingDeadlineAtMs?: number;
  }> = {}
): MemoryRetrievalDeadline {
  const clock = options.clock ?? Date.now;
  const nowMs = clock();
  const requestedDeadlineAtMs = nowMs + boundedMemoryAdmissionDeadlineMs(
    options.admissionDeadlineMs
  );
  const existingDeadlineAtMs = options.existingDeadlineAtMs;
  const hasExistingDeadline = typeof existingDeadlineAtMs === "number" &&
    Number.isFinite(existingDeadlineAtMs);
  const outerDeadlineAtMs = hasExistingDeadline
    ? options.admissionDeadlineMs === undefined
      ? existingDeadlineAtMs
      : Math.min(existingDeadlineAtMs, requestedDeadlineAtMs)
    : requestedDeadlineAtMs;
  const hardDeadlineAtMs = Math.min(
    outerDeadlineAtMs,
    nowMs + MEMORY_INTERACTIVE_HARD_DEADLINE_MS
  );
  const softDeadlineAtMs = Math.min(
    hardDeadlineAtMs,
    nowMs + MEMORY_INTERACTIVE_SOFT_DEADLINE_MS
  );

  const controller = new AbortController();
  let expired = hardDeadlineAtMs <= nowMs;
  const expire = () => {
    expired = true;
    if (!controller.signal.aborted) {
      controller.abort(MEMORY_ADMISSION_DEADLINE_REASON);
    }
  };
  const forwardParentAbort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) {
    forwardParentAbort();
  } else {
    parentSignal?.addEventListener("abort", forwardParentAbort, { once: true });
  }
  const timeout = !controller.signal.aborted && !expired
    ? setTimeout(expire, hardDeadlineAtMs - nowMs)
    : null;
  if (expired) expire();

  return Object.freeze({
    canStartOptional: () => !controller.signal.aborted &&
      clock() < softDeadlineAtMs,
    dispose() {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", forwardParentAbort);
    },
    expired: () => expired || clock() >= hardDeadlineAtMs,
    outerDeadlineAtMs,
    remainingMs: () => Math.max(0, hardDeadlineAtMs - clock()),
    signal: controller.signal
  });
}

export async function runOptionalMemoryUtility<T>(
  deadline: MemoryRetrievalDeadline,
  role: OptionalMemoryUtilityRole,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (!deadline.canStartOptional()) {
    throw new Error("memory_optional_soft_deadline_exceeded");
  }
  const budget = optionalUtilityBudget[role];
  const availableMs = deadline.remainingMs() - budget.reserveMs;
  if (availableMs < 1) {
    throw new Error("memory_optional_hard_deadline_reserved");
  }
  const timeoutMs = Math.max(1, Math.min(
    budget.maximumMs,
    Math.floor(availableMs)
  ));
  const controller = new AbortController();
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(deadline.signal.reason);
  };
  if (deadline.signal.aborted) forwardAbort();
  else deadline.signal.addEventListener("abort", forwardAbort, { once: true });
  const timeout = !controller.signal.aborted
    ? setTimeout(() => controller.abort({
        code: `memory_${role.toLocaleLowerCase("und")}_timeout`
      }), timeoutMs)
    : null;
  try {
    // Governed utilities own their binding lifecycle and settle it before
    // returning an unavailable result. Await that settlement after
    // cancellation instead of racing ahead with a pending binding.
    return await operation(controller.signal);
  } finally {
    if (timeout) clearTimeout(timeout);
    deadline.signal.removeEventListener("abort", forwardAbort);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("memory_admission_aborted");
}

export async function abortableMemoryRead<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function runBoundedMemoryRead<T>(
  deadline: MemoryRetrievalDeadline,
  maximumMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  cancellationSignal?: AbortSignal
): Promise<T> {
  const timeoutMs = Math.min(maximumMs, deadline.remainingMs());
  if (timeoutMs < 1 || deadline.signal.aborted) throw abortReason(deadline.signal);
  const controller = new AbortController();
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(deadline.signal.reason);
  };
  const forwardCancellation = () => {
    if (!controller.signal.aborted) controller.abort(cancellationSignal?.reason);
  };
  if (deadline.signal.aborted) forwardAbort();
  else deadline.signal.addEventListener("abort", forwardAbort, { once: true });
  if (cancellationSignal?.aborted) forwardCancellation();
  else cancellationSignal?.addEventListener("abort", forwardCancellation, { once: true });
  const timeout = !controller.signal.aborted
    ? setTimeout(() => controller.abort({ code: "memory_local_read_timeout" }), timeoutMs)
    : null;
  try {
    return await operation(controller.signal);
  } finally {
    if (timeout) clearTimeout(timeout);
    deadline.signal.removeEventListener("abort", forwardAbort);
    cancellationSignal?.removeEventListener("abort", forwardCancellation);
  }
}

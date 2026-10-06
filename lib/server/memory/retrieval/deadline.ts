import { boundedMemoryAdmissionDeadlineMs } from "../admissionDeadline";

// Standalone interactive reads that carry no configured admission budget
// (inbound Memory MCP search, explicit relation candidates) use this outer
// deadline. Run admission always passes the administrator-configured budget,
// which then is the hard deadline without a lower hidden ceiling.
export const MEMORY_STANDALONE_READ_DEADLINE_MS = 26_000;
export const MEMORY_SNAPSHOT_OPTIONAL_MAXIMUM_MS = 1_000;
export const MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS = 1_500;
// Query embedding starts beside the control call and keeps its own eight-second
// fence. System Model utilities scale with the configured admission budget
// without extending embedding or reranker provider budgets.
export const MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS = 8_000;
export const MEMORY_CONTROL_SCREEN_OPTIONAL_MAXIMUM_MS = 1_500;
export const MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS = 2_000;
export const MEMORY_RERANK_OPTIONAL_MAXIMUM_MS = 4_000;
// Authoritative rejoin plus the synchronous packer after a reranking stage.
const MEMORY_REJOIN_RESERVE_MS = 2_000;
// A timed-out control decision must still leave enough of the shared admission
// envelope for the two authoritative local expansion passes plus synchronous
// packing and attachment. The provider result is optional; the fresh rejoin is
// not.
export const MEMORY_CONTROL_READ_RESERVE_MS =
  MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS * 2 + 1_000;
// Optional System Model work (control, query resolution) and the soft start
// fence share one window: the remaining admission budget minus a fixed local
// tail for the reranker ceiling and the rejoin/packing reserve. A short budget
// shrinks the tail proportionally, so optional work keeps at least three
// quarters of it; a longer budget extends only the window.
export const MEMORY_OPTIONAL_TAIL_RESERVE_MS =
  MEMORY_RERANK_OPTIONAL_MAXIMUM_MS + MEMORY_REJOIN_RESERVE_MS;
const MEMORY_OPTIONAL_TAIL_MAXIMUM_SHARE_DIVISOR = 4;

export function memoryOptionalWindowMs(budgetMs: number): number {
  const budget = Number.isFinite(budgetMs) ? Math.max(0, Math.floor(budgetMs)) : 0;
  return budget - Math.min(
    MEMORY_OPTIONAL_TAIL_RESERVE_MS,
    Math.floor(budget / MEMORY_OPTIONAL_TAIL_MAXIMUM_SHARE_DIVISOR)
  );
}

const MEMORY_ADMISSION_DEADLINE_REASON = Object.freeze({
  code: "memory_admission_deadline_exceeded"
});

export type MemoryRetrievalDeadline = Readonly<{
  /** Hard budget remaining when this attempt's deadline was created. */
  budgetMs: number;
  canStartOptional(): boolean;
  dispose(): void;
  expired(): boolean;
  /** Effective optional System Model window derived from `budgetMs`. */
  optionalWindowMs: number;
  outerDeadlineAtMs: number;
  remainingMs(): number;
  signal: AbortSignal;
}>;

export type OptionalMemoryUtilityRole =
  | "CONTROL"
  | "CONTROL_SCREEN"
  | "QUERY_EMBED"
  | "QUERY_RESOLVE"
  | "RERANK";

/**
 * The admission budget, not a provider, prevented this optional utility from
 * starting: the soft window has closed or the remaining time is reserved.
 */
export class MemoryOptionalDeadlineError extends Error {
  readonly code: "memory_optional_soft_deadline_exceeded" |
    "memory_optional_hard_deadline_reserved";

  constructor(code: MemoryOptionalDeadlineError["code"]) {
    super(code);
    this.name = "MemoryOptionalDeadlineError";
    this.code = code;
  }
}

function optionalUtilityTimeoutCode(role: OptionalMemoryUtilityRole): string {
  return `memory_${role.toLocaleLowerCase("und")}_timeout`;
}

const optionalUtilityTimeoutCodes: ReadonlySet<string> = new Set(
  (["CONTROL", "CONTROL_SCREEN", "QUERY_EMBED", "QUERY_RESOLVE", "RERANK"] as const)
    .map(optionalUtilityTimeoutCode)
);

/**
 * True when a budget stopped the optional utility: it could not start, or its
 * own or the admission deadline aborted it. Callers record a deadline reason
 * instead of reporting the provider as unavailable. A user Stop is not a
 * deadline.
 */
export function isMemoryDeadlineExhaustion(error: unknown): boolean {
  if (error instanceof MemoryOptionalDeadlineError) return true;
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : null;
  return typeof code === "string" && (
    code === MEMORY_ADMISSION_DEADLINE_REASON.code ||
    optionalUtilityTimeoutCodes.has(code)
  );
}

// A null maximum is bounded by the deadline's configured optional window.
const optionalUtilityBudget = Object.freeze({
  CONTROL: {
    maximumMs: null,
    reserveMs: MEMORY_CONTROL_READ_RESERVE_MS
  },
  CONTROL_SCREEN: {
    maximumMs: MEMORY_CONTROL_SCREEN_OPTIONAL_MAXIMUM_MS,
    reserveMs: MEMORY_CONTROL_READ_RESERVE_MS
  },
  QUERY_EMBED: {
    maximumMs: MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS,
    reserveMs: 0
  },
  QUERY_RESOLVE: {
    // The resolver starts from the original-query speculative frontier beside
    // the control call. The final pack boundary never waits for it, while
    // governed cancellation settlement must stay inside the hard admission
    // envelope.
    maximumMs: null,
    reserveMs: MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS
  },
  RERANK: {
    maximumMs: MEMORY_RERANK_OPTIONAL_MAXIMUM_MS,
    // Preserve time for authoritative rejoin and the synchronous packer.
    reserveMs: MEMORY_REJOIN_RESERVE_MS
  }
} satisfies Record<OptionalMemoryUtilityRole, Readonly<{
  maximumMs: number | null;
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
  const existingDeadlineAtMs = options.existingDeadlineAtMs;
  const hasExistingDeadline = typeof existingDeadlineAtMs === "number" &&
    Number.isFinite(existingDeadlineAtMs);
  const requestedDeadlineAtMs = nowMs + (
    options.admissionDeadlineMs === undefined && !hasExistingDeadline
      ? MEMORY_STANDALONE_READ_DEADLINE_MS
      : boundedMemoryAdmissionDeadlineMs(options.admissionDeadlineMs)
  );
  // The configured or already running admission deadline is the hard
  // deadline; a smaller outer deadline still wins.
  const hardDeadlineAtMs = hasExistingDeadline
    ? options.admissionDeadlineMs === undefined
      ? existingDeadlineAtMs
      : Math.min(existingDeadlineAtMs, requestedDeadlineAtMs)
    : requestedDeadlineAtMs;
  const budgetMs = Math.max(0, Math.floor(hardDeadlineAtMs - nowMs));
  const optionalWindowMs = memoryOptionalWindowMs(budgetMs);
  const softDeadlineAtMs = nowMs + optionalWindowMs;

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
    budgetMs,
    canStartOptional: () => !controller.signal.aborted &&
      clock() < softDeadlineAtMs,
    dispose() {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", forwardParentAbort);
    },
    expired: () => expired || clock() >= hardDeadlineAtMs,
    optionalWindowMs,
    outerDeadlineAtMs: hardDeadlineAtMs,
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
    // A Stop is not budget exhaustion; nothing was dispatched in either case.
    if (deadline.signal.aborted && !isMemoryDeadlineExhaustion(deadline.signal.reason)) {
      throw abortReason(deadline.signal);
    }
    throw new MemoryOptionalDeadlineError("memory_optional_soft_deadline_exceeded");
  }
  const budget = optionalUtilityBudget[role];
  const availableMs = deadline.remainingMs() - budget.reserveMs;
  if (availableMs < 1) {
    throw new MemoryOptionalDeadlineError("memory_optional_hard_deadline_reserved");
  }
  const maximumMs = budget.maximumMs ?? deadline.optionalWindowMs;
  const timeoutMs = Math.max(1, Math.min(maximumMs, Math.floor(availableMs)));
  const controller = new AbortController();
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(deadline.signal.reason);
  };
  if (deadline.signal.aborted) forwardAbort();
  else deadline.signal.addEventListener("abort", forwardAbort, { once: true });
  const timeout = !controller.signal.aborted
    ? setTimeout(() => controller.abort({
        code: optionalUtilityTimeoutCode(role)
      }), timeoutMs)
    : null;
  try {
    const pending = operation(controller.signal);
    // Other utilities cancel the provider wait and finish their own durable
    // settlement before returning; abandoning that work here could leave a
    // live binding at the final context-attachment boundary.
    if (role !== "CONTROL") return await pending;
    // Control is read-only. Its service owns binding settlement
    // and discards late provider results after cancellation. Stop awaiting a
    // non-cooperative adapter here as well, so the result can never gain action
    // authority after its reserved read budget begins. Explicit handlers keep
    // late resolution/rejection observed without a bare Promise.race.
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => finish(() => reject(abortReason(controller.signal)));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      );
      if (controller.signal.aborted) onAbort();
    });
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

export const MEMORY_ACTION_ANSWER_RESULT_VERSION = 1 as const;

export const MEMORY_ACTION_ANSWER_OPERATIONS = [
  "NONE",
  "SAVE",
  "UPDATE",
  "FORGET",
  "LIST",
  "SEARCH",
  "RESET"
] as const;

export const MEMORY_ACTION_ANSWER_STATUSES = [
  "AMBIGUOUS",
  "COMMITTED",
  "COMPLETE",
  "CONFIRMATION_REQUIRED",
  "REJECTED",
  "THIS_CHAT_ONLY",
  "UNAVAILABLE"
] as const;

export type MemoryActionAnswerOperation =
  (typeof MEMORY_ACTION_ANSWER_OPERATIONS)[number];
export type MemoryActionAnswerStatus =
  (typeof MEMORY_ACTION_ANSWER_STATUSES)[number];

export type MemoryActionAnswerResult = Readonly<{
  operation: MemoryActionAnswerOperation;
  status: MemoryActionAnswerStatus;
  version: typeof MEMORY_ACTION_ANSWER_RESULT_VERSION;
}>;

/**
 * Every answer starts with a server-owned denial of mutation authority. Memory
 * preparation may replace it with a more specific result, but user text and
 * provider prose can never remove this default.
 */
export const MEMORY_ACTION_NO_COMMIT_RESULT: MemoryActionAnswerResult =
  Object.freeze({
    operation: "NONE",
    status: "UNAVAILABLE",
    version: MEMORY_ACTION_ANSWER_RESULT_VERSION
  });

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function validPair(
  operation: MemoryActionAnswerOperation,
  status: MemoryActionAnswerStatus
): boolean {
  if (operation === "NONE") return status === "UNAVAILABLE";
  if (operation === "SAVE") {
    return status === "COMMITTED" || status === "REJECTED" ||
      status === "THIS_CHAT_ONLY" || status === "UNAVAILABLE";
  }
  if (operation === "UPDATE" || operation === "FORGET") {
    return status === "AMBIGUOUS" || status === "COMMITTED" ||
      status === "REJECTED" || status === "UNAVAILABLE";
  }
  if (operation === "LIST" || operation === "SEARCH") {
    return status === "COMPLETE" || status === "UNAVAILABLE";
  }
  return operation === "RESET" &&
    (status === "CONFIRMATION_REQUIRED" || status === "UNAVAILABLE");
}

export function decodeMemoryActionAnswerResult(
  value: unknown
): MemoryActionAnswerResult | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "operation" || keys[1] !== "status" ||
    keys[2] !== "version" ||
    !includes(MEMORY_ACTION_ANSWER_OPERATIONS, record.operation) ||
    !includes(MEMORY_ACTION_ANSWER_STATUSES, record.status) ||
    record.version !== MEMORY_ACTION_ANSWER_RESULT_VERSION ||
    !validPair(record.operation, record.status)) return null;
  return {
    operation: record.operation,
    status: record.status,
    version: MEMORY_ACTION_ANSWER_RESULT_VERSION
  };
}

/** Trusted, code-owned answer instruction. The bridge deliberately contains
 * no statement, candidate, identifier, reason, or model output. */
export function memoryActionAnswerContract(
  result: MemoryActionAnswerResult
): string {
  const decoded = decodeMemoryActionAnswerResult(result);
  if (!decoded) throw new Error("memory_action_answer_result_invalid");
  const authority = `operation=${decoded.operation}; status=${decoded.status}.`;
  const authorityWidth = "operation=UPDATE; status=CONFIRMATION_REQUIRED.".length;
  return [
    '<aiqsa_memory_result version="1">',
    authority.padEnd(authorityWidth, " "),
    "Server truth: claim Personal Memory changed only for the matching COMMITTED operation; otherwise no reusable change occurred.",
    "For REJECTED or UNAVAILABLE, never expose or paraphrase candidate content or secrets.",
    "Preserve the ordinary answer; exact Memory feedback is rendered separately.",
    "</aiqsa_memory_result>"
  ].join("\n");
}

/** Version 3 is the async PENDING contract, so the next synchronous result
 * contract is 4. Accepted runs replay versions 1 and 2 exactly. */
export const MEMORY_ACTION_ANSWER_RESULT_VERSION = 4 as const;
export const MEMORY_ACTION_ASYNC_ANSWER_RESULT_VERSION = 3 as const;

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
  "PENDING",
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
  version: 1 | 2 | typeof MEMORY_ACTION_ANSWER_RESULT_VERSION |
    typeof MEMORY_ACTION_ASYNC_ANSWER_RESULT_VERSION;
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

/** Used only after the current message's background command is durable. */
export const MEMORY_ACTION_PENDING_RESULT: MemoryActionAnswerResult =
  Object.freeze({ operation: "NONE", status: "PENDING", version: 3 });

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function validPair(
  operation: MemoryActionAnswerOperation,
  status: MemoryActionAnswerStatus,
  version: MemoryActionAnswerResult["version"]
): boolean {
  if (version === 3) return operation === "NONE" && status === "PENDING";
  if (status === "PENDING") return false;
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
    (record.version !== 1 && record.version !== 2 && record.version !== MEMORY_ACTION_ANSWER_RESULT_VERSION &&
      record.version !== MEMORY_ACTION_ASYNC_ANSWER_RESULT_VERSION) ||
    !validPair(record.operation, record.status, record.version)) return null;
  return {
    operation: record.operation,
    status: record.status,
    version: record.version
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
  if (decoded.version === 3) {
    return [
      '<aiqsa_memory_result version="3">',
      authority.padEnd(authorityWidth, " "),
      "Only this result proves a Memory change. You do not mutate Memory.",
      "PENDING means durable background processing: intent and outcome are not yet known; no change is guaranteed.",
      "If asked to save, change, or forget while PENDING, explicitly say you will try; never promise success or claim it is done, failed, or absent from Memory. Do not ask the user to wait.",
      "For list/search/reset or pattern exclusion, use /memory or Manage Memory; PENDING authorizes none.",
      "Current-chat context is not saved Memory. Never reveal rejected candidates or secrets.",
      "Preserve the ordinary answer. If the user did not request a Memory change, do not mention background processing.",
      "</aiqsa_memory_result>"
    ].join("\n");
  }
  if (decoded.version === 1) {
    // Accepted runs must reproduce the exact v1 prompt on recovery.
    return [
      '<aiqsa_memory_result version="1">',
      authority.padEnd(authorityWidth, " "),
      "Server truth: claim Personal Memory changed only for the matching COMMITTED operation; otherwise no reusable change occurred.",
      "For REJECTED or UNAVAILABLE, never expose or paraphrase candidate content or secrets.",
      "Preserve the ordinary answer; exact Memory feedback is rendered separately.",
      "</aiqsa_memory_result>"
    ].join("\n");
  }
  if (decoded.version === 4) {
    // Users never see Memory failures: a system UNAVAILABLE result is not
    // narrated, yet it never authorizes a success claim either.
    return [
      '<aiqsa_memory_result version="4">',
      authority.padEnd(authorityWidth, " "),
      "Only this server result establishes whether Personal Memory changed. You report the server's completed work; you do not perform the mutation yourself.",
      "Confirm saving, changing, or forgetting only when the matching operation has status COMMITTED.",
      "COMMITTED means the server successfully completed that operation: acknowledge it as done, never say it failed or was not saved.",
      "If the operation is SAVE, UPDATE, FORGET, LIST, SEARCH, or RESET and its status is UNAVAILABLE, say nothing about it: never mention Memory, saving, remembering, a failure, error, limit, or unavailability, never say whether it was done, and answer the rest normally from available information.",
      "Otherwise, if this user message asks to save, change, or forget and the result is operation=NONE, or status REJECTED or THIS_CHAT_ONLY, explicitly say it was not done.",
      "Current-chat context is not saved Memory. Do not expose or paraphrase rejected candidate content or secrets.",
      "Preserve any separately requested ordinary answer.",
      "</aiqsa_memory_result>"
    ].join("\n");
  }
  // Accepted runs must reproduce the exact v2 prompt on recovery.
  return [
    '<aiqsa_memory_result version="2">',
    authority.padEnd(authorityWidth, " "),
    "Only this server result establishes whether Personal Memory changed. You report the server's completed work; you do not perform the mutation yourself.",
    "Confirm saving, changing, or forgetting only when the matching operation has status COMMITTED.",
    "COMMITTED means the server successfully completed that operation: acknowledge it as done, never say it failed or was not saved.",
    "If this user message asks to save, change, or forget and the matching operation is not COMMITTED, explicitly say it was not done. This includes NONE/UNAVAILABLE and THIS_CHAT_ONLY.",
    "Current-chat context is not saved Memory. Do not expose or paraphrase rejected candidate content or secrets.",
    "Preserve any separately requested ordinary answer.",
    "</aiqsa_memory_result>"
  ].join("\n");
}

import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

export const LONGMEMEVAL_REPOSITORY_COMMIT =
  "9e0b455f4ef0e2ab8f2e582289761153549043fc";
export const LONGMEMEVAL_S_SHA256 =
  "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
export const LONGMEMEVAL_ORACLE_SHA256 =
  "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c";
export const LONGMEMEVAL_EVALUATOR_SHA256 =
  "ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251";
export const LONGMEMEVAL_SAMPLE_SEED = "aiqsa-longmemeval-20260826";
export const LONGMEMEVAL_MAX_CONCURRENCY = 32;
export const LONGMEMEVAL_MAX_CASE_CONCURRENCY = 32;
export const LONGMEMEVAL_MAX_SESSION_CONCURRENCY = 16;
export const LONGMEMEVAL_MAX_EVALUATOR_CONCURRENCY = 32;
export const LONGMEMEVAL_QUESTION_TYPES = [
  "knowledge-update",
  "multi-session",
  "single-session-assistant",
  "single-session-preference",
  "single-session-user",
  "temporal-reasoning"
] as const;

export type LongMemEvalQuestionType =
  (typeof LONGMEMEVAL_QUESTION_TYPES)[number];

export type LongMemEvalTurn = Readonly<{
  content: string;
  role: "assistant" | "user";
}>;

export type LongMemEvalCase = Readonly<{
  answer: number | string;
  answerSessionIds: readonly string[];
  haystackDates: readonly string[];
  haystackSessionIds: readonly string[];
  haystackSessions: readonly (readonly LongMemEvalTurn[])[];
  question: string;
  questionDate: string;
  questionId: string;
  questionType: LongMemEvalQuestionType;
}>;

export type LongMemEvalSelection = Readonly<{
  cases: readonly LongMemEvalCase[];
  mode: "explicit" | "seeded_hash";
  seed: string;
}>;

export type LongMemEvalRetrievalAudit = Readonly<{
  aggregationBoundaryCount: number | null;
  aggregationGroupCounts: Readonly<Record<string, number>>;
  aggregationGuideFormat: string | null;
  aggregationMemberCount: number | null;
  aggregationOperation: string | null;
  aggregationRequested: boolean | null;
  aggregationResolution: string | null;
  aggregationState: string | null;
  hardCapTokens: number | null;
  itemCount: number | null;
  mode: string | null;
  omissionCounts: Readonly<Record<string, number>>;
  packedTokens: number | null;
  reason: string | null;
  relevanceAcceptedCount: number | null;
  relevanceCandidateCount: number | null;
  relevanceDecisionCounts: Readonly<Record<string, number>>;
  relevanceRejoinedCount: number | null;
  targetTokens: number | null;
}>;

/** Runs bounded independent work concurrently while preserving input order.
 * On failure it stops admitting new work, waits for already-started work to
 * settle, and only then rejects so callers can safely clean up shared state. */
export async function mapConcurrentOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>
): Promise<readonly R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
    concurrency > LONGMEMEVAL_MAX_CONCURRENCY) {
    throw new Error("longmemeval_concurrency_invalid");
  }
  if (items.length === 0) return Object.freeze([]);
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      try {
        results[index] = await operation(items[index]!, index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    worker
  ));
  if (failed) throw firstError;
  return Object.freeze(results);
}

/** Splits official-evaluator inputs round-robin so long and short calls are
 * spread across workers without changing either item content or shard order. */
export function partitionLongMemEvalEvaluation<T>(
  items: readonly T[],
  concurrency: number
): readonly (readonly T[])[] {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
    concurrency > LONGMEMEVAL_MAX_EVALUATOR_CONCURRENCY) {
    throw new Error("longmemeval_evaluator_concurrency_invalid");
  }
  if (items.length === 0) return Object.freeze([]);
  const shards = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => [] as T[]
  );
  items.forEach((item, index) => shards[index % shards.length]!.push(item));
  return Object.freeze(shards.map((shard) => Object.freeze(shard)));
}

export type LongMemEvalEvaluationValue<T> = Readonly<{
  questionId: string;
  value: T;
}>;

/** Merges independently evaluated shards into the original answer order and
 * fails closed for every missing, duplicate, or unexpected question id. */
export function mergeLongMemEvalEvaluationResults<T>(
  expectedQuestionIds: readonly string[],
  shards: readonly (readonly LongMemEvalEvaluationValue<T>[])[]
): readonly T[] {
  if (new Set(expectedQuestionIds).size !== expectedQuestionIds.length) {
    throw new Error("longmemeval_evaluator_expected_ids_invalid");
  }
  const expected = new Set(expectedQuestionIds);
  const values = new Map<string, T>();
  for (const shard of shards) {
    for (const result of shard) {
      if (!expected.has(result.questionId) || values.has(result.questionId)) {
        throw new Error("longmemeval_evaluator_result_invalid");
      }
      values.set(result.questionId, result.value);
    }
  }
  if (values.size !== expectedQuestionIds.length) {
    throw new Error("longmemeval_evaluator_result_incomplete");
  }
  return Object.freeze(expectedQuestionIds.map((questionId) =>
    values.get(questionId)!));
}

const questionTypeSet = new Set<string>(LONGMEMEVAL_QUESTION_TYPES);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function sanitizedCounts(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(Object.entries(value)
    .filter(([key, count]) => /^[A-Za-z0-9_.:-]{1,64}$/u.test(key) &&
      nonNegativeInteger(count) !== null)
    .slice(0, 64)
    .map(([key, count]) => [key, Number(count)])));
}

function uppercaseCode(value: unknown, maximum = 32): string | null {
  return typeof value === "string" &&
    new RegExp(`^[A-Z_]{1,${maximum}}$`, "u").test(value)
    ? value
    : null;
}

/** Retains only aggregate, text-free retrieval evidence before the disposable
 * benchmark identity (and its private Memory rows) is deleted. */
export function sanitizeLongMemEvalRetrievalAudit(
  value: unknown
): LongMemEvalRetrievalAudit {
  const budget = isRecord(value) ? value : {};
  const plan = isRecord(budget.plan) ? budget.plan : {};
  const mode = typeof plan.mode === "string" &&
    /^[A-Z_]{1,32}$/u.test(plan.mode) ? plan.mode : null;
  const reason = typeof budget.reason === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(budget.reason) ? budget.reason : null;
  return Object.freeze({
    aggregationBoundaryCount: nonNegativeInteger(budget.aggregationBoundaryCount),
    aggregationGroupCounts: sanitizedCounts(budget.aggregationGroupCounts),
    aggregationGuideFormat: uppercaseCode(budget.aggregationGuideFormat),
    aggregationMemberCount: nonNegativeInteger(budget.aggregationMemberCount),
    aggregationOperation: uppercaseCode(budget.aggregationOperation),
    aggregationRequested: typeof plan.aggregationRequested === "boolean"
      ? plan.aggregationRequested
      : null,
    aggregationResolution: uppercaseCode(budget.aggregationResolution),
    aggregationState: uppercaseCode(budget.aggregationState),
    hardCapTokens: nonNegativeInteger(budget.hardCapTokens),
    itemCount: nonNegativeInteger(budget.itemCount),
    mode,
    omissionCounts: sanitizedCounts(budget.omissionCounts),
    packedTokens: nonNegativeInteger(budget.packedTokens),
    reason,
    relevanceAcceptedCount: nonNegativeInteger(budget.relevanceAcceptedCount),
    relevanceCandidateCount: nonNegativeInteger(budget.relevanceCandidateCount),
    relevanceDecisionCounts: sanitizedCounts(budget.relevanceDecisionCounts),
    relevanceRejoinedCount: nonNegativeInteger(budget.relevanceRejoinedCount),
    targetTokens: nonNegativeInteger(budget.targetTokens)
  });
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new Error(code);
  }
  return value;
}

function benchmarkTurnContent(value: unknown, code: string): string {
  if (typeof value !== "string" || value.includes("\u0000")) {
    throw new Error(code);
  }
  return value;
}

function stringArray(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(code);
  return Object.freeze(value.map((entry) => requiredString(entry, code)));
}

function decodeTurns(value: unknown, caseIndex: number): readonly LongMemEvalTurn[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`longmemeval_session_invalid:${caseIndex}`);
  }
  return Object.freeze(value.map((candidate) => {
    if (!isRecord(candidate) ||
      (candidate.role !== "assistant" && candidate.role !== "user")) {
      throw new Error(`longmemeval_turn_invalid:${caseIndex}`);
    }
    return Object.freeze({
      content: benchmarkTurnContent(
        candidate.content,
        `longmemeval_turn_content_invalid:${caseIndex}`
      ),
      role: candidate.role
    });
  }));
}

function decodeCase(value: unknown, index: number): LongMemEvalCase {
  if (!isRecord(value)) throw new Error(`longmemeval_case_invalid:${index}`);
  const questionType = requiredString(
    value.question_type,
    `longmemeval_question_type_invalid:${index}`
  );
  if (!questionTypeSet.has(questionType)) {
    throw new Error(`longmemeval_question_type_invalid:${index}`);
  }
  if (typeof value.answer !== "string" && typeof value.answer !== "number") {
    throw new Error(`longmemeval_answer_invalid:${index}`);
  }
  if (!Array.isArray(value.haystack_sessions)) {
    throw new Error(`longmemeval_sessions_invalid:${index}`);
  }
  const haystackSessions = Object.freeze(
    value.haystack_sessions.map((session) => decodeTurns(session, index))
  );
  const haystackDates = stringArray(
    value.haystack_dates,
    `longmemeval_dates_invalid:${index}`
  );
  const haystackSessionIds = stringArray(
    value.haystack_session_ids,
    `longmemeval_session_ids_invalid:${index}`
  );
  if (haystackSessions.length !== haystackDates.length ||
    haystackSessions.length !== haystackSessionIds.length) {
    throw new Error(`longmemeval_session_alignment_invalid:${index}`);
  }
  for (const date of haystackDates) parseLongMemEvalDate(date);
  const questionDate = requiredString(
    value.question_date,
    `longmemeval_question_date_invalid:${index}`
  );
  parseLongMemEvalDate(questionDate);
  return Object.freeze({
    answer: value.answer,
    answerSessionIds: stringArray(
      value.answer_session_ids,
      `longmemeval_answer_session_ids_invalid:${index}`
    ),
    haystackDates,
    haystackSessionIds,
    haystackSessions,
    question: requiredString(value.question, `longmemeval_question_invalid:${index}`),
    questionDate,
    questionId: requiredString(
      value.question_id,
      `longmemeval_question_id_invalid:${index}`
    ),
    questionType: questionType as LongMemEvalQuestionType
  });
}

export function decodeLongMemEvalDataset(value: unknown): readonly LongMemEvalCase[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("longmemeval_dataset_invalid");
  }
  const cases = Object.freeze(value.map(decodeCase));
  if (new Set(cases.map((entry) => entry.questionId)).size !== cases.length) {
    throw new Error("longmemeval_question_ids_duplicate");
  }
  return cases;
}

export function parseLongMemEvalDate(value: string): Date {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \(([A-Z][a-z]{2})\) (\d{2}):(\d{2})$/u
    .exec(value);
  if (!match) throw new Error("longmemeval_date_invalid");
  const [, yearText, monthText, dayText, weekday, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || hour > 23 || minute > 59 ||
    weekdays[date.getUTCDay()] !== weekday) {
    throw new Error("longmemeval_date_invalid");
  }
  return date;
}

export function longMemEvalQuestionPrompt(entry: Pick<
  LongMemEvalCase,
  "question" | "questionDate"
>): string {
  return [
    "Please answer the question based on the relevant chat history.",
    "",
    `Current Date: ${entry.questionDate}`,
    `Question: ${entry.question}`,
    "Answer:"
  ].join("\n");
}

function selectionHash(seed: string, questionId: string): string {
  return createHash("sha256")
    .update(seed, "utf8")
    .update("\u0000", "utf8")
    .update(questionId, "utf8")
    .digest("hex");
}

export function selectLongMemEvalCases(
  cases: readonly LongMemEvalCase[],
  input: Readonly<{
    questionIds?: readonly string[];
    sampleSize?: number;
    seed?: string;
  }>
): LongMemEvalSelection {
  const seed = input.seed?.trim() || LONGMEMEVAL_SAMPLE_SEED;
  const questionIds = input.questionIds?.map((value) => value.trim()) ?? [];
  if (questionIds.length > 0) {
    if (questionIds.some((value) => !value) ||
      new Set(questionIds).size !== questionIds.length) {
      throw new Error("longmemeval_question_selection_invalid");
    }
    const byId = new Map(cases.map((entry) => [entry.questionId, entry]));
    const selected = questionIds.map((id) => byId.get(id));
    if (selected.some((entry) => !entry)) {
      throw new Error("longmemeval_question_selection_missing");
    }
    return Object.freeze({
      cases: Object.freeze(selected as LongMemEvalCase[]),
      mode: "explicit",
      seed
    });
  }
  const sampleSize = input.sampleSize ?? 1;
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > cases.length) {
    throw new Error("longmemeval_sample_size_invalid");
  }
  const selected = [...cases]
    .sort((left, right) => {
      const byHash = selectionHash(seed, left.questionId)
        .localeCompare(selectionHash(seed, right.questionId));
      return byHash || left.questionId.localeCompare(right.questionId);
    })
    .slice(0, sampleSize);
  return Object.freeze({
    cases: Object.freeze(selected),
    mode: "seeded_hash",
    seed
  });
}

export function assertBenchmarkBaseUrl(value: string, expectedPort: number): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("longmemeval_base_url_invalid");
  }
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname) ||
    parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash || parsed.port !== String(expectedPort) ||
    expectedPort === 3000) {
    throw new Error("longmemeval_base_url_not_isolated");
  }
  return parsed;
}

export function assertBenchmarkDatabaseUrl(value: string, expectedPort: number): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("longmemeval_database_url_invalid");
  }
  const queryKeys = [...parsed.searchParams.keys()];
  if (parsed.protocol !== "postgresql:" || !loopbackHosts.has(parsed.hostname) ||
    parsed.username !== "aiqsa_benchmark" ||
    parsed.password !== "aiqsa-memory-benchmark-dev-password" ||
    parsed.pathname !== "/aiqsa_memory_benchmark" ||
    parsed.port !== String(expectedPort) || expectedPort === 5432 ||
    queryKeys.length !== 1 || queryKeys[0] !== "schema" ||
    parsed.searchParams.get("schema") !== "public" || parsed.hash) {
    throw new Error("longmemeval_database_url_not_isolated");
  }
  return parsed;
}

export function resolveBenchmarkOutputDirectory(
  benchmarkRoot: string,
  candidate: string
): string {
  const resultsRoot = resolve(benchmarkRoot, "results");
  const output = resolve(benchmarkRoot, candidate);
  if (output === resultsRoot || !output.startsWith(`${resultsRoot}${sep}`)) {
    throw new Error("longmemeval_output_directory_not_isolated");
  }
  return output;
}

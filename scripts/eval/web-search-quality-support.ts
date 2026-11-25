/**
 * Shared parts of the web search quality eval (`web-search-quality.ts`):
 * the question file, the append-only result stores, the answer loop with the
 * product's Search tool router and tool-result rendering, the judge, the
 * statistics and the report. Everything here takes its model and engines as
 * ports, so the unit test runs it whole with fakes.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { observedFailure } from "../../lib/server/providers/providerObservability";
import type { SearchPlanToolRouter } from "../../lib/server/search/toolExecutor";
import { searchExecutionsFromToolResult } from "../../lib/server/search/toolResult";
import {
  executeReadToolResult,
  READ_TOOL_RESULT_NAME,
  readToolResultTool,
  TOOL_RESULT_LIMITS,
  toolModelOutput,
  toolOutputExcerpt,
  toolResultOutputText,
  type SavedToolResult,
  type SavedToolResultReader
} from "../../lib/server/engine/toolResults";
import { openAICompatibleResponsesToolBridge } from "../../lib/server/tools/bridges";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "../../lib/server/tools/types";

// ---------------------------------------------------------------- questions

/**
 * One question per JSON line: `{"id", "set", "q", "gold"}`, the prototype's
 * format (2026-11-26). Optional `lang` (`"ru"` marks a Russian question;
 * without it the question's script decides) is the only addition read; any
 * other field (`title`, `source`) is ignored.
 */
export type Question = Readonly<{ gold: string; id: string; q: string; russian: boolean; set: string }>;

const QUESTION_ID = /^[A-Za-z0-9][\w.-]{0,79}$/u;
const SET_NAME = /^[A-Za-z0-9][\w-]{0,39}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Share of Cyrillic among the letters of a text. */
export function cyrillicShare(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  return letters.filter((letter) => /[Ѐ-ӿ]/u.test(letter)).length / letters.length;
}

/** Errors name the line, never its content. */
export function parseQuestions(text: string): Question[] {
  const questions: Question[] = [];
  const ids = new Set<string>();
  text.split(/\r?\n/u).forEach((line, index) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`question_line_invalid_json:${index + 1}`);
    }
    if (!isRecord(value) || typeof value.id !== "string" || !QUESTION_ID.test(value.id) ||
      typeof value.set !== "string" || !SET_NAME.test(value.set) ||
      typeof value.q !== "string" || !value.q.trim() || value.q.length > 4_000 ||
      typeof value.gold !== "string" || !value.gold.trim() || value.gold.length > 2_000 ||
      value.lang !== undefined && typeof value.lang !== "string") {
      throw new Error(`question_line_invalid:${index + 1}`);
    }
    if (ids.has(value.id)) throw new Error(`question_id_duplicate:${index + 1}`);
    ids.add(value.id);
    const russian = typeof value.lang === "string" ? value.lang.toLowerCase() === "ru" : cyrillicShare(value.q) >= 0.5;
    questions.push({ gold: value.gold.trim(), id: value.id, q: value.q.trim(), russian, set: value.set });
  });
  return questions;
}

export function serializeQuestion(question: Question): string {
  return JSON.stringify({ id: question.id, set: question.set, q: question.q, gold: question.gold, ...(question.russian ? { lang: "ru" } : {}) });
}

/** A changed question or gold is a new question: its old answers and grades are not reused. */
export function questionHash(question: Pick<Question, "gold" | "q">): string {
  return createHash("sha256").update(`${question.q}\u0000${question.gold}`).digest("hex").slice(0, 16);
}

export type QuestionSelection = Readonly<{ ids?: readonly string[]; limit?: number; sets?: readonly string[] }>;

/** The chosen questions; a limit takes them round-robin across sets, in file order, so a short run still covers every set. */
export function selectQuestions(questions: readonly Question[], selection: QuestionSelection): Question[] {
  const ids = selection.ids ? new Set(selection.ids) : null;
  const sets = selection.sets ? new Set(selection.sets) : null;
  const chosen = questions.filter((question) => (!ids || ids.has(question.id)) && (!sets || sets.has(question.set)));
  if (selection.limit === undefined || selection.limit >= chosen.length) return chosen;
  const bySet = new Map<string, Question[]>();
  for (const question of chosen) bySet.set(question.set, [...bySet.get(question.set) ?? [], question]);
  const queues = [...bySet.values()];
  const picked: Question[] = [];
  for (let round = 0; picked.length < selection.limit; round += 1) {
    for (const queue of queues) {
      if (picked.length >= selection.limit) break;
      if (queue[round]) picked.push(queue[round]!);
    }
  }
  const order = new Map(chosen.map((question, index) => [question.id, index]));
  return picked.sort((left, right) => order.get(left.id)! - order.get(right.id)!);
}

// ------------------------------------------------------------------ stores

/** Lines of an append-only JSONL file; a line cut by an interruption is skipped. */
export function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

/** Whether the file ends inside a line, as an interrupted append leaves it. */
function endsMidLine(path: string): boolean {
  if (!existsSync(path)) return false;
  const descriptor = openSync(path, "r");
  try {
    const { size } = fstatSync(descriptor);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(descriptor, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(descriptor);
  }
}

/** One synchronous append per record, so concurrent tasks of one process never interleave lines; a line an interruption cut
 * is closed first, so the new record stays readable. */
export function appendJsonl(path: string, value: unknown): void {
  appendFileSync(path, `${endsMidLine(path) ? "\n" : ""}${JSON.stringify(value)}\n`);
}

export type RunConfig = Readonly<{ effort: string; engine: string; model: string }>;

export function configKey(config: RunConfig): string {
  return `${config.model}|${config.engine}|${config.effort}`;
}

export type SearchRecord = Readonly<{
  /** USD the engine reported (or its published per-request price); null when unknown. */
  costUsd: number | null;
  /** In-answer search actions other than a search (`open_page`, `find_in_page`). */
  kind?: string;
  /** A failure's code, content-free. */
  code?: string;
  query: string | null;
  seconds?: number;
  sources: number;
  status: "complete" | "empty" | "error";
}>;

export type AnswerOutcome = Readonly<{
  answer: string;
  /** Sum over the answer's searches; null when any search's cost is unknown. */
  engineCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  rounds: number;
  searches: readonly SearchRecord[];
}>;

export type AnswerRecord = Readonly<{
  answer?: string;
  at: string;
  code?: string;
  config: string;
  effort: string;
  engine: string;
  engineCostUsd?: number | null;
  id: string;
  inputTokens?: number | null;
  model: string;
  outputTokens?: number | null;
  qhash: string;
  rounds?: number;
  searches?: readonly SearchRecord[];
  seconds: number;
  set: string;
  status: "error" | "ok";
  v: 1;
}>;

function isAnswerRecord(value: unknown): value is AnswerRecord {
  return isRecord(value) && value.v === 1 && typeof value.config === "string" && typeof value.id === "string" &&
    typeof value.qhash === "string" && (value.status === "ok" || value.status === "error") && typeof value.seconds === "number";
}

export function answerRecordKey(record: Pick<AnswerRecord, "config" | "id" | "qhash">): string {
  return `${record.config}\n${record.id}\n${record.qhash}`;
}

/** The record that counts per configuration and question: the last answer, else the last failure. */
export function latestAnswers(values: readonly unknown[]): Map<string, AnswerRecord> {
  const latest = new Map<string, AnswerRecord>();
  for (const value of values) {
    if (!isAnswerRecord(value)) continue;
    const key = answerRecordKey(value);
    const previous = latest.get(key);
    if (!previous || value.status === "ok" || previous.status === "error") latest.set(key, value);
  }
  return latest;
}

export type Grade = "CORRECT" | "INCORRECT" | "NOT_ATTEMPTED";

/** The judgment's key: the exact answer graded against the exact question. */
export function judgmentKey(record: AnswerRecord): string {
  return createHash("sha256").update(`${answerRecordKey(record)}\n${record.answer ?? ""}`).digest("hex");
}

export function readJudgments(path: string): Map<string, Grade> {
  const grades = new Map<string, Grade>();
  for (const value of readJsonl(path)) {
    if (isRecord(value) && typeof value.key === "string" &&
      (value.grade === "CORRECT" || value.grade === "INCORRECT" || value.grade === "NOT_ATTEMPTED")) {
      grades.set(value.key, value.grade);
    }
  }
  return grades;
}

/** A failure as a content-free code. */
export function failureCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && /^[a-z][a-z0-9_:]{0,127}$/u.test(error.code)) return error.code;
  const observed = observedFailure(error);
  return observed.code === "unknown" && observed.httpStatus !== undefined ? `http_${observed.httpStatus}` : observed.code;
}

/** At most `limit` tasks at once, in order of start. */
export async function mapPool<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

// ----------------------------------------------------------- the answer loop

/** One Responses request: the completed response object, or a thrown, classified failure after the model-call retries. */
export type ResponsesModel = (body: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<Readonly<Record<string, unknown>>>;

/** What an engine gives the answer loop: nothing, OpenAI's search inside the answer request, or the product's Search tool router. */
export type PreparedEngine =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "in_answer" }>
  | Readonly<{ kind: "client"; router: SearchPlanToolRouter }>;

export const DEFAULT_ANSWER_INSTRUCTIONS = (today: string) =>
  `Today is ${today}. Answer the user's question. Use web search when the answer may depend on facts you are not certain about. ` +
  "Give a short final answer (one or two sentences) and cite the sources you used as markdown links. Answer in the language of the question.";

function serializedTool(tool: RunTool): Record<string, unknown> {
  return openAICompatibleResponsesToolBridge.serializeTool(tool).tool;
}

function outputItems(response: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  return Array.isArray(response.output) ? response.output.filter(isRecord) : [];
}

export function responseText(response: Readonly<Record<string, unknown>>): string {
  return outputItems(response).flatMap((item) => item.type === "message" && Array.isArray(item.content)
    ? item.content.flatMap((part) => isRecord(part) && part.type === "output_text" && typeof part.text === "string" ? [part.text] : [])
    : []).join("").trim();
}

function usageNumber(response: Readonly<Record<string, unknown>>, key: string): number | null {
  const usage = isRecord(response.usage) ? response.usage : null;
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function addKnown(total: number | null, value: number | null): number | null {
  return value === null ? total : (total ?? 0) + value;
}

/** In-answer searches as the response reports them (`web_search_call` items). */
function hostedSearches(response: Readonly<Record<string, unknown>>): SearchRecord[] {
  return outputItems(response).flatMap((item): SearchRecord[] => {
    if (item.type !== "web_search_call") return [];
    const action = isRecord(item.action) ? item.action : {};
    const kind = typeof action.type === "string" && action.type !== "search" ? action.type : undefined;
    const query = typeof action.query === "string" ? action.query
      : Array.isArray(action.queries) ? action.queries.filter((value) => typeof value === "string").join(" | ") || null : null;
    const sources = Array.isArray(action.sources) ? action.sources.length : 0;
    return [{ costUsd: null, ...(kind ? { kind } : {}), query, sources,
      status: item.status === "completed" ? sources > 0 || kind ? "complete" : "empty" : "error",
      ...(item.status !== "completed" && typeof item.status === "string" ? { code: `web_search_call_${item.status}` } : {}) }];
  });
}

/** One search call's record from the router's result (`lib/server/search/toolExecutor.ts`). */
function clientSearchRecord(result: ToolExecutionResult, query: string | null, seconds: number): SearchRecord {
  const executions = searchExecutionsFromToolResult(result);
  if (executions.length === 0) {
    // Refused before any engine call (an invalid or too long query), or too large to keep.
    const text = toolResultOutputText(result);
    const code = /^Search failed: ([a-z_]+)$/u.exec(text)?.[1] ?? "search_result_invalid";
    return { code, costUsd: result.rawPreview?.providerCall === false ? 0 : null, query, seconds, sources: 0, status: "error" };
  }
  const sources = executions.reduce((sum, execution) => sum + execution.sources.length, 0);
  const failed = executions.every((execution) => execution.status === "error");
  const costs = executions.map((execution) => execution.costUsd ?? null);
  const code = executions.find((execution) => execution.failure)?.failure?.code;
  return {
    ...(code ? { code } : {}),
    costUsd: costs.every((cost) => cost !== null) ? costs.reduce<number>((sum, cost) => sum + cost!, 0) : null,
    query, seconds, sources,
    status: failed ? "error" : sources === 0 ? "empty" : "complete"
  };
}

function callArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Saved long results of one answer, read back by `read_tool_result` as the engine's observation store would serve them. */
function memorySavedResults(): Readonly<{ reader: SavedToolResultReader; save(result: SavedToolResult): string }> {
  const saved = new Map<string, SavedToolResult>();
  return {
    reader: { read: ({ handle }) => Promise.resolve(saved.get(handle) ?? null) },
    save(result) {
      const handle = `tor1_${randomBytes(16).toString("hex")}`;
      saved.set(handle, result);
      return handle;
    }
  };
}

/**
 * One question answered by the model in a tool loop, as the native engine runs a turn (`lib/server/engine/toolBatch.ts`): the client
 * engine's tools are the product's Search tools (`createSearchPlanToolRouter`) beside `read_tool_result`; a result longer than the
 * engine's short excerpt is saved with a handle and reaches the model as the engine's excerpt (`toolOutputExcerpt`,
 * `toolModelOutput`). The in-answer engine adds the hosted `web_search` tool as the product's tool bridge declares it. The last
 * round allows no tools, so every answer ends with text.
 */
export async function answerQuestion(input: Readonly<{
  effort: string;
  engine: PreparedEngine;
  instructions: string;
  maxRounds: number;
  model: ResponsesModel;
  modelId: string;
  now: () => number;
  question: Question;
  signal: AbortSignal;
}>): Promise<AnswerOutcome> {
  const { engine } = input;
  const tools = engine.kind === "in_answer" ? [{ type: "web_search" }]
    : engine.kind === "client" ? [...engine.router.tools, readToolResultTool].map(serializedTool) : [];
  const conversation: Record<string, unknown>[] = [{ content: input.question.q, role: "user" }];
  const searches: SearchRecord[] = [];
  const store = memorySavedResults();
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (let round = 1; ; round += 1) {
    const last = round >= input.maxRounds;
    const response = await input.model({
      include: ["reasoning.encrypted_content", ...engine.kind === "in_answer" ? ["web_search_call.action.sources"] : []],
      input: conversation,
      instructions: input.instructions,
      model: input.modelId,
      reasoning: { effort: input.effort },
      store: false,
      stream: false,
      ...(tools.length > 0 ? { tool_choice: last ? "none" : "auto", tools } : {})
    }, input.signal);
    inputTokens = addKnown(inputTokens, usageNumber(response, "input_tokens"));
    outputTokens = addKnown(outputTokens, usageNumber(response, "output_tokens"));
    searches.push(...hostedSearches(response));
    const output = outputItems(response);
    const calls = output.filter((item) => item.type === "function_call");
    if (calls.length === 0 || last || engine.kind !== "client") {
      const costs = searches.map((search) => search.costUsd);
      return {
        answer: responseText(response),
        engineCostUsd: costs.every((cost) => cost !== null) ? costs.reduce<number>((sum, cost) => sum + cost!, 0) : null,
        inputTokens, outputTokens, rounds: round, searches
      };
    }
    // Hosted search items never replay (PROVIDERS.md, Search); reasoning, messages and calls do, within the turn.
    conversation.push(...output.filter((item) => item.type !== "web_search_call"));
    const results = await Promise.all(calls.map(async (item) => {
      const call: ModelToolCall = { arguments: callArguments(item.arguments), id: String(item.call_id ?? ""), name: String(item.name ?? "") };
      const startedAt = input.now();
      let result: ToolExecutionResult;
      if (call.name === READ_TOOL_RESULT_NAME) {
        result = await executeReadToolResult(call, { chatId: "eval", reader: store.reader, signal: input.signal, userId: "eval" });
      } else if (engine.router.accepts(call.name)) {
        result = await engine.router.execute(call, null, { retainOriginal: true, signal: input.signal });
        const query = typeof call.arguments.query === "string" ? call.arguments.query : null;
        searches.push(clientSearchRecord(result, query, Math.round((input.now() - startedAt) / 100) / 10));
      } else {
        result = { callId: call.id, content: [{ text: `Unknown tool ${JSON.stringify(call.name.slice(0, 80))}.`, type: "text" }],
          name: call.name, status: "error" };
      }
      const text = toolResultOutputText(result);
      const saveAbove = call.name === READ_TOOL_RESULT_NAME ? TOOL_RESULT_LIMITS.inlineChars : TOOL_RESULT_LIMITS.saveChars;
      const saved = text.length > saveAbove ? { handle: store.save({ arguments: call.arguments, text, toolName: call.name }) } : null;
      return { call_id: call.id, output: toolModelOutput(result, text, toolOutputExcerpt(text, saved)), type: "function_call_output" };
    }));
    conversation.push(...results);
  }
}

// ---------------------------------------------------------------- the run

export type EvaluationProgress = Readonly<{ code?: string; config: string; id: string; seconds: number; status: "error" | "ok" }>;

/**
 * Answers every (configuration, question) without an answer in `answersPath`, appending one record per attempt. Questions go in
 * order with all configurations of one question side by side, so an interrupted run still leaves paired results. A failed
 * question is recorded with its code and tried again by the next run.
 */
export async function runEvaluation(input: Readonly<{
  answer(question: Question, config: RunConfig, signal: AbortSignal): Promise<AnswerOutcome>;
  answersPath: string;
  concurrency: number;
  configs: readonly RunConfig[];
  now: () => number;
  progress?(event: EvaluationProgress): void;
  questions: readonly Question[];
  signal?: AbortSignal;
}>): Promise<Readonly<{ answered: number; failed: number; skipped: number }>> {
  const latest = latestAnswers(readJsonl(input.answersPath));
  const jobs: Array<Readonly<{ config: RunConfig; question: Question }>> = [];
  let skipped = 0;
  for (const question of input.questions) {
    for (const config of input.configs) {
      const done = latest.get(answerRecordKey({ config: configKey(config), id: question.id, qhash: questionHash(question) }));
      if (done?.status === "ok") skipped += 1;
      else jobs.push({ config, question });
    }
  }
  const signal = input.signal ?? new AbortController().signal;
  let answered = 0;
  let failed = 0;
  await mapPool(jobs, input.concurrency, async ({ config, question }) => {
    if (signal.aborted) return;
    const startedAt = input.now();
    const base = { config: configKey(config), effort: config.effort, engine: config.engine, id: question.id, model: config.model,
      qhash: questionHash(question), set: question.set, v: 1 as const };
    let record: AnswerRecord;
    try {
      const outcome = await input.answer(question, config, signal);
      record = { ...base, ...outcome, at: new Date().toISOString(), seconds: Math.round((input.now() - startedAt) / 100) / 10, status: "ok" };
      answered += 1;
    } catch (error) {
      if (signal.aborted) return;
      record = { ...base, at: new Date().toISOString(), code: failureCode(error), seconds: Math.round((input.now() - startedAt) / 100) / 10,
        status: "error" };
      failed += 1;
    }
    appendJsonl(input.answersPath, record);
    input.progress?.({ ...(record.code ? { code: record.code } : {}), config: record.config, id: record.id, seconds: record.seconds,
      status: record.status });
  });
  return { answered, failed, skipped };
}

// ---------------------------------------------------------------- the judge

/** SimpleQA-style grading (prototype `judge_lib.py`, 2026-11-26). */
export function judgePrompt(question: Question, answer: string): string {
  return [
    "You grade answers to factual questions. Compare the predicted answer with the gold target.",
    "- CORRECT: the predicted answer contains the gold target's meaning without contradicting it (minor wording, rounding, inflection, " +
      "transliteration or extra correct detail are fine; for numbers the same value written differently is fine).",
    "- INCORRECT: the predicted answer gives a different or contradictory final answer, or hedges between several answers.",
    "- NOT_ATTEMPTED: the predicted answer does not give an answer (says it cannot find or does not know).",
    `Question: ${question.q}`,
    `Gold target: ${question.gold}`,
    `Predicted answer: ${answer.slice(0, 3_000)}`,
    'Reply with JSON only: {"grade": "CORRECT" | "INCORRECT" | "NOT_ATTEMPTED"}'
  ].join("\n");
}

export function parseGrade(text: string): Grade | null {
  const match = /"grade"\s*:\s*"(CORRECT|INCORRECT|NOT_ATTEMPTED)"/u.exec(text);
  return match ? match[1] as Grade : null;
}

export type Grader = (question: Question, answer: string, signal: AbortSignal) => Promise<Grade | null>;

/** A grader on a Responses model; an unreadable verdict is asked again twice, a failed call leaves the answer ungraded. */
export function modelGrader(input: Readonly<{ effort: string; model: ResponsesModel; modelId: string }>): Grader {
  return async (question, answer, signal) => {
    if (!answer.trim()) return "NOT_ATTEMPTED";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await input.model({ input: [{ content: judgePrompt(question, answer), role: "user" }], model: input.modelId,
        reasoning: { effort: input.effort }, store: false, stream: false }, signal);
      const grade = parseGrade(responseText(response));
      if (grade) return grade;
    }
    return null;
  };
}

/** Grades every current answer that has no judgment yet, appending each verdict. */
export async function judgePending(input: Readonly<{
  answers: ReadonlyMap<string, AnswerRecord>;
  concurrency: number;
  grade: Grader;
  judgmentsPath: string;
  questions: readonly Question[];
  signal?: AbortSignal;
}>): Promise<Readonly<{ failed: number; graded: number }>> {
  const grades = readJudgments(input.judgmentsPath);
  const byId = new Map(input.questions.map((question) => [question.id, question]));
  const pending = [...input.answers.values()].filter((record) => record.status === "ok" && !grades.has(judgmentKey(record)) &&
    byId.get(record.id) && questionHash(byId.get(record.id)!) === record.qhash);
  const signal = input.signal ?? new AbortController().signal;
  let graded = 0;
  let failed = 0;
  await mapPool(pending, input.concurrency, async (record) => {
    let grade: Grade | null = null;
    try {
      grade = await input.grade(byId.get(record.id)!, record.answer ?? "", signal);
    } catch {
      grade = null;
    }
    if (grade) {
      appendJsonl(input.judgmentsPath, { grade, key: judgmentKey(record), v: 1 });
      graded += 1;
    } else {
      failed += 1;
    }
  });
  return { failed, graded };
}

// ---------------------------------------------------------------- statistics

/** Nearest-rank percentile; null without values. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

/** Two-sided exact McNemar test on the discordant pairs: a binomial test of `aWins` against `bWins` at one half. */
export function exactMcNemar(aWins: number, bWins: number): number {
  const n = aWins + bWins;
  if (n === 0) return 1;
  const smaller = Math.min(aWins, bWins);
  let logPmf = -n * Math.LN2;
  let tail = 0;
  for (let k = 0; k <= smaller; k += 1) {
    tail += Math.exp(logPmf);
    logPmf += Math.log((n - k) / (k + 1));
  }
  return Math.min(1, 2 * tail);
}

// ------------------------------------------------------------------- report

type ConfigRows = Readonly<{ config: string; records: Map<string, AnswerRecord> }>;

function format(value: number | null, digits: number): string {
  return value === null ? "-" : value.toFixed(digits);
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column]!.length)));
  const line = (row: readonly string[]) => row.map((cell, column) => column === 0 ? cell.padEnd(widths[column]!)
    : cell.padStart(widths[column]!)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

/**
 * The comparison table and the paired tests. Accuracy counts a question once a configuration has a record for it: an answer the
 * judge graded CORRECT counts, a failed or ungraded one does not (the err and ungr columns say how many). Engine cost is the mean
 * per answered question of what the engines reported, `unknown` when any search's cost is unknown (in-answer search is billed
 * inside the answer request, which Codex LB does not price). Russian means questions marked `lang: "ru"` or written mostly in
 * Cyrillic.
 */
export function buildReport(input: Readonly<{
  answers: ReadonlyMap<string, AnswerRecord>;
  grades: ReadonlyMap<string, Grade>;
  questions: readonly Question[];
}>): string {
  const byId = new Map(input.questions.map((question) => [question.id, question]));
  const sets = [...new Set(input.questions.map((question) => question.set))];
  const configs = new Map<string, ConfigRows>();
  for (const record of input.answers.values()) {
    const question = byId.get(record.id);
    if (!question || questionHash(question) !== record.qhash) continue;
    const rows = configs.get(record.config) ?? { config: record.config, records: new Map() };
    rows.records.set(record.id, record);
    configs.set(record.config, rows);
  }
  const grade = (record: AnswerRecord | undefined) => record?.status === "ok" ? input.grades.get(judgmentKey(record)) : undefined;
  const correct = (record: AnswerRecord | undefined) => grade(record) === "CORRECT";
  const accuracy = (rows: ConfigRows, filter: (question: Question) => boolean) => {
    const ids = [...rows.records.keys()].filter((id) => filter(byId.get(id)!));
    return ids.length === 0 ? null : 100 * ids.filter((id) => correct(rows.records.get(id))).length / ids.length;
  };
  const ordered = [...configs.values()].sort((left, right) => left.config.localeCompare(right.config));
  const body = ordered.map((rows) => {
    const records = [...rows.records.values()];
    const ok = records.filter((record) => record.status === "ok");
    const costs = ok.map((record) => record.engineCostUsd ?? null);
    const cost = ok.length > 0 && costs.every((value) => value !== null)
      ? costs.reduce<number>((sum, value) => sum + value!, 0) / ok.length : null;
    const searches = ok.flatMap((record) => (record.searches ?? []).filter((search) => !search.kind));
    const failedSearches = searches.filter((search) => search.status !== "complete").length;
    const seconds = ok.map((record) => record.seconds);
    return [
      rows.config,
      String(records.length),
      format(accuracy(rows, () => true), 0),
      ...sets.map((set) => format(accuracy(rows, (question) => question.set === set), 0)),
      format(accuracy(rows, (question) => question.russian), 0),
      format(ok.length ? 100 * ok.filter((record) => grade(record) === "NOT_ATTEMPTED").length / ok.length : null, 0),
      String(records.length - ok.length),
      String(ok.filter((record) => grade(record) === undefined).length),
      cost === null ? ok.length ? "unknown" : "-" : cost.toFixed(4),
      format(percentile(seconds, 0.5), 1),
      format(percentile(seconds, 0.9), 1),
      format(ok.length ? searches.length / ok.length : null, 1),
      format(searches.length ? 100 * failedSearches / searches.length : null, 0)
    ];
  });
  const header = ["model|engine|effort", "n", "acc%", ...sets.map((set) => `${set}%`), "RU%", "na%", "err", "ungr", "eng$/q", "p50s",
    "p90s", "srch/q", "srchfail%"];
  const pairs: string[][] = [];
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      const a = ordered[left]!;
      const b = ordered[right]!;
      const shared = [...a.records.keys()].filter((id) => b.records.has(id));
      const aWins = shared.filter((id) => correct(a.records.get(id)) && !correct(b.records.get(id))).length;
      const bWins = shared.filter((id) => correct(b.records.get(id)) && !correct(a.records.get(id))).length;
      pairs.push([a.config, b.config, String(shared.length), String(aWins), String(bWins), exactMcNemar(aWins, bWins).toFixed(3)]);
    }
  }
  pairs.sort((left, right) => Number(left[5]) - Number(right[5]) || left[0]!.localeCompare(right[0]!));
  return [
    `Questions: ${input.questions.length} (${sets.map((set) => `${set} ${input.questions.filter((question) => question.set === set).length}`).join(", ")}; ` +
      `Russian ${input.questions.filter((question) => question.russian).length})`,
    "",
    table(header, body),
    "",
    "acc% counts failed (err) and ungraded (ungr) answers as not correct; na% is NOT_ATTEMPTED among answers; eng$/q is the engines' " +
      "reported cost per answer (unknown when any search's cost is unknown); p50s/p90s are seconds per answer; srchfail% counts failed " +
      "or empty searches.",
    "",
    "Paired comparisons (questions both answered; A wins / B wins; exact McNemar p):",
    pairs.length ? table(["A", "B", "n", "A wins", "B wins", "p"], pairs) : "(fewer than two configurations)"
  ].join("\n");
}

// ------------------------------------------------------------------- dry run

/** A model that searches once with the question, then answers from what it read; the judge port calls every answer INCORRECT. */
export function dryRunModel(): ResponsesModel {
  return (body) => {
    const conversation = Array.isArray(body.input) ? body.input.filter(isRecord) : [];
    const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord) : [];
    const searchTool = tools.find((tool) => tool.type === "function" && tool.name !== READ_TOOL_RESULT_NAME);
    const prompt = typeof conversation[0]?.content === "string" ? conversation[0].content : "";
    if (prompt.startsWith("You grade answers")) {
      return Promise.resolve({ output: [{ content: [{ text: '{"grade": "INCORRECT"}', type: "output_text" }], type: "message" }],
        status: "completed" });
    }
    const results = conversation.filter((item) => item.type === "function_call_output");
    if (searchTool && results.length === 0 && body.tool_choice !== "none") {
      return Promise.resolve({ output: [{ arguments: JSON.stringify({ query: prompt.slice(0, 100) }), call_id: "call_dry_1",
        name: searchTool.name, type: "function_call" }], status: "completed", usage: { input_tokens: 10, output_tokens: 5 } });
    }
    return Promise.resolve({ output: [{ content: [{ text: "Dry run: no model was called.", type: "output_text" }], type: "message" }],
      status: "completed", usage: { input_tokens: 20, output_tokens: 5 } });
  };
}

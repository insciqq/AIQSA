/**
 * Compaction quality evaluation for the native engine (task
 * `engine-compaction`): rerun on every change to compaction code or prompts.
 *
 * For each synthetic session (`compaction-quality-scenarios.ts`) and each
 * path (native, summary) it plans and runs one real compaction through
 * `compact()` (three in a row for `sequential`; native on the model, then a
 * summary for `--switch-model` from the stored transcript for `switch`), then
 * asks the compacted agent a recall question about the planted probes (it may
 * read saved results with `read_tool_result`) and gives it the session's
 * continuation (tools are simulated), scoring exact recall per probe,
 * constraint adherence, repeated finished work, latency and sizes.
 *
 * Output is content-free JSON lines on stdout (and `--out <file>`): counts,
 * timings, usage, sizes, booleans per probe and check, error codes. Keys,
 * prompts, transcripts, summaries and answers are never printed.
 *
 * Run (Codex LB; key from the environment, never from .env):
 *   CODEX_LB_API_KEY=... npx tsx scripts/eval/compaction-quality.ts [flags]
 *   npx tsx scripts/eval/compaction-quality.ts --dry-run      (no network)
 * Other providers (summary path and mechanism checks): --provider
 * openrouter|gemini|deepseek|openai with OPENROUTER_API_KEY, GEMINI_API_KEY,
 * DEEPSEEK_API_KEY or OPENAI_API_KEY. See `--help`.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contextTokenEstimator, tokenEstimateProfileFor } from "../../lib/domain/tokenEstimate";
import { normalizeTokenUsage } from "../../lib/domain/usage";
import {
  compact,
  COMPACTION_DEFAULTS,
  compactionRetention,
  findCompactionCut,
  planCompaction,
  usableContextTokens,
  type CompactionCut,
  type CompactionMetadata,
  type CompactionMode,
  type CompactionModelCall,
  type CompactionPath
} from "../../lib/server/engine/compaction";
import { SUMMARIZER_INSTRUCTIONS, SUMMARY_SECTIONS } from "../../lib/server/engine/compaction/summaryPrompt";
import { nativeCompactionRequest, summaryCompactionRequest } from "../../lib/server/engine/compactionCalls";
import {
  contextAnchor,
  contextItemTokens,
  contextMeasureCalibration,
  measureContext,
  type ContextAnchor,
  type ContextMeasureCalibration
} from "../../lib/server/engine/contextMeasure";
import {
  modelResponseItems,
  projectTranscript,
  type TranscriptItem,
  type TranscriptTarget
} from "../../lib/server/engine/transcript";
import { responsesHistoryFromOutput, type ProviderHistoryItem } from "../../lib/server/providers/history";
import { modelCallRetryDecision } from "../../lib/server/engine/modelCall";
import { sleepWithSignal } from "../../lib/server/providers/providerRetry";
import { createProviderSafeFetch } from "../../lib/server/providers/providerSafeFetch";
import type { ProviderModelCapabilities, ProviderRunRequest, ProviderRunResult } from "../../lib/server/providers/types";
import type { RunTool } from "../../lib/server/tools/types";
import { DEFAULT_ROOT, parseAnswerObject } from "../spikes/compaction-scale";
import { createSpikeConnection, SPIKE_PROVIDER_PROFILES, SPIKE_PROVIDERS, type SpikeProvider } from "../spikes/transcript-replay-support";
import { APPROVAL_PENDING_TEXT } from "../../lib/server/engine/compaction/items";
import {
  SCENARIO_IDS,
  SCENARIOS,
  type BuiltScenario,
  type Continuation,
  type EvalScenario,
  type EvalTool,
  type HandlePolicy,
  type Probe,
  type ProbeCategory,
  type ScenarioId
} from "./compaction-quality-scenarios";

// ------------------------------------------------------------------ options

export type EvalOptions = Readonly<{
  concurrency: number;
  dryRun: boolean;
  /** Reasoning effort of the recall and continuation calls. */
  effort: string;
  /** Which results are saved with a handle: those the engine saves, or all. */
  handles: HandlePolicy;
  /** Output each request reserves from the window. */
  maxOutputTokens: number;
  mode: CompactionMode;
  model: string;
  out?: string;
  paths: readonly CompactionPath[];
  provider: SpikeProvider;
  /** Responses root (without /v1) for Codex LB. */
  root: string;
  scenarios: readonly ScenarioId[];
  seed: number;
  summaryEffort: string;
  summaryMaxOutputTokens: number | null;
  switchModel: string;
  timeoutMs: number;
  tokens: number;
  /** The context window planning uses; null sizes it so the session sits at 75 %. */
  window: number | null;
}>;

export const EVAL_USAGE = `Usage: npx tsx scripts/eval/compaction-quality.ts [flags]

Environment: CODEX_LB_API_KEY (default provider codex-lb, root https://codex-lb.psaux.info,
  override with --root or CODEX_LB_ROOT); OPENAI_API_KEY, OPENROUTER_API_KEY,
  GEMINI_API_KEY, DEEPSEEK_API_KEY for --provider. Nothing is read from .env.

Flags:
  --scenarios a,b         ${SCENARIO_IDS.join(",")} (default: all)
  --paths a,b             native,summary (default: both; native needs codex-lb or openai)
  --provider p            ${SPIKE_PROVIDERS.join(", ")} (default codex-lb)
  --model id              (default gpt-6.1-sol)
  --switch-model id       second model of the switch scenario (default gpt-6-astra)
  --tokens N              size of each session in estimated tokens (default 160000)
  --handles large|all     results saved with a handle: those over 2000 characters, as the engine
                          does (default), or every result
  --window N|auto         context window for planning (default auto: the session at 75 %)
  --max-output N          output each request reserves (default 32000)
  --mode m                background|foreground compaction budgets (default background)
  --summary-max-output N  summary output tokens (default by mode: 8192 / 4096)
  --summary-effort e      reasoning effort of summary calls (default low)
  --effort e              reasoning effort of recall and continuation calls (default low)
  --seed N                (default 1)
  --concurrency N         scenario runs at once (default 2)
  --timeout-ms N          per model call (default 600000)
  --root url              Responses root for codex-lb (default ${DEFAULT_ROOT})
  --out file              also append the JSON lines to this file
  --dry-run               build, plan and compact with a fake model; no network`;

const EFFORT = /^(?:none|minimal|low|medium|high|xhigh)$/u;
const MODEL = /^[A-Za-z0-9][\w.:/-]{0,127}$/u;

function invalid(flag: string): never {
  throw new Error(`eval_argument_invalid:${flag.replace(/[^a-z-]/gu, "")}`);
}

function count(flag: string, value: string | undefined, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!value || !/^\d+$/u.test(value) || parsed < minimum || parsed > maximum) invalid(flag);
  return parsed;
}

export function parseEvalArguments(argv: readonly string[], env: Readonly<Record<string, string | undefined>>):
  EvalOptions | Readonly<{ help: true }> {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined) invalid(flag);
    values.set(flag.slice(2), value);
    index += 1;
  }
  const known = new Set(["scenarios", "paths", "provider", "model", "switch-model", "tokens", "handles", "window", "max-output", "mode",
    "summary-max-output", "summary-effort", "effort", "seed", "concurrency", "timeout-ms", "root", "out"]);
  for (const key of values.keys()) if (!known.has(key)) invalid(`--${key}`);
  const list = <T extends string>(flag: string, allowed: readonly T[], fallback: readonly T[]): T[] => {
    const raw = values.get(flag);
    if (raw === undefined) return [...fallback];
    const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0 || !entries.every((entry) => (allowed as readonly string[]).includes(entry))) invalid(`--${flag}`);
    return [...new Set(entries as T[])];
  };
  const provider = values.get("provider") ?? "codex-lb";
  if (!(SPIKE_PROVIDERS as readonly string[]).includes(provider)) invalid("--provider");
  const paths = list<CompactionPath>("paths", ["native", "summary"], ["native", "summary"]);
  if (paths.includes("native") && provider !== "codex-lb" && provider !== "openai") invalid("--paths");
  for (const flag of ["model", "switch-model"]) if (values.has(flag) && !MODEL.test(values.get(flag)!)) invalid(`--${flag}`);
  for (const flag of ["summary-effort", "effort"]) if (values.has(flag) && !EFFORT.test(values.get(flag)!)) invalid(`--${flag}`);
  const mode = values.get("mode") ?? "background";
  if (mode !== "background" && mode !== "foreground") invalid("--mode");
  const handles = values.get("handles") ?? "large";
  if (handles !== "large" && handles !== "all") invalid("--handles");
  const window = values.get("window") ?? "auto";
  const root = (values.get("root") ?? env.CODEX_LB_ROOT ?? DEFAULT_ROOT).replace(/\/+$/u, "");
  if (!/^https:\/\/[^/\s]+(?:\/[^?#\s]*)?$/u.test(root) || /\/v1$/u.test(root)) invalid("--root");
  return {
    concurrency: count("--concurrency", values.get("concurrency") ?? "2", 1, 6),
    dryRun,
    effort: values.get("effort") ?? "low",
    handles,
    maxOutputTokens: count("--max-output", values.get("max-output") ?? "32000", 0, 1_000_000),
    mode,
    model: values.get("model") ?? "gpt-6.1-sol",
    ...(values.has("out") ? { out: values.get("out")! } : {}),
    paths,
    provider: provider as SpikeProvider,
    root,
    scenarios: list<ScenarioId>("scenarios", SCENARIO_IDS, SCENARIO_IDS),
    seed: count("--seed", values.get("seed") ?? "1", 0, 1_000_000),
    summaryEffort: values.get("summary-effort") ?? "low",
    summaryMaxOutputTokens: values.has("summary-max-output") ? count("--summary-max-output", values.get("summary-max-output"), 256, 65_536) : null,
    switchModel: values.get("switch-model") ?? "gpt-6-astra",
    timeoutMs: count("--timeout-ms", values.get("timeout-ms") ?? "600000", 10_000, 3_600_000),
    tokens: count("--tokens", values.get("tokens") ?? "160000", 4_000, 2_000_000),
    window: window === "auto" ? null : count("--window", window, 8_000, 10_000_000)
  };
}

// ------------------------------------------------------------- the models

/** One model as the evaluation calls it. */
export type EvalModel = Readonly<{
  /** The route compacts natively (Codex LB, OpenAI): a request with `compactionTrigger` returns one compaction item. */
  nativeCompaction: boolean;
  /** A request through the product's provider adapter. */
  run(request: ProviderRunRequest, signal: AbortSignal): Promise<ProviderRunResult>;
}>;

export type EvalEnvironment = Readonly<{
  emit(line: Readonly<Record<string, unknown>>): void;
  /** The model for a provider and model id, or null without credentials. */
  model(provider: SpikeProvider, model: string): EvalModel | null;
  now(): number;
}>;

const CAPABILITIES: ProviderModelCapabilities = {
  nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, streaming: true, toolCalling: true, vision: false
};

function requestParams(provider: SpikeProvider, maxOutputTokens: number, effort: string): Record<string, unknown> {
  switch (provider) {
    case "codex-lb":
      return { maxOutputTokens, reasoning: { effort, summary: "auto" }, stream: true };
    case "openai":
      return { background: false, maxOutputTokens, reasoning: { effort, summary: "auto" }, store: false, stream: true };
    case "openrouter":
      return { maxTokens: maxOutputTokens, reasoning: { effort, enabled: true }, stream: true };
    case "gemini":
    case "deepseek":
      return { maxOutputTokens, reasoning: { effort }, stream: true };
  }
}

function runTool(tool: EvalTool): RunTool {
  return { capability: "mcp", description: tool.description, inputSchema: { ...tool.parameters }, name: tool.name };
}

export const READ_TOOL_RESULT: EvalTool = {
  description: "Read a saved tool result by its handle (tor1_…). Returns up to `limit` characters from `offset`.",
  name: "read_tool_result",
  parameters: { additionalProperties: false, properties: { handle: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } },
    required: ["handle"], type: "object" }
};

type Run = Readonly<{
  build: BuiltScenario;
  calibration: ContextMeasureCalibration;
  estimate: (value: unknown) => number;
  fixedTokens: number;
  model: EvalModel;
  options: EvalOptions;
  scenario: EvalScenario;
  target: TranscriptTarget;
}>;

function request(run: Run, history: readonly ProviderHistoryItem[], input: Readonly<{
  effort: string; maxOutputTokens: number; system: string; toolChoice: "auto" | "none"; tools: readonly EvalTool[];
}>): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: `eval-${run.scenario.id}`,
    content: { blocks: [] },
    history,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: run.options.provider === "gemini"
      ? { ...CAPABILITIES, reasoningEfforts: ["minimal", "low", "medium", "high"] } : CAPABILITIES,
    modelId: run.target.model,
    parallelToolCalls: false,
    params: requestParams(run.options.provider, input.maxOutputTokens, input.effort),
    prompt: { developer: null, system: input.system },
    provider: SPIKE_PROVIDER_PROFILES[run.options.provider].family,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: input.tools.length > 0 ? input.toolChoice : "none",
    toolMode: input.tools.length > 0 ? "auto" : "none",
    tools: input.tools.map(runTool)
  };
}

/**
 * The compaction call `compact()` uses, built as the engine builds it
 * (`lib/server/engine/compactionCalls.ts`) from the session's own request
 * and sent through the product's adapter: a native call is that request
 * with the span as history and the `compaction_trigger` item last, a
 * summary call the allowlisted request with the summarizer's instructions.
 */
function compactionCall(run: Run): CompactionModelCall {
  return async (call) => {
    const native = call.kind === "native";
    if (native && !run.model.nativeCompaction) throw new Error("native_unsupported");
    const session = request(run, [], { effort: native ? run.options.effort : run.options.summaryEffort, maxOutputTokens: 8_192,
      system: run.scenario.instructions, toolChoice: "auto", tools: run.scenario.tools });
    const response = await run.model.run(native ? nativeCompactionRequest(session, call) : summaryCompactionRequest(session, call),
      call.signal);
    const usage = normalizeTokenUsage(response.usage);
    return { ...(response.history ? { history: response.history } : {}), text: response.finalText,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
  };
}

// --------------------------------------------------------------- the agent

type CallRecord = Readonly<{ arguments: string; name: string }>;

type Conversation = Readonly<{
  calls: readonly CallRecord[];
  /** Anchored estimate error per call after the first, in percent of reported input. */
  estimateErrors: readonly number[];
  firstInputTokens: number | null;
  inputTokens: number | null;
  latencyMs: number;
  outputTokens: number | null;
  reads: number;
  rounds: number;
  text: string;
}>;

function serveTool(run: Run, call: CallRecord): Readonly<{ outcome: "complete" | "error"; output: string }> {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    args = {};
  }
  if (call.name === READ_TOOL_RESULT.name) {
    const stored = typeof args.handle === "string" ? run.build.store.get(args.handle) : undefined;
    if (stored === undefined) return { outcome: "error", output: JSON.stringify({ code: "tool_observation_unavailable" }) };
    const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(Math.floor(args.limit), 24_000) : 24_000;
    return { outcome: "complete", output: JSON.stringify({ content: stored.slice(offset, offset + limit), offset, total: stored.length }) };
  }
  // The continuation's tools are simulated: every call succeeds without effect.
  return { outcome: "complete", output: /shell|exec/u.test(call.name)
    ? JSON.stringify({ exit_code: 0, stderr: "", stdout: "ok (simulated in evaluation)" })
    : JSON.stringify({ ok: true, note: "simulated in evaluation" }) };
}

/** A user turn on the compacted transcript: up to `maxRounds` model calls, tools served locally. */
async function converse(run: Run, items: readonly TranscriptItem[], prompt: string, tools: readonly EvalTool[],
  maxRounds: number, now: () => number): Promise<Conversation> {
  const transcript: TranscriptItem[] = [...items, { id: run.build.nextId(), kind: "user", text: prompt }];
  const started = now();
  const calls: CallRecord[] = [];
  const estimateErrors: number[] = [];
  let anchor: ContextAnchor | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let firstInputTokens: number | null = null;
  let reads = 0;
  let text = "";
  let rounds = 0;
  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;
    const measure = measureContext({ anchor, calibration: run.calibration, estimate: run.estimate, fixedTokens: run.fixedTokens,
      items: transcript, target: run.target });
    const result = await run.model.run(request(run, projectTranscript(transcript, run.target), {
      effort: run.options.effort, maxOutputTokens: 8_192, system: run.scenario.instructions,
      toolChoice: round === maxRounds ? "none" : "auto", tools
    }), AbortSignal.timeout(run.options.timeoutMs));
    const usage = normalizeTokenUsage(result.usage);
    if (usage.inputTokens !== null) {
      inputTokens = (inputTokens ?? 0) + usage.inputTokens;
      firstInputTokens ??= usage.inputTokens;
      if (measure.anchored && usage.inputTokens > 0) {
        estimateErrors.push(Math.round((measure.tokens - usage.inputTokens) / usage.inputTokens * 10_000) / 100);
      }
    }
    if (usage.outputTokens !== null) outputTokens = (outputTokens ?? 0) + usage.outputTokens;
    const produced: readonly ProviderHistoryItem[] = result.history ?? (result.finalText ? [{ text: result.finalText, type: "assistant_text" }] : []);
    const itemCount = transcript.length;
    transcript.push(...modelResponseItems({ estimate: run.estimate, history: produced, nextId: run.build.nextId, origin: run.target, usage }));
    anchor = contextAnchor({ itemCount, target: run.target, usage }) ?? anchor;
    text = result.finalText;
    const requested = produced.flatMap((item) => item.type === "tool_call" ? [item] : []);
    if (requested.length === 0) break;
    for (const call of requested) {
      const record = { arguments: call.arguments, name: call.name };
      calls.push(record);
      if (call.name === READ_TOOL_RESULT.name) reads += 1;
      const served = serveTool(run, record);
      transcript.push({ callId: call.callId, id: run.build.nextId(), kind: "tool_result", name: call.name, ...served });
    }
  }
  return { calls, estimateErrors, firstInputTokens, inputTokens, latencyMs: Math.round(now() - started), outputTokens, reads, rounds, text };
}

// ------------------------------------------------------------------ scoring

export function normalizeAnswer(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value !== "string") return null;
  return value.trim().replace(/^[`"'«]+|[`"'».]+$/gu, "").replace(/\s+/gu, " ").replace(/(\d)[ ,](?=\d{3}(?!\d))/gu, "$1").toLowerCase();
}

export function recallQuestion(probes: readonly Probe[]): string {
  return [
    "Pause the work and answer a check question about this session. Use the conversation above, including any summary and recorded " +
    "state; when an exact value lives in a saved tool result, you may read it with read_tool_result first.",
    "Then reply with exactly one JSON object and nothing else, no prose and no code fence, with exactly these keys:",
    ...probes.flatMap((probe) => probe.fields.map((field) => `- "${field.key}": ${field.question}`)),
    "Use each value exactly as written in the session (same spelling, digits and case), as a string. Use null for a value you do not know."
  ].join("\n");
}

export type RecallScore = Readonly<{
  categories: Readonly<Partial<Record<ProbeCategory, Readonly<{ hit: number; total: number }>>>>;
  fields: Readonly<Record<string, boolean>>;
  parsed: boolean;
  probes: Readonly<Record<string, boolean>>;
  /** Keys answered with a superseded value. */
  superseded: readonly string[];
}>;

export function scoreRecall(text: string, probes: readonly Probe[]): RecallScore {
  const answer = parseAnswerObject(text);
  const fields: Record<string, boolean> = {};
  const scored: Record<string, boolean> = {};
  const superseded: string[] = [];
  const categories: Partial<Record<ProbeCategory, { hit: number; total: number }>> = {};
  for (const probe of probes) {
    let all = true;
    for (const field of probe.fields) {
      const got = normalizeAnswer(answer?.[field.key]);
      const accepted = [field.expected, ...(field.accept ?? [])].map((value) => normalizeAnswer(value));
      const hit = got !== null && accepted.includes(got);
      fields[field.key] = hit;
      all &&= hit;
      if (got !== null && (field.superseded ?? []).some((value) => normalizeAnswer(value) === got)) superseded.push(field.key);
    }
    scored[probe.id] = all;
    const bucket = categories[probe.category] ?? { hit: 0, total: 0 };
    bucket.total += 1;
    if (all) bucket.hit += 1;
    categories[probe.category] = bucket;
  }
  return { categories, fields, parsed: answer !== null, probes: scored, superseded };
}

export type ContinuationScore = Readonly<{
  /** Whether each `next` check matched, by id: which part of the next step was missed. */
  next: Readonly<Record<string, boolean>>;
  nextStep: boolean;
  repeated: readonly string[];
  /** Re-issued the call that waits for approval. */
  repeatedPending: boolean;
  toolCalls: number;
  violations: readonly string[];
}>;

/** Arguments as compact JSON, whatever spacing or escapes the model sent, so patterns see one form. */
export function compactArguments(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

export function scoreContinuation(continuation: Continuation, calls: readonly CallRecord[], text: string,
  pending: CallRecord | null): ContinuationScore {
  const compact = calls.map((call) => ({ arguments: compactArguments(call.arguments), name: call.name }));
  const matches = (tool: RegExp | undefined, pattern: RegExp) => tool
    ? compact.some((call) => tool.test(call.name) && pattern.test(call.arguments))
    : compact.some((call) => pattern.test(`${call.name} ${call.arguments}`)) || pattern.test(text);
  const next = Object.fromEntries(continuation.checks.filter((check) => check.kind === "next")
    .map((check) => [check.id, matches(check.tool, check.pattern)]));
  const pendingArguments = pending ? compactArguments(pending.arguments) : null;
  return {
    next,
    nextStep: Object.keys(next).length > 0 && Object.values(next).every(Boolean),
    repeated: continuation.repeated.filter((check) => compact.some((call) => check.tool.test(call.name) && check.pattern.test(call.arguments)))
      .map((check) => check.id),
    repeatedPending: pending !== null && compact.some((call) => call.name === pending.name && call.arguments === pendingArguments),
    toolCalls: calls.length,
    violations: continuation.checks.filter((check) => check.kind === "forbidden" && matches(check.tool, check.pattern)).map((check) => check.id)
  };
}

/** The scenario's tool names the continuation called, in order; any other name counts as `other` (names only, never arguments). */
export function calledTools(scenario: Pick<EvalScenario, "tools">, calls: readonly CallRecord[]): string[] {
  const known = new Set([...scenario.tools.map((tool) => tool.name), READ_TOOL_RESULT.name]);
  return calls.map((call) => known.has(call.name) ? call.name : "other");
}

// ---------------------------------------------------------------- the runs

function metadataRecord(metadata: CompactionMetadata): Record<string, unknown> {
  return { ...metadata };
}

/** The latest call still waiting for its result or the user's approval. */
function pendingCall(items: readonly TranscriptItem[]): CallRecord | null {
  const latest = new Map<string, TranscriptItem>();
  for (const item of items) if (item.kind === "tool_result") latest.set(item.callId, item);
  const call = [...items].reverse().find((item) => {
    if (item.kind !== "tool_call") return false;
    const result = latest.get(item.callId);
    return !result || (result.kind === "tool_result" && result.output === APPROVAL_PENDING_TEXT);
  });
  return call?.kind === "tool_call" ? { arguments: call.arguments, name: call.name } : null;
}

type Step = Readonly<{ items: TranscriptItem[]; ok: boolean }>;

/** Plans and runs one compaction on `items` for `target`, appending its item. */
async function compactOnce(run: Run, env: EvalEnvironment, items: readonly TranscriptItem[], path: CompactionPath,
  base: Readonly<Record<string, unknown>>, step: number): Promise<Step> {
  const tokens = measureContext({ calibration: run.calibration, estimate: run.estimate, fixedTokens: run.fixedTokens, items, target: run.target }).tokens;
  const window = { contextWindow: run.options.window ?? Math.ceil(tokens / 0.75) + run.options.maxOutputTokens, maxOutputTokens: run.options.maxOutputTokens };
  const usable = usableContextTokens(window);
  const plan = planCompaction({ background: "idle", calibration: run.calibration, estimate: run.estimate, items, target: run.target, tokens, window });
  let cut: CompactionCut | null = plan.kind === "background" || plan.kind === "foreground" ? plan.cut : null;
  const planned = cut ? plan.kind : "forced";
  cut ??= findCompactionCut({ calibration: run.calibration, estimate: run.estimate, items, recentTokens: compactionRetention(usable).recentTokens,
    target: run.target });
  if (!cut) {
    env.emit({ ...base, code: "no_cut_point", event: "error", stage: "compaction", step });
    return { items: [...items], ok: false };
  }
  const outcome = await compact({
    call: compactionCall(run), calibration: run.calibration, classifyTool: run.scenario.classify, cut, estimate: run.estimate, items,
    mode: run.options.mode, nextId: run.build.nextId, now: env.now,
    options: { ...(run.options.summaryMaxOutputTokens ? { summaryOutputTokens: run.options.summaryMaxOutputTokens } : {}),
      summaryReasoningEffort: run.options.summaryEffort },
    path, target: run.target, usable
  });
  env.emit({ ...base, event: "compaction", model: run.target.model, planned, requestedPath: path, share: Math.round(plan.share * 1_000) / 1_000,
    step, tokens, usable, ...metadataRecord(outcome.metadata) });
  return outcome.ok ? { items: [...items, outcome.item], ok: true } : { items: [...items], ok: false };
}

async function recall(run: Run, env: EvalEnvironment, items: readonly TranscriptItem[], probes: readonly Probe[],
  base: Readonly<Record<string, unknown>>, after: number): Promise<RecallScore | null> {
  try {
    const conversation = await converse(run, items, recallQuestion(probes), [READ_TOOL_RESULT], 4, env.now);
    const score = scoreRecall(conversation.text, probes);
    env.emit({ ...base, after, event: "recall", model: run.target.model, ...conversationRecord(conversation), ...score });
    return score;
  } catch (error) {
    env.emit({ ...base, after, code: errorCode(error), ...errorStatus(error), event: "error", stage: "recall" });
    return null;
  }
}

async function continueWork(run: Run, env: EvalEnvironment, items: readonly TranscriptItem[],
  base: Readonly<Record<string, unknown>>): Promise<ContinuationScore | null> {
  try {
    const conversation = await converse(run, items, run.scenario.continuation.prompt, [...run.scenario.tools, READ_TOOL_RESULT], 4, env.now);
    const score = scoreContinuation(run.scenario.continuation, conversation.calls, conversation.text, pendingCall(items));
    env.emit({ ...base, calledTools: calledTools(run.scenario, conversation.calls), event: "continuation", model: run.target.model,
      ...conversationRecord(conversation), ...score });
    return score;
  } catch (error) {
    env.emit({ ...base, code: errorCode(error), ...errorStatus(error), event: "error", stage: "continuation" });
    return null;
  }
}

function conversationRecord(conversation: Conversation): Record<string, unknown> {
  return {
    estimateErrorPct: conversation.estimateErrors, firstInputTokens: conversation.firstInputTokens, inputTokens: conversation.inputTokens,
    latencyMs: conversation.latencyMs, outputTokens: conversation.outputTokens, reads: conversation.reads, rounds: conversation.rounds
  };
}

/** The HTTP status a provider error carries, when it carries one. */
function errorStatus(error: unknown): { httpStatus?: number } {
  const status = error && typeof error === "object" ? (error as { httpStatus?: unknown }).httpStatus : undefined;
  return typeof status === "number" && Number.isInteger(status) ? { httpStatus: status } : {};
}

/** A code-like identifier from a failure, never its message. */
function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[\w.:-]{1,80}$/u.test(code)) return code;
  }
  if (error instanceof Error && /^[a-z][a-z0-9_]{1,63}$/u.test(error.message)) return error.message;
  return error instanceof Error ? `error_${error.name.replace(/\W/gu, "").slice(0, 40)}` : "error_unknown";
}

/** The estimate, calibration and transcript target of one provider and model. */
function measuring(options: EvalOptions, modelId: string) {
  const family = SPIKE_PROVIDER_PROFILES[options.provider].family;
  const estimate = contextTokenEstimator({ modelId, provider: family });
  const target: TranscriptTarget = { model: modelId, provider: options.provider,
    ...(options.provider === "codex-lb" || options.provider === "openai" ? { nativeCompaction: true } : {}) };
  return { calibration: contextMeasureCalibration(tokenEstimateProfileFor({ modelId, provider: family })), estimate, target };
}

function runFor(scenario: EvalScenario, build: BuiltScenario, options: EvalOptions, model: EvalModel, modelId: string): Run {
  const { calibration, estimate, target } = measuring(options, modelId);
  return {
    build, calibration, estimate, fixedTokens: estimate(scenario.instructions) + estimate(JSON.stringify(scenario.tools)) + 16,
    model, options, scenario, target
  };
}

export type PathOutcome = Readonly<{
  continuation: ContinuationScore | null;
  firstRecall: RecallScore | null;
  path: CompactionPath | "native+switch";
  recall: RecallScore | null;
  scenario: ScenarioId;
}>;

async function runScenarioPath(options: EvalOptions, env: EvalEnvironment, id: ScenarioId, path: CompactionPath): Promise<PathOutcome | null> {
  const scenario = SCENARIOS[id];
  const model = env.model(options.provider, options.model);
  const label = id === "switch" ? "native+switch" as const : path;
  const base = { path: label, scenario: id };
  if (!model) {
    env.emit({ ...base, code: "missing_credentials", event: "error", stage: "connect" });
    return null;
  }
  const sizing = measuring(options, options.model);
  const build = scenario.build({ handles: options.handles, seed: options.seed, targetTokens: options.tokens,
    weigh: (item) => contextItemTokens(item, sizing.target, sizing.estimate, "opaque", sizing.calibration) });
  const run = runFor(scenario, build, options, model, options.model);
  env.emit({ ...base, event: "transcript", handles: build.handles.size, items: build.items.length, phaseEnds: build.phaseEnds,
    planted: build.planted.map((entry) => ({ id: entry.id, position: Math.round(entry.position * 1_000) / 1_000 })),
    tokens: measureContext({ calibration: run.calibration, estimate: run.estimate, fixedTokens: run.fixedTokens, items: build.items, target: run.target }).tokens });

  if (id === "sequential") {
    let items: TranscriptItem[] = [];
    let firstRecall: RecallScore | null = null;
    let start = 0;
    for (const [index, end] of build.phaseEnds.entries()) {
      items = [...items, ...build.items.slice(start, end)];
      start = end;
      const step = await compactOnce(run, env, items, path, base, index + 1);
      if (!step.ok) return { continuation: null, firstRecall, path: label, recall: null, scenario: id };
      items = step.items;
      if (index === 0) firstRecall = await recall(run, env, items, scenario.probes.filter((probe) => probe.phase === 1), base, 1);
    }
    const last = await recall(run, env, items, scenario.probes, base, build.phaseEnds.length);
    const continuation = await continueWork(run, env, items, base);
    return { continuation, firstRecall, path: label, recall: last, scenario: id };
  }

  if (id === "switch") {
    // Native first where the route has it; the switched model then reads only the stored transcript.
    const native = await compactOnce(run, env, build.items, model.nativeCompaction ? "native" : "summary", base, 1);
    if (!native.ok) return { continuation: null, firstRecall: null, path: label, recall: null, scenario: id };
    const switched = env.model(options.provider, options.switchModel);
    if (!switched) {
      env.emit({ ...base, code: "missing_credentials", event: "error", stage: "connect" });
      return null;
    }
    const other = runFor(scenario, build, options, switched, options.switchModel);
    const summary = await compactOnce(other, env, native.items, "summary", base, 2);
    if (!summary.ok) return { continuation: null, firstRecall: null, path: label, recall: null, scenario: id };
    const score = await recall(other, env, summary.items, scenario.probes, base, 2);
    const continuation = await continueWork(other, env, summary.items, base);
    return { continuation, firstRecall: null, path: label, recall: score, scenario: id };
  }

  const step = await compactOnce(run, env, build.items, path, base, 1);
  if (!step.ok) return { continuation: null, firstRecall: null, path: label, recall: null, scenario: id };
  const score = await recall(run, env, step.items, scenario.probes, base, 1);
  const continuation = await continueWork(run, env, step.items, base);
  return { continuation, firstRecall: null, path: label, recall: score, scenario: id };
}

function share(hit: number, total: number): string {
  return `${hit}/${total}`;
}

/** Per-path totals against the targets: 100 % for constraints, corrections and pending items; 90 % for facts. */
export function summarizeOutcomes(outcomes: readonly PathOutcome[]): Record<string, unknown> {
  const byPath = new Map<string, PathOutcome[]>();
  for (const outcome of outcomes) byPath.set(outcome.path, [...(byPath.get(outcome.path) ?? []), outcome]);
  const paths: Record<string, unknown> = {};
  for (const [path, list] of byPath) {
    const totals: Record<string, { hit: number; total: number }> = {};
    for (const outcome of list) {
      for (const [category, value] of Object.entries(outcome.recall?.categories ?? {})) {
        const bucket = totals[category] ?? { hit: 0, total: 0 };
        bucket.hit += value?.hit ?? 0;
        bucket.total += value?.total ?? 0;
        totals[category] = bucket;
      }
    }
    const strict = ["constraint", "correction", "pending"].every((category) => !totals[category] || totals[category]!.hit === totals[category]!.total);
    const facts = totals.fact;
    const continuations = list.flatMap((outcome) => outcome.continuation ? [outcome.continuation] : []);
    const sequential = list.find((outcome) => outcome.scenario === "sequential");
    const firstPhase = (score: RecallScore | null) => score
      ? Object.entries(score.probes).filter(([id]) => SCENARIOS.sequential.probes.some((probe) => probe.id === id && probe.phase === 1))
        .filter(([, hit]) => hit).length : null;
    paths[path] = {
      categories: Object.fromEntries(Object.entries(totals).map(([category, value]) => [category, share(value.hit, value.total)])),
      continuations: share(continuations.filter((score) => score.nextStep).length, list.length),
      factsMeetTarget: facts ? facts.hit >= facts.total * 0.9 : null,
      recallFailures: list.filter((outcome) => !outcome.recall).length,
      repeatedWork: continuations.reduce((total, score) => total + score.repeated.length + (score.repeatedPending ? 1 : 0), 0),
      sequentialPhase1: sequential ? { afterFirst: firstPhase(sequential.firstRecall), afterThird: firstPhase(sequential.recall) } : null,
      strictTargetsMet: strict,
      violations: continuations.reduce((total, score) => total + score.violations.length, 0)
    };
  }
  return paths;
}

async function pool<T>(tasks: readonly (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]!();
    }
  }));
  return results;
}

export async function runCompactionEvaluation(options: EvalOptions, env: EvalEnvironment): Promise<Record<string, unknown>> {
  env.emit({ concurrency: options.concurrency, dryRun: options.dryRun, effort: options.effort, event: "plan", handles: options.handles,
    maxOutputTokens: options.maxOutputTokens,
    mode: options.mode, model: options.model, paths: options.paths, provider: options.provider, scenarios: options.scenarios, seed: options.seed,
    summaryEffort: options.summaryEffort, summaryMaxOutputTokens: options.summaryMaxOutputTokens ?? COMPACTION_DEFAULTS.summaryOutputTokens[options.mode],
    switchModel: options.switchModel, tokens: options.tokens, window: options.window ?? "auto" });
  const tasks = options.scenarios.flatMap((id) => (id === "switch" ? ["native" as const] : options.paths)
    .map((path) => () => runScenarioPath(options, env, id, path).catch((error: unknown) => {
      env.emit({ code: errorCode(error), ...errorStatus(error), event: "error", path, scenario: id, stage: "run" });
      return null;
    })));
  const outcomes = (await pool(tasks, options.concurrency)).flatMap((outcome) => outcome ? [outcome] : []);
  const summary = { event: "summary", paths: summarizeOutcomes(outcomes) };
  env.emit(summary);
  return summary;
}

// ------------------------------------------------------------------ dry run

const DRY_SUMMARY = SUMMARY_SECTIONS.map((section) => `## ${section}\n- (dry run)`).join("\n\n");

/** A model that answers without any network: summaries with the fixed sections, nulls for recall, nothing for work. */
export function dryRunModel(): EvalModel {
  return {
    nativeCompaction: true,
    async run(request) {
      if (request.compactionTrigger) {
        return { finalProviderResponsePreview: {}, finalText: "",
          history: responsesHistoryFromOutput([{ encrypted_content: "DRY-RUN", id: "cmp_dry", type: "compaction" }]),
          usage: normalizeTokenUsage({}) };
      }
      const text = request.prompt.system === SUMMARIZER_INSTRUCTIONS ? DRY_SUMMARY
        : request.tools?.some((tool) => tool.name === READ_TOOL_RESULT.name) && request.tools.length === 1 ? "{}" : "Dry run: no model was called.";
      return { finalProviderResponsePreview: {}, finalText: text, history: [{ text, type: "assistant_text" }],
        usage: normalizeTokenUsage({}) };
    }
  };
}

// --------------------------------------------------------------------- CLI

/** Attempts per model call: transient failures are sent again, as the engine does. */
const CALL_ATTEMPTS = 3;

function realModel(options: EvalOptions, provider: SpikeProvider): EvalModel | null {
  const profile = SPIKE_PROVIDER_PROFILES[provider];
  const apiKey = process.env[profile.apiKeyEnv]?.trim();
  if (!apiKey) return null;
  const baseUrl = provider === "codex-lb" ? `${options.root}/v1` : profile.defaultBaseUrl;
  if (!baseUrl) return null;
  const fetchFn = createProviderSafeFetch({
    configuration: { allowPrivateNetwork: false, apiRoot: baseUrl, authenticationMode: "bearer", responseTimeoutMs: options.timeoutMs }
  });
  const connection = createSpikeConnection(provider, { apiKey, baseUrl, errorDetail: false, fetchFn, timeoutMs: options.timeoutMs });
  return {
    // The routes the engine compacts natively on (`nativeCompactionRoute`).
    nativeCompaction: provider === "codex-lb" || provider === "openai",
    async run(providerRequest, signal) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const stream = connection.adapter.stream(providerRequest, { signal, timeoutMs: options.timeoutMs });
          let next = await stream.next();
          while (!next.done) next = await stream.next();
          return next.value;
        } catch (error) {
          const decision = modelCallRetryDecision(error, signal);
          if (!decision || attempt >= CALL_ATTEMPTS) throw error;
          await sleepWithSignal(decision.retryAfterMs ?? 2_000 * attempt, signal);
        }
      }
    }
  };
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseEvalArguments>;
  try {
    parsed = parseEvalArguments(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "eval_argument_invalid"}\n${EVAL_USAGE}\n`);
    return 2;
  }
  if ("help" in parsed) {
    process.stdout.write(`${EVAL_USAGE}\n`);
    return 0;
  }
  const options = parsed;
  if (options.out) writeFileSync(options.out, "");
  const summary = await runCompactionEvaluation(options, {
    emit(line) {
      const text = `${JSON.stringify(line)}\n`;
      process.stdout.write(text);
      if (options.out) appendFileSync(options.out, text);
    },
    model: (provider) => options.dryRun ? dryRunModel() : realModel(options, provider),
    now: () => performance.now()
  });
  return Object.keys(summary.paths as Record<string, unknown>).length > 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`compaction_quality_failed:${error instanceof Error ? error.name : "unknown"}\n`);
    process.exitCode = 1;
  });
}

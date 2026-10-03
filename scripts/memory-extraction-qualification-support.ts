import { isAbsolute } from "node:path";
import { cleanupQualificationDatabase } from "./memory-cleanup-qualification-support";

/** Deterministic part of the paid long-term extraction qualification. */
export const MEMORY_EXTRACTION_QUALIFICATION_ACK = "DISPOSABLE_PAID_MEMORY_EXTRACTION";
export const MEMORY_EXTRACTION_QUALIFICATION_VERSION = 2;

export type ExtractionQualificationOptions = Readonly<{ output: string; runId: string }>;

export function extractionQualificationOptions(
  args: readonly string[]
): ExtractionQualificationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !["--ack", "--run-id", "--output"].includes(key) || !value || values.has(key)) {
      throw new Error("memory_extraction_arguments_invalid");
    }
    values.set(key, value);
  }
  if (values.get("--ack") !== MEMORY_EXTRACTION_QUALIFICATION_ACK) {
    throw new Error("memory_extraction_disposable_ack_required");
  }
  const runId = values.get("--run-id") ?? "";
  const output = values.get("--output") ?? "";
  if (!/^[a-f0-9]{12}$/u.test(runId) || !isAbsolute(output)) {
    throw new Error("memory_extraction_arguments_invalid");
  }
  return { output, runId };
}

/** The cleanup qualification's disposable-target guard, read from this
 * script's own variable. Checked before any server module or database opens. */
export function extractionQualificationDatabase(
  environment: Readonly<Record<string, string | undefined>>,
  runId: string
): URL {
  const {
    AIQSA_MEMORY_CLEANUP_DATABASE_URL: _unrelated,
    ...rest
  } = environment;
  try {
    return cleanupQualificationDatabase({
      ...rest,
      AIQSA_MEMORY_CLEANUP_DATABASE_URL: environment.AIQSA_MEMORY_EXTRACTION_DATABASE_URL
    }, runId);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw new Error(/^memory_cleanup_[a-z_]+$/u.test(code)
      ? code.replace(/^memory_cleanup_/u, "memory_extraction_")
      : "memory_extraction_database_not_disposable");
  }
}

export const EXTRACTION_QUALIFICATION_GROUPS = Object.freeze([
  "DURABLE", "ONGOING", "MIXED", "PROTECTED", "CHANGE",
  "SHORT_TERM", "MOMENTARY", "COMMON", "CHANGE_WITHOUT_PRIOR"
] as const);
export type ExtractionQualificationGroup = (typeof EXTRACTION_QUALIFICATION_GROUPS)[number];
export type ExtractionQualificationExpectation = "SAVE" | "NONE" | "CHANGE";

const expectationByGroup: Readonly<Record<ExtractionQualificationGroup, ExtractionQualificationExpectation>> = {
  CHANGE: "CHANGE",
  CHANGE_WITHOUT_PRIOR: "NONE",
  COMMON: "NONE",
  DURABLE: "SAVE",
  MIXED: "SAVE",
  MOMENTARY: "NONE",
  ONGOING: "SAVE",
  PROTECTED: "SAVE",
  SHORT_TERM: "NONE"
};

export function extractionQualificationExpectation(
  group: ExtractionQualificationGroup
): ExtractionQualificationExpectation {
  return expectationByGroup[group];
}

/** Groups whose every scenario must pass; DURABLE and ONGOING allow one miss
 * per group across both qualification runs, judged by the integrator. */
const strictGroups = new Set<ExtractionQualificationGroup>([
  "MIXED", "PROTECTED", "CHANGE", "SHORT_TERM", "MOMENTARY", "COMMON",
  "CHANGE_WITHOUT_PRIOR"
]);

type ScenarioSource = Readonly<{
  id: string;
  language: "ru" | "en";
  group: ExtractionQualificationGroup;
  /** Direct user message whose saved fact the change must update or withdraw. */
  prior?: string;
  text: string;
  /** Exact fragments of `text`; omitted means the whole message. */
  allowed?: readonly string[];
  /** Upper bound of correct saves; omitted means unbounded. */
  maxSaves?: number;
}>;

export type ExtractionQualificationSpan = Readonly<{ start: number; end: number }>;

export type ExtractionQualificationScenario = Readonly<{
  id: string;
  language: "ru" | "en";
  group: ExtractionQualificationGroup;
  expectation: ExtractionQualificationExpectation;
  prior: string | null;
  text: string;
  allowed: readonly ExtractionQualificationSpan[];
  maxSaves: number | null;
}>;

/** UTF-16 offsets of the one occurrence of `fragment`; the oracle compares
 * saved evidence offsets with these spans, never words of model output. */
export function extractionQualificationSpan(
  text: string,
  fragment: string
): ExtractionQualificationSpan {
  const start = text.indexOf(fragment);
  if (!fragment || start < 0 || text.indexOf(fragment, start + 1) >= 0) {
    throw new Error("memory_extraction_fixture_span_invalid");
  }
  return { start, end: start + fragment.length };
}

/** Synthetic Russian and English examples of the agreed long-term criterion. */
const SCENARIO_SOURCES: readonly ScenarioSource[] = [
  { id: "ru_profession", language: "ru", group: "DURABLE", text: "Я работаю инженером-конструктором." },
  { id: "en_profession", language: "en", group: "DURABLE", text: "I work as a structural engineer." },
  { id: "ru_gluten_free", language: "ru", group: "DURABLE", text: "Я не ем глютен." },
  { id: "en_gluten_free", language: "en", group: "DURABLE", text: "I don't eat gluten." },
  { id: "ru_nut_allergy", language: "ru", group: "DURABLE", text: "У меня аллергия на орехи." },
  { id: "en_nut_allergy", language: "en", group: "DURABLE", text: "I have a nut allergy." },
  { id: "ru_vegetarian", language: "ru", group: "DURABLE", text: "Я вегетарианец." },
  { id: "en_vegetarian", language: "en", group: "DURABLE", text: "I am a vegetarian." },
  { id: "ru_spicy", language: "ru", group: "DURABLE", text: "Я люблю острое." },
  { id: "en_spicy", language: "en", group: "DURABLE", text: "I love spicy food." },
  { id: "ru_brief", language: "ru", group: "DURABLE", text: "Всегда отвечай мне кратко." },
  { id: "en_brief", language: "en", group: "DURABLE", text: "Always answer me briefly." },
  { id: "ru_moved", language: "ru", group: "DURABLE", text: "Я переехал в Берлин." },
  { id: "en_moved", language: "en", group: "DURABLE", text: "I moved to Berlin." },
  { id: "ru_morning_runs", language: "ru", group: "ONGOING", text: "Я бегаю по утрам." },
  { id: "en_morning_runs", language: "en", group: "ONGOING", text: "I go running every morning." },
  { id: "ru_masters", language: "ru", group: "ONGOING", text: "Я учусь в магистратуре до 2027 года." },
  { id: "en_masters", language: "en", group: "ONGOING", text: "I am in a master's program until 2027." },
  { id: "ru_berlin_contract", language: "ru", group: "ONGOING", text: "Я живу в Берлине по контракту на два года." },
  { id: "en_berlin_contract", language: "en", group: "ONGOING", text: "I live in Berlin on a two-year contract." },
  { id: "ru_japanese", language: "ru", group: "ONGOING", text: "Я учу японский." },
  { id: "en_japanese", language: "en", group: "ONGOING", text: "I am learning Japanese." },
  { id: "ru_doctor_on_call", language: "ru", group: "MIXED", text: "Я врач, завтра дежурю.",
    allowed: ["Я врач"], maxSaves: 1 },
  { id: "en_doctor_on_call", language: "en", group: "MIXED", text: "I am a doctor, and I am on call tomorrow.",
    allowed: ["I am a doctor"], maxSaves: 1 },
  { id: "ru_remember_debt", language: "ru", group: "PROTECTED", text: "Запомни: я должен Ивану 38 рублей.",
    allowed: ["я должен Ивану 38 рублей"] },
  { id: "en_remember_debt", language: "en", group: "PROTECTED", text: "Remember this: I owe Ivan 38 rubles.",
    allowed: ["I owe Ivan 38 rubles"] },
  { id: "ru_gluten_change", language: "ru", group: "CHANGE", prior: "Я не ем глютен.",
    text: "Пять лет не ел глютен, а теперь снова ем хлеб." },
  { id: "en_gluten_change", language: "en", group: "CHANGE", prior: "I don't eat gluten.",
    text: "I avoided gluten for five years, but now I eat bread again." },
  { id: "ru_phone_sold", language: "ru", group: "CHANGE", prior: "У меня телефон Pixel 8.",
    text: "Я продал свой Pixel 8." },
  { id: "en_phone_sold", language: "en", group: "CHANGE", prior: "I own a Pixel 8 phone.",
    text: "I sold my Pixel 8." },
  { id: "ru_debt", language: "ru", group: "SHORT_TERM", text: "Я должен Ивану 38 рублей." },
  { id: "en_debt", language: "en", group: "SHORT_TERM", text: "I owe Ivan 38 rubles." },
  { id: "ru_parcel", language: "ru", group: "SHORT_TERM", text: "Моя посылка придёт завтра." },
  { id: "en_parcel", language: "en", group: "SHORT_TERM", text: "My parcel arrives tomorrow." },
  { id: "ru_meeting", language: "ru", group: "SHORT_TERM", text: "У меня встреча в пятницу." },
  { id: "en_meeting", language: "en", group: "SHORT_TERM", text: "I have a meeting on Friday." },
  { id: "ru_headache", language: "ru", group: "SHORT_TERM", text: "У меня сегодня болит голова." },
  { id: "en_headache", language: "en", group: "SHORT_TERM", text: "I have a headache today." },
  { id: "ru_ordered_phone", language: "ru", group: "SHORT_TERM", text: "Я заказал iPhone." },
  { id: "en_ordered_phone", language: "en", group: "SHORT_TERM", text: "I ordered an iPhone." },
  { id: "ru_presentation", language: "ru", group: "SHORT_TERM", text: "Я делаю презентацию к пятнице." },
  { id: "en_presentation", language: "en", group: "SHORT_TERM", text: "I am preparing a presentation for Friday." },
  { id: "ru_coffee_now", language: "ru", group: "MOMENTARY", text: "Сейчас хочу кофе." },
  { id: "en_coffee_now", language: "en", group: "MOMENTARY", text: "I want a coffee right now." },
  { id: "ru_bread", language: "ru", group: "COMMON", text: "Я регулярно ем хлеб." },
  { id: "en_bread", language: "en", group: "COMMON", text: "I regularly eat bread." },
  { id: "ru_morning_coffee", language: "ru", group: "COMMON", text: "Я пью кофе по утрам." },
  { id: "en_morning_coffee", language: "en", group: "COMMON", text: "I drink coffee in the morning." },
  { id: "ru_started_bread", language: "ru", group: "CHANGE_WITHOUT_PRIOR", text: "Я начал есть хлеб." },
  { id: "en_started_bread", language: "en", group: "CHANGE_WITHOUT_PRIOR", text: "I started eating bread." }
];

export const MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS: readonly ExtractionQualificationScenario[] =
  Object.freeze(SCENARIO_SOURCES.map((source) => {
    const expectation = extractionQualificationExpectation(source.group);
    if ((expectation === "CHANGE") !== (source.prior !== undefined) ||
      (expectation !== "SAVE" && source.allowed !== undefined)) {
      throw new Error("memory_extraction_fixture_invalid");
    }
    return Object.freeze({
      allowed: Object.freeze((source.allowed ?? [source.text]).map((fragment) =>
        extractionQualificationSpan(source.text, fragment))),
      expectation,
      group: source.group,
      id: source.id,
      language: source.language,
      maxSaves: source.maxSaves ?? null,
      prior: source.prior ?? null,
      text: source.text
    });
  }));

/** What the disposable database shows after one scenario, without content. */
export type ExtractionQualificationObservation = Readonly<{
  /** Evidence spans this target message now supports on automatic versions. */
  saved: readonly Readonly<ExtractionQualificationSpan & { explicitRemember: boolean }>[];
  /** CHANGE only: the prior message produced a current automatic fact. */
  priorSaved?: boolean;
  /** CHANGE only: no fact version saved from the prior message is current. */
  priorReplaced?: boolean;
}>;

export type ExtractionQualificationVerdict = Readonly<{
  correctSaves: number;
  falseSaves: number;
  miss: boolean;
  passed: boolean;
  reason: "PASSED" | "FALSE_SAVE" | "MISS" | "NOT_PROTECTED" | "PRIOR_MISSING" | "NOT_CHANGED";
}>;

function overlaps(left: ExtractionQualificationSpan, right: ExtractionQualificationSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

export function judgeExtractionScenario(
  scenario: ExtractionQualificationScenario,
  observation: ExtractionQualificationObservation
): ExtractionQualificationVerdict {
  let correctSaves = 0;
  let falseSaves = 0;
  for (const span of observation.saved) {
    if (scenario.expectation !== "NONE" &&
      scenario.allowed.some((allowed) => overlaps(span, allowed))) correctSaves++;
    else falseSaves++;
  }
  if (scenario.maxSaves !== null && correctSaves > scenario.maxSaves) {
    falseSaves += correctSaves - scenario.maxSaves;
    correctSaves = scenario.maxSaves;
  }
  const verdict = (
    reason: ExtractionQualificationVerdict["reason"],
    miss = false
  ): ExtractionQualificationVerdict => ({
    correctSaves, falseSaves, miss, passed: reason === "PASSED", reason
  });
  if (scenario.expectation === "CHANGE") {
    if (observation.priorSaved !== true) return verdict("PRIOR_MISSING");
    if (observation.priorReplaced !== true) return verdict("NOT_CHANGED", true);
    return verdict(falseSaves > 0 ? "FALSE_SAVE" : "PASSED");
  }
  if (falseSaves > 0) return verdict("FALSE_SAVE", scenario.expectation === "SAVE" && correctSaves === 0);
  if (scenario.expectation === "NONE") return verdict("PASSED");
  if (correctSaves === 0) return verdict("MISS", true);
  if (scenario.group === "PROTECTED" && !observation.saved.some((span) =>
    span.explicitRemember && scenario.allowed.some((allowed) => overlaps(span, allowed)))) {
    return verdict("NOT_PROTECTED");
  }
  return verdict("PASSED");
}

// Keys are bounded codes, optionally prefixed by a stage ("adjudication:<code>").
const CODE = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}$/u;
type Counts = Record<string, number>;

function increment(counts: Counts, key: string, by = 1): void {
  const safe = CODE.test(key) ? key : "invalid_code";
  counts[safe] = (counts[safe] ?? 0) + by;
}

export type ExtractionQualificationGroupReport = {
  expectation: ExtractionQualificationExpectation;
  scenarios: number;
  passed: number;
  saved: number;
  notSaved: number;
  falseSaves: number;
  misses: number;
  failures: Counts;
  receipts: Counts;
  byLanguage: Record<"ru" | "en", { scenarios: number; passed: number; falseSaves: number; misses: number }>;
};

export type ExtractionQualificationUsage = Readonly<{
  /** Provider-call stage: extraction or semantic adjudication. */
  stage: "extraction" | "adjudication";
  state: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCostMicros: number | null;
}>;

export type ExtractionQualificationBinding = Readonly<{
  errorCode: string | null;
  memoryJobId: string | null;
  stage: ExtractionQualificationUsage["stage"];
  state: string;
}>;

/** Reported state per provider-call binding. RETRIED marks a settled
 * retryable failure the job recovered from: a transient extraction call whose
 * job then succeeded, or a retryable adjudication failure whose job then
 * succeeded with an adjudication. A degraded (unadjudicated) apply, a terminal
 * job or an unretried failure keeps its state and counts as degraded. */
export function extractionQualificationCallStates(
  bindings: readonly ExtractionQualificationBinding[],
  context: Readonly<{
    retryableAdjudicationCodes: ReadonlySet<string>;
    succeededJobs: ReadonlySet<string>;
  }>
): string[] {
  const adjudicatedJobs = new Set(bindings.flatMap(({ memoryJobId, stage, state }) =>
    stage === "adjudication" && state === "SUCCEEDED" && memoryJobId ? [memoryJobId] : []));
  return bindings.map((row) => {
    if (row.state !== "FAILED" || row.memoryJobId === null ||
      !context.succeededJobs.has(row.memoryJobId)) return row.state;
    const code = row.errorCode ?? "";
    const retried = row.stage === "extraction"
      ? /_transient$/u.test(code)
      : context.retryableAdjudicationCodes.has(code) && adjudicatedJobs.has(row.memoryJobId);
    return retried ? "RETRIED" : row.state;
  });
}

export type ExtractionQualificationResult = Readonly<{
  scenario: ExtractionQualificationScenario;
  verdict: ExtractionQualificationVerdict;
  /** Content-free receipt outcomes or rejection reason codes of the target. */
  receipts: readonly string[];
}>;

export type ExtractionQualificationReport = Readonly<{
  status: "passed" | "failed";
  version: typeof MEMORY_EXTRACTION_QUALIFICATION_VERSION;
  scenarios: number;
  groups: Record<ExtractionQualificationGroup, ExtractionQualificationGroupReport>;
  degraded: number;
  degradedCodes: Counts;
  jobRetries: Counts;
  jobStages: Counts;
  providerCalls: Counts;
  /** `<stage>:<errorCode>` of every unsuccessful provider-call binding. */
  bindingFailures: Counts;
  /** Server-owned normalization reason codes of accepted adjudications. */
  adjudicationNormalized: Counts;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMicros: number;
  reportedTokenCalls: number;
  reportedCostCalls: number;
  sanitizedAggregatesOnly: true;
}>;

export function summarizeExtractionQualification(input: Readonly<{
  results: readonly ExtractionQualificationResult[];
  adjudicationNormalized?: readonly string[];
  bindingFailures?: readonly string[];
  degradedCodes: readonly string[];
  /** Retryable job failures the coordinator policy retried. */
  jobRetries?: readonly string[];
  jobStages: readonly string[];
  usage: readonly ExtractionQualificationUsage[];
}>): ExtractionQualificationReport {
  const groups = Object.fromEntries(EXTRACTION_QUALIFICATION_GROUPS.map((group) => [group, {
    byLanguage: {
      en: { falseSaves: 0, misses: 0, passed: 0, scenarios: 0 },
      ru: { falseSaves: 0, misses: 0, passed: 0, scenarios: 0 }
    },
    expectation: extractionQualificationExpectation(group),
    failures: {}, falseSaves: 0, misses: 0, notSaved: 0, passed: 0, receipts: {},
    saved: 0, scenarios: 0
  } satisfies ExtractionQualificationGroupReport])) as Record<
    ExtractionQualificationGroup, ExtractionQualificationGroupReport
  >;
  for (const { receipts, scenario, verdict } of input.results) {
    const group = groups[scenario.group];
    const language = group.byLanguage[scenario.language];
    group.scenarios++;
    language.scenarios++;
    if (verdict.passed) { group.passed++; language.passed++; }
    else increment(group.failures, verdict.reason);
    if (verdict.correctSaves + verdict.falseSaves > 0) group.saved++;
    else group.notSaved++;
    group.falseSaves += verdict.falseSaves;
    language.falseSaves += verdict.falseSaves;
    if (verdict.miss) { group.misses++; language.misses++; }
    for (const receipt of receipts) increment(group.receipts, receipt);
  }
  const degradedCodes: Counts = {};
  for (const code of input.degradedCodes) increment(degradedCodes, code);
  const jobRetries: Counts = {};
  for (const code of input.jobRetries ?? []) increment(jobRetries, code);
  const jobStages: Counts = {};
  for (const stage of input.jobStages) increment(jobStages, stage);
  const bindingFailures: Counts = {};
  for (const key of input.bindingFailures ?? []) increment(bindingFailures, key);
  const adjudicationNormalized: Counts = {};
  for (const code of input.adjudicationNormalized ?? []) increment(adjudicationNormalized, code);
  const providerCalls: Counts = {};
  let degraded = input.degradedCodes.length;
  for (const row of input.usage) {
    increment(providerCalls, `${row.stage}:${row.state}`);
    // RETRIED: a retryable failure whose job then succeeded on retry.
    if (row.state !== "SUCCEEDED" && row.state !== "RETRIED") degraded++;
  }
  const sum = (key: "inputTokens" | "outputTokens" | "totalTokens" | "estimatedCostMicros") =>
    input.usage.reduce((total, row) => total + (row[key] ?? 0), 0);
  const groupFailed = EXTRACTION_QUALIFICATION_GROUPS.some((name) => {
    const group = groups[name];
    return strictGroups.has(name)
      ? group.passed !== group.scenarios
      : group.misses > 1 || group.passed + group.misses < group.scenarios;
  });
  return {
    adjudicationNormalized,
    bindingFailures,
    degraded,
    degradedCodes,
    estimatedCostMicros: sum("estimatedCostMicros"),
    groups,
    inputTokens: sum("inputTokens"),
    jobRetries,
    jobStages,
    outputTokens: sum("outputTokens"),
    providerCalls,
    reportedCostCalls: input.usage.filter((row) => row.estimatedCostMicros !== null).length,
    reportedTokenCalls: input.usage.filter((row) => row.totalTokens !== null).length,
    sanitizedAggregatesOnly: true,
    scenarios: input.results.length,
    status: degraded === 0 && !groupFailed && input.results.length ===
      MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS.length ? "passed" : "failed",
    totalTokens: sum("totalTokens"),
    version: MEMORY_EXTRACTION_QUALIFICATION_VERSION
  };
}

/** The parent prints only this projection of the child's IPC message. */
export function sanitizeExtractionQualificationMessage(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const raw = message as Record<string, unknown>;
  if (raw.status !== "passed" && raw.status !== "failed") return null;
  const safe: Record<string, unknown> = { sanitizedAggregatesOnly: true, status: raw.status };
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const counts = (value: unknown): Counts | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const result: Counts = {};
    for (const [key, entry] of Object.entries(value)) {
      if (CODE.test(key) && count(entry)) result[key] = entry as number;
    }
    return result;
  };
  for (const key of ["scenarios", "degraded", "inputTokens", "outputTokens", "totalTokens",
    "estimatedCostMicros", "reportedTokenCalls", "reportedCostCalls"]) {
    if (count(raw[key])) safe[key] = raw[key];
  }
  for (const key of ["degradedCodes", "jobRetries", "jobStages", "providerCalls", "bindingFailures",
    "adjudicationNormalized"]) {
    const projected = counts(raw[key]);
    if (projected) safe[key] = projected;
  }
  if (raw.groups && typeof raw.groups === "object" && !Array.isArray(raw.groups)) {
    const groups: Record<string, unknown> = {};
    for (const name of EXTRACTION_QUALIFICATION_GROUPS) {
      const group = (raw.groups as Record<string, unknown>)[name];
      if (!group || typeof group !== "object" || Array.isArray(group)) continue;
      const source = group as Record<string, unknown>;
      const projected: Record<string, unknown> = { expectation: extractionQualificationExpectation(name) };
      for (const key of ["scenarios", "passed", "saved", "notSaved", "falseSaves", "misses"]) {
        if (count(source[key])) projected[key] = source[key];
      }
      for (const key of ["failures", "receipts"]) {
        const value = counts(source[key]);
        if (value) projected[key] = value;
      }
      const byLanguage = source.byLanguage as Record<string, unknown> | undefined;
      if (byLanguage && typeof byLanguage === "object") {
        projected.byLanguage = Object.fromEntries(["ru", "en"].flatMap((language) => {
          const value = counts(byLanguage[language]);
          return value ? [[language, value]] : [];
        }));
      }
      groups[name] = projected;
    }
    safe.groups = groups;
  }
  if (typeof raw.code === "string") {
    safe.code = /^memory_[a-z0-9_]{1,88}$/u.test(raw.code) ? raw.code : "memory_extraction_qualification_failed";
  }
  if (typeof raw.phase === "string" && /^[a-z][a-z0-9_]{0,47}$/u.test(raw.phase)) safe.phase = raw.phase;
  if (typeof raw.prismaCode === "string" && /^P\d{4}$/u.test(raw.prismaCode)) safe.prismaCode = raw.prismaCode;
  return safe;
}

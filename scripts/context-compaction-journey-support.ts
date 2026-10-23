/**
 * Pure parts of the opt-in paid context-compaction journey smoke
 * (`smoke-context-compaction-journey.ts`): configuration, the deterministic
 * Russian journey text, run parameters, bounded readers of the Admin and Chat
 * projections, per-round evidence and the verdict. Nothing here performs I/O,
 * and nothing here ever returns prompt or answer text as evidence.
 */
import type { AdminProviderModelConfiguration } from "../lib/contracts/adminProviders";
import type { CatalogModel } from "../lib/contracts/catalog";
import type { ChatDetailWire, ChatMessageWire } from "../lib/contracts/chats";
import type { ContextCompactionStatus } from "../lib/contracts/contextCompaction";
import type { SessionContextStatus } from "../lib/contracts/sessionStatus";
import { textFromContentBlocks } from "../lib/domain/modelRunEvents";
import { COMPACTION_THRESHOLDS } from "../lib/server/engine/compaction/policy";

export const JOURNEY_ROUTES = ["anthropic", "codex-lb"] as const;
export type JourneyRoute = (typeof JOURNEY_ROUTES)[number];

export const JOURNEY_LIMITS = Object.freeze({
  /**
   * Paid checks run at real windows (operator decision 2026-10-23): models
   * below 400k tokens are nearly gone, and at small windows the engine's fixed
   * prompt, tools, kept tail and summary leave no background cut at all. The
   * minimum still admits the 272k windows Codex LB lists for its older models.
   */
  defaultContextWindow: 400_000,
  minContextWindow: 262_144,
  /** A codex-lb route is further bounded by the window its listing publishes for the model. */
  maxContextWindow: 1_000_000,
  /** At every admitted window the brief and 6 % fillers cross the trigger by about the 15th turn (see the support tests). */
  defaultMaxTurns: 20,
  /** Brief, two corrections, the rule, one filler and the probe. */
  minTurns: 6,
  maxTurns: 24,
  answerMaxOutputTokens: 2_048,
  /** Share of the window's composer budget (90 % of it) the opening brief occupies, within `maxMessageBytes`. */
  briefBudgetShare: 0.18,
  /**
   * Largest filler step. A turn that adds more than the 72-85 % band (13 % of
   * the window) can skip the background compaction and wait in the foreground,
   * so a filler stays well inside it.
   */
  fillerMaxBudgetShare: 0.06,
  fillerMinTokens: 256,
  /** The first compaction belongs to the first turn whose context passes this share of the usable window. */
  triggerShare: COMPACTION_THRESHOLDS.background,
  /**
   * How long a turn past the trigger waits for its background summary before
   * the next turn. The slowest compaction call measured at a 64k window took
   * 116 s (`runContext.ts`); a 400k-window summary reads several times more.
   * One still running then is joined by the next turn, and its marker is read
   * when it lands on the turn that started it.
   */
  summaryWaitMs: 420_000,
  /** One message's text, below the app's 1 MiB JSON body limit (`lib/server/http/requestBodyConfig.ts`) with room for the envelope. */
  maxMessageBytes: 896 * 1024,
  /** All message text one route sends: a 1M window filled to the trigger in Cyrillic prose. */
  maxRouteRequestBytes: 8 * 1024 * 1024
});

export type JourneyRatioBand = Readonly<{ max: number; min: number }>;

/**
 * The accepted provider-reported / estimated prompt ratio of every
 * single-request turn, per route. A route without a band reports its ratios
 * unchecked: the Anthropic estimate still omits the hidden tool-use prompt.
 */
export const JOURNEY_RATIO_BANDS: Readonly<Partial<Record<JourneyRoute, JourneyRatioBand>>> = Object.freeze({
  "codex-lb": Object.freeze({ max: 1, min: 0.85 })
});

/** The bootstrap token of a test-mode stand, as tests/e2e/support/localAuth.ts uses it. */
export const JOURNEY_TEST_AUTH_TOKEN = "aiqsa-test-token";

export type JourneyStage =
  | "auth"
  | "catalog"
  | "chat"
  | "cleanup"
  | "config"
  | "evidence"
  | "provider_setup"
  | "turn";

const CODE_PATTERN = /^[a-z0-9_]{1,80}$/u;

/** A stable, content-free failure; any other code collapses to one generic value. */
export class JourneyFailure extends Error {
  readonly code: string;
  /** The stand's HTTP status when the failure is a stand response. */
  readonly httpStatus: number | null;
  readonly stage: JourneyStage;

  constructor(stage: JourneyStage, code: string, httpStatus: number | null = null) {
    const safe = CODE_PATTERN.test(code) ? code : "journey_failed";
    super(safe);
    this.name = "JourneyFailure";
    this.code = safe;
    this.httpStatus = httpStatus;
    this.stage = stage;
  }
}

/**
 * Content-free facts about an exception that is not a JourneyFailure: its
 * constructor name and the first stack frame inside this repository's
 * `scripts/` (file:line:column). The message is never read.
 */
export function exceptionDiagnostics(error: unknown): Readonly<{ errorClass: string; frame: string | null }> {
  // A thrown primitive reports its type; null reports "null".
  const name = error === null ? "null" : typeof error === "object" ? error.constructor?.name : typeof error;
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  const frame = stack.split("\n").slice(1)
    .map((line) => /(scripts\/[A-Za-z0-9._-]+\.[cm]?[jt]s:\d+:\d+)/u.exec(line)?.[1] ?? null)
    .find((value) => value !== null) ?? null;
  return { errorClass: typeof name === "string" && /^[A-Za-z0-9_$]{1,64}$/u.test(name) ? name : "unknown", frame };
}

/**
 * The opt-in debug writer: one JSON line per value, consecutive duplicates
 * (polling) written once, nothing at all when disabled.
 */
export function createDebugEmitter(enabled: boolean, write: (line: string) => void): (value: Record<string, unknown>) => void {
  let last = "";
  return (value) => {
    if (!enabled) return;
    const line = JSON.stringify({ smoke: "context-compaction-journey", ...value });
    if (line === last) return;
    last = line;
    write(`${line}\n`);
  };
}

function fail(stage: JourneyStage, code: string): never {
  throw new JourneyFailure(stage, code);
}

// Configuration ---------------------------------------------------------------

export type JourneyRouteConfig =
  | Readonly<{ route: "anthropic"; apiKey: string; model: string }>
  | Readonly<{ route: "codex-lb"; apiKey: string; apiRoot: string; model: string }>;

export type JourneyRouteSkip = Readonly<{ route: JourneyRoute; skipped: "api_key_missing" | "base_url_missing" }>;

export type JourneyConfig = Readonly<{
  baseUrl: URL;
  cleanupProviders: boolean;
  contextWindow: number;
  /** AIQSA_JOURNEY_DEBUG=1: sanitized per-request and reuse-decision lines. */
  debug: boolean;
  /** True when AIQSA_JOURNEY_ROUTES named the routes explicitly. */
  explicitRoutes: boolean;
  maxTurns: number;
  routes: readonly (JourneyRouteConfig | JourneyRouteSkip)[];
}>;

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function envValue(env: Env, name: string): string {
  return env[name]?.trim() ?? "";
}

function integerSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = envValue(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? value : fail("config", `${name.toLowerCase()}_invalid`);
}

/** The stand origin. Keys travel to it, so plain HTTP is accepted only on loopback. */
export function journeyBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("config", "base_url_invalid");
  }
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))) {
    return fail("config", "base_url_invalid");
  }
  return new URL(url.origin);
}

/**
 * A compatible endpoint root without credentials, query or trailing slash.
 * codex-lb's CLI route maps to its documented OpenAI-compatible `/v1` root,
 * as `codexLbRoute` maps the Codex profile.
 */
export function journeyApiRoot(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("config", "codex_lb_base_url_invalid");
  }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return fail("config", "codex_lb_base_url_invalid");
  }
  if (url.pathname.replace(/\/+$/u, "") === "/backend-api/codex") url.pathname = "/v1";
  return url.toString().replace(/\/+$/u, "");
}

function modelSetting(env: Env, name: string, fallback: string): string {
  const value = envValue(env, name) || fallback;
  return MODEL_ID.test(value) ? value : fail("config", `${name.toLowerCase()}_invalid`);
}

/**
 * The journey configuration. `codexApiRootFallback` supplies the codex-lb root
 * of the operator's Codex profile when CODEX_LB_BASE_URL is absent.
 */
export function journeyConfig(env: Env, codexApiRootFallback: () => string | null = () => null): JourneyConfig {
  const routeList = envValue(env, "AIQSA_JOURNEY_ROUTES");
  const requested = routeList ? routeList.split(",").map((value) => value.trim()).filter(Boolean) : [...JOURNEY_ROUTES];
  if (requested.length === 0 || requested.some((value) => !(JOURNEY_ROUTES as readonly string[]).includes(value))) {
    fail("config", "routes_invalid");
  }
  const routes = [...new Set(requested as JourneyRoute[])].map((route): JourneyRouteConfig | JourneyRouteSkip => {
    if (route === "anthropic") {
      const apiKey = envValue(env, "ANTHROPIC_API_KEY");
      return apiKey
        ? { apiKey, model: modelSetting(env, "AIQSA_JOURNEY_ANTHROPIC_MODEL", "claude-sonnet-5"), route }
        : { route, skipped: "api_key_missing" };
    }
    const apiKey = envValue(env, "CODEX_LB_API_KEY");
    if (!apiKey) return { route, skipped: "api_key_missing" };
    const rawRoot = envValue(env, "CODEX_LB_BASE_URL") || codexApiRootFallback() || "";
    if (!rawRoot) return { route, skipped: "base_url_missing" };
    return { apiKey, apiRoot: journeyApiRoot(rawRoot), model: modelSetting(env, "AIQSA_JOURNEY_CODEX_MODEL", "gpt-6.1-sol"), route };
  });
  return {
    baseUrl: journeyBaseUrl(envValue(env, "AIQSA_JOURNEY_BASE_URL") || "http://127.0.0.1:3000"),
    cleanupProviders: envValue(env, "AIQSA_JOURNEY_CLEANUP_PROVIDERS") === "1",
    contextWindow: integerSetting(env, "AIQSA_JOURNEY_CONTEXT_WINDOW", JOURNEY_LIMITS.defaultContextWindow,
      JOURNEY_LIMITS.minContextWindow, JOURNEY_LIMITS.maxContextWindow),
    debug: ["1", "true"].includes(envValue(env, "AIQSA_JOURNEY_DEBUG").toLowerCase()),
    explicitRoutes: Boolean(routeList),
    maxTurns: integerSetting(env, "AIQSA_JOURNEY_MAX_TURNS", JOURNEY_LIMITS.defaultMaxTurns,
      JOURNEY_LIMITS.minTurns, JOURNEY_LIMITS.maxTurns),
    routes
  };
}

// Deterministic Russian journey text -----------------------------------------

/** Estimated tokens of one text, as the stand measures it for the route. */
export type TokenEstimate = (text: string) => number;

const SUBJECTS = [
  "Команда поддержки", "Отдел аналитики", "Мобильное приложение", "Служба доставки",
  "Руководитель направления", "Платформа уведомлений", "Система отчётности", "Партнёрская сеть",
  "Группа дизайна", "Сервис оплаты", "Каталог изданий", "Центр обработки заявок"
];
const VERBS = [
  "уточняет", "проверяет", "описывает", "согласует", "обновляет", "собирает",
  "анализирует", "готовит", "сравнивает", "поддерживает", "документирует", "пересматривает"
];
const OBJECTS = [
  "требования к интерфейсу", "сценарии регистрации читателей", "правила хранения данных", "план тестирования",
  "журнал изменений", "карту пользовательских путей", "список открытых вопросов", "критерии приёмки",
  "схему интеграции с учётными системами", "модель уведомлений", "порядок эскалации обращений", "набор метрик качества"
];
const DETAILS = [
  "с учётом отзывов первых пользователей", "перед очередной демонстрацией заказчику",
  "в тесной связке с юридической службой", "без изменения согласованных параметров",
  "чтобы снизить нагрузку на операторов", "на основе прошлогодних наблюдений",
  "для региональных филиалов", "с акцентом на доступность для людей с нарушениями зрения",
  "в рамках пилотного запуска", "по итогам внутреннего аудита",
  "при участии внешних консультантов", "с прицелом на дальнейшее масштабирование"
];

/** mulberry32: a small deterministic generator, never a security primitive. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

/** Digit-free prose of about `targetTokens` estimated tokens, stable for a seed. */
export function journeyProse(seed: number, targetTokens: number, estimate: TokenEstimate): string {
  const random = seededRandom(seed);
  const paragraphs: string[] = [];
  let tokens = 0;
  // The iteration ceiling guarantees termination even for a degenerate estimate.
  for (let index = 0; tokens < targetTokens && index < 4_096; index += 1) {
    const sentences = Array.from({ length: 6 }, () =>
      `${pick(random, SUBJECTS)} ${pick(random, VERBS)} ${pick(random, OBJECTS)} ${pick(random, DETAILS)}.`);
    const paragraph = sentences.join(" ");
    paragraphs.push(paragraph);
    tokens += Math.max(1, estimate(paragraph));
  }
  return paragraphs.join("\n\n");
}

export function journeyBrief(targetTokens: number, estimate: TokenEstimate): string {
  const header = [
    "Продуктовый бриф проекта «Лазурный маяк».",
    "Ключевые параметры (исходная версия): срок реализации проекта — 3 недели; бюджет проекта — 120 тысяч евро; " +
      "заказчик — сеть городских библиотек.",
    "Ниже приведено подробное описание контекста проекта. Прочитай бриф и кратко подтверди, что понял ключевые параметры."
  ].join("\n");
  return `${header}\n\n${journeyProse(0x4c41, Math.max(0, targetTokens - estimate(header)), estimate)}`;
}

export function journeyFiller(index: number, targetTokens: number, estimate: TokenEstimate): string {
  const header = "Дополнительные материалы к брифу «Лазурный маяк» (справочный текст, ключевые параметры здесь не меняются). " +
    "Прочитай и ответь кратко.";
  return `${header}\n\n${journeyProse(0x1000 + index, Math.max(0, targetTokens - estimate(header)), estimate)}`;
}

export const JOURNEY_CORRECTIONS = [
  "Исправь: срок реализации проекта не 3, а 5 недель. Запомни это исправление и кратко подтверди.",
  "Исправь ещё: бюджет проекта не 120, а 175 тысяч евро. Запомни это исправление и кратко подтверди."
] as const;

export const JOURNEY_RULE = "Новое постоянное правило: всегда отвечай списком ровно из трёх пунктов, " +
  "без вступления и без заключения. Соблюдай его во всех следующих ответах. Подтверди правило.";

export const JOURNEY_PROBE = "Каков итоговый срок реализации проекта «Лазурный маяк» в неделях и каков его итоговый " +
  "бюджет в тысячах евро? Учти все исправления и постоянное правило ответа.";

/**
 * The window the engine's compaction thresholds measure against
 * (`runContext.ts`: the context window less the output reserve the session
 * status reports), not the composer's budget, which also keeps a safety margin.
 */
export function engineContextTokens(status: Pick<SessionContextStatus, "contextWindow" | "maxOutputTokens">): number | null {
  return status.contextWindow === null ? null : Math.max(0, status.contextWindow - status.maxOutputTokens);
}

const utf8 = new TextEncoder();

/**
 * The text `build` makes for `tokens`, made smaller until it fits one
 * message's byte bound; what it leaves out is sent by later turns.
 */
export function boundedMessage(build: (tokens: number) => string, tokens: number): string {
  let target = tokens;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const text = build(target);
    const bytes = utf8.encode(text).byteLength;
    if (bytes <= JOURNEY_LIMITS.maxMessageBytes) return text;
    target = Math.floor(target * (JOURNEY_LIMITS.maxMessageBytes / bytes) * 0.98);
  }
  return fail("turn", "request_bytes_bound");
}

/**
 * Estimated tokens of the next filler: a full step below the trigger, which
 * lands the crossing turn below 78 %, inside the background band. Past the
 * trigger without a summary a minimal filler gives the engine one more request
 * boundary: its background compaction starts from its own measure, which can
 * trail the reported one.
 */
export function nextFillerTokens(input: Readonly<{ approximateInputTokens: number; budgetTokens: number }>): number {
  const { approximateInputTokens, budgetTokens } = input;
  if (approximateInputTokens >= budgetTokens * JOURNEY_LIMITS.triggerShare) return JOURNEY_LIMITS.fillerMinTokens;
  return Math.max(JOURNEY_LIMITS.fillerMinTokens, Math.floor(budgetTokens * JOURNEY_LIMITS.fillerMaxBudgetShare));
}

// Probe answer check (in memory only) -----------------------------------------

const LIST_ITEM = /^([ \t]*)(?:[-*•–—]|\d{1,2}[.)])[ \t]+\S/u;

/** Top-level list items: markers at the shallowest indentation present. */
export function listItemCount(text: string): number {
  const indents = text.split(/\r?\n/u).flatMap((line) => {
    const match = LIST_ITEM.exec(line);
    return match ? [match[1]!.replace(/\t/gu, "    ").length] : [];
  });
  if (indents.length === 0) return 0;
  const top = Math.min(...indents);
  return indents.filter((indent) => indent === top).length;
}

/** The corrected deadline (5 weeks) and budget (175 thousand) in a three-item list. */
export function probeAnswerCarriesCorrections(text: string): boolean {
  const deadline = /(?<!\d)5(?!\d)[\s -]*(?:ти[\s ]*)?недел/iu.test(text) || /пят[ьи][\s ]+недел/iu.test(text);
  const budget = /(?<!\d)175(?:[\s ]?000)?(?![\d])/u.test(text);
  return deadline && budget && listItemCount(text) === 3;
}

// Run parameters ----------------------------------------------------------------

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The cheapest offered effort: none, then minimal, then low, else the default. */
export function lowestReasoningEffort(model: Pick<CatalogModel, "parameterControls">): string {
  const control = model.parameterControls.reasoningEffort;
  return ["none", "minimal", "low"].find((effort) => control.options.includes(effort)) ?? control.defaultValue;
}

/**
 * The run parameters the composer would send for this model with the smallest
 * reasoning setting and the journey's answer ceiling (see buildParams in
 * components/app-shell/runControlsActions.ts).
 */
export function journeyRunParams(model: CatalogModel, maxOutputTokens: number): Record<string, unknown> {
  const controls = model.parameterControls;
  const base = { ...model.defaultParams };
  const effort = lowestReasoningEffort(model);
  const tokens = Math.min(maxOutputTokens, controls.maxOutputTokens.maxValue ?? maxOutputTokens);
  const family = model.providerFamily ?? "";
  if (family === "anthropic") {
    const params: Record<string, unknown> = {
      ...base,
      maxTokens: tokens,
      outputConfig: { ...(record(base.outputConfig) ? base.outputConfig : {}), effort },
      thinking: {
        ...(record(base.thinking) ? base.thinking : {}),
        budgetTokens: 0,
        enabled: controls.reasoningEffort.supported && effort !== "none",
        type: "adaptive"
      }
    };
    if (controls.temperature.supported) params.temperature = controls.temperature.defaultValue;
    else delete params.temperature;
    delete params.reasoning;
    return params;
  }
  if (family === "openai" || family === "openai_compatible") {
    const reasoning: Record<string, unknown> = { ...(record(base.reasoning) ? base.reasoning : {}), effort };
    if (controls.reasoningMode?.supported) reasoning.mode = controls.reasoningMode.defaultValue;
    else delete reasoning.mode;
    const params: Record<string, unknown> = {
      ...base,
      maxOutputTokens: tokens,
      reasoning,
      temperature: controls.temperature.defaultValue
    };
    if (controls.background.supported) params.background = false;
    else delete params.background;
    if (controls.stream.supported) params.stream = controls.stream.defaultValue;
    else delete params.stream;
    return params;
  }
  if (family === "gemini") {
    const params: Record<string, unknown> = {
      ...base,
      maxOutputTokens: tokens,
      reasoning: { ...(record(base.reasoning) ? base.reasoning : {}), effort }
    };
    delete params.maxTokens;
    delete params.temperature;
    if (controls.stream.supported) params.stream = controls.stream.defaultValue;
    else delete params.stream;
    return params;
  }
  if (family === "openrouter") {
    const usesVerbosityEffort = typeof base.verbosity === "string";
    const params: Record<string, unknown> = {
      ...base,
      maxTokens: tokens,
      ...(controls.reasoningEffort.supported
        ? { reasoning: { ...(record(base.reasoning) ? base.reasoning : {}), enabled: effort !== "none",
          ...(usesVerbosityEffort || effort === "none" ? {} : { effort }) } }
        : {})
    };
    if (controls.stream.supported) params.stream = controls.stream.defaultValue;
    else delete params.stream;
    if (usesVerbosityEffort && effort !== "none") params.verbosity = effort;
    if (controls.temperature.supported) params.temperature = controls.temperature.defaultValue;
    else delete params.temperature;
    return params;
  }
  return fail("catalog", "model_family_unsupported");
}

// Admin provider projection -------------------------------------------------------

export type JourneyProviderModel = Readonly<{
  activeConfig: AdminProviderModelConfiguration | null;
  activeVersion: number;
  displayName: string;
  draftConfig: AdminProviderModelConfiguration;
  draftVersion: number;
  enabled: boolean;
  id: string;
  updatedAt: string;
}>;

type JourneyActiveCheck = Readonly<{
  connectionVersion: number;
  credentialId: string;
  credentialVersionId: string;
  modelVersion: number;
  providerModelId: string;
  status: string;
}>;

export type JourneyConnection = Readonly<{
  active: boolean;
  activeChecks: readonly JourneyActiveCheck[];
  activeVersion: number;
  apiRoot: string | null;
  checkRunning: boolean;
  /** The default credential's active version when it is enabled and unrevoked. */
  defaultCredentialVersionId: string | null;
  defaultCredentialId: string | null;
  enabled: boolean;
  family: string;
  id: string;
  models: readonly JourneyProviderModel[];
}>;

function modelConfiguration(value: unknown): AdminProviderModelConfiguration | null {
  return record(value) && typeof value.upstreamModelId === "string" && typeof value.adapterKind === "string" &&
    record(value.capabilities) ? value as AdminProviderModelConfiguration : null;
}

function readModel(value: unknown): JourneyProviderModel | null {
  if (!record(value) || typeof value.id !== "string" || typeof value.displayName !== "string" ||
    typeof value.enabled !== "boolean" || typeof value.updatedAt !== "string" ||
    !Number.isSafeInteger(value.activeVersion) || !Number.isSafeInteger(value.draftVersion)) return null;
  const draftConfig = modelConfiguration(value.draftConfig);
  const activeConfig = value.activeConfig === null ? null : modelConfiguration(value.activeConfig);
  if (!draftConfig || (value.activeConfig !== null && !activeConfig)) return null;
  return {
    activeConfig, activeVersion: Number(value.activeVersion), displayName: value.displayName, draftConfig,
    draftVersion: Number(value.draftVersion), enabled: value.enabled, id: value.id, updatedAt: value.updatedAt
  };
}

function readActiveCheck(value: unknown): JourneyActiveCheck[] {
  return record(value) && typeof value.credentialId === "string" && typeof value.credentialVersionId === "string" &&
    typeof value.providerModelId === "string" && typeof value.status === "string" &&
    Number.isSafeInteger(value.connectionVersion) && Number.isSafeInteger(value.modelVersion)
    ? [{ connectionVersion: Number(value.connectionVersion), credentialId: value.credentialId,
        credentialVersionId: value.credentialVersionId, modelVersion: Number(value.modelVersion),
        providerModelId: value.providerModelId, status: value.status }]
    : [];
}

function defaultCredentialVersion(entry: Record<string, unknown>): string | null {
  const credentials = Array.isArray(entry.credentials) ? entry.credentials : [];
  const credential = credentials.find((candidate) => record(candidate) && candidate.id === entry.defaultCredentialId);
  if (!record(credential) || credential.enabled !== true || !record(credential.activeVersion)) return null;
  const version = credential.activeVersion;
  return typeof version.id === "string" && (version.revokedAt === null || version.revokedAt === undefined) ? version.id : null;
}

/** The fields of `GET /api/admin/providers` the journey needs, or null for an unexpected shape. */
export function readConnections(value: unknown): JourneyConnection[] | null {
  if (!record(value) || !Array.isArray(value.connections)) return null;
  const connections: JourneyConnection[] = [];
  for (const entry of value.connections) {
    if (!record(entry) || typeof entry.id !== "string" || typeof entry.family !== "string" ||
      typeof entry.enabled !== "boolean" || !Array.isArray(entry.models)) return null;
    const models = entry.models.map(readModel);
    if (models.some((model) => model === null)) return null;
    const config = record(entry.activeConfig) ? entry.activeConfig : record(entry.draftConfig) ? entry.draftConfig : null;
    connections.push({
      active: record(entry.activeConfig),
      activeChecks: Array.isArray(entry.activeChecks) ? entry.activeChecks.flatMap(readActiveCheck) : [],
      activeVersion: Number.isSafeInteger(entry.activeVersion) ? Number(entry.activeVersion) : 0,
      apiRoot: typeof config?.apiRoot === "string" ? config.apiRoot.replace(/\/+$/u, "") : null,
      checkRunning: record(entry.checkRun) && entry.checkRun.state === "running",
      defaultCredentialId: typeof entry.defaultCredentialId === "string" ? entry.defaultCredentialId : null,
      defaultCredentialVersionId: defaultCredentialVersion(entry),
      enabled: entry.enabled,
      family: entry.family,
      id: entry.id,
      models: models as JourneyProviderModel[]
    });
  }
  return connections;
}

export type JourneyTarget = Readonly<{ apiRoot?: string; family: "anthropic" | "openai_compatible"; upstreamModelId: string }>;

/** Why an existing deployment can or cannot serve the journey; booleans only. */
export type DeploymentUsability = Readonly<{
  checkAvailable: boolean;
  connectionActive: boolean;
  connectionEnabled: boolean;
  credentialActive: boolean;
  modelActive: boolean;
  modelEnabled: boolean;
  usable: boolean;
}>;

/**
 * A deployment is reusable only when runs can use it now: an enabled, published
 * connection whose default credential has an unrevoked active version, an
 * enabled published model, and an `available` check for that exact tuple.
 * Seeded code-owned templates (disabled, keyless, unpublished) never qualify.
 */
export function deploymentUsability(connection: JourneyConnection, model: JourneyProviderModel): DeploymentUsability {
  const credentialActive = connection.defaultCredentialVersionId !== null;
  const modelActive = model.activeConfig !== null && model.activeVersion > 0;
  const checkAvailable = connection.activeChecks.some((check) => check.status === "available" &&
    check.providerModelId === model.id && check.credentialId === connection.defaultCredentialId &&
    check.credentialVersionId === connection.defaultCredentialVersionId &&
    check.modelVersion === model.activeVersion && check.connectionVersion === connection.activeVersion);
  const usability = {
    checkAvailable, connectionActive: connection.active, connectionEnabled: connection.enabled, credentialActive,
    modelActive, modelEnabled: model.enabled
  };
  return { ...usability, usable: Object.values(usability).every(Boolean) };
}

/** The model of the route inside one connection, whatever its state. */
export function modelInConnection(connection: JourneyConnection, upstreamModelId: string): JourneyProviderModel | null {
  return connection.models.find((model) => (model.activeConfig ?? model.draftConfig).upstreamModelId === upstreamModelId) ?? null;
}

export type JourneyReuseDecision = Readonly<{
  candidates: readonly DeploymentUsability[];
  match: Readonly<{ connection: JourneyConnection; model: JourneyProviderModel }> | null;
  reason: "no_candidate" | "not_usable" | "usable";
}>;

/** The first usable existing deployment of the route's model, with the evidence for the choice. */
export function journeyReuseDecision(connections: readonly JourneyConnection[], target: JourneyTarget): JourneyReuseDecision {
  const candidates = connections.flatMap((connection) => {
    if (connection.family !== target.family || (target.apiRoot !== undefined && connection.apiRoot !== target.apiRoot)) return [];
    const model = modelInConnection(connection, target.upstreamModelId);
    return model ? [{ connection, model, usability: deploymentUsability(connection, model) }] : [];
  });
  const match = candidates.find((candidate) => candidate.usability.usable) ?? null;
  return {
    candidates: candidates.map((candidate) => candidate.usability),
    match: match ? { connection: match.connection, model: match.model } : null,
    reason: match ? "usable" : candidates.length > 0 ? "not_usable" : "no_candidate"
  };
}

/**
 * The Admin model update that publishes the journey window as the
 * administrator-set `capabilities.contextWindow`, or null when the active
 * configuration already carries it.
 */
export function contextWindowUpdate(model: JourneyProviderModel, contextWindow: number): Record<string, unknown> | null {
  if (model.activeConfig?.capabilities.contextWindow === contextWindow &&
    model.draftConfig.capabilities.contextWindow === contextWindow) return null;
  return {
    action: "update",
    activate: true,
    configuration: { ...model.draftConfig, capabilities: { ...model.draftConfig.capabilities, contextWindow } },
    displayName: model.displayName,
    expectedActiveVersion: model.activeVersion,
    expectedDisplayName: model.displayName,
    expectedDraftVersion: model.draftVersion,
    expectedUpdatedAt: model.updatedAt
  };
}

/**
 * The context window a custom-setup discovery response lists for one model
 * (`AdminCompatibleDiscoveredModel.capabilities.contextWindow`), or null.
 */
export function discoveredContextWindow(discovery: unknown, model: string): number | null {
  if (!record(discovery) || !Array.isArray(discovery.models)) return null;
  const entry = discovery.models.find((candidate) => record(candidate) && candidate.id === model);
  const value = record(entry) && record(entry.capabilities) ? entry.capabilities.contextWindow : undefined;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

/** The quick-setup candidate naming the requested model, else the policy's first choice. */
export function quickSetupCandidate(value: unknown, model: string): Readonly<{ candidateId: string; policyVersion: number }> | null {
  if (!record(value) || !Array.isArray(value.candidates) || !Number.isSafeInteger(value.policyVersion)) return null;
  const candidates = value.candidates.filter((entry): entry is { candidateId: string; displayName: string } =>
    record(entry) && typeof entry.candidateId === "string" && typeof entry.displayName === "string");
  const normalized = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  const chosen = candidates.find((entry) => entry.candidateId === model) ??
    candidates.find((entry) => normalized(entry.candidateId).includes(normalized(model)) ||
      normalized(entry.displayName) === normalized(model)) ?? candidates[0];
  return chosen ? { candidateId: chosen.candidateId, policyVersion: Number(value.policyVersion) } : null;
}

/**
 * The custom-setup request for the codex-lb compatible Responses endpoint.
 * With a discovery receipt the model is a selected catalog id; without one it
 * is the handler's manual fallback, which setup proves with a tiny generation.
 */
export function codexLbSetupBody(input: Readonly<{
  apiRoot: string;
  catalogProof?: string;
  connectionDisplayName: string;
  contextWindow: number;
  model: string;
  secret: string;
}>): Record<string, unknown> {
  return {
    allowPrivateNetwork: true,
    apiRoot: input.apiRoot,
    authenticationMode: "bearer",
    // Hybrid compaction freezes only for tool-capable models; setup verifies the declaration.
    capabilities: {
      contextWindow: input.contextWindow, defaultMaxOutputTokens: 4096, streaming: true, toolCalling: true,
      parallelToolCalls: false, reasoning: true, reasoningEfforts: ["low"], defaultReasoningEffort: "low",
      nativePdfInput: false, nativeImageGeneration: false, nativeSearch: false, pdf: true, vision: false
    },
    confirmPaidRequest: true,
    connectionDisplayName: input.connectionDisplayName,
    modelDisplayName: "Context journey model",
    protocol: "responses",
    responseTimeoutSeconds: 180,
    secret: input.secret,
    ...(input.catalogProof ? { catalogProof: input.catalogProof, modelIds: [input.model] } : { modelId: input.model })
  };
}

// Catalog readiness and debug evidence ---------------------------------------------

export type CatalogReadiness =
  | "catalog_model_identity_missing"
  | "catalog_model_missing"
  | "catalog_tool_calling_unavailable"
  | "catalog_window_not_applied"
  | "ready";

/** The catalog state of the journey model; a non-ready value is the timeout's failure code. */
export function catalogReadiness(model: CatalogModel | null | undefined, contextWindow: number): CatalogReadiness {
  if (!model) return "catalog_model_missing";
  if (!model.providerFamily || !model.upstreamModelId) return "catalog_model_identity_missing";
  if (model.contextWindow !== contextWindow) return "catalog_window_not_applied";
  // Hybrid compaction is frozen only for tool-capable admissions.
  return model.capabilities.toolCalling ? "ready" : "catalog_tool_calling_unavailable";
}

const STATIC_PATH_SEGMENTS = new Set([
  "actions", "admin", "api", "auth", "cancel", "catalog", "chats", "credentials", "custom-setup", "delete-permanently",
  "discover", "me", "memory-mode", "messages", "model-runs", "models", "providers", "quick-setup", "status", "token"
]);

/** A request path with every non-route segment (ids) replaced and the query dropped. */
export function debugPath(path: string): string {
  const pathname = path.split(/[?#]/u, 1)[0] ?? "";
  return pathname.split("/").map((segment) => segment === "" || STATIC_PATH_SEGMENTS.has(segment) ? segment : "<id>").join("/");
}

/** A value suitable for evidence only when it is a short stable code. */
export function stableCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/u.test(value) ? value : null;
}

/** One sanitized HTTP debug line: method, redacted path, status and stable codes only. */
export function debugHttpLine(input: Readonly<{ body?: unknown; method: string; path: string; stage: string; status: number | null }>): Record<string, unknown> {
  const body = record(input.body) ? input.body : {};
  const error = stableCode(body.error);
  const code = stableCode(body.code);
  const outcome = stableCode(body.outcome);
  return {
    debug: "http",
    stage: input.stage,
    method: input.method,
    path: debugPath(input.path),
    status: input.status,
    ...(error ? { error } : {}),
    ...(code ? { code } : {}),
    ...(outcome ? { outcome } : {})
  };
}

// Usage ledger ---------------------------------------------------------------------

/**
 * Provider-reported prompt accounting as AIQSA normalizes it: `inputTokens`
 * is the whole prompt (Anthropic's uncached input plus cache reads plus cache
 * writes; OpenAI-style `input_tokens`, whose cached part is a subset), and the
 * two cache fields are components of it.
 */
export type LedgerUsage = Readonly<{ cacheWriteInputTokens: number; cachedInputTokens: number; inputTokens: number }>;

const LEDGER_FIELDS = ["cacheWriteInputTokens", "cachedInputTokens", "inputTokens"] as const;

/** The usage analytics read the ledger compares: the last seven UTC days. */
export const LEDGER_USAGE_PATH = "/api/admin/usage?period=7d&tz=UTC";

/**
 * The Admin usage ledger totals for this model, or null when the shape is
 * unexpected. The analytics break usage down by model across users, so the
 * ledger is exact only while the smoke's synthetic account is the only one
 * using the route model, as on its disposable stand. Rows are keyed by the
 * canonical connection/model identity or the raw run spelling; either counts.
 * Unreported counts add zero.
 */
export function ledgerUsage(
  analytics: unknown,
  keys: Readonly<{ modelIds: readonly string[]; providers: readonly string[] }>
): LedgerUsage | null {
  if (!record(analytics) || !record(analytics.usage) || !Array.isArray(analytics.usage.byModel)) return null;
  const totals = { cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens: 0 };
  for (const row of analytics.usage.byModel) {
    if (!record(row) || typeof row.provider !== "string" || typeof row.modelId !== "string") return null;
    if (!keys.providers.includes(row.provider) || !keys.modelIds.includes(row.modelId)) continue;
    for (const field of LEDGER_FIELDS) {
      const value = row[field];
      if (value !== null && value !== undefined && !(Number.isSafeInteger(value) && Number(value) >= 0)) return null;
      totals[field] += Number(value ?? 0);
    }
  }
  return totals;
}

/** One turn's ledger growth, or null when either side is unknown or it shrank. */
export function ledgerDelta(before: LedgerUsage | null, after: LedgerUsage | null): LedgerUsage | null {
  if (!before || !after) return null;
  const delta = {
    cacheWriteInputTokens: after.cacheWriteInputTokens - before.cacheWriteInputTokens,
    cachedInputTokens: after.cachedInputTokens - before.cachedInputTokens,
    inputTokens: after.inputTokens - before.inputTokens
  };
  return Object.values(delta).every((value) => value >= 0) ? delta : null;
}

/**
 * The full provider prompt of a turn. Normally `inputTokens` already contains
 * both cache components; only when the components exceed it (a route that
 * reported uncached input alone) is the prompt their sum.
 */
export function fullPromptTokens(usage: LedgerUsage): Readonly<{ accounting: "exclusive_detected" | "inclusive"; tokens: number }> {
  const components = usage.cachedInputTokens + usage.cacheWriteInputTokens;
  return components > usage.inputTokens
    ? { accounting: "exclusive_detected", tokens: usage.inputTokens + components }
    : { accounting: "inclusive", tokens: usage.inputTokens };
}

// Chat projection --------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["cancelled", "complete", "error"]);

/** The assistant answering the user message sent after `previousLeafId`, once terminal. */
export function settledTurn(detail: ChatDetailWire, previousLeafId: string | null): Readonly<{
  assistant: ChatMessageWire;
  user: ChatMessageWire;
}> | null {
  const newestFirst = [...detail.messages].reverse();
  const user = newestFirst.find((message) => message.role === "user" && message.parentMessageId === previousLeafId);
  const assistant = user && newestFirst.find((message) => message.role === "assistant" && message.parentMessageId === user.id);
  return user && assistant && TERMINAL_STATUSES.has(assistant.status) ? { assistant, user } : null;
}

export function messageText(message: Pick<ChatMessageWire, "content">): string {
  if (typeof message.content === "string") return message.content;
  return record(message.content) ? textFromContentBlocks(message.content as { blocks?: unknown[] }) : "";
}

/** The compaction marker the chat projection shows on one answer, as it stands now. */
export function compactionMarker(detail: Pick<ChatDetailWire, "messages">, messageId: string): ContextCompactionStatus | null {
  return detail.messages.find((message) => message.id === messageId)?.artifactSummary?.contextCompaction ?? null;
}

/** Whether any of these answers shows an applied summary. */
export function summaryShown(detail: Pick<ChatDetailWire, "messages">, messageIds: readonly string[]): boolean {
  return messageIds.some((id) => compactionMarker(detail, id)?.outcome === "summary_applied");
}

// Run stream --------------------------------------------------------------------------

/** A compaction status line is a few hundred bytes; any longer line is skipped whole. */
const STREAM_LINE_MAX_CHARS = 4_096;

/**
 * Reads a run's own event stream for the one fact the chat projection cannot
 * give: whether the turn waited for a summary. A summary the request waits
 * for publishes a running compaction status before its call; a background
 * summary, which the user does not wait for, publishes only its settled
 * marker. Text arrives in arbitrary pieces and nothing beyond the current
 * bounded line is kept.
 */
export function createRunStreamScanner(): Readonly<{ push(text: string): void; summaryCycles(): number }> {
  let event = "";
  let line = "";
  let skipping = false;
  let cycles = 0;
  const complete = (value: string) => {
    if (value === "") {
      event = "";
      return;
    }
    if (value.startsWith("event:")) {
      event = value.slice("event:".length).trim();
      return;
    }
    if (event !== "artifact" || !value.startsWith("data:")) return;
    let data: unknown = null;
    try {
      data = JSON.parse(value.slice("data:".length));
    } catch {
      return;
    }
    if (record(data) && data.artifactType === "context_compaction" && record(data.payload) &&
      data.payload.state === "running") cycles += 1;
  };
  return {
    push(text) {
      const pieces = text.split("\n");
      pieces.forEach((piece, index) => {
        if (!skipping && line.length + piece.length > STREAM_LINE_MAX_CHARS) {
          skipping = true;
          line = "";
        }
        if (!skipping) line += piece;
        if (index === pieces.length - 1) return;
        if (!skipping) complete(line.replace(/\r$/u, ""));
        line = "";
        skipping = false;
      });
    },
    summaryCycles: () => cycles
  };
}

// Evidence and verdict ---------------------------------------------------------------

export type JourneyTurnKind = "brief" | "correction" | "filler" | "probe" | "rule";

export type JourneyRound = Readonly<{
  /** The turn's dispatched estimate as a share of the engine's window (`engineContextTokens`). */
  budgetShare: number | null;
  /** How the full prompt was derived from the ledger components. */
  reportedAccounting: "exclusive_detected" | "inclusive" | null;
  reportedCacheWriteInputTokens: number | null;
  reportedCachedInputTokens: number | null;
  /** The ledger's normalized `inputTokens` for the turn, before any correction. */
  reportedLedgerInputTokens: number | null;
  compactionOutcome: ContextCompactionStatus["outcome"] | null;
  estimatedInputTokens: number | null;
  kind: JourneyTurnKind;
  ratio: number | null;
  reportedInputTokens: number | null;
  /** The engine's measure of the request that started this turn's summary, as a share of its window. */
  summaryAtBudgetShare: number | null;
  /** The request waited for a summary (true), did not (false), or the run stream could not be read (null). */
  summaryBought: boolean | null;
  turn: number;
}>;

export type JourneyRoundInput = Readonly<{
  answerTokens: number;
  /** The turn's own compaction marker: the engine records it on the run whose request started the summary. */
  compaction: ContextCompactionStatus | null;
  /** An earlier turn's summary finished during this turn, so its call's usage may be in this turn's ledger growth. */
  compactionSettled?: boolean;
  kind: JourneyTurnKind;
  reported: LedgerUsage | null;
  session: SessionContextStatus | null;
  summaryBought: boolean | null;
  toolCalls: number;
  turn: number;
}>;

const rounded = (value: number) => Math.round(value * 1_000) / 1_000;

/**
 * One turn's content-free evidence. The estimate is the stand's own session
 * measurement of the final request as dispatched (its after-answer phase minus
 * the answer's estimate; room a run reserves for follow-ups is never part of
 * it), as a share of the window the engine's thresholds use.
 * `reportedInputTokens` is the turn's full provider prompt from the usage
 * ledger (`fullPromptTokens`), with its cache components alongside. The ratio
 * (full prompt / estimate) is given for every turn that sent one provider
 * request: no tool rounds, no summary of its own (a background summary is a
 * call beside the answer) and no earlier summary settling during it, since
 * those add input the final request estimate does not describe.
 */
export function journeyRound(input: JourneyRoundInput): JourneyRound {
  const { session } = input;
  const estimated = session
    ? Math.max(0, session.approximateInputTokens - (session.phase === "after_answer" ? input.answerTokens : 0))
    : null;
  const budget = session ? engineContextTokens(session) : null;
  const share = (tokens: number | null) => tokens !== null && budget ? rounded(tokens / budget) : null;
  const full = input.reported ? fullPromptTokens(input.reported) : null;
  const reported = full?.tokens ?? null;
  const singleRequest = input.toolCalls === 0 && input.compaction === null && input.compactionSettled !== true;
  return {
    budgetShare: share(estimated),
    reportedAccounting: full?.accounting ?? null,
    reportedCacheWriteInputTokens: input.reported?.cacheWriteInputTokens ?? null,
    reportedCachedInputTokens: input.reported?.cachedInputTokens ?? null,
    reportedLedgerInputTokens: input.reported?.inputTokens ?? null,
    compactionOutcome: input.compaction?.outcome ?? null,
    estimatedInputTokens: estimated,
    kind: input.kind,
    ratio: estimated && reported && singleRequest ? rounded(reported / estimated) : null,
    reportedInputTokens: reported,
    summaryAtBudgetShare: input.compaction?.outcome === "summary_applied" ? share(input.compaction.beforeTokens) : null,
    summaryBought: input.summaryBought,
    turn: input.turn
  };
}

/**
 * Whether the turn just answered waits for a background summary before the
 * next one: no turn shows a summary yet, and this turn's or the previous
 * turn's context passed the trigger, so the engine has started one by this
 * turn's request unless its own measure still trails.
 */
export function awaitsSummary(previous: readonly JourneyRound[], share: number | null): boolean {
  if (previous.some((round) => round.summaryAtBudgetShare !== null)) return false;
  const last = previous.at(-1)?.budgetShare ?? null;
  return [share, last].some((value) => value !== null && value > JOURNEY_LIMITS.triggerShare);
}

export type JourneyVerdict = Readonly<{
  code: string | null;
  compactionTriggered: boolean;
  firstSummaryAtBudgetShare: number | null;
  /**
   * The first summary's share of the window in provider-reported tokens: its
   * turn's ledger also holds the summary call, so the engine's measure is
   * scaled by the ratio of the latest single-request turn before it.
   */
  firstSummaryAtReportedBudgetShare: number | null;
  passed: boolean;
}>;

/**
 * Passes when the first summary started past the trigger, at the first turn
 * whose dispatched estimate exceeded it or at the next one (the engine starts
 * it from its own measure before the request, which can trail the reported
 * estimate by a turn), was in context before the probe answered (an earlier
 * turn's, or one the probe waited for), every single-request ratio lies in
 * the route's band (when it has one) and the probe answer carried both
 * corrections.
 */
export function journeyVerdict(
  rounds: readonly JourneyRound[],
  probeAnswerCarriesCorrections: boolean,
  ratioBand: JourneyRatioBand | null = null
): JourneyVerdict {
  const compactionTriggered = rounds.some((round) => round.compactionOutcome !== null);
  const first = rounds.findIndex((round) => round.summaryAtBudgetShare !== null);
  const firstSummaryAtBudgetShare = first >= 0 ? rounds[first]!.summaryAtBudgetShare : null;
  const earlier = first >= 0 ? rounds.slice(0, first) : rounds;
  const crossed = rounds.findIndex((round) => round.budgetShare !== null && round.budgetShare > JOURNEY_LIMITS.triggerShare);
  const ratioBefore = [...earlier].reverse().find((round) => round.ratio !== null)?.ratio ?? null;
  const ratios = rounds.flatMap((round) => round.ratio === null ? [] : [round.ratio]);
  const code = (() => {
    if (!compactionTriggered) return "compaction_not_triggered";
    if (firstSummaryAtBudgetShare === null) return "summary_not_bought";
    if (firstSummaryAtBudgetShare <= JOURNEY_LIMITS.triggerShare) return "summary_before_trigger";
    if (crossed >= 0 && crossed < first - 1) return "trigger_crossed_without_summary";
    const summarized = rounds[first]!;
    if (summarized.kind === "probe" && summarized.summaryBought !== true) return "summary_after_probe";
    if (ratioBand && ratios.length === 0) return "ratio_missing";
    if (ratioBand && ratios.some((ratio) => ratio < ratioBand.min || ratio > ratioBand.max)) return "ratio_out_of_range";
    return probeAnswerCarriesCorrections ? null : "probe_answer_missing_corrections";
  })();
  return {
    code,
    compactionTriggered,
    firstSummaryAtBudgetShare,
    firstSummaryAtReportedBudgetShare: firstSummaryAtBudgetShare !== null && ratioBefore !== null
      ? rounded(firstSummaryAtBudgetShare * ratioBefore) : null,
    passed: code === null
  };
}

/** Exit 0 needs at least one executed route and every executed route passing;
 * an explicitly requested route that had to be skipped also fails the run. */
export function journeyExitCode(
  results: readonly Readonly<{ status: "failed" | "passed" | "skipped" }>[],
  explicitRoutes: boolean
): 0 | 1 {
  const executed = results.filter((result) => result.status !== "skipped");
  if (executed.length === 0 || executed.some((result) => result.status !== "passed")) return 1;
  return explicitRoutes && results.some((result) => result.status === "skipped") ? 1 : 0;
}

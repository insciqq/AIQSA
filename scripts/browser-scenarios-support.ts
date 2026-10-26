/**
 * Pure parts of `scripts/smoke-browser-scenarios-paid.ts`: the stand guard,
 * the scenarios with their Russian prompts, the `browser-result.json` schema
 * and its deterministic oracles, and the content-free run evidence.
 *
 * Oracles read only the result file the agent writes into the turn's output
 * files, never the chat answer, so a verdict is reproducible. Evidence lines
 * carry codes, counts, booleans, timings, token counts and provider-reported
 * cost; never prompts, answers, page content, prices or URLs.
 */

export const BROWSER_RESULT_FILE = "browser-result.json";
/** A result file larger than this is not read (a valid one is a few KiB). */
export const BROWSER_RESULT_MAX_BYTES = 256 * 1024;

export const BROWSER_BLOCKED_CODES = ["captcha", "bot_wall", "sign_in_required", "code_required"] as const;
export type BrowserBlockedCode = (typeof BROWSER_BLOCKED_CODES)[number] | "other";

export const BROWSER_SCENARIO_IDS = ["S1", "S2", "S3", "S4", "S5"] as const;
export type BrowserScenarioId = (typeof BROWSER_SCENARIO_IDS)[number];

/** Published saucedemo.com demo credentials (public test shop, no real orders). */
export const SAUCEDEMO_SECRET = Object.freeze({
  description: "Логин и пароль демо-магазина www.saucedemo.com (публичные тестовые данные).",
  entries: [
    { name: "SAUCEDEMO_USERNAME", value: "standard_user" },
    { name: "SAUCEDEMO_PASSWORD", value: "secret_sauce" }
  ],
  name: "Saucedemo"
});

/** Fixed future nights for S4, so every run asks the same question. */
export const S4_CHECK_IN = "2026-12-09";
export const S4_CHECK_OUT = "2026-12-11";

// Stand guard ------------------------------------------------------------------------

type ComposePort = { host_ip?: string; published?: string | number; target?: number };
type ComposeDevice = string | { source?: string; target?: string };
type ComposeService = {
  devices?: ComposeDevice[];
  environment?: Record<string, string | null>;
  image?: string;
  networks?: Record<string, unknown> | string[];
  ports?: ComposePort[];
};
/** `docker compose config --format json` of the stand. */
export type BrowserScenarioStand = { name?: string; services?: Record<string, ComposeService> };

export type StandBound = number | "default" | "none";
export type StandTarget = Readonly<{
  baseUrl: string;
  bootstrapToken: string;
  databaseUrl: string;
  project: string;
  /** The stand's Workspace environment as configured ("default" when the code default applies). */
  configuredBounds: Readonly<{ maxToolCalls: StandBound; maxToolRounds: StandBound; turnTimeoutSeconds: StandBound }>;
}>;

export class BrowserScenarioError extends Error {
  constructor(code: string) {
    super(`browser_scenarios_${code}`);
    this.name = "BrowserScenarioError";
  }
}

const fail = (code: string): never => { throw new BrowserScenarioError(code); };

function loopbackPort(service: ComposeService | undefined, target: number): string {
  const entry = service?.ports?.find((item) => item.target === target);
  const published = String(entry?.published ?? "");
  if (!entry || entry.host_ip !== "127.0.0.1" || !/^\d+$/u.test(published) ||
    Number(published) < 1024 || Number(published) > 65535) fail("loopback_required");
  return published;
}

function configuredBound(value: string | null | undefined): StandBound {
  if (value === undefined || value === null || value === "") return "default";
  return /^\d+$/u.test(value) ? Number(value) : fail("runtime_bounds_invalid");
}

/**
 * Admits only an explicitly acknowledged, task-owned real-KVM stand that is
 * reachable on loopback: never the persistent `aiqsa` project, never a
 * deterministic runtime. The Workspace bounds are not demanded, only
 * recorded, so the same script measures main's defaults and later branches.
 */
export function requireBrowserScenarioStand(mode: string | undefined, stand: BrowserScenarioStand): StandTarget {
  if (mode !== "DISPOSABLE") fail("opt_in_required");
  const project = stand.name ?? "";
  if (!/^aiqsa-[a-z0-9][a-z0-9-]{0,62}$/u.test(project) || /psaux/u.test(project)) fail("project_invalid");
  const services = stand.services ?? {};
  const app = services.app;
  const runner = services["workspace-runner"];
  const roles = [app, services.postgres, runner, services["workspace-maintenance"], services["memory-worker"]];
  if (roles.some((role) => !role)) fail("roles_missing");
  const env = (service: ComposeService | undefined) => service?.environment ?? {};
  if (env(runner).AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME !== "0" ||
    env(app).AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME === "1" ||
    env(app).AIQSA_TEST_MODE === "1" || env(app).PLAYWRIGHT_TEST_AUTH === "1") fail("real_runtime_required");
  const kvm = (runner?.devices ?? []).some((device) =>
    typeof device === "string" ? device.split(":")[0] === "/dev/kvm" : device.source === "/dev/kvm");
  if (!kvm) fail("kvm_required");
  for (const key of ["AIQSA_WORKSPACE_RUNNER_URL", "AIQSA_WORKSPACE_RUNNER_TOKEN"]) {
    if (!env(app)[key] || env(services["memory-worker"])[key] !== env(app)[key]) fail("runner_wiring_invalid");
  }
  const appPort = loopbackPort(app, 3000);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  if (env(app).AIQSA_APP_BASE_URL !== baseUrl) fail("base_url_mismatch");
  if (!/^(1|true|yes|on)$/iu.test(env(app).AIQSA_BOOTSTRAP_LOGIN_ENABLED ?? "")) fail("bootstrap_login_required");
  const bootstrapToken = env(app).AIQSA_BOOTSTRAP_AUTH_TOKEN ?? "";
  if (bootstrapToken.length < 32) fail("bootstrap_token_required");
  let database: URL;
  try { database = new URL(env(app).DATABASE_URL ?? ""); } catch { return fail("database_invalid"); }
  if (database.protocol !== "postgresql:" || database.hostname !== "postgres" || database.pathname !== "/aiqsa" ||
    !database.password || database.username !== "aiqsa") fail("database_invalid");
  database.hostname = "127.0.0.1";
  database.port = loopbackPort(services.postgres, 5432);
  database.search = "";
  return {
    baseUrl,
    bootstrapToken,
    configuredBounds: {
      maxToolCalls: configuredBound(env(app).AIQSA_WORKSPACE_MAX_TOOL_CALLS),
      maxToolRounds: configuredBound(env(app).AIQSA_WORKSPACE_MAX_TOOL_ROUNDS),
      turnTimeoutSeconds: configuredBound(env(app).AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS)
    },
    databaseUrl: database.toString(),
    project
  };
}

// Effective bounds of an admitted run -----------------------------------------------

export type RunBounds = Readonly<{ maxToolCalls: number | "none"; maxToolRounds: number | "none"; turnTimeoutSeconds: number | "none" }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const positive = (value: unknown): number | "none" =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : "none";

/**
 * The limits the run was admitted with, from its frozen request: the tool
 * budgets the engine enforces and the Workspace turn deadline. A limit the
 * request does not carry (limits off) is "none".
 */
export function runBounds(normalizedRequest: unknown): RunBounds {
  const request = record(normalizedRequest) ? normalizedRequest : {};
  const budgets = record(request.toolBudgets) ? request.toolBudgets : {};
  const workspace = record(request.workspace) ? request.workspace : {};
  return {
    maxToolCalls: positive(budgets.maxToolCalls),
    maxToolRounds: positive(budgets.maxToolRounds),
    turnTimeoutSeconds: positive(workspace.turnTimeoutSeconds)
  };
}

// Result file and oracles ------------------------------------------------------------

export type BrowserResult = Readonly<Record<string, unknown>>;

export type ParsedBrowserResult =
  | Readonly<{ ok: true; blocked: readonly BrowserBlockedCode[]; value: BrowserResult }>
  | Readonly<{ ok: false; code: "result_invalid_json" | "result_not_object" | "result_too_large" }>;

/** Normalizes the agent's `blocked` list; unknown entries count as `other`. */
export function blockedCodes(value: unknown): BrowserBlockedCode[] {
  if (!Array.isArray(value)) return [];
  const codes = new Set<BrowserBlockedCode>();
  for (const entry of value) {
    const code = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!code || code === "none") continue;
    codes.add((BROWSER_BLOCKED_CODES as readonly string[]).includes(code) ? code as BrowserBlockedCode : "other");
  }
  return [...codes].sort();
}

export function parseBrowserResult(bytes: Uint8Array): ParsedBrowserResult {
  if (bytes.byteLength > BROWSER_RESULT_MAX_BYTES) return { code: "result_too_large", ok: false };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/u, ""));
  } catch {
    return { code: "result_invalid_json", ok: false };
  }
  if (!record(value)) return { code: "result_not_object", ok: false };
  return { blocked: blockedCodes(value.blocked), ok: true, value };
}

/** A price the agent wrote: a JSON number, or a plain decimal string such as "2,49". */
export function priceValue(value: unknown): number | null {
  let number: number;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && /^\s*\d{1,7}(?:[.,]\d{1,2})?\s*$/u.test(value)) number = Number(value.trim().replace(",", "."));
  else return null;
  return Number.isFinite(number) && number > 0 && number < 10_000_000 ? number : null;
}

/** True when `value` is an http(s) URL on `domain` or one of its subdomains. */
export function urlOnDomain(value: unknown, domain: string): boolean {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (url.protocol === "https:" || url.protocol === "http:") && (host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

const nonEmptyText = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 1000;
const items = (result: BrowserResult) => Array.isArray(result.items) ? result.items.filter(record) : [];
const isEuro = (value: unknown) => typeof value === "string" && /^(eur|€)$/iu.test(value.trim());
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance + 1e-9;

function oracleS1(result: BrowserResult): string[] {
  const valid = items(result).filter((item) =>
    nonEmptyText(item.name) && priceValue(item.price) !== null && isEuro(item.currency) && urlOnDomain(item.url, "amazon.es"));
  const failed: string[] = [];
  if (valid.length < 8) failed.push("items_lt_8");
  if (valid.filter((item) => item.offer === true).length < 2) failed.push("offers_lt_2");
  return failed;
}

function oracleS2(result: BrowserResult): string[] {
  const cart = record(result.cart) ? result.cart : null;
  if (!cart) return ["cart_missing"];
  const lines = Array.isArray(cart.lines) ? cart.lines : [];
  const failed: string[] = [];
  if (lines.length !== 3) failed.push("cart_lines_not_3");
  const totals = lines.map((line) => record(line) && nonEmptyText(line.name) ? priceValue(line.line_total) : null);
  if (lines.length === 0 || totals.some((total) => total === null)) failed.push("cart_line_price_invalid");
  const subtotal = priceValue(cart.subtotal);
  if (subtotal === null) failed.push("cart_subtotal_invalid");
  else if (!totals.some((total) => total === null) &&
    !near(subtotal, totals.reduce<number>((sum, total) => sum + (total ?? 0), 0), 0.02)) failed.push("cart_subtotal_mismatch");
  return failed;
}

function oracleS3(result: BrowserResult): string[] {
  const checkout = record(result.checkout) ? result.checkout : null;
  if (!checkout) return ["checkout_missing"];
  const failed: string[] = [];
  const itemTotal = priceValue(checkout.item_total);
  const tax = priceValue(checkout.tax);
  if (itemTotal === null || !near(itemTotal, 39.98, 0.005)) failed.push("item_total_mismatch");
  if (tax === null || !near(tax, 3.2, 0.005)) failed.push("tax_mismatch");
  if (checkout.finished !== false) failed.push("order_not_proven_unfinished");
  return failed;
}

function oracleS4(result: BrowserResult): string[] {
  const valid = items(result).filter((item) =>
    nonEmptyText(item.name) && priceValue(item.price) !== null && urlOnDomain(item.url, "booking.com"));
  return valid.length < 5 ? ["items_lt_5"] : [];
}

// Scenarios -------------------------------------------------------------------------

/**
 * What a scenario may do beside the waiting harness while its turn runs, for
 * example drive a live handoff panel with Playwright (`browser-scenarios-final`
 * adds S5 this way). The harness aborts `signal` once the run is terminal.
 */
export type ScenarioInteraction = (context: Readonly<{
  baseUrl: string;
  chatId: string;
  cookie: string;
  runId: string;
  signal: AbortSignal;
}>) => Promise<void>;

export type BrowserScenario = Readonly<{
  id: BrowserScenarioId;
  /** `not_available` scenarios are reported without a run. */
  availability: "available" | "not_available";
  interaction?: ScenarioInteraction;
  oracle(result: BrowserResult): string[];
  prompt: string;
  /** The saved Workspace secret the scenario expects (S3). */
  secret?: "saucedemo";
}>;

const SAFETY = "Ничего не покупай, не оформляй и не подтверждай заказы, ничего не оплачивай.";

function resultInstruction(fields: string): string {
  return [
    `В конце обязательно сохрани файл ${BROWSER_RESULT_FILE} в папку выходных файлов этого ответа, чтобы я мог его скачать. Это JSON строго такого вида:`,
    "{",
    '  "status": "completed" | "partial" | "blocked",',
    '  "blocked": [],',
    fields,
    "}",
    "Цены пиши числами без символа валюты, например 2.49. Если сайт показал капчу, страницу проверки на робота, потребовал войти в аккаунт " +
      'или ввести код подтверждения, перечисли это в "blocked" кодами captcha, bot_wall, sign_in_required, code_required ' +
      "и всё равно сохрани файл с тем, что удалось собрать. Ответь коротко."
  ].join("\n");
}

const ITEM_FIELDS = '  "items": [{"name": "...", "price": 2.49, "currency": "EUR", "url": "https://...", "offer": true}]';

export const BROWSER_SCENARIOS: Readonly<Record<BrowserScenarioId, BrowserScenario>> = Object.freeze({
  S1: {
    availability: "available",
    id: "S1",
    oracle: oracleS1,
    prompt: [
      "Зайди на amazon.es и посмотри продукты: соки (zumo), йогурты (yogur) и замороженные продукты La Sirena. " +
        "Найди, что сейчас есть в продаже, и какие на них действуют акции и скидки. Хочу понять, что выгодно взять на две недели.",
      `В аккаунт не входи. ${SAFETY}`,
      "Собери не меньше 8 товаров с названием, текущей ценой в евро и ссылкой на страницу товара на amazon.es; " +
        'у товаров со скидкой или акцией поставь "offer": true, у остальных false.',
      resultInstruction(ITEM_FIELDS)
    ].join("\n\n")
  },
  S2: {
    availability: "available",
    id: "S2",
    oracle: oracleS2,
    prompt: [
      "Зайди на amazon.es без входа в аккаунт и положи в корзину 3 недорогих продуктовых товара " +
        "(например, сок, йогурт и что-нибудь замороженное), по одной штуке. Потом открой корзину и посмотри, " +
        "какие там строки и какая промежуточная сумма.",
      `В аккаунт не входи и не регистрируйся. ${SAFETY} Корзину не оформляй.`,
      resultInstruction('  "cart": {"lines": [{"name": "...", "quantity": 1, "line_total": 2.49}], "subtotal": 7.47}')
    ].join("\n\n")
  },
  S3: {
    availability: "available",
    id: "S3",
    oracle: oracleS3,
    prompt: [
      "Открой тестовый магазин https://www.saucedemo.com и войди: логин и пароль сохранены в моих секретах (Saucedemo). " +
        "Добавь в корзину «Sauce Labs Backpack» и «Sauce Labs Bike Light», начни оформление, заполни имя, фамилию " +
        "и индекс любыми тестовыми значениями и дойди до страницы обзора заказа (Checkout: Overview).",
      `Кнопку Finish не нажимай: заказ должен остаться незавершённым. ${SAFETY}`,
      "Запиши Item total и Tax со страницы обзора.",
      resultInstruction('  "checkout": {"item_total": 0.0, "tax": 0.0, "finished": false}')
    ].join("\n\n"),
    secret: "saucedemo"
  },
  S4: {
    availability: "available",
    id: "S4",
    oracle: oracleS4,
    prompt: [
      `Найди на booking.com 5 отелей в Мадриде для двух взрослых на ночи с ${S4_CHECK_IN} по ${S4_CHECK_OUT} ` +
        "(заезд 9 декабря 2026, выезд 11 декабря 2026). Если появится баннер про cookies, закрой его.",
      `Ничего не бронируй и не входи в аккаунт. ${SAFETY}`,
      "Для каждого отеля нужны название, цена за весь период и ссылка на страницу отеля на booking.com " +
        '("offer": true, если booking показывает скидку или спецпредложение).',
      resultInstruction(ITEM_FIELDS)
    ].join("\n\n")
  },
  S5: {
    // Sign-in through live handoff: no saved credentials, the user types them
    // only into the live view. `browser-scenarios-final` makes it available by
    // adding `interaction` (Playwright on the handoff panel) and an oracle.
    availability: "not_available",
    id: "S5",
    oracle: () => ["not_available"],
    prompt: ""
  }
});

export function selectedScenarios(raw: string | undefined): BrowserScenarioId[] {
  const value = raw?.trim() || BROWSER_SCENARIO_IDS.join(",");
  const ids = value.split(",").map((entry) => entry.trim().toUpperCase());
  if (ids.length === 0 || ids.some((id) => !(BROWSER_SCENARIO_IDS as readonly string[]).includes(id)) ||
    new Set(ids).size !== ids.length) fail("scenarios_invalid");
  return BROWSER_SCENARIO_IDS.filter((id) => ids.includes(id));
}

// Run evidence ----------------------------------------------------------------------

export type ToolCallRow = Readonly<{ roundIndex: number; state: string; toolName: string }>;
export type UsageRow = Readonly<{
  costReported: boolean;
  estimatedCostMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}>;

export function toolCallStats(calls: readonly ToolCallRow[]): Readonly<{
  analyzeImageCalls: number; failedToolCalls: number; rounds: number; toolCalls: number;
}> {
  return {
    analyzeImageCalls: calls.filter((call) => call.toolName === "analyze_image").length,
    failedToolCalls: calls.filter((call) => call.state === "error").length,
    // Tool rounds are numbered from 1; a run without tool calls had none.
    rounds: calls.reduce((max, call) => Math.max(max, call.roundIndex), 0),
    toolCalls: calls.length
  };
}

/**
 * Provider-reported usage of one run. Cost is known only when every usage row
 * of the run carries the provider's reported charge; otherwise it stays
 * unknown (null) and is never estimated.
 */
export function usageEvidence(rows: readonly UsageRow[]): Readonly<{
  costUsd: number | null; inputTokens: number | null; outputTokens: number | null; usageEvents: number;
}> {
  const sum = (key: "inputTokens" | "outputTokens") => rows.some((row) => row[key] !== null)
    ? rows.reduce((total, row) => total + (row[key] ?? 0), 0) : null;
  const known = rows.length > 0 && rows.every((row) => row.costReported && row.estimatedCostMicros !== null);
  return {
    costUsd: known ? rows.reduce((total, row) => total + (row.estimatedCostMicros ?? 0), 0) / 1_000_000 : null,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    usageEvents: rows.length
  };
}

export type RunRecord = Readonly<{
  blocked: readonly BrowserBlockedCode[];
  costUsd: number | null;
  rounds: number | null;
  scenario: BrowserScenarioId;
  success: boolean;
  toolCalls: number | null;
  wallSeconds: number | null;
}>;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** One baseline-table row: a scenario's runs aggregated without their content. */
export function scenarioSummary(scenario: BrowserScenarioId, runs: readonly RunRecord[]) {
  const own = runs.filter((run) => run.scenario === scenario);
  const numbers = (key: "rounds" | "toolCalls" | "wallSeconds") =>
    own.map((run) => run[key]).filter((value): value is number => value !== null);
  const blocked: Record<string, number> = {};
  for (const run of own) for (const code of run.blocked) blocked[code] = (blocked[code] ?? 0) + 1;
  const costs = own.map((run) => run.costUsd);
  return {
    blocked,
    costKnownRuns: costs.filter((cost) => cost !== null).length,
    costUsdTotal: own.length > 0 && costs.every((cost) => cost !== null)
      ? Math.round(costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) * 1_000_000) / 1_000_000 : null,
    medianRounds: median(numbers("rounds")),
    medianToolCalls: median(numbers("toolCalls")),
    medianWallSeconds: median(numbers("wallSeconds")),
    runs: own.length,
    scenario,
    successes: own.filter((run) => run.success).length
  };
}

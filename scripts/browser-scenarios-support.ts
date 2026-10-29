/**
 * Pure parts of `scripts/smoke-browser-scenarios-paid.ts`: the stand guard,
 * the scenarios with their Russian prompts, the `browser-result.json` schema
 * and its deterministic oracles, and the content-free run evidence.
 *
 * Oracles read only the result file the agent writes into the turn's output
 * files, never the chat answer, so a verdict is reproducible. Evidence lines
 * carry codes, counts, booleans, timings, token counts (per run and per model
 * request), provider-reported cost and cost estimates from token totals at
 * fixed list prices; never prompts, answers, page content, prices or URLs.
 */
import { createHash } from "node:crypto";

export const BROWSER_RESULT_FILE = "browser-result.json";
/** A result file larger than this is not read (a valid one is a few KiB). */
export const BROWSER_RESULT_MAX_BYTES = 256 * 1024;

export const BROWSER_BLOCKED_CODES = ["captcha", "bot_wall", "sign_in_required", "code_required"] as const;
export type BrowserBlockedCode = (typeof BROWSER_BLOCKED_CODES)[number] | "other";

export const BROWSER_SCENARIO_IDS = ["S1", "S2", "S3", "S4", "S5", "S6"] as const;
export type BrowserScenarioId = (typeof BROWSER_SCENARIO_IDS)[number];
/** What runs when nothing is selected: S6 is long (hundreds of rounds) and runs only when named. */
export const DEFAULT_BROWSER_SCENARIO_IDS: readonly BrowserScenarioId[] = Object.freeze(["S1", "S2", "S3", "S4", "S5"]);

/** Published saucedemo.com demo credentials (public test shop, no real orders). */
export const SAUCEDEMO_SECRET = Object.freeze({
  description: "Логин и пароль демо-магазина www.saucedemo.com (публичные тестовые данные).",
  entries: [
    { name: "SAUCEDEMO_USERNAME", value: "standard_user" },
    { name: "SAUCEDEMO_PASSWORD", value: "secret_sauce" }
  ],
  name: "Saucedemo"
});

/** The same public login as values: what the S5 user types into the live view, and what must never be stored. */
export const SAUCEDEMO_LOGIN_VALUES: readonly string[] = Object.freeze(SAUCEDEMO_SECRET.entries.map((entry) => entry.value));

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
  admin: Readonly<{ email: string; password: string }>;
  baseUrl: string;
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
  const roles = [app, services.postgres, runner, services["workspace-maintenance"], services["memory-worker"],
    services["migrate-bootstrap"]];
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
  // A production-mode app is not ready with bootstrap login on, so the harness
  // signs in as the administrator that bootstrap created, with its password.
  const adminEmail = env(services["migrate-bootstrap"]).AIQSA_INITIAL_ADMIN_EMAIL ?? "";
  const adminPassword = env(services["migrate-bootstrap"]).AIQSA_INITIAL_ADMIN_PASSWORD ?? "";
  if (!/^[^@\s]+@[^@\s]+$/u.test(adminEmail) || adminPassword.length < 12) fail("admin_credentials_required");
  let database: URL;
  try { database = new URL(env(app).DATABASE_URL ?? ""); } catch { return fail("database_invalid"); }
  if (database.protocol !== "postgresql:" || database.hostname !== "postgres" || database.pathname !== "/aiqsa" ||
    !database.password || database.username !== "aiqsa") fail("database_invalid");
  database.hostname = "127.0.0.1";
  database.port = loopbackPort(services.postgres, 5432);
  database.search = "";
  return {
    admin: { email: adminEmail, password: adminPassword },
    baseUrl,
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

/**
 * What the admitted bounds must be. `any` (default) only records them;
 * `unlimited` demands the shipped defaults (operator decision 2026-10-26): no
 * per-answer tool call or round limit and a 3600 s turn, so a long scenario is
 * measured as users run it.
 */
export type BoundsExpectation = "any" | "unlimited";

export function boundsExpectation(raw: string | undefined): BoundsExpectation {
  const value = raw?.trim() || "any";
  return value === "any" || value === "unlimited" ? value : fail("expect_bounds_invalid");
}

/** Stable codes for admitted bounds that differ from the expectation; empty when they match. */
export function unexpectedBounds(bounds: RunBounds, expectation: BoundsExpectation): string[] {
  if (expectation === "any") return [];
  const codes: string[] = [];
  if (bounds.maxToolCalls !== "none") codes.push("tool_calls_limited");
  if (bounds.maxToolRounds !== "none") codes.push("tool_rounds_limited");
  if (bounds.turnTimeoutSeconds !== 3_600) codes.push("turn_timeout_not_3600");
  return codes;
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
const flag = (value: boolean) => value ? 1 : 0;

/** A verdict with content-free counts, so it can be audited later without the file. */
export type OracleVerdict = Readonly<{ counts: Readonly<Record<string, number>>; failed: readonly string[] }>;

/**
 * The identity of a listed page: an Amazon product's ASIN when the URL names
 * one, otherwise host (without `www.`) and path, without query or fragment.
 */
export function canonicalPageKey(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");
    const asin = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$)/iu.exec(url.pathname)?.[1];
    if (asin && (host === "amazon.es" || host.endsWith(".amazon.es"))) return `amazon.es/dp/${asin.toUpperCase()}`;
    return `${host}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return null;
  }
}

const nameKey = (value: string) => value.trim().toLowerCase().replace(/\s+/gu, " ");

/** Valid entries counted once: a repeated page identity or a repeated name adds nothing. */
function distinctEntries(entries: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const pages = new Set<string>();
  const names = new Set<string>();
  return entries.filter((entry) => {
    const page = canonicalPageKey(String(entry.url));
    const name = nameKey(String(entry.name));
    if (!page || pages.has(page) || names.has(name)) return false;
    pages.add(page);
    names.add(name);
    return true;
  });
}

function oracleS1(result: BrowserResult): OracleVerdict {
  const listed = items(result);
  const valid = listed.filter((item) =>
    nonEmptyText(item.name) && priceValue(item.price) !== null && isEuro(item.currency) && urlOnDomain(item.url, "amazon.es"));
  const distinct = distinctEntries(valid);
  const offers = distinct.filter((item) => item.offer === true).length;
  const failed: string[] = [];
  if (distinct.length < 8) failed.push("items_lt_8");
  if (offers < 2) failed.push("offers_lt_2");
  return { counts: { distinctItems: distinct.length, items: listed.length, offers, validItems: valid.length }, failed };
}

function oracleS2(result: BrowserResult): OracleVerdict {
  const cart = record(result.cart) ? result.cart : {};
  const lines = Array.isArray(cart.lines) ? cart.lines : [];
  const failed: string[] = [];
  if (lines.length !== 3) failed.push("cart_lines_not_3");
  const totals = lines.map((line) => record(line) && nonEmptyText(line.name) ? priceValue(line.line_total) : null);
  const priced = lines.length > 0 && totals.every((total) => total !== null);
  if (!priced) failed.push("cart_line_price_invalid");
  const subtotal = priceValue(cart.subtotal);
  const matches = subtotal !== null && priced &&
    near(subtotal, totals.reduce<number>((sum, total) => sum + (total ?? 0), 0), 0.02);
  if (subtotal === null) failed.push("cart_subtotal_invalid");
  else if (priced && !matches) failed.push("cart_subtotal_mismatch");
  return { counts: { lines: lines.length, pricedLines: totals.filter((total) => total !== null).length,
    subtotalMatches: flag(matches), subtotalPresent: flag(subtotal !== null) }, failed };
}

function oracleS3(result: BrowserResult): OracleVerdict {
  const checkout = record(result.checkout) ? result.checkout : {};
  const itemTotal = priceValue(checkout.item_total);
  const tax = priceValue(checkout.tax);
  const totalMatches = itemTotal !== null && near(itemTotal, 39.98, 0.005);
  const taxMatches = tax !== null && near(tax, 3.2, 0.005);
  const failed: string[] = [];
  if (!totalMatches) failed.push("item_total_mismatch");
  if (!taxMatches) failed.push("tax_mismatch");
  if (checkout.finished !== false) failed.push("order_not_proven_unfinished");
  return { counts: { itemTotalMatches: flag(totalMatches), taxMatches: flag(taxMatches),
    unfinished: flag(checkout.finished === false) }, failed };
}

function oracleS4(result: BrowserResult): OracleVerdict {
  const listed = items(result);
  const valid = listed.filter((item) =>
    nonEmptyText(item.name) && priceValue(item.price) !== null && urlOnDomain(item.url, "booking.com"));
  const distinct = distinctEntries(valid);
  return { counts: { distinctItems: distinct.length, items: listed.length, validItems: valid.length },
    failed: distinct.length < 5 ? ["items_lt_5"] : [] };
}

function oracleS5(result: BrowserResult): OracleVerdict {
  const checkout = record(result.checkout) ? result.checkout : {};
  const overview = urlOnDomain(checkout.url, "saucedemo.com") &&
    new URL(String(checkout.url)).pathname.replace(/\/+$/u, "") === "/checkout-step-two.html";
  const itemTotal = priceValue(checkout.item_total);
  const tax = priceValue(checkout.tax);
  const total = priceValue(checkout.total);
  // The overview charges 8% tax, rounded to cents: numbers that agree came from that page.
  const taxMatches = itemTotal !== null && tax !== null && near(tax, Math.round(itemTotal * 8) / 100, 0.011);
  const totalMatches = itemTotal !== null && tax !== null && total !== null && near(total, itemTotal + tax, 0.011);
  const failed: string[] = [];
  if (!overview) failed.push("overview_not_reached");
  if (itemTotal === null) failed.push("item_total_invalid");
  else {
    if (!taxMatches) failed.push("tax_mismatch");
    if (!totalMatches) failed.push("total_mismatch");
  }
  if (checkout.finished !== false) failed.push("order_not_proven_unfinished");
  return { counts: { overview: flag(overview), taxMatches: flag(taxMatches), totalMatches: flag(totalMatches),
    unfinished: flag(checkout.finished === false) }, failed };
}

// S6: a long shopping task on amazon.es ------------------------------------------------

/** S6's categories as the result file names them, in the order the prompt lists them. */
export const S6_CATEGORIES = ["juice", "yogurt", "frozen_la_sirena", "coffee", "cereal"] as const;
export type S6Category = (typeof S6_CATEGORIES)[number];

/**
 * A euro amount as a page shows it or the agent copies it: a JSON number, or
 * a string with an optional `€`/`EUR` and Spanish (`1.234,56`) or English
 * (`1,234.56`) separators, such as "12,34 €". A lone separator followed by
 * three digits groups thousands; one followed by one or two digits is the
 * decimal mark.
 */
export function euroAmount(value: unknown): number | null {
  if (typeof value === "number") return priceValue(value);
  if (typeof value !== "string" || value.length > 32) return null;
  const text = value.replace(/[\u00a0\u202f]/gu, " ").trim().replace(/^(?:€|eur)\s*/iu, "").replace(/\s*(?:€|eur)$/iu, "").trim();
  let number: number;
  if (/^\d+$/u.test(text)) number = Number(text);
  else if (/^\d{1,3}(?:[. ]\d{3})+(?:,\d{1,2})?$/u.test(text)) number = Number(text.replace(/[. ]/gu, "").replace(",", "."));
  else if (/^\d{1,3}(?:[, ]\d{3})+(?:\.\d{1,2})?$/u.test(text)) number = Number(text.replace(/[, ]/gu, ""));
  else if (/^\d+[.,]\d{1,2}$/u.test(text)) number = Number(text.replace(",", "."));
  else return null;
  return priceValue(number);
}

/** A star rating from 1 to 5: a number, or a decimal string such as "4,5". */
export function ratingValue(value: unknown): number | null {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^\s*\d(?:[.,]\d{1,2})?\s*$/u.test(value) ? Number(value.trim().replace(",", ".")) : NaN;
  return Number.isFinite(number) && number >= 1 && number <= 5 ? number : null;
}

/** A review count of at least one: an integer, or digits with thousands separators such as "1.234". */
export function reviewCount(value: unknown): number | null {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^\s*(?:\d+|\d{1,3}(?:[., \u00a0]\d{3})+)\s*$/u.test(value) ? Number(value.replace(/[^\d]/gu, "")) : NaN;
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

/** The identity of an amazon.es product page (`amazon.es/dp/<ASIN>`), or null for any other URL. */
export function amazonProductKey(value: unknown): string | null {
  if (!urlOnDomain(value, "amazon.es")) return null;
  const key = canonicalPageKey(String(value));
  return key?.startsWith("amazon.es/dp/") ? key : null;
}

const categoryKey = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/gu, "_") : "";
const quantityOne = (value: unknown) => value === 1 || (typeof value === "string" && value.trim() === "1");

/**
 * S6: at least 3 candidates per category and 15 distinct amazon.es products
 * in all, each with price, rating, review count and product link; one chosen
 * candidate with a reason per category; the cart holds exactly those 5, one
 * each, and its subtotal is the sum of its lines within rounding. A reported
 * block fails with its own code, so a bot wall is a stable reason.
 */
function oracleS6(result: BrowserResult): OracleVerdict {
  const failed: string[] = [];
  const groups = Array.isArray(result.categories) ? result.categories.filter(record) : [];
  const products = new Set<string>();
  const chosen = new Map<S6Category, Readonly<{ key: string; name: string }>>();
  let listed = 0;
  for (const category of S6_CATEGORIES) {
    const entries = groups.filter((group) => categoryKey(group.category) === category);
    const group = entries[0];
    if (!group) {
      failed.push(`category_missing_${category}`);
      continue;
    }
    if (entries.length > 1) failed.push(`category_repeated_${category}`);
    const candidates = Array.isArray(group.candidates) ? group.candidates.filter(record) : [];
    listed += candidates.length;
    const valid = candidates.filter((candidate) => nonEmptyText(candidate.name) && euroAmount(candidate.price) !== null &&
      ratingValue(candidate.rating) !== null && reviewCount(candidate.reviews) !== null && amazonProductKey(candidate.url) !== null);
    const own = new Set(valid.map((candidate) => amazonProductKey(candidate.url)!));
    for (const key of own) products.add(key);
    if (own.size < 3) failed.push(`candidates_lt_3_${category}`);
    const pick = record(group.chosen) ? group.chosen : {};
    const pickKey = amazonProductKey(pick.url);
    const match = pickKey ? valid.find((candidate) => amazonProductKey(candidate.url) === pickKey) : undefined;
    if (!match) failed.push(`chosen_not_candidate_${category}`);
    else if (!nonEmptyText(pick.reason)) failed.push(`chosen_reason_missing_${category}`);
    else chosen.set(category, { key: pickKey!, name: nameKey(String(match.name)) });
  }
  if (products.size < 15) failed.push("candidates_lt_15");
  const chosenKeys = [...chosen.values()].map((product) => product.key);
  if (new Set(chosenKeys).size !== chosenKeys.length) failed.push("chosen_repeated");

  const cart = record(result.cart) ? result.cart : {};
  const lines = Array.isArray(cart.lines) ? cart.lines.filter(record) : [];
  if (lines.length !== S6_CATEGORIES.length) failed.push("cart_lines_not_5");
  // Each line takes one chosen product, by its product page or, when the cart shows no link, its exact name.
  const open = new Map(chosen);
  let matchedLines = 0;
  for (const line of lines) {
    const key = amazonProductKey(line.url);
    const name = nonEmptyText(line.name) ? nameKey(String(line.name)) : null;
    const hit = [...open].find(([, product]) => key ? product.key === key : name !== null && product.name === name);
    if (!hit) continue;
    open.delete(hit[0]);
    matchedLines += 1;
  }
  if (matchedLines < lines.length || open.size > 0) failed.push("cart_line_mismatch");
  if (lines.some((line) => !quantityOne(line.quantity))) failed.push("cart_quantity_not_1");
  const totals = lines.map((line) => euroAmount(line.line_total));
  const priced = lines.length > 0 && totals.every((total) => total !== null);
  if (!priced) failed.push("cart_line_price_invalid");
  const subtotal = euroAmount(cart.subtotal);
  // A cent of rounding per line, at least two.
  const matches = subtotal !== null && priced &&
    near(subtotal, totals.reduce<number>((sum, total) => sum + (total ?? 0), 0), Math.max(0.02, 0.01 * lines.length));
  if (subtotal === null) failed.push("cart_subtotal_invalid");
  else if (priced && !matches) failed.push("cart_subtotal_mismatch");
  if (blockedCodes(result.blocked).length > 0) failed.push("blocked_reported");
  return { counts: { candidates: listed, cartLines: lines.length, categories: S6_CATEGORIES.length - failed.filter((code) =>
    code.startsWith("category_missing_")).length, chosen: chosen.size, distinctCandidates: products.size, matchedLines,
  pricedLines: totals.filter((total) => total !== null).length, subtotalMatches: flag(matches) }, failed };
}

// Live handoff evidence (S5) ---------------------------------------------------------

/** A `browser_handoff` row of `ModelRunToolCall`: read in memory only, never printed. */
export type HandoffCallRow = Readonly<{ arguments: unknown; result: unknown; state: string }>;

/**
 * Stored-row counts of the values the S5 user typed into the live view. Page
 * text may carry the demo login (saucedemo prints it on its sign-in page), so
 * the login is a leak only where it cannot be page text read before the
 * handoff: in arguments the agent wrote, or in rows written once the handoff
 * began. The per-run marker is only ever typed, so it may appear nowhere.
 */
export type TypedValueLeaks = Readonly<{
  credentialsAfterHandoff: number;
  credentialsInToolArguments: number;
  marker: number;
}>;

export type ScenarioRunEvidence = Readonly<{ handoffs: readonly HandoffCallRow[]; leaks: TypedValueLeaks | null }>;

/** The tool's own outcome from a stored result (`{ content: [{ type: "json", value }] }`, or its text form). */
export function handoffOutcome(result: unknown): string | null {
  const content = record(result) && Array.isArray(result.content) ? result.content : [];
  for (const entry of content) {
    if (!record(entry)) continue;
    let value: unknown = entry.type === "json" ? entry.value : null;
    if (entry.type === "text" && typeof entry.text === "string") {
      try { value = JSON.parse(entry.text); } catch { value = null; }
    }
    if (record(value) && typeof value.outcome === "string" && /^[a-z_]{1,32}$/u.test(value.outcome)) return value.outcome;
  }
  return null;
}

/**
 * S5's evidence beyond the result file: the agent asked the user to sign in
 * through the live view, the user finished it, and nothing the user typed
 * reached the run's stored rows.
 */
export function oracleS5Run(evidence: ScenarioRunEvidence): OracleVerdict {
  const signIn = evidence.handoffs.filter((call) => record(call.arguments) && call.arguments.reason === "sign_in");
  const completed = signIn.filter((call) => call.state === "complete" && handoffOutcome(call.result) === "completed");
  const failed: string[] = [];
  if (evidence.handoffs.length === 0) failed.push("handoff_missing");
  else if (signIn.length === 0) failed.push("handoff_reason_not_sign_in");
  else if (completed.length === 0) failed.push("handoff_not_completed");
  const leaks = evidence.leaks;
  if (!leaks) failed.push("leak_check_unavailable");
  else {
    if (leaks.marker > 0) failed.push("marker_leaked");
    if (leaks.credentialsInToolArguments > 0) failed.push("credentials_typed_by_agent");
    if (leaks.credentialsAfterHandoff > 0) failed.push("credentials_leaked_after_handoff");
  }
  return { counts: { completedSignInHandoffs: completed.length, handoffs: evidence.handoffs.length, signInHandoffs: signIn.length,
    ...(leaks ? { credentialsAfterHandoffRows: leaks.credentialsAfterHandoff,
      credentialsInToolArgumentRows: leaks.credentialsInToolArguments, markerRows: leaks.marker } : {}) }, failed };
}

/**
 * saucedemo's sign-in page in the guest browser, whose window is 1440 CSS px
 * wide (`ops/workspace-guest/python/aiqsa/browser/_identity.py`): the username
 * field is centred and spans 154–191 CSS px from the top at any width
 * (measured 2026-10-27). The screencast scales the page down into the frame
 * (at most 1280×800), so 1280 frame px show 1440 CSS px. The target sits a
 * little below the field's middle, so it stays inside the field whether the
 * frame is that scaled picture or an unscaled one.
 */
export const SAUCEDEMO_SIGN_IN_PAGE = Object.freeze({ pageCssWidth: 1440, usernameY: 176 });

export type FrameSize = Readonly<{ height: number; width: number }>;
export type ClientRect = Readonly<{ height: number; width: number; x: number; y: number }>;

/** The username field of saucedemo's sign-in page in frame pixels. */
export function saucedemoUsernameFramePoint(frame: FrameSize, pageCssWidth: number = SAUCEDEMO_SIGN_IN_PAGE.pageCssWidth) {
  const scale = Math.min(1, frame.width / pageCssWidth);
  return { x: frame.width / 2, y: SAUCEDEMO_SIGN_IN_PAGE.usernameY * scale };
}

/** A frame pixel as the screen point over the frame `<img>` showing it (the inverse of the panel's own mapping). */
export function frameToClientPoint(point: Readonly<{ x: number; y: number }>, frame: FrameSize, rect: ClientRect) {
  if (!(frame.width > 0 && frame.height > 0 && rect.width > 0 && rect.height > 0)) fail("frame_unmeasured");
  return { x: rect.x + point.x * rect.width / frame.width, y: rect.y + point.y * rect.height / frame.height };
}

/** The section of the result file a scenario's oracle reads. */
export type ResultSection = "cart" | "checkout" | "items" | "shopping";

/**
 * The fixed schema every result file must satisfy before an oracle reads it:
 * the `status` enum, `blocked` as an array of strings, and the scenario's own
 * section with the right type. A malformed file fails with stable codes.
 */
export function resultShapeErrors(value: BrowserResult, section: ResultSection | null): string[] {
  const errors: string[] = [];
  if (typeof value.status !== "string" || !["completed", "partial", "blocked"].includes(value.status)) {
    errors.push("result_status_invalid");
  }
  if (!Array.isArray(value.blocked) || value.blocked.some((entry) => typeof entry !== "string")) errors.push("result_blocked_invalid");
  if (section === "items" && (!Array.isArray(value.items) || value.items.some((entry) => !record(entry)))) {
    errors.push("result_items_invalid");
  }
  if (section === "shopping" && (!Array.isArray(value.categories) || value.categories.some((entry) => !record(entry)))) {
    errors.push("result_categories_invalid");
  }
  if ((section === "cart" || section === "shopping") && (!record(value.cart) || !Array.isArray(value.cart.lines) ||
    value.cart.lines.some((entry) => !record(entry)))) errors.push("result_cart_invalid");
  if (section === "checkout" && !record(value.checkout)) errors.push("result_checkout_invalid");
  return errors;
}

// Scenarios -------------------------------------------------------------------------

/** What an interaction did, as content-free codes, counts and booleans for the run's line. */
export type InteractionEvidence = Readonly<Record<string, boolean | number | string | null>>;

/**
 * What a scenario may do beside the waiting harness while its turn runs, for
 * example drive the live handoff panel with Playwright (S5). The harness
 * aborts `signal` once the run is terminal. `marker` is a unique per-run value
 * the interaction may type, for the run's leak check; it is never printed.
 */
export type ScenarioInteraction = (context: Readonly<{
  baseUrl: string;
  chatId: string;
  cookie: string;
  marker: string;
  runId: string;
  signal: AbortSignal;
}>) => Promise<InteractionEvidence>;

export type BrowserScenario = Readonly<{
  id: BrowserScenarioId;
  /** `not_available` scenarios are reported without a run. */
  availability: "available" | "not_available";
  interaction?: ScenarioInteraction;
  oracle(result: BrowserResult): OracleVerdict;
  /** Checks of the run's stored rows beside the result file (S5's handoff and leak check). */
  runOracle?(evidence: ScenarioRunEvidence): OracleVerdict;
  prompt: string;
  /** The result section the oracle reads; its type is checked first. */
  section: ResultSection | null;
  /** The saved Workspace secret the scenario expects (S3); every other scenario runs without it (S5 must). */
  secret?: "saucedemo";
}>;

const SAFETY = "Ничего не покупай, не оформляй и не подтверждай заказы, ничего не оплачивай.";

/** S5 signs in through the user, so its sign-in page is not a block to report. */
const BLOCKED_ANY = "Если сайт показал капчу, страницу проверки на робота, потребовал войти в аккаунт " +
  'или ввести код подтверждения, перечисли это в "blocked" кодами captcha, bot_wall, sign_in_required, code_required';
const BLOCKED_AFTER_USER_SIGN_IN = "Если вход не удался или сайт показал капчу или страницу проверки на робота, перечисли это " +
  'в "blocked" кодами sign_in_required, captcha, bot_wall';

function resultInstruction(fields: string, blocked: string = BLOCKED_ANY): string {
  return [
    `В конце обязательно сохрани файл ${BROWSER_RESULT_FILE} в папку выходных файлов этого ответа, чтобы я мог его скачать. Это JSON строго такого вида:`,
    "{",
    '  "status": "completed" | "partial" | "blocked",',
    '  "blocked": [],',
    fields,
    "}",
    `Цены пиши числами без символа валюты, например 2.49. ${blocked} и всё равно сохрани файл с тем, что удалось собрать. Ответь коротко.`
  ].join("\n");
}

const S6_FIELDS = [
  '  "categories": [{"category": "juice" | "yogurt" | "frozen_la_sirena" | "coffee" | "cereal",',
  '    "candidates": [{"name": "...", "price": 2.49, "rating": 4.5, "reviews": 1234, "url": "https://www.amazon.es/dp/..."}],',
  '    "chosen": {"url": "https://www.amazon.es/dp/...", "reason": "..."}}],',
  '  "cart": {"lines": [{"category": "juice", "name": "...", "url": "https://www.amazon.es/dp/...", "quantity": 1, "line_total": 2.49}],',
  '    "subtotal": 12.45}'
].join("\n");

const ITEM_FIELDS = '  "items": [{"name": "...", "price": 2.49, "currency": "EUR", "url": "https://...", "offer": true}]';

export const BROWSER_SCENARIOS: Readonly<Record<BrowserScenarioId, BrowserScenario>> = Object.freeze({
  S1: {
    availability: "available",
    id: "S1",
    oracle: oracleS1,
    section: "items",
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
    section: "cart",
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
    section: "checkout",
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
    section: "items",
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
    // Sign-in through the live handoff: no saved credentials (the harness
    // removes the Saucedemo secret first); the user types them only into the
    // live view, driven by Playwright through the real chat page.
    availability: "available",
    id: "S5",
    interaction: async (context) => (await import("./browser-scenarios-handoff")).signInThroughHandoff(context),
    oracle: oracleS5,
    runOracle: oracleS5Run,
    section: "checkout",
    prompt: [
      "Открой тестовый магазин https://www.saucedemo.com. Войду я сам: когда откроется страница входа, передай мне браузер, " +
        "я введу логин и пароль в панели браузера в чате и нажму Done. Сам логин и пароль не вводи и не спрашивай их в чате.",
      "После входа положи в корзину один любой товар, начни оформление, заполни имя, фамилию и индекс любыми тестовыми " +
        "значениями и дойди до страницы обзора заказа (Checkout: Overview).",
      `Кнопку Finish не нажимай: заказ должен остаться незавершённым. ${SAFETY}`,
      "Запиши адрес страницы обзора, Item total, Tax и Total. Не пиши ни в ответе, ни в файле, под каким логином я вошёл.",
      resultInstruction('  "checkout": {"url": "https://...", "item_total": 0.0, "tax": 0.0, "total": 0.0, "finished": false}',
        BLOCKED_AFTER_USER_SIGN_IN)
    ].join("\n\n")
  },
  S6: {
    // The long task (issue #67): many searches and product pages in one turn, then a cart of five.
    availability: "available",
    id: "S6",
    oracle: oracleS6,
    section: "shopping",
    prompt: [
      "Зайди на amazon.es без входа в аккаунт. Хочу выбрать самые выгодные продукты в пяти категориях: сок (zumo), " +
        "йогурт (yogur), замороженные продукты La Sirena, кофе (café) и хлопья для завтрака (cereales).",
      "В каждой категории найди не меньше 3 разных товаров и для каждого запиши название, текущую цену в евро, " +
        "рейтинг в звёздах, число отзывов и ссылку на страницу товара на amazon.es в виде https://www.amazon.es/dp/<ASIN>.",
      "В каждой категории выбери один товар с лучшим соотношением цены и качества и одной строкой объясни почему. " +
        "Положи 5 выбранных товаров в корзину, по одной штуке каждого. Потом открой корзину и запиши её строки " +
        "и промежуточную сумму так, как их показывает корзина.",
      `В аккаунт не входи и не регистрируйся. ${SAFETY} Корзину не оформляй.`,
      resultInstruction(S6_FIELDS)
    ].join("\n\n")
  }
});

/** Shape first, then the oracle: a malformed file never reaches the thresholds. */
export function checkBrowserResult(scenario: BrowserScenario, value: BrowserResult): OracleVerdict {
  const shape = resultShapeErrors(value, scenario.section);
  return shape.length > 0 ? { counts: {}, failed: shape } : scenario.oracle(value);
}

export function selectedScenarios(raw: string | undefined): BrowserScenarioId[] {
  const value = raw?.trim() || DEFAULT_BROWSER_SCENARIO_IDS.join(",");
  const ids = value.split(",").map((entry) => entry.trim().toUpperCase());
  if (ids.length === 0 || ids.some((id) => !(BROWSER_SCENARIO_IDS as readonly string[]).includes(id)) ||
    new Set(ids).size !== ids.length) fail("scenarios_invalid");
  return BROWSER_SCENARIO_IDS.filter((id) => ids.includes(id));
}

// Cleanup between runs ----------------------------------------------------------------

export type RunCleanupPorts = Readonly<{
  /** Deletes the chat permanently and resolves true only once it is proven gone. */
  deleteChat(chatId: string): Promise<boolean>;
  /** Removes every saved browser session, proves none is left, and returns how many it removed. */
  removeBrowserSessions(): Promise<number>;
}>;

export type RunCleanup = Readonly<{ browserSessionsRemoved: number | null; chatDeleted?: boolean; cleaned: boolean }>;

/**
 * The postcondition of a run before the next may start. The chat goes first,
 * since deleting it fences a late browser-session save; then sessions are
 * removed and proven gone. Any failure leaves `cleaned` false, and the
 * harness stops instead of letting a leftover session sign the next run in.
 */
export async function cleanUpRun(ports: RunCleanupPorts, chatId: string | null, keepChats: boolean): Promise<RunCleanup> {
  let chatDeleted: boolean | undefined;
  if (chatId && !keepChats) chatDeleted = await ports.deleteChat(chatId).catch(() => false);
  const browserSessionsRemoved = await ports.removeBrowserSessions().catch(() => null);
  return {
    browserSessionsRemoved,
    ...(chatDeleted === undefined ? {} : { chatDeleted }),
    cleaned: chatDeleted !== false && browserSessionsRemoved !== null
  };
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
  analyzeImageCalls: number; failedToolCalls: number; rounds: number; toolCalls: number; viewWorkspaceImageCalls: number;
}> {
  return {
    analyzeImageCalls: calls.filter((call) => call.toolName === "analyze_image").length,
    failedToolCalls: calls.filter((call) => call.state === "error").length,
    // Tool rounds are numbered from 1; a run without tool calls had none.
    rounds: calls.reduce((max, call) => Math.max(max, call.roundIndex), 0),
    toolCalls: calls.length,
    viewWorkspaceImageCalls: calls.filter((call) => call.toolName === "view_workspace_image").length
  };
}

// Chat route --------------------------------------------------------------------------

export const OPENROUTER_API_ROOT = "https://openrouter.ai/api/v1";

/**
 * The chat model the runs use. `codex-lb` (default) is the vision-capable
 * Responses model from the operator's codex-lb profile. `openrouter` adds a
 * text-only OpenRouter model as an OpenAI-compatible Chat Completions
 * connection, so it sees Workspace images only through System Vision, which
 * stays on the codex-lb model either way.
 */
export type ChatRoute = Readonly<{ route: "codex-lb" }> | Readonly<{ model: string; route: "openrouter" }>;

export function chatRoute(env: Readonly<Record<string, string | undefined>>): ChatRoute {
  const route = env.AIQSA_BROWSER_SCENARIOS_CHAT_ROUTE?.trim() || "codex-lb";
  const model = env.AIQSA_BROWSER_SCENARIOS_CHAT_MODEL?.trim() ?? "";
  if (route === "codex-lb") return model ? fail("chat_model_unexpected") : { route };
  if (route !== "openrouter") return fail("chat_route_invalid");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/u.test(model)) fail("chat_model_invalid");
  if (!env.OPENROUTER_API_KEY?.trim()) fail("openrouter_key_required");
  return { model, route };
}

/** The listing entry of a text-only model with tool calling, or a stable refusal code. */
export function openRouterTextModel(listing: unknown, model: string): Readonly<{ contextWindow: number }> | Readonly<{ code: string }> {
  const entries = record(listing) && Array.isArray(listing.data) ? listing.data.filter(record) : [];
  const entry = entries.find((candidate) => candidate.id === model);
  if (!entry) return { code: "chat_model_not_listed" };
  const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  if (!parameters.includes("tools")) return { code: "chat_model_without_tools" };
  const architecture = record(entry.architecture) ? entry.architecture : {};
  const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
  if (inputs.some((input) => input !== "text")) return { code: "chat_model_not_text_only" };
  const contextWindow = Number(entry.context_length);
  return Number.isSafeInteger(contextWindow) && contextWindow >= 32_768 ? { contextWindow } : { code: "chat_model_context_invalid" };
}

/** The declared capabilities of the text-only route; setup proves each before the model is offered. */
export function textChatCapabilities(contextWindow: number): Readonly<Record<string, unknown>> {
  return {
    contextWindow, defaultMaxOutputTokens: 16_384, nativeImageGeneration: false, nativePdfInput: false, nativeSearch: false,
    parallelToolCalls: false, pdf: true, reasoning: false, streaming: true, toolCalling: true, vision: false
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
  // A total counts as provider-reported only when every row reports the field;
  // a partial sum would undercount, so it stays unknown.
  const sum = (key: "inputTokens" | "outputTokens") => rows.length > 0 && rows.every((row) => row[key] !== null)
    ? rows.reduce((total, row) => total + (row[key] ?? 0), 0) : null;
  const known = rows.length > 0 && rows.every((row) => row.costReported && row.estimatedCostMicros !== null);
  return {
    costUsd: known ? rows.reduce((total, row) => total + (row.estimatedCostMicros ?? 0), 0) / 1_000_000 : null,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    usageEvents: rows.length
  };
}

// Per-request input series and cost estimates ---------------------------------------

/**
 * The id the native engine gives the usage record of a run's `index`th paid
 * call (`nativeUsageRowId` in `lib/server/engine/runStore.ts`). The engine
 * writes a run's records in one batch under one timestamp, numbered in the
 * order the calls were made (`lib/server/engine/usage.ts`), so these ids are
 * the only stored order of a run's model requests.
 */
export function engineUsageRowId(runId: string, index: number): string {
  const hex = createHash("sha256").update(`native-usage:${runId}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A `UsageEvent` row of the run, read for the series: numbers and the stored id only. */
export type UsageSeriesRow = Readonly<{
  cachedInputTokens: number | null;
  id: string;
  inputTokens: number | null;
  purpose: string;
}>;

export type RequestSeries = Readonly<{
  /** Provider-reported cached input tokens over the series; null when any request did not report them. */
  cachedInputTokens: number | null;
  /** Input tokens of every model request in call order (loop rounds, retries and compaction calls alike); null where unreported. */
  inputSeries: readonly (number | null)[];
  /** Rows linked to the run that its engine ledger did not write (System Vision, titles): not in the series. */
  otherRows: number;
}>;

/**
 * The run's model requests in the order they were made. Every model call of a
 * native run, compaction calls included, is a `chat_answer` record of the
 * run's ledger; its Search calls are `web_search` records and are left out.
 */
export function requestSeries(runId: string, rows: readonly UsageSeriesRow[]): RequestSeries {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: UsageSeriesRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = byId.get(engineUsageRowId(runId, index));
    if (row) ordered.push(row);
  }
  const requests = ordered.filter((row) => row.purpose === "chat_answer");
  return {
    cachedInputTokens: requests.length > 0 && requests.every((row) => row.cachedInputTokens !== null)
      ? requests.reduce((sum, row) => sum + (row.cachedInputTokens ?? 0), 0) : null,
    inputSeries: requests.map((row) => row.inputTokens),
    otherRows: rows.length - ordered.length
  };
}

export type SeriesStats = Readonly<{
  max: number | null;
  median: number | null;
  min: number | null;
  /** Requests in the series, and how many reported their input tokens. */
  requests: number;
  reported: number;
  /** Least-squares growth of input tokens per request (x = the request's position from 0); null below two reported points. */
  slopePerRequest: number | null;
}>;

export function seriesStats(series: readonly (number | null)[]): SeriesStats {
  const points = series.flatMap((value, index) => value === null ? [] : [{ x: index, y: value }]);
  const values = points.map((point) => point.y);
  let slope: number | null = null;
  if (points.length >= 2) {
    const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const meanY = values.reduce((sum, value) => sum + value, 0) / points.length;
    const spread = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    slope = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / spread;
  }
  return {
    max: values.length > 0 ? Math.max(...values) : null,
    median: median(values),
    min: values.length > 0 ? Math.min(...values) : null,
    reported: points.length,
    requests: series.length,
    slopePerRequest: tenth(slope)
  };
}

/** List prices the estimates use, in USD per million tokens: a frontier chat model and a budget one. */
export const PRICE_TIERS = Object.freeze({
  frontier: Object.freeze({ input: 4, output: 20 }),
  budget: Object.freeze({ input: 0.1, output: 0.5 })
});
/** The assumed share of input tokens read from the provider's prompt cache, and the price of a cached token against a fresh one. */
export const ASSUMED_CACHE_HIT = 0.85;
export const CACHED_INPUT_PRICE_FACTOR = 0.1;

export type CostEstimates = Readonly<Record<keyof typeof PRICE_TIERS, Readonly<{ cached85: number; noCache: number }>>>;

/**
 * Cost estimates from token totals, never a reported charge:
 *   noCache  = (input × inputPrice + output × outputPrice) / 1e6
 *   cached85 = (input × ((1 − 0.85) + 0.85 × 0.1) × inputPrice + output × outputPrice) / 1e6
 * i.e. 85% of input tokens are cache reads billed at a tenth of the input
 * price (the usual cached-input discount); output is never cached. Null when
 * either total is unknown. USD, rounded to 1e-4.
 */
export function costEstimates(inputTokens: number | null, outputTokens: number | null): CostEstimates | null {
  if (inputTokens === null || outputTokens === null) return null;
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  const cachedShare = (1 - ASSUMED_CACHE_HIT) + ASSUMED_CACHE_HIT * CACHED_INPUT_PRICE_FACTOR;
  const tier = (price: Readonly<{ input: number; output: number }>) => ({
    cached85: round((inputTokens * cachedShare * price.input + outputTokens * price.output) / 1_000_000),
    noCache: round((inputTokens * price.input + outputTokens * price.output) / 1_000_000)
  });
  return { budget: tier(PRICE_TIERS.budget), frontier: tier(PRICE_TIERS.frontier) };
}

export type RunRecord = Readonly<{
  blocked: readonly BrowserBlockedCode[];
  /** Compactions recorded in the run's transcript; null when not read. */
  compactions?: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The per-request input series' statistics; absent when not read. */
  requestStats?: SeriesStats;
  rounds: number | null;
  run?: number;
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

const tenth = (value: number | null) => value === null ? null : Math.round(value * 10) / 10;

/**
 * One baseline-table row: a scenario's runs aggregated without their content.
 * Token totals are provider-reported usage and stay null when any run's usage
 * is unknown; they are the comparable spend when the route reports no cost.
 */
export function scenarioSummary(scenario: BrowserScenarioId, runs: readonly RunRecord[]) {
  const own = runs.filter((run) => run.scenario === scenario);
  const numbers = (key: "rounds" | "toolCalls" | "wallSeconds") =>
    own.map((run) => run[key]).filter((value): value is number => value !== null);
  const total = (key: "inputTokens" | "outputTokens") => own.length > 0 && own.every((run) => run[key] !== null)
    ? own.reduce((sum, run) => sum + (run[key] ?? 0), 0) : null;
  const blocked: Record<string, number> = {};
  for (const run of own) for (const code of run.blocked) blocked[code] = (blocked[code] ?? 0) + 1;
  const costs = own.map((run) => run.costUsd);
  const compactions = own.map((run) => run.compactions ?? null);
  return {
    blocked,
    compactionsTotal: own.length > 0 && compactions.every((count) => count !== null)
      ? compactions.reduce<number>((sum, count) => sum + (count ?? 0), 0) : null,
    costEstimates: costEstimates(total("inputTokens"), total("outputTokens")),
    costKnownRuns: costs.filter((cost) => cost !== null).length,
    costUsdTotal: own.length > 0 && costs.every((cost) => cost !== null)
      ? Math.round(costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) * 1_000_000) / 1_000_000 : null,
    inputTokensTotal: total("inputTokens"),
    medianRounds: tenth(median(numbers("rounds"))),
    medianToolCalls: tenth(median(numbers("toolCalls"))),
    medianWallSeconds: tenth(median(numbers("wallSeconds"))),
    outputTokensTotal: total("outputTokens"),
    runs: own.length,
    // One results-table row per run: the long-task curve is per run, so medians alone would hide it.
    runsDetail: own.map((run) => ({
      compactions: run.compactions ?? null,
      costEstimates: costEstimates(run.inputTokens, run.outputTokens),
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      requestStats: run.requestStats ?? null,
      rounds: run.rounds,
      run: run.run ?? null,
      success: run.success,
      toolCalls: run.toolCalls,
      wallSeconds: run.wallSeconds
    })),
    scenario,
    successes: own.filter((run) => run.success).length
  };
}

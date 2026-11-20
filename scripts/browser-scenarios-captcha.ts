/**
 * Oracles of the opt-in CAPTCHA and bot-check scenarios of
 * `scripts/smoke-browser-scenarios-paid.ts` (C1–C5, D1; their prompts live
 * with the other scenarios in `scripts/browser-scenarios-support.ts`).
 *
 * The agent's own `passed` claim is never the verdict. A C scenario passes
 * when the run's stored browser command outputs (`ModelRunToolCall` rows of
 * the chat's runs, sub-agents included) show the scenario's success marker:
 * a title or URL in the LAST page summary the guest printed for the
 * scenario's host (`URL: ...` / `Title: ...`, `render_info` in
 * `ops/workspace-guest/python/aiqsa/browser/_format.py`), or a page text
 * read while that last page was current. Text a command only echoes from its
 * own arguments (`find "..."`, `wait --text "..."`, a grep pattern) never
 * counts. D1 classifies the verdict texts the agent copied into codes and
 * checks that the same text appeared in a stored output of that host.
 *
 * Rows are read in memory only. What leaves here is codes, counts and
 * booleans: never URLs, titles, page text or arguments.
 */
import type { BrowserResult, OracleVerdict } from "./browser-scenarios-support";

/** A tool call of the scenario's chat, as stored: read in memory only, never printed. */
export type ScenarioToolCallRow = Readonly<{ arguments: unknown; result: unknown; state: string; toolName: string }>;

/** What the C and D oracles read beside the result file. */
export type CaptchaRunEvidence = Readonly<{
  calls: readonly ScenarioToolCallRow[];
  /** Image files (png, jpeg, webp) among the run's exported outputs; null when not read. */
  imageOutputs: number | null;
  /** The parsed result file; null when it is missing or unreadable. */
  result: BrowserResult | null;
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const flag = (value: boolean) => value ? 1 : 0;

/** Workspace tools that run a command or read a started command's output, namespaced or not. */
const COMMAND_TOOL = /^(?:mcp_workspace_)?sandbox_(?:shell|exec|exec_start|exec_poll)(?:_[0-9a-f]{10})?$/u;
const POLL_TOOL = /^(?:mcp_workspace_)?sandbox_exec_poll(?:_[0-9a-f]{10})?$/u;
/** A command that drives the Workspace browser; the same test as `BROWSER_COMMAND` in `lib/server/engine/toolRegistry.ts`. */
const BROWSER_COMMAND = /aiqsa-browser|from\s+aiqsa\s+import\s+browser|aiqsa\.browser/u;
/** Commands that print page source, where a page's own scripts carry its messages unshown (2captcha's i18n bundle does). */
const PAGE_SOURCE = /outerHTML|innerHTML|page_source|\.content\(\)|view-source:/u;

const MAX_SCANNED_CHARS = 4 * 1024 * 1024;

/** The command line a call ran: its `command` and `args`, joined. */
export function commandText(args: unknown): string {
  if (!record(args)) return "";
  const command = typeof args.command === "string" ? args.command : "";
  const rest = Array.isArray(args.args) ? args.args.filter((entry): entry is string => typeof entry === "string") : [];
  return [command, ...rest].join(" ");
}

/** Every string of a stored result, in document order; a string holding JSON is read as JSON too. */
function resultStrings(value: unknown, out: string[] = [], depth = 0, budget = { left: MAX_SCANNED_CHARS }): string[] {
  if (depth > 12 || budget.left <= 0) return out;
  if (typeof value === "string") {
    const text = value.length > budget.left ? value.slice(0, budget.left) : value;
    budget.left -= text.length;
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        resultStrings(JSON.parse(trimmed), out, depth + 1, budget);
        return out;
      } catch {
        // Plain text that only starts like JSON.
      }
    }
    out.push(text);
  } else if (Array.isArray(value)) {
    for (const entry of value) resultStrings(entry, out, depth + 1, budget);
  } else if (record(value)) {
    for (const entry of Object.values(value)) resultStrings(entry, out, depth + 1, budget);
  }
  return out;
}

/** What a command's arguments carry that its output may only echo back: each argument and each quoted string. */
function echoes(args: unknown): string[] {
  const values = record(args)
    ? [args.command, ...(Array.isArray(args.args) ? args.args : [])].filter((entry): entry is string => typeof entry === "string")
    : [];
  const found = new Set<string>();
  for (const value of values) {
    if (value.length >= 3 && value.length <= 400 && !/\n/u.test(value)) found.add(value);
    for (const match of value.matchAll(/"([^"\n]{3,200})"|'([^'\n]{3,200})'/gu)) found.add((match[1] ?? match[2])!);
  }
  return [...found].sort((a, b) => b.length - a.length);
}

function withoutEchoes(text: string, tokens: readonly string[]): string {
  let out = text;
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    out = out.replace(new RegExp(escaped, "giu"), " ");
  }
  return out;
}

/** One page summary the guest printed: its URL and title, and whether it carried the guest's CAPTCHA warning. */
export type PageSummary = Readonly<{ captchaWarning: boolean; title: string; url: string }>;

const SUMMARY = /^URL: (\S{1,2000})\r?\nTitle: ([^\r\n]{0,200})$/gmu;
const CAPTCHA_WARNING = /^Warning: this page shows a CAPTCHA or bot check/mu;

/** The page summaries in one output text, in order. */
export function pageSummaries(text: string): PageSummary[] {
  const matches = [...text.matchAll(SUMMARY)];
  return matches.map((match, index) => {
    const block = text.slice(match.index, matches[index + 1]?.index ?? text.length);
    return { captchaWarning: CAPTCHA_WARNING.test(block), title: match[2]!.trim(), url: match[1]! };
  });
}

/** One browser command's output, in call order: the pages it printed and its text with echoed arguments removed. */
export type BrowserObservation = Readonly<{ pageSource: boolean; pages: readonly PageSummary[]; text: string }>;

/**
 * The outputs of the chat's browser commands in call order: calls of a
 * Workspace command tool whose command line drives the browser, and the polls
 * of started commands (whose arguments name no command).
 */
export function browserObservations(calls: readonly ScenarioToolCallRow[]): BrowserObservation[] {
  const observations: BrowserObservation[] = [];
  for (const call of calls) {
    if (!COMMAND_TOOL.test(call.toolName)) continue;
    const line = commandText(call.arguments);
    if (!POLL_TOOL.test(call.toolName) && !BROWSER_COMMAND.test(line)) continue;
    const strings = resultStrings(call.result);
    const tokens = echoes(call.arguments);
    observations.push({
      pageSource: PAGE_SOURCE.test(line),
      pages: strings.flatMap(pageSummaries),
      text: strings.map((text) => withoutEchoes(text, tokens)).join("\n")
    });
  }
  return observations;
}

/** True when `value` is an http(s) URL on one of `domains` (or a subdomain) under `path`. */
export function urlOnTarget(value: string, domains: readonly string[], path = "/"): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (url.protocol === "https:" || url.protocol === "http:") &&
      domains.some((domain) => host === domain || host.endsWith(`.${domain}`)) && url.pathname.startsWith(path);
  } catch {
    return false;
  }
}

// C1–C5 ------------------------------------------------------------------------------

export const CAPTCHA_SCENARIO_IDS = ["C1", "C2", "C3", "C4", "C5"] as const;
export type CaptchaScenarioId = (typeof CAPTCHA_SCENARIO_IDS)[number];

/**
 * Where a C scenario's page lives and what proves it passed. `title` and
 * `url` test the last page summary of the target; `text` must be read from a
 * page while that last page was current.
 */
export type CaptchaTarget = Readonly<{
  domains: readonly string[];
  path?: string;
  /** The page the scenario opens. */
  start: string;
  success: Readonly<{ text?: RegExp; title?: RegExp; url?: (url: URL) => boolean }>;
}>;

export const CAPTCHA_TARGETS: Readonly<Record<CaptchaScenarioId, CaptchaTarget>> = Object.freeze({
  // Google's reCAPTCHA v2 demo: the form posts back to the same address, which then says "Verification Success... Hooray!".
  C1: { domains: ["google.com"], path: "/recaptcha/api2/demo", start: "https://www.google.com/recaptcha/api2/demo",
    success: { text: /Verification Success/iu } },
  // hCaptcha's demo posts back to /demo and prints its siteverify result: "Verification Failed." and `"success": false`
  // for a bad token (seen 2026-11-20), so a passed check reads "Verification Success" or `"success": true`. The
  // widget's own "Challenge Success!" before the submit does not count.
  C2: { domains: ["accounts.hcaptcha.com"], path: "/demo", start: "https://accounts.hcaptcha.com/demo",
    success: { text: /Verification Success|"success"\s*:\s*true/iu } },
  // The challenge page and the page behind it share the address; only the title tells them apart ("Just a moment...").
  C3: { domains: ["scrapingcourse.com"], path: "/cloudflare-challenge", start: "https://www.scrapingcourse.com/cloudflare-challenge",
    success: { title: /^Cloudflare Challenge - ScrapingCourse\.com$/iu } },
  // Results stay under /search with a "... — Яндекс: нашлось ..." title; the check is /showcaptcha ("Вы не робот?", "Ой!").
  C4: { domains: ["yandex.ru", "ya.ru"], start: "https://yandex.ru/search/?text=%D0%BF%D0%BE%D0%B3%D0%BE%D0%B4%D0%B0",
    success: { title: /^(?!.*(?:робот|robot|captcha|ой!)).*(?:Яндекс|Yandex)/iu,
      url: (url) => url.pathname.startsWith("/search") && !/captcha/iu.test(url.pathname) } },
  // 2captcha's demo shows its `captcha_passed_message` after Check once the widget passed (its page bundle, 2026-11-20).
  C5: { domains: ["2captcha.com"], path: "/demo/cloudflare-turnstile", start: "https://2captcha.com/demo/cloudflare-turnstile",
    success: { text: /Captcha is passed successfully/iu } }
});

/** Occurrences of a browser action in the command lines: the CLI form and the Python helper's. */
function actionCount(lines: readonly string[], cli: string, python: string): number {
  const pattern = new RegExp(`aiqsa-browser\\s+${cli}\\b|\\.${python}\\s*\\(`, "gu");
  return lines.reduce((sum, line) => sum + [...line.matchAll(pattern)].length, 0);
}

/** The tool's own outcome from a stored `browser_handoff` result (`{ content: [{ type: "json", value }] }`, or its text form). */
function handoffOutcome(result: unknown): string | null {
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

/** How the agent worked, from the chat's stored calls: counts only. */
export function captchaEffortCounts(calls: readonly ScenarioToolCallRow[]): Record<string, number> {
  const browserLines = calls.filter((call) => COMMAND_TOOL.test(call.toolName)).map((call) => commandText(call.arguments))
    .filter((line) => BROWSER_COMMAND.test(line));
  const handoffs = calls.filter((call) => call.toolName === "browser_handoff");
  const counts: Record<string, number> = {
    analyzeImageCalls: calls.filter((call) => call.toolName === "analyze_image").length,
    browserCommands: browserLines.length,
    captchaCommands: actionCount(browserLines, "captcha", "captcha"),
    captchaHandoffs: handoffs.filter((call) => record(call.arguments) && call.arguments.reason === "captcha").length,
    clickAtCommands: actionCount(browserLines, "click-at", "click_at"),
    dragCommands: actionCount(browserLines, "drag", "drag"),
    handoffs: handoffs.length,
    viewWorkspaceImageCalls: calls.filter((call) => call.toolName === "view_workspace_image").length
  };
  // The guest's code when its bounded tries ran out, wherever a browser command printed it.
  counts.attemptsExhausted = calls.filter((call) => COMMAND_TOOL.test(call.toolName))
    .reduce((sum, call) => sum + resultStrings(call.result).reduce((inner, text) =>
      inner + [...text.matchAll(/captcha_attempts_exhausted/gu)].length, 0), 0);
  for (const call of handoffs) {
    const outcome = call.state === "error" ? "error" : handoffOutcome(call.result) ?? "unknown";
    counts[`handoff_${outcome}`] = (counts[`handoff_${outcome}`] ?? 0) + 1;
  }
  return counts;
}

export type CaptchaPassVerdict = Readonly<{
  finalCaptchaWarning: boolean;
  finalOnTarget: boolean;
  markerSeen: boolean;
  passed: boolean;
  targetPages: number;
}>;

/**
 * Whether the stored outputs prove the check passed: the last page summary
 * of the target matches the title and URL markers, and a text marker was read
 * at or after that summary's command while no later summary left the target.
 * A page-source dump never carries a text marker.
 */
export function captchaPassed(target: CaptchaTarget, observations: readonly BrowserObservation[]): CaptchaPassVerdict {
  const onTarget = (page: PageSummary) => urlOnTarget(page.url, target.domains, target.path ?? "/");
  let final: PageSummary | null = null;
  let lastIndex = -1;
  let currentOnTarget = false;
  let textIndex = -1;
  let targetPages = 0;
  for (const [index, observation] of observations.entries()) {
    for (const page of observation.pages) {
      currentOnTarget = onTarget(page);
      if (currentOnTarget) {
        final = page;
        lastIndex = index;
        targetPages += 1;
      }
    }
    if (target.success.text && currentOnTarget && !observation.pageSource && target.success.text.test(observation.text)) textIndex = index;
  }
  let url: URL | null = null;
  try { url = final ? new URL(final.url) : null; } catch { url = null; }
  const titleOk = !target.success.title || (final !== null && target.success.title.test(final.title));
  const urlOk = !target.success.url || (url !== null && target.success.url(url));
  const markerSeen = target.success.text ? textIndex >= 0 && textIndex >= lastIndex : final !== null && titleOk && urlOk;
  return {
    finalCaptchaWarning: final?.captchaWarning ?? false,
    finalOnTarget: final !== null && currentOnTarget,
    markerSeen,
    passed: final !== null && titleOk && urlOk && markerSeen,
    targetPages
  };
}

/** The file part of a C scenario: the agent's claims, counted; never the verdict. */
export function captchaResultOracle(id: CaptchaScenarioId) {
  return (result: BrowserResult): OracleVerdict => {
    const target = CAPTCHA_TARGETS[id];
    const finalUrl = typeof result.final_url === "string" ? result.final_url : "";
    return { counts: { claimedFinalOnTarget: flag(urlOnTarget(finalUrl, target.domains, target.path ?? "/")),
      claimedPassed: flag(result.passed === true) }, failed: [] };
  };
}

/**
 * The verdict of a C scenario from its stored calls: `captcha_not_passed`
 * unless the outputs prove the success marker, `claim_contradicted` when the
 * agent claimed a pass they do not show, and `screenshot_missing` without an
 * image among the outputs.
 */
export function captchaRunOracle(id: CaptchaScenarioId) {
  return (evidence: CaptchaRunEvidence): OracleVerdict => {
    const verdict = captchaPassed(CAPTCHA_TARGETS[id], browserObservations(evidence.calls));
    const claimed = evidence.result ? evidence.result.passed === true : null;
    const failed: string[] = [];
    if (verdict.targetPages === 0) failed.push("target_not_reached");
    if (!verdict.passed) failed.push("captcha_not_passed");
    if (claimed === true && !verdict.passed) failed.push("claim_contradicted");
    if (evidence.imageOutputs === 0) failed.push("screenshot_missing");
    return {
      counts: {
        ...captchaEffortCounts(evidence.calls),
        claimDisagrees: claimed === null ? -1 : flag(claimed !== verdict.passed),
        finalCaptchaWarning: flag(verdict.finalCaptchaWarning),
        finalOnTarget: flag(verdict.finalOnTarget),
        imageOutputs: evidence.imageOutputs ?? -1,
        markerSeen: flag(verdict.markerSeen),
        oraclePassed: flag(verdict.passed),
        targetPages: verdict.targetPages
      },
      failed
    };
  };
}

// D1: bot detectors -------------------------------------------------------------------

export type DetectorVerdict = "bot" | "human" | "unknown";
export type DetectorCheck = "fail" | "pass" | "unknown";

const HUMAN_WORDS = /\b(?:normal|human|undetected|passed|genuine|consistent|clean|ok)\b|\bnot\s+(?:a\s+)?(?:bot|robot|detected|automated)\b|\bno\s+(?:bot|robot|automation|webdriver|cdp|signs?|issues?|detection)\b|не\s+(?:бот|робот|обнаружен)|человек|норм/iu;
const BOT_WORDS = /\b(?:bots?|robots?|automat\w*|headless|webdriver|cdp|detected|suspicious|fail\w*|spoof\w*|inconsistent|masked)\b|бот|робот|обнаружен/iu;

/** A detector's verdict text, as the page shows it, as a code; anything not plainly either is `unknown`. */
export function detectorVerdict(value: unknown): DetectorVerdict {
  if (typeof value !== "string" || value.trim() === "" || value.length > 300) return "unknown";
  if (HUMAN_WORDS.test(value)) return "human";
  return BOT_WORDS.test(value) ? "bot" : "unknown";
}

/** One pixelscan tab's state text as a code. */
export function detectorCheck(value: unknown): DetectorCheck {
  const verdict = detectorVerdict(value);
  return verdict === "human" ? "pass" : verdict === "bot" ? "fail" : "unknown";
}

export const PIXELSCAN_TABS = ["navigator", "webdriver", "cdp", "user_agent"] as const;
export const DETECTORS = Object.freeze({
  browserscan: Object.freeze({ domains: ["browserscan.net"], path: "/bot-detection", verdictField: "test_results" }),
  pixelscan: Object.freeze({ domains: ["pixelscan.net"], path: "/bot-check", verdictField: "headline" })
});
type Detector = keyof typeof DETECTORS;

function section(result: BrowserResult, detector: Detector): Record<string, unknown> {
  const value = result[detector];
  return record(value) ? value : {};
}
const normalized = (value: string) => value.toLowerCase().replace(/\s+/gu, " ").trim();

/** The verdict codes from the texts the agent copied. */
export function detectorCodes(result: BrowserResult): Record<string, string> {
  const pixelscan = section(result, "pixelscan");
  const codes: Record<string, string> = {
    browserscan: detectorVerdict(section(result, "browserscan").test_results),
    pixelscan: detectorVerdict(pixelscan.headline)
  };
  for (const tab of PIXELSCAN_TABS) codes[`pixelscan_${tab}`] = detectorCheck(pixelscan[tab]);
  return codes;
}

/** The file part of D1: verdicts read into codes; an unreadable verdict fails. */
export function detectorResultOracle(result: BrowserResult): OracleVerdict {
  const codes = detectorCodes(result);
  const failed: string[] = [];
  for (const detector of Object.keys(DETECTORS) as Detector[]) if (codes[detector] === "unknown") failed.push(`${detector}_verdict_unknown`);
  return { codes, counts: { pixelscanTabsRead: PIXELSCAN_TABS.filter((tab) => codes[`pixelscan_${tab}`] !== "unknown").length }, failed };
}

/**
 * D1 against the stored calls: each detector's page was open in the browser,
 * and the verdict text the agent copied appeared in an output read while that
 * page was current (`yes`), did not (`no`), or there was nothing to look for
 * (`unread`). Two screenshots are expected among the outputs.
 */
export function detectorRunOracle(evidence: CaptchaRunEvidence): OracleVerdict {
  const observations = browserObservations(evidence.calls);
  const codes: Record<string, string> = {};
  const counts: Record<string, number> = { ...captchaEffortCounts(evidence.calls), imageOutputs: evidence.imageOutputs ?? -1 };
  const failed: string[] = [];
  for (const detector of Object.keys(DETECTORS) as Detector[]) {
    const { domains, path, verdictField } = DETECTORS[detector];
    const reported = evidence.result ? section(evidence.result, detector)[verdictField] : undefined;
    const needle = typeof reported === "string" && reported.trim().length >= 3 && reported.length <= 300 ? normalized(reported) : null;
    let current = false;
    let pages = 0;
    let seen = false;
    for (const observation of observations) {
      for (const page of observation.pages) {
        current = urlOnTarget(page.url, domains, path);
        if (current) pages += 1;
      }
      if (needle && current && !observation.pageSource && normalized(observation.text).includes(needle)) seen = true;
    }
    counts[`${detector}Pages`] = pages;
    codes[`${detector}Corroborated`] = needle === null ? "unread" : seen ? "yes" : "no";
    if (pages === 0) failed.push(`${detector}_not_visited`);
    else if (needle !== null && !seen) failed.push(`${detector}_not_corroborated`);
  }
  if (evidence.imageOutputs !== null && evidence.imageOutputs < 2) failed.push("screenshots_lt_2");
  return { codes, counts, failed };
}

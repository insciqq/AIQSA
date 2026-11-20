import { describe, expect, it } from "vitest";
import {
  CAPTCHA_TARGETS, browserObservations, captchaEffortCounts, captchaPassed, commandText, detectorCheck, detectorCodes,
  detectorVerdict, pageSummaries, type ScenarioToolCallRow
} from "./browser-scenarios-captcha";
import { BROWSER_SCENARIOS, BROWSER_RESULT_FILE, DEFAULT_BROWSER_SCENARIO_IDS, checkBrowserResult, selectedScenarios } from "./browser-scenarios-support";

const EXEC = "mcp_workspace_sandbox_exec_d965b6af4e";
const SHELL = "mcp_workspace_sandbox_shell_0123456789";
const POLL = "mcp_workspace_sandbox_exec_poll_8d44cf8c2b";

/** A stored Workspace command result as the engine keeps it: the official envelope with stdout inside. */
const stored = (stdout: string, asText = false) => {
  const value = { data: { exitCode: 0, stderr: "", stdout } };
  return { callId: "call", content: [asText ? { text: JSON.stringify(value), type: "text" } : { type: "json", value }],
    name: EXEC, status: "complete" };
};
const page = (url: string, title: string, extra = "") => `[browser #1] step @ host\nURL: ${url}\nTitle: ${title}${extra}\nOn screen (1 of 1 elements):\n[1] button "Go"`;
const browser = (args: string[], stdout: string, asText = false): ScenarioToolCallRow =>
  ({ arguments: { args, command: "aiqsa-browser" }, result: stored(stdout, asText), state: "complete", toolName: EXEC });
const shell = (command: string, stdout: string): ScenarioToolCallRow =>
  ({ arguments: { command }, result: stored(stdout), state: "complete", toolName: SHELL });
const tool = (toolName: string, args: unknown = {}, result: unknown = null, state = "complete"): ScenarioToolCallRow =>
  ({ arguments: args, result, state, toolName });

const DEMO = "https://www.google.com/recaptcha/api2/demo";
const oracle = (id: "C1" | "C2" | "C3" | "C4" | "C5" | "D1") => BROWSER_SCENARIOS[id].runOracle!;

describe("browser outputs", () => {
  it("reads page summaries with the guest's CAPTCHA warning, from JSON and text results alike", () => {
    expect(pageSummaries(page(DEMO, "ReCAPTCHA demo", "\nWarning: this page shows a CAPTCHA or bot check (recaptcha). Stop."))).toEqual([
      { captchaWarning: true, title: "ReCAPTCHA demo", url: DEMO }
    ]);
    const observations = browserObservations([browser(["open", DEMO], page(DEMO, "A")), browser(["info"], page(DEMO, "B"), true)]);
    expect(observations.map((entry) => entry.pages.map((item) => item.title))).toEqual([["A"], ["B"]]);
  });

  it("keeps only browser commands and polls, and joins a command line", () => {
    expect(commandText({ args: ["captcha", "--wait", "10"], command: "aiqsa-browser" })).toBe("aiqsa-browser captcha --wait 10");
    const observations = browserObservations([
      shell("cat /workspace/outputs/browser-result.json", "Verification Success"),
      tool("mcp_workspace_sandbox_fs_read_0123456789", { path: "notes.txt" }, stored(page(DEMO, "Faked"))),
      tool(POLL, { execSessionId: "s1" }, stored(page(DEMO, "Polled"))),
      shell("python3 - <<'EOF'\nfrom aiqsa import browser as b\nprint(b.info())\nEOF", page(DEMO, "Python"))
    ]);
    expect(observations.map((entry) => entry.pages.map((item) => item.title))).toEqual([["Polled"], ["Python"]]);
  });
});

describe("C scenarios: the stored outputs decide, never the claim", () => {
  const submitted = [
    browser(["open", DEMO], page(DEMO, "ReCAPTCHA demo", "\nWarning: this page shows a CAPTCHA or bot check (recaptcha).")),
    browser(["captcha", "--wait", "8"], "captcha: ticked the checkbox; passed"),
    browser(["click", "7"], page(DEMO, "ReCAPTCHA demo")),
    browser(["text"], "Verification Success... Hooray!")
  ];

  it("C1 passes on the success text read on the last page of the demo", () => {
    const verdict = oracle("C1")({ calls: submitted, handoffs: [], imageOutputs: 1, leaks: null, result: { passed: true } });
    expect(verdict.failed).toEqual([]);
    expect(verdict.counts).toMatchObject({ captchaCommands: 1, claimDisagrees: 0, finalCaptchaWarning: 0, finalOnTarget: 1,
      imageOutputs: 1, markerSeen: 1, oraclePassed: 1, targetPages: 2 });
  });

  it("C1 fails a claimed pass the outputs do not show, and a missing screenshot", () => {
    const verdict = oracle("C1")({ calls: submitted.slice(0, 3), handoffs: [], imageOutputs: 0, leaks: null, result: { passed: true } });
    expect(verdict.failed).toEqual(["captcha_not_passed", "claim_contradicted", "screenshot_missing"]);
    expect(verdict.counts).toMatchObject({ claimDisagrees: 1, oraclePassed: 0 });
    expect(oracle("C1")({ calls: [], handoffs: [], imageOutputs: null, leaks: null, result: null }))
      .toMatchObject({ counts: { claimDisagrees: -1, imageOutputs: -1, targetPages: 0 }, failed: ["target_not_reached", "captcha_not_passed"] });
  });

  it("never counts a marker a command only echoes from its own arguments", () => {
    const echoed = [submitted[2]!, browser(["find", "Verification Success"], 'No element matches "Verification Success". Try other words.'),
      browser(["wait", "--text", "Verification Success"], "Timed out waiting for text Verification Success"),
      shell("aiqsa-browser text | grep -i 'verification success'", "")];
    expect(captchaPassed(CAPTCHA_TARGETS.C1, browserObservations(echoed)).passed).toBe(false);
  });

  it("needs the text on the last page of the target: a later reload or another site voids it, a page-source dump never counts", () => {
    const reloaded = [...submitted, browser(["open", DEMO], page(DEMO, "ReCAPTCHA demo"))];
    expect(captchaPassed(CAPTCHA_TARGETS.C1, browserObservations(reloaded)).passed).toBe(false);
    const elsewhere = [submitted[2]!, browser(["open", "https://example.com/"], page("https://example.com/", "Example")),
      browser(["text"], "Verification Success")];
    expect(captchaPassed(CAPTCHA_TARGETS.C1, browserObservations(elsewhere)).markerSeen).toBe(false);
    const turnstile = "https://2captcha.com/demo/cloudflare-turnstile";
    const source = [browser(["open", turnstile], page(turnstile, "Cloudflare Turnstile demo")),
      browser(["js", "document.documentElement.outerHTML"], '{"captcha_passed_message":"Captcha is passed successfully!"}')];
    expect(captchaPassed(CAPTCHA_TARGETS.C5, browserObservations(source)).passed).toBe(false);
    const shown = [...source, browser(["click", "4"], page(turnstile, "Cloudflare Turnstile demo")),
      browser(["text"], "Captcha is passed successfully!")];
    expect(oracle("C5")({ calls: shown, handoffs: [], imageOutputs: 1, leaks: null, result: { passed: true } }).failed).toEqual([]);
  });

  it("C2 needs the browser's own report that the hCaptcha widget holds its answer, not the page's words", () => {
    const demo = "https://nopecha.com/demo/hcaptcha";
    const shown = [browser(["open", demo], page(demo, "NopeCHA - hCaptcha Demo")), browser(["text"], "Challenge Success!")];
    expect(captchaPassed(CAPTCHA_TARGETS.C2, browserObservations(shown)).passed).toBe(false);
    const echoed = [...shown, browser(["find", "The page's check is passed (hCaptcha)"], "No element matches.")];
    expect(captchaPassed(CAPTCHA_TARGETS.C2, browserObservations(echoed)).passed).toBe(false);
    const passed = [...shown, browser(["captcha"], page(demo, "NopeCHA - hCaptcha Demo") +
      "\nThe page's check is passed (hCaptcha); go on with the page.")];
    expect(captchaPassed(CAPTCHA_TARGETS.C2, browserObservations(passed)).passed).toBe(true);
  });

  it("C3 reads the title of the last page: the challenge's own title fails", () => {
    const url = "https://www.scrapingcourse.com/cloudflare-challenge";
    const challenge = [browser(["open", url], page(url, "Just a moment..."))];
    expect(oracle("C3")({ calls: challenge, handoffs: [], imageOutputs: 1, leaks: null, result: { passed: false } }))
      .toMatchObject({ counts: { claimDisagrees: 0, oraclePassed: 0 }, failed: ["captcha_not_passed"] });
    const through = [...challenge, browser(["wait", "--seconds", "10"], page(url, "Cloudflare Challenge - ScrapingCourse.com"))];
    expect(oracle("C3")({ calls: through, handoffs: [], imageOutputs: 1, leaks: null, result: { passed: false } }))
      .toMatchObject({ counts: { claimDisagrees: 1, oraclePassed: 1 }, failed: [] });
  });

  it("C4 needs Yandex's results, never its check page, polled output included", () => {
    const captchaUrl = "https://yandex.ru/showcaptcha?cc=1&retpath=x";
    const results = "https://yandex.ru/search/?text=%D0%BF%D0%BE%D0%B3%D0%BE%D0%B4%D0%B0&lr=213";
    const blocked = [browser(["open", CAPTCHA_TARGETS.C4.start], page(captchaUrl, "Вы не робот?"))];
    expect(captchaPassed(CAPTCHA_TARGETS.C4, browserObservations(blocked)).passed).toBe(false);
    const robotTitle = [browser(["open", CAPTCHA_TARGETS.C4.start], page(results, "Ой! Вы не робот? — Яндекс"))];
    expect(captchaPassed(CAPTCHA_TARGETS.C4, browserObservations(robotTitle)).passed).toBe(false);
    const passed = [...blocked, tool(POLL, { execSessionId: "s1" }, stored(page(results, "погода — Яндекс: нашлось 2 млн результатов")))];
    expect(captchaPassed(CAPTCHA_TARGETS.C4, browserObservations(passed))).toMatchObject({ finalOnTarget: true, passed: true, targetPages: 2 });
  });

  it("counts how the agent worked, from every stored call of the chat", () => {
    const handoff = (outcome: string) => ({ content: [{ type: "json", value: { outcome, page: {} } }] });
    expect(captchaEffortCounts([
      browser(["captcha", "--wait", "8"], "captcha_attempts_exhausted: picture task left"),
      shell("aiqsa-browser click-at 640 410 --hold 0.2 && aiqsa-browser drag 100 200 300 200", ""),
      shell("python3 - <<'EOF'\nfrom aiqsa import browser as b\nb.captcha(wait=5)\nb.click_at(1, 2)\nEOF", ""),
      tool("view_workspace_image"), tool("view_workspace_image"), tool("analyze_image"),
      tool("browser_handoff", { reason: "captcha" }, handoff("not_answered")),
      tool("browser_handoff", { reason: "captcha" }, handoff("completed")),
      tool("browser_handoff", { reason: "sign_in" }, null, "error")
    ])).toEqual({ analyzeImageCalls: 1, attemptsExhausted: 1, browserCommands: 3, captchaCommands: 2, captchaHandoffs: 2,
      clickAtCommands: 2, dragCommands: 1, handoff_completed: 1, handoff_error: 1, handoff_not_answered: 1, handoffs: 3,
      viewWorkspaceImageCalls: 2 });
  });
});

describe("D1 bot detectors", () => {
  const pixelscan = "https://pixelscan.net/bot-check";
  const browserscan = "https://www.browserscan.net/bot-detection";
  const human = { browserscan: { test_results: "Normal" }, blocked: null,
    pixelscan: { cdp: "No CDP detected", headline: "You are not a bot", navigator: "Consistent", user_agent: "OK", webdriver: "Not detected" } };
  const calls = [
    browser(["open", pixelscan], page(pixelscan, "Pixelscan")), browser(["text"], "Result\nYou are not a bot\nNavigator Consistent"),
    browser(["open", browserscan], page(browserscan, "BrowserScan")), browser(["text"], "Bot Detection\nTest Results: Normal")
  ];

  it("classifies verdict texts into codes; anything unclear is unknown", () => {
    expect(["Normal", "You are not a bot", "No automation detected", "Not detected", "Human", "Вы не бот"].map(detectorVerdict))
      .toEqual(["human", "human", "human", "human", "human", "human"]);
    expect(["Robot", "Bot detected", "Headless browser", "WebDriver detected", "Automation framework: Playwright"].map(detectorVerdict))
      .toEqual(["bot", "bot", "bot", "bot", "bot"]);
    expect(["", "Checking...", 42, null, "x".repeat(301)].map(detectorVerdict)).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown"]);
    expect([detectorCheck("Not detected"), detectorCheck("Detected"), detectorCheck("—")]).toEqual(["pass", "fail", "unknown"]);
    expect(detectorCodes(human)).toEqual({ browserscan: "human", pixelscan: "human", pixelscan_cdp: "pass", pixelscan_navigator: "pass",
      pixelscan_user_agent: "pass", pixelscan_webdriver: "pass" });
  });

  it("passes verdicts read and corroborated on both pages with two screenshots", () => {
    expect(checkBrowserResult(BROWSER_SCENARIOS.D1, human)).toEqual({ codes: detectorCodes(human), counts: { pixelscanTabsRead: 4 }, failed: [] });
    expect(oracle("D1")({ calls, handoffs: [], imageOutputs: 2, leaks: null, result: human })).toMatchObject({
      codes: { browserscanCorroborated: "yes", pixelscanCorroborated: "yes" }, counts: { browserscanPages: 1, pixelscanPages: 1 }, failed: [] });
  });

  it("fails an unread verdict, a page never opened, a verdict the outputs never showed, and missing screenshots", () => {
    const unread = { ...human, browserscan: { test_results: "" } };
    expect(checkBrowserResult(BROWSER_SCENARIOS.D1, unread).failed).toEqual(["browserscan_verdict_unknown"]);
    const invented = { ...human, pixelscan: { ...human.pixelscan, headline: "Bot detected" } };
    expect(oracle("D1")({ calls: calls.slice(0, 2), handoffs: [], imageOutputs: 1, leaks: null, result: invented })).toMatchObject({
      codes: { browserscanCorroborated: "no", pixelscanCorroborated: "no" },
      failed: ["browserscan_not_visited", "pixelscan_not_corroborated", "screenshots_lt_2"] });
    expect(oracle("D1")({ calls, handoffs: [], imageOutputs: null, leaks: null, result: null }).codes)
      .toEqual({ browserscanCorroborated: "unread", pixelscanCorroborated: "unread" });
  });
});

describe("C and D scenarios", () => {
  it("run only when named, after the S scenarios, in canonical order", () => {
    expect(DEFAULT_BROWSER_SCENARIO_IDS).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(selectedScenarios(undefined)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(selectedScenarios("d1,c5,C1,s1")).toEqual(["S1", "C1", "C5", "D1"]);
    expect(selectedScenarios("C1,C2,C3,C4,C5,D1")).toEqual(["C1", "C2", "C3", "C4", "C5", "D1"]);
    expect(() => selectedScenarios("C6")).toThrow("browser_scenarios_scenarios_invalid");
  });

  it("state the task as a user would, naming no command or tool, and ask for the claim file and a screenshot", () => {
    for (const id of ["C1", "C2", "C3", "C4", "C5", "D1"] as const) {
      const scenario = BROWSER_SCENARIOS[id];
      expect(scenario.toolCallEvidence).toBe(true);
      expect(scenario.prompt).toContain(BROWSER_RESULT_FILE);
      expect(scenario.prompt).toMatch(/скриншот/u);
      expect(scenario.prompt).not.toMatch(/aiqsa-browser|click-at|click_at|--wait|--hold|browser_handoff|view_workspace_image|analyze_image|передай мне/u);
    }
    for (const id of ["C1", "C2", "C3", "C4", "C5"] as const) {
      expect(BROWSER_SCENARIOS[id].prompt).toContain(CAPTCHA_TARGETS[id].start);
      expect(BROWSER_SCENARIOS[id].prompt).toContain('"passed": true | false');
    }
  });

  it("check the claim file's own shape: one blocked code or null, a boolean claim", () => {
    const claim = { blocked: null, final_title: "ReCAPTCHA demo", final_url: DEMO, passed: true };
    expect(checkBrowserResult(BROWSER_SCENARIOS.C1, claim)).toEqual({ counts: { claimedFinalOnTarget: 1, claimedPassed: 1 }, failed: [] });
    expect(checkBrowserResult(BROWSER_SCENARIOS.C1, { ...claim, blocked: ["captcha"] }).failed).toEqual([]);
    expect(checkBrowserResult(BROWSER_SCENARIOS.C1, { ...claim, blocked: 3, passed: "yes" }).failed)
      .toEqual(["result_blocked_invalid", "result_passed_invalid"]);
    expect(checkBrowserResult(BROWSER_SCENARIOS.D1, { blocked: "captcha" }).failed).toEqual(["result_pixelscan_invalid", "result_browserscan_invalid"]);
  });
});

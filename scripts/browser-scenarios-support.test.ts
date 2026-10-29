import { describe, expect, it } from "vitest";
import { nativeUsageRowId } from "../lib/server/engine/runStore";
import {
  BROWSER_SCENARIOS, BROWSER_RESULT_FILE, BROWSER_RESULT_MAX_BYTES, S6_CATEGORIES, SAUCEDEMO_LOGIN_VALUES, amazonProductKey, blockedCodes,
  boundsExpectation, canonicalPageKey, chatRoute, checkBrowserResult, cleanUpRun, costEstimates, engineUsageRowId, euroAmount,
  frameToClientPoint, openRouterTextModel, textChatCapabilities, handoffOutcome, median, parseBrowserResult, priceValue, ratingValue,
  requestSeries, requireBrowserScenarioStand, resultShapeErrors, reviewCount, runBounds, saucedemoUsernameFramePoint, scenarioSummary,
  selectedScenarios, seriesStats, toolCallStats, unexpectedBounds, urlOnDomain, usageEvidence,
  type BrowserScenarioStand, type RunRecord
} from "./browser-scenarios-support";

function stand(): BrowserScenarioStand {
  const runner = { AIQSA_WORKSPACE_RUNNER_URL: "http://workspace-runner:4310", AIQSA_WORKSPACE_RUNNER_TOKEN: "synthetic-runner-token" };
  return { name: "aiqsa-bx-base-stand", services: {
    app: { environment: { ...runner, AIQSA_APP_BASE_URL: "http://127.0.0.1:32101", AIQSA_WORKSPACE_MAX_TOOL_CALLS: "320", AIQSA_WORKSPACE_MAX_TOOL_ROUNDS: "",
      AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS: "1800", DATABASE_URL: "postgresql://aiqsa:synthetic@postgres:5432/aiqsa?schema=public" },
    ports: [{ host_ip: "127.0.0.1", published: "32101", target: 3000 }] },
    "memory-worker": { environment: { ...runner } },
    "migrate-bootstrap": { environment: { AIQSA_INITIAL_ADMIN_EMAIL: "admin@example.com", AIQSA_INITIAL_ADMIN_PASSWORD: "p".repeat(64) } },
    postgres: { environment: {}, ports: [{ host_ip: "127.0.0.1", published: "32102", target: 5432 }] },
    "workspace-maintenance": { environment: {} },
    "workspace-runner": { devices: [{ source: "/dev/kvm", target: "/dev/kvm" }], environment: { AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0" } }
  } };
}

const write = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("browser scenario stand guard", () => {
  it("admits an acknowledged loopback real-KVM stand and records its configured bounds", () => {
    expect(requireBrowserScenarioStand("DISPOSABLE", stand())).toEqual({
      admin: { email: "admin@example.com", password: "p".repeat(64) },
      baseUrl: "http://127.0.0.1:32101",
      configuredBounds: { maxToolCalls: 320, maxToolRounds: "default", turnTimeoutSeconds: 1800 },
      databaseUrl: "postgresql://aiqsa:synthetic@127.0.0.1:32102/aiqsa",
      project: "aiqsa-bx-base-stand"
    });
  });

  it.each([
    ["no acknowledgement", (value: BrowserScenarioStand) => value, undefined, "browser_scenarios_opt_in_required"],
    ["the persistent project", (value: BrowserScenarioStand) => ({ ...value, name: "aiqsa" }), "DISPOSABLE", "browser_scenarios_project_invalid"],
    ["a psaux project", (value: BrowserScenarioStand) => ({ ...value, name: "aiqsa-psaux-app" }), "DISPOSABLE", "browser_scenarios_project_invalid"],
    ["a missing deletion worker", (value: BrowserScenarioStand) => {
      delete value.services!["memory-worker"]; return value;
    }, "DISPOSABLE", "browser_scenarios_roles_missing"],
    ["a deterministic runner", (value: BrowserScenarioStand) => {
      value.services!["workspace-runner"]!.environment!.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME = "1"; return value;
    }, "DISPOSABLE", "browser_scenarios_real_runtime_required"],
    ["a runner without KVM", (value: BrowserScenarioStand) => {
      value.services!["workspace-runner"]!.devices = []; return value;
    }, "DISPOSABLE", "browser_scenarios_kvm_required"],
    ["a public app port", (value: BrowserScenarioStand) => {
      value.services!.app!.ports![0]!.host_ip = "0.0.0.0"; return value;
    }, "DISPOSABLE", "browser_scenarios_loopback_required"],
    ["a foreign base URL", (value: BrowserScenarioStand) => {
      value.services!.app!.environment!.AIQSA_APP_BASE_URL = "https://ai.example.invalid"; return value;
    }, "DISPOSABLE", "browser_scenarios_base_url_mismatch"],
    ["missing administrator credentials", (value: BrowserScenarioStand) => {
      value.services!["migrate-bootstrap"]!.environment!.AIQSA_INITIAL_ADMIN_PASSWORD = ""; return value;
    }, "DISPOSABLE", "browser_scenarios_admin_credentials_required"],
    ["a non-numeric bound", (value: BrowserScenarioStand) => {
      value.services!.app!.environment!.AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS = "long"; return value;
    }, "DISPOSABLE", "browser_scenarios_runtime_bounds_invalid"]
  ])("refuses %s", (_name, change, mode, code) => {
    expect(() => requireBrowserScenarioStand(mode, change(stand()))).toThrow(code);
  });
});

describe("run bounds", () => {
  it("records the frozen tool budgets and turn deadline, and none for an absent limit", () => {
    expect(runBounds({ toolBudgets: { maxToolCalls: 320, maxToolRounds: 160 }, workspace: { turnTimeoutSeconds: 1800 } }))
      .toEqual({ maxToolCalls: 320, maxToolRounds: 160, turnTimeoutSeconds: 1800 });
    expect(runBounds({ toolBudgets: { maxToolCalls: null }, workspace: {} }))
      .toEqual({ maxToolCalls: "none", maxToolRounds: "none", turnTimeoutSeconds: "none" });
    expect(runBounds(null)).toEqual({ maxToolCalls: "none", maxToolRounds: "none", turnTimeoutSeconds: "none" });
  });
});

describe("browser-result.json", () => {
  it("parses an object, normalizes blocked codes and rejects other shapes", () => {
    const parsed = parseBrowserResult(write({ blocked: ["captcha", "BOT_WALL", "geo_block", "none", "captcha"], status: "blocked" }));
    expect(parsed).toMatchObject({ blocked: ["bot_wall", "captcha", "other"], ok: true });
    expect(parseBrowserResult(new TextEncoder().encode("{oops"))).toEqual({ code: "result_invalid_json", ok: false });
    expect(parseBrowserResult(write([1, 2]))).toEqual({ code: "result_not_object", ok: false });
    expect(parseBrowserResult(new Uint8Array(BROWSER_RESULT_MAX_BYTES + 1))).toEqual({ code: "result_too_large", ok: false });
    expect(blockedCodes("captcha")).toEqual([]);
  });

  it("reads prices as numbers or plain decimals only", () => {
    expect(priceValue(2.49)).toBe(2.49);
    expect(priceValue("2,49")).toBe(2.49);
    expect(priceValue("2.49 €")).toBeNull();
    expect(priceValue(0)).toBeNull();
    expect(priceValue("abc")).toBeNull();
  });

  it("matches URLs by exact domain or subdomain", () => {
    expect(urlOnDomain("https://www.amazon.es/dp/X", "amazon.es")).toBe(true);
    expect(urlOnDomain("https://amazon.es.evil.invalid/dp/X", "amazon.es")).toBe(false);
    expect(urlOnDomain("https://notamazon.es/", "amazon.es")).toBe(false);
    expect(urlOnDomain("javascript:alert(1)", "amazon.es")).toBe(false);
  });
});

describe("result schema", () => {
  const valid = { blocked: [], status: "completed" };

  it("requires the status enum and a blocked array of strings", () => {
    expect(resultShapeErrors({ ...valid, items: [] }, "items")).toEqual([]);
    expect(resultShapeErrors({ items: [] }, "items")).toEqual(["result_status_invalid", "result_blocked_invalid"]);
    expect(resultShapeErrors({ ...valid, status: "done" }, null)).toEqual(["result_status_invalid"]);
    expect(resultShapeErrors({ ...valid, blocked: "captcha" }, null)).toEqual(["result_blocked_invalid"]);
    expect(resultShapeErrors({ ...valid, blocked: ["captcha", 1] }, null)).toEqual(["result_blocked_invalid"]);
  });

  it("requires the scenario's own section with the right type", () => {
    expect(resultShapeErrors({ ...valid, items: [1] }, "items")).toEqual(["result_items_invalid"]);
    expect(resultShapeErrors(valid, "items")).toEqual(["result_items_invalid"]);
    expect(resultShapeErrors({ ...valid, cart: { lines: {} } }, "cart")).toEqual(["result_cart_invalid"]);
    expect(resultShapeErrors({ ...valid, cart: { lines: [] } }, "cart")).toEqual([]);
    expect(resultShapeErrors({ ...valid, checkout: [] }, "checkout")).toEqual(["result_checkout_invalid"]);
  });

  it("never runs a scenario oracle on a malformed file", () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ currency: "EUR", name: `Item ${index}`, offer: true, price: 2,
      url: `https://www.amazon.es/dp/B00000000${index}` }));
    expect(checkBrowserResult(BROWSER_SCENARIOS.S1, { items })).toEqual({ counts: {}, failed: ["result_status_invalid", "result_blocked_invalid"] });
    expect(checkBrowserResult(BROWSER_SCENARIOS.S1, { ...valid, items }).failed).toEqual([]);
  });
});

describe("scenario oracles", () => {
  const amazonItem = (index: number, offer: boolean) =>
    ({ currency: "EUR", name: `Item ${index}`, offer, price: 1 + index, url: `https://www.amazon.es/dp/B00000000${index}` });

  it("S1 needs 8 distinct priced amazon.es items in euros, 2 of them offers", () => {
    const oracle = BROWSER_SCENARIOS.S1.oracle;
    const items = Array.from({ length: 8 }, (_, index) => amazonItem(index, index < 2));
    expect(oracle({ items })).toEqual({ counts: { distinctItems: 8, items: 8, offers: 2, validItems: 8 }, failed: [] });
    expect(oracle({ items: items.slice(0, 7) }).failed).toEqual(["items_lt_8"]);
    expect(oracle({ items: items.map((item) => ({ ...item, offer: false })) }).failed).toEqual(["offers_lt_2"]);
    expect(oracle({ items: items.map((item) => ({ ...item, currency: "USD" })) }).failed).toEqual(["items_lt_8", "offers_lt_2"]);
    expect(oracle({ items: items.map((item) => ({ ...item, url: "https://www.amazon.com/dp/B000000001" })) }).failed)
      .toEqual(["items_lt_8", "offers_lt_2"]);
    expect(oracle({}).failed).toEqual(["items_lt_8", "offers_lt_2"]);
  });

  it("S1 counts one product once, whatever its URL decoration or name repetition", () => {
    const oracle = BROWSER_SCENARIOS.S1.oracle;
    const copies = Array.from({ length: 8 }, (_, index) => ({ ...amazonItem(index, true),
      url: `https://www.amazon.es/Zumo-Naranja/dp/B0ABCDEF12/ref=sr_1_${index}?keywords=zumo&th=${index}#x` }));
    expect(oracle({ items: copies })).toEqual({ counts: { distinctItems: 1, items: 8, offers: 1, validItems: 8 },
      failed: ["items_lt_8", "offers_lt_2"] });
    const sameName = Array.from({ length: 8 }, (_, index) => ({ ...amazonItem(index, true), name: " Zumo  NARANJA " }));
    expect(oracle({ items: sameName }).counts).toMatchObject({ distinctItems: 1, offers: 1 });
    const repeatedOffer = [...Array.from({ length: 8 }, (_, index) => amazonItem(index, index === 0)), amazonItem(0, true)];
    expect(oracle({ items: repeatedOffer }).failed).toEqual(["offers_lt_2"]);
  });

  it("canonicalizes page identity", () => {
    expect(canonicalPageKey("https://www.amazon.es/Some-Name/dp/b0abcdef12/ref=x?y=1")).toBe("amazon.es/dp/B0ABCDEF12");
    expect(canonicalPageKey("https://amazon.es/gp/product/B0ABCDEF12")).toBe("amazon.es/dp/B0ABCDEF12");
    expect(canonicalPageKey("https://www.booking.com/hotel/es/sol.es.html?aid=1#map")).toBe("booking.com/hotel/es/sol.es.html");
    expect(canonicalPageKey("https://www.booking.com/hotel/es/sol.es.html/")).toBe("booking.com/hotel/es/sol.es.html");
    expect(canonicalPageKey("not a url")).toBeNull();
  });

  it("S2 needs 3 priced cart lines whose sum matches the subtotal within 0.02", () => {
    const oracle = BROWSER_SCENARIOS.S2.oracle;
    const lines = [{ line_total: 1.15, name: "A", quantity: 1 }, { line_total: "2,30", name: "B", quantity: 1 }, { line_total: 3.05, name: "C" }];
    expect(oracle({ cart: { lines, subtotal: 6.5 } })).toEqual({
      counts: { lines: 3, pricedLines: 3, subtotalMatches: 1, subtotalPresent: 1 }, failed: [] });
    expect(oracle({ cart: { lines, subtotal: 6.52 } }).failed).toEqual([]);
    expect(oracle({ cart: { lines, subtotal: 6.55 } }).failed).toEqual(["cart_subtotal_mismatch"]);
    expect(oracle({ cart: { lines: lines.slice(0, 2), subtotal: 3.45 } }).failed).toEqual(["cart_lines_not_3"]);
    expect(oracle({ cart: { lines: [...lines.slice(0, 2), { name: "C", line_total: "n/a" }], subtotal: 6.5 } }).failed)
      .toEqual(["cart_line_price_invalid"]);
    expect(oracle({ cart: { lines } }).failed).toEqual(["cart_subtotal_invalid"]);
  });

  it("S3 needs the overview totals of the two items and an unfinished order", () => {
    const oracle = BROWSER_SCENARIOS.S3.oracle;
    expect(oracle({ checkout: { finished: false, item_total: 39.98, tax: "3.20" } })).toEqual({
      counts: { itemTotalMatches: 1, taxMatches: 1, unfinished: 1 }, failed: [] });
    expect(oracle({ checkout: { finished: true, item_total: 39.98, tax: 3.2 } }).failed).toEqual(["order_not_proven_unfinished"]);
    expect(oracle({ checkout: { item_total: 29.99, tax: 2.4 } }).failed)
      .toEqual(["item_total_mismatch", "tax_mismatch", "order_not_proven_unfinished"]);
  });

  it("S4 needs 5 distinct priced booking.com entries", () => {
    const oracle = BROWSER_SCENARIOS.S4.oracle;
    const items = Array.from({ length: 5 }, (_, index) =>
      ({ currency: "EUR", name: `Hotel ${index}`, price: 200 + index, url: `https://www.booking.com/hotel/es/h${index}.html` }));
    expect(oracle({ items })).toEqual({ counts: { distinctItems: 5, items: 5, validItems: 5 }, failed: [] });
    expect(oracle({ items: [...items.slice(0, 4), { ...items[4], url: "https://www.expedia.es/h" }] }).failed).toEqual(["items_lt_5"]);
    const copies = items.map((item, index) => ({ ...item, url: `https://www.booking.com/hotel/es/h0.html?checkin=x&room=${index}` }));
    expect(oracle({ items: copies })).toEqual({ counts: { distinctItems: 1, items: 5, validItems: 5 }, failed: ["items_lt_5"] });
  });

  it("S5 needs the checkout overview's own numbers and an unfinished order", () => {
    const oracle = BROWSER_SCENARIOS.S5.oracle;
    const checkout = { finished: false, item_total: 29.99, tax: "2.40", total: 32.39, url: "https://www.saucedemo.com/checkout-step-two.html" };
    expect(oracle({ checkout })).toEqual({ counts: { overview: 1, taxMatches: 1, totalMatches: 1, unfinished: 1 }, failed: [] });
    expect(oracle({ checkout: { ...checkout, url: "https://www.saucedemo.com/checkout-step-one.html" } }).failed)
      .toEqual(["overview_not_reached"]);
    expect(oracle({ checkout: { ...checkout, url: "https://saucedemo.example/checkout-step-two.html" } }).failed)
      .toEqual(["overview_not_reached"]);
    expect(oracle({ checkout: { ...checkout, item_total: "n/a" } }).failed).toEqual(["item_total_invalid"]);
    expect(oracle({ checkout: { ...checkout, tax: 3.2 } }).failed).toEqual(["tax_mismatch", "total_mismatch"]);
    expect(oracle({ checkout: { ...checkout, total: 29.99 } }).failed).toEqual(["total_mismatch"]);
    expect(oracle({ checkout: { ...checkout, finished: true } }).failed).toEqual(["order_not_proven_unfinished"]);
    expect(checkBrowserResult(BROWSER_SCENARIOS.S5, { blocked: [], checkout: [], status: "completed" }).failed)
      .toEqual(["result_checkout_invalid"]);
  });

  it("asks S5's user to sign in through the browser, with no saved login and nothing to type in the prompt", () => {
    const scenario = BROWSER_SCENARIOS.S5;
    expect(scenario.availability).toBe("available");
    expect(scenario.interaction).toBeTypeOf("function");
    expect(scenario.secret).toBeUndefined();
    expect(scenario.prompt).toContain("https://www.saucedemo.com");
    for (const value of SAUCEDEMO_LOGIN_VALUES) expect(scenario.prompt).not.toContain(value);
    expect(scenario.prompt).not.toMatch(/browser_handoff|aiqsa-browser|секрет/iu);
  });

  it("asks for the result file and forbids orders and payments in every available prompt", () => {
    for (const scenario of Object.values(BROWSER_SCENARIOS).filter((entry) => entry.availability === "available")) {
      expect(scenario.prompt).toContain(BROWSER_RESULT_FILE);
      expect(scenario.prompt).toContain("не оформляй и не подтверждай заказы, ничего не оплачивай");
      expect(scenario.prompt).toMatch(/[а-я]/u);
    }
    expect(BROWSER_SCENARIOS.S3.secret).toBe("saucedemo");
  });
});

describe("S5 live handoff evidence", () => {
  const ended = (outcome: string) => ({ callId: "call-1", content: [{ type: "json", value: { next: "...", outcome, page: {} } }],
    name: "browser_handoff", status: "complete" });
  const signIn = { arguments: { message: "Please sign in.", reason: "sign_in" }, result: ended("completed"), state: "complete" };
  const clean = { credentialsAfterHandoff: 0, credentialsInToolArguments: 0, marker: 0 };
  const oracle = BROWSER_SCENARIOS.S5.runOracle!;

  it("passes a completed sign-in handoff with nothing typed in stored rows", () => {
    expect(oracle({ handoffs: [signIn], leaks: clean })).toEqual({ counts: { completedSignInHandoffs: 1,
      credentialsAfterHandoffRows: 0, credentialsInToolArgumentRows: 0, handoffs: 1, markerRows: 0, signInHandoffs: 1 }, failed: [] });
    const retried = { ...signIn, result: ended("cancelled") };
    expect(oracle({ handoffs: [retried, signIn], leaks: clean }).failed).toEqual([]);
  });

  it("needs a sign_in handoff the user completed", () => {
    expect(oracle({ handoffs: [], leaks: clean }).failed).toEqual(["handoff_missing"]);
    expect(oracle({ handoffs: [{ ...signIn, arguments: { reason: "other" } }], leaks: clean }).failed)
      .toEqual(["handoff_reason_not_sign_in"]);
    for (const outcome of ["cancelled", "timed_out"]) {
      expect(oracle({ handoffs: [{ ...signIn, result: ended(outcome) }], leaks: clean }).failed).toEqual(["handoff_not_completed"]);
    }
    const refused = { ...signIn, result: { content: [{ type: "json", value: { error: "browser_handoff_unavailable" } }] }, state: "error" };
    expect(oracle({ handoffs: [refused], leaks: clean }).failed).toEqual(["handoff_not_completed"]);
    expect(oracle({ handoffs: [{ ...signIn, state: "error" }], leaks: clean }).failed).toEqual(["handoff_not_completed"]);
  });

  it("reads the outcome from a stored JSON or text result", () => {
    expect(handoffOutcome(ended("completed"))).toBe("completed");
    expect(handoffOutcome({ content: [{ text: JSON.stringify({ outcome: "timed_out" }), type: "text" }] })).toBe("timed_out");
    expect(handoffOutcome({ content: [{ text: "not json", type: "text" }] })).toBeNull();
    expect(handoffOutcome(null)).toBeNull();
  });

  it("fails on each leak of typed values, and when the leak check could not run", () => {
    expect(oracle({ handoffs: [signIn], leaks: { ...clean, marker: 2 } }).failed).toEqual(["marker_leaked"]);
    expect(oracle({ handoffs: [signIn], leaks: { ...clean, credentialsInToolArguments: 1 } }).failed).toEqual(["credentials_typed_by_agent"]);
    expect(oracle({ handoffs: [signIn], leaks: { ...clean, credentialsAfterHandoff: 1 } }).failed).toEqual(["credentials_leaked_after_handoff"]);
    expect(oracle({ handoffs: [signIn], leaks: null })).toEqual({ counts: { completedSignInHandoffs: 1, handoffs: 1, signInHandoffs: 1 },
      failed: ["leak_check_unavailable"] });
  });

  it("maps saucedemo's username field into the frame and onto the screen", () => {
    // The guest's 1440 CSS px window shown in a 1280 px frame, the frame drawn at half size.
    const scaled = saucedemoUsernameFramePoint({ height: 800, width: 1280 });
    expect(scaled.x).toBe(640);
    expect(scaled.y).toBeCloseTo(156.44, 2);
    // Inside the field (154–191 CSS px) in frame pixels, whether the frame is scaled or not.
    expect(scaled.y).toBeGreaterThan(154 * 1280 / 1440);
    expect(scaled.y).toBeLessThan(191 * 1280 / 1440);
    const unscaled = saucedemoUsernameFramePoint({ height: 800, width: 1280 }, 1280);
    expect(unscaled.y).toBeGreaterThan(154);
    expect(unscaled.y).toBeLessThan(191);
    const client = frameToClientPoint(scaled, { height: 800, width: 1280 }, { height: 400, width: 640, x: 100, y: 200 });
    expect(client.x).toBe(420);
    expect(client.y).toBeCloseTo(278.22, 2);
    expect(() => frameToClientPoint(scaled, { height: 0, width: 0 }, { height: 400, width: 640, x: 0, y: 0 }))
      .toThrow("browser_scenarios_frame_unmeasured");
  });
});

describe("cleanup between runs", () => {
  const ports = (chat: () => Promise<boolean>, sessions: () => Promise<number>, order: string[] = []) => ({
    deleteChat: async () => { order.push("chat"); return chat(); },
    removeBrowserSessions: async () => { order.push("sessions"); return sessions(); }
  });

  it("deletes the chat before removing sessions and passes only when both are proven", async () => {
    const order: string[] = [];
    expect(await cleanUpRun(ports(async () => true, async () => 1, order), "chat-1", false))
      .toEqual({ browserSessionsRemoved: 1, chatDeleted: true, cleaned: true });
    expect(order).toEqual(["chat", "sessions"]);
  });

  it("fails the postcondition when the chat stays or a session cannot be removed", async () => {
    expect((await cleanUpRun(ports(async () => false, async () => 0), "chat-1", false)).cleaned).toBe(false);
    expect((await cleanUpRun(ports(async () => { throw new Error("x"); }, async () => 0), "chat-1", false)).cleaned).toBe(false);
    expect(await cleanUpRun(ports(async () => true, async () => { throw new Error("browser_session_cleanup_failed"); }), "chat-1", false))
      .toEqual({ browserSessionsRemoved: null, chatDeleted: true, cleaned: false });
  });

  it("still clears sessions when chats are kept or no chat was created", async () => {
    const order: string[] = [];
    expect(await cleanUpRun(ports(async () => true, async () => 0, order), "chat-1", true)).toEqual({ browserSessionsRemoved: 0, cleaned: true });
    expect(await cleanUpRun(ports(async () => true, async () => 2, order), null, false)).toEqual({ browserSessionsRemoved: 2, cleaned: true });
    expect(order).toEqual(["sessions", "sessions"]);
  });
});

describe("selection and evidence", () => {
  it("selects scenarios in canonical order and refuses unknown or repeated ids", () => {
    expect(selectedScenarios(undefined)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(selectedScenarios("s3, S1")).toEqual(["S1", "S3"]);
    expect(selectedScenarios("S6")).toEqual(["S6"]);
    expect(selectedScenarios("S1")).toEqual(["S1"]);
    expect(selectedScenarios("s6,s1")).toEqual(["S1", "S6"]);
    expect(() => selectedScenarios("S7")).toThrow("browser_scenarios_scenarios_invalid");
    expect(() => selectedScenarios("S1,S1")).toThrow("browser_scenarios_scenarios_invalid");
  });

  it("counts tool calls, tool rounds, image analyses and failures", () => {
    expect(toolCallStats([
      { roundIndex: 1, state: "complete", toolName: "mcp_workspace_sandbox_exec" },
      { roundIndex: 1, state: "error", toolName: "mcp_workspace_sandbox_exec" },
      { roundIndex: 3, state: "complete", toolName: "analyze_image" },
      { roundIndex: 4, state: "complete", toolName: "view_workspace_image" }
    ])).toEqual({ analyzeImageCalls: 1, failedToolCalls: 1, rounds: 4, toolCalls: 4, viewWorkspaceImageCalls: 1 });
    expect(toolCallStats([])).toEqual({ analyzeImageCalls: 0, failedToolCalls: 0, rounds: 0, toolCalls: 0, viewWorkspaceImageCalls: 0 });
  });

  it("selects the chat route: codex-lb by default, or a text-only OpenRouter model with its key", () => {
    expect(chatRoute({})).toEqual({ route: "codex-lb" });
    expect(() => chatRoute({ AIQSA_BROWSER_SCENARIOS_CHAT_MODEL: "deepseek/deepseek-v3.2" })).toThrow("browser_scenarios_chat_model_unexpected");
    const openRouter = { AIQSA_BROWSER_SCENARIOS_CHAT_MODEL: "deepseek/deepseek-v3.2", AIQSA_BROWSER_SCENARIOS_CHAT_ROUTE: "openrouter",
      OPENROUTER_API_KEY: "synthetic" };
    expect(chatRoute(openRouter)).toEqual({ model: "deepseek/deepseek-v3.2", route: "openrouter" });
    expect(() => chatRoute({ ...openRouter, OPENROUTER_API_KEY: " " })).toThrow("browser_scenarios_openrouter_key_required");
    expect(() => chatRoute({ ...openRouter, AIQSA_BROWSER_SCENARIOS_CHAT_MODEL: "https://evil.invalid/x" }))
      .toThrow("browser_scenarios_chat_model_invalid");
    expect(() => chatRoute({ ...openRouter, AIQSA_BROWSER_SCENARIOS_CHAT_ROUTE: "anthropic" })).toThrow("browser_scenarios_chat_route_invalid");
  });

  it("admits only a listed text-only OpenRouter model with tool calling, taking its listed window", () => {
    const entry = { architecture: { input_modalities: ["text"] }, context_length: 163_840, id: "deepseek/deepseek-v3.2",
      supported_parameters: ["tools", "tool_choice"] };
    expect(openRouterTextModel({ data: [entry] }, "deepseek/deepseek-v3.2")).toEqual({ contextWindow: 163_840 });
    expect(openRouterTextModel({ data: [entry] }, "deepseek/other")).toEqual({ code: "chat_model_not_listed" });
    expect(openRouterTextModel({ data: [{ ...entry, supported_parameters: [] }] }, entry.id)).toEqual({ code: "chat_model_without_tools" });
    expect(openRouterTextModel({ data: [{ ...entry, architecture: { input_modalities: ["text", "image"] } }] }, entry.id))
      .toEqual({ code: "chat_model_not_text_only" });
    expect(openRouterTextModel(null, entry.id)).toEqual({ code: "chat_model_not_listed" });
    expect(textChatCapabilities(163_840)).toMatchObject({ contextWindow: 163_840, toolCalling: true, vision: false });
  });

  it("keeps cost unknown unless every usage row carries a provider-reported charge", () => {
    const reported = { costReported: true, estimatedCostMicros: 1_500, inputTokens: 100, outputTokens: 10 };
    expect(usageEvidence([reported, reported])).toEqual({ costUsd: 0.003, inputTokens: 200, outputTokens: 20, usageEvents: 2 });
    expect(usageEvidence([reported, { ...reported, costReported: false }]).costUsd).toBeNull();
    expect(usageEvidence([])).toEqual({ costUsd: null, inputTokens: null, outputTokens: null, usageEvents: 0 });
  });

  it("reports a token total only when every usage row reports that field", () => {
    const row = { costReported: false, estimatedCostMicros: null, inputTokens: 100, outputTokens: 10 };
    expect(usageEvidence([row, { ...row, inputTokens: null }])).toEqual({ costUsd: null, inputTokens: null, outputTokens: 20, usageEvents: 2 });
    expect(usageEvidence([row, { ...row, outputTokens: null }]).outputTokens).toBeNull();
  });

  it("aggregates one baseline row per scenario", () => {
    const run = (overrides: Partial<RunRecord>): RunRecord => ({ blocked: [], costUsd: null, inputTokens: 1_000,
      outputTokens: 10, rounds: 4, scenario: "S1", success: false, toolCalls: 10, wallSeconds: 100, ...overrides });
    const summary = scenarioSummary("S1", [
      run({ blocked: ["bot_wall"], rounds: 2, toolCalls: 6, wallSeconds: 60.15 }),
      run({ blocked: ["bot_wall", "captcha"], success: true, rounds: 6, outputTokens: null }),
      run({ scenario: "S2", success: true })
    ]);
    expect(summary).toMatchObject({ blocked: { bot_wall: 2, captcha: 1 }, compactionsTotal: null, costEstimates: null, costKnownRuns: 0,
      costUsdTotal: null, inputTokensTotal: 2_000, medianRounds: 4, medianToolCalls: 8, medianWallSeconds: 80.1, outputTokensTotal: null,
      runs: 2, scenario: "S1", successes: 1 });
    expect(summary.runsDetail.map((row) => [row.rounds, row.success, row.costEstimates === null])).toEqual([[2, false, false], [6, true, true]]);
    expect(scenarioSummary("S2", [run({ costUsd: 0.25, scenario: "S2" }), run({ costUsd: 0.5, scenario: "S2" })]).costUsdTotal).toBe(0.75);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });
});

describe("S6 long shopping task", () => {
  type Entry = Record<string, unknown>;
  type S6Fixture = { blocked: string[]; cart: { lines: Entry[]; subtotal: unknown };
    categories: { candidates: Entry[]; category: string; chosen: Entry }[]; status: string };
  const asin = (category: number, index: number) => `B0S6C${category}N${index}XX`;
  const result = (): S6Fixture => ({
    blocked: [],
    cart: {
      lines: S6_CATEGORIES.map((category, c) => ({ category, line_total: 1.5 + c, name: `${category} 0`, quantity: 1,
        url: `https://www.amazon.es/dp/${asin(c, 0)}` })),
      subtotal: 17.5
    },
    categories: S6_CATEGORIES.map((category, c) => ({
      candidates: [0, 1, 2].map((index) => ({ name: `${category} ${index}`, price: 1.5 + c + index / 10, rating: 4.2,
        reviews: 100 + index, url: `https://www.amazon.es/Some-Product/dp/${asin(c, index)}/ref=sr_1_${index}?th=1` })),
      category,
      chosen: { reason: "Lowest price per kilo among well-rated options.", url: `https://www.amazon.es/dp/${asin(c, 0)}` }
    })),
    status: "completed"
  });
  const check = (value: unknown) => checkBrowserResult(BROWSER_SCENARIOS.S6, value as Record<string, unknown>);

  it("passes 15 candidates, one reasoned choice per category and a cart of exactly those five", () => {
    expect(check(result())).toEqual({ counts: { candidates: 15, cartLines: 5, categories: 5, chosen: 5, distinctCandidates: 15,
      matchedLines: 5, pricedLines: 5, subtotalMatches: 1 }, failed: [] });
  });

  it("tolerates currency formatting, decimal commas, string counts and a cart line known only by its name", () => {
    const value = result();
    value.cart.lines = value.cart.lines.map((line, index) => ({ ...line,
      line_total: `${(line.line_total as number).toFixed(2).replace(".", ",")} €`, quantity: "1", ...(index === 0 ? { url: undefined } : {}) }));
    value.cart.subtotal = "17,50 €";
    value.categories[0]!.candidates = value.categories[0]!.candidates.map((candidate) => ({ ...candidate, price: "1,50 €", rating: "4,2",
      reviews: "1.234" }));
    expect(check(value).failed).toEqual([]);
    // A cent of rounding per line is accepted, more is not.
    expect(check({ ...value, cart: { ...value.cart, subtotal: 17.54 } }).failed).toEqual([]);
  });

  it("fails a missing category", () => {
    const value = result();
    value.categories = value.categories.filter((group) => group.category !== "coffee");
    expect(check(value).failed).toEqual(["category_missing_coffee", "candidates_lt_15", "cart_line_mismatch"]);
    expect(check({ ...result(), categories: [...result().categories, result().categories[0]] }).failed).toEqual(["category_repeated_juice"]);
  });

  it("counts only amazon.es product pages with price, rating and review count", () => {
    for (const change of [{ url: "https://www.amazon.com/dp/B0S6C0N1XX" }, { url: "https://www.amazon.es/s?k=zumo" },
      { url: "https://amazon.es.evil.invalid/dp/B0S6C0N1XX" }, { rating: null }, { reviews: 0 }, { price: "gratis" }]) {
      const value = result();
      value.categories[0]!.candidates[1] = { ...value.categories[0]!.candidates[1]!, ...change };
      expect(check(value).failed).toEqual(["candidates_lt_3_juice", "candidates_lt_15"]);
    }
    const repeated = result();
    repeated.categories[1]!.candidates[2] = { ...repeated.categories[1]!.candidates[2]!, url: repeated.categories[0]!.candidates[2]!.url };
    expect(check(repeated).failed).toEqual(["candidates_lt_15"]);
  });

  it("needs each choice to be one of its category's candidates, with a reason", () => {
    const outside = result();
    outside.categories[2]!.chosen = { ...outside.categories[2]!.chosen, url: "https://www.amazon.es/dp/B0OTHER000" };
    expect(check(outside).failed).toEqual(["chosen_not_candidate_frozen_la_sirena", "cart_line_mismatch"]);
    const unexplained = result();
    unexplained.categories[3]!.chosen = { ...unexplained.categories[3]!.chosen, reason: " " };
    expect(check(unexplained).failed).toEqual(["chosen_reason_missing_coffee", "cart_line_mismatch"]);
  });

  it("fails cart lines that do not match the chosen products one to one", () => {
    const other = result();
    other.cart.lines[4] = { ...other.cart.lines[4]!, name: "cereal 1", url: `https://www.amazon.es/dp/${asin(4, 1)}` };
    expect(check(other).failed).toEqual(["cart_line_mismatch"]);
    const twice = result();
    twice.cart.lines[1] = { ...twice.cart.lines[0]! };
    twice.cart.subtotal = 1.5 * 2 + 3.5 + 4.5 + 5.5;
    expect(check(twice).failed).toEqual(["cart_line_mismatch"]);
    const short = result();
    short.cart.lines = short.cart.lines.slice(0, 4);
    short.cart.subtotal = 12;
    expect(check(short).failed).toEqual(["cart_lines_not_5", "cart_line_mismatch"]);
    const doubled = result();
    doubled.cart.lines[0] = { ...doubled.cart.lines[0]!, quantity: 2 };
    expect(check(doubled).failed).toEqual(["cart_quantity_not_1"]);
  });

  it("fails a subtotal inconsistent with the lines", () => {
    expect(check({ ...result(), cart: { ...result().cart, subtotal: 17.6 } }).failed).toEqual(["cart_subtotal_mismatch"]);
    expect(check({ ...result(), cart: { ...result().cart, subtotal: undefined } }).failed).toEqual(["cart_subtotal_invalid"]);
    const unpriced = result();
    unpriced.cart.lines[2] = { ...unpriced.cart.lines[2]!, line_total: "n/a" };
    expect(check(unpriced).failed).toEqual(["cart_line_price_invalid"]);
  });

  it("fails with a stable reason when the agent reports a bot wall", () => {
    expect(check({ blocked: ["bot_wall"], cart: { lines: [] }, categories: [], status: "blocked" }).failed).toEqual([
      ...S6_CATEGORIES.map((category) => `category_missing_${category}`), "candidates_lt_15", "cart_lines_not_5",
      "cart_line_price_invalid", "cart_subtotal_invalid", "blocked_reported"]);
    expect(check({ ...result(), blocked: ["captcha"] }).failed).toEqual(["blocked_reported"]);
  });

  it("checks the result shape first", () => {
    expect(check({ blocked: [], cart: { lines: [] }, status: "completed" }).failed).toEqual(["result_categories_invalid"]);
    expect(check({ blocked: [], categories: [], status: "completed" }).failed).toEqual(["result_cart_invalid"]);
  });

  it("asks for every category, the result fields and a guest cart without checkout", () => {
    const prompt = BROWSER_SCENARIOS.S6.prompt;
    for (const key of [...S6_CATEGORIES, "amazon.es", "rating", "reviews", "chosen", "subtotal", "не входи", "Корзину не оформляй"]) {
      expect(prompt).toContain(key);
    }
  });

  it("reads euro amounts, ratings, review counts and product keys as pages show them", () => {
    expect(euroAmount("12,34 €")).toBe(12.34);
    expect(euroAmount("€ 1.234,56")).toBe(1234.56);
    expect(euroAmount("1,234.56 EUR")).toBe(1234.56);
    expect(euroAmount("12.3")).toBe(12.3);
    expect(euroAmount("1.234")).toBe(1234);
    expect(euroAmount(3)).toBe(3);
    expect(euroAmount("12,345,6")).toBeNull();
    expect(euroAmount("0,00 €")).toBeNull();
    expect(ratingValue("4,5")).toBe(4.5);
    expect(ratingValue(5.5)).toBeNull();
    expect(reviewCount("1.234")).toBe(1234);
    expect(reviewCount(12.5)).toBeNull();
    expect(amazonProductKey("https://www.amazon.es/x/dp/b0abcdef12?th=1")).toBe("amazon.es/dp/B0ABCDEF12");
    expect(amazonProductKey("https://www.amazon.es/s?k=cafe")).toBeNull();
  });
});

describe("per-request input series", () => {
  const runId = "8f9b5a52-3f39-4a8e-9f3c-1f0c9d1e2a77";

  it("derives the engine's own usage row ids", () => {
    for (const index of [0, 1, 17]) expect(engineUsageRowId(runId, index)).toBe(nativeUsageRowId(runId, String(index)));
  });

  it("orders the run's model requests by their ledger index and leaves out Search and other writers' rows", () => {
    const row = (index: number, inputTokens: number | null, purpose = "chat_answer") =>
      ({ cachedInputTokens: 10 as number | null, id: engineUsageRowId(runId, index), inputTokens, purpose });
    const rows = [row(3, 400), row(0, 100), row(2, null, "web_search"), row(1, 250),
      { cachedInputTokens: null, id: "0e1c1d1a-0000-4000-8000-000000000000", inputTokens: 999, purpose: "chat_vision" }];
    expect(requestSeries(runId, rows)).toEqual({ cachedInputTokens: 30, inputSeries: [100, 250, 400], otherRows: 1 });
    expect(requestSeries(runId, [row(0, 100), { ...row(1, 200), cachedInputTokens: null }]).cachedInputTokens).toBeNull();
    expect(requestSeries(runId, [])).toEqual({ cachedInputTokens: null, inputSeries: [], otherRows: 0 });
  });

  it("summarizes the series with min, median, max and a least-squares slope per request", () => {
    expect(seriesStats([100, 200, 300, 400])).toEqual({ max: 400, median: 250, min: 100, reported: 4, requests: 4, slopePerRequest: 100 });
    // A compaction drops the context; the slope is the fitted growth over the whole series.
    expect(seriesStats([1_000, 5_000, 9_000, 2_000]).slopePerRequest).toBe(700);
    expect(seriesStats([100, null, 300])).toEqual({ max: 300, median: 200, min: 100, reported: 2, requests: 3, slopePerRequest: 100 });
    expect(seriesStats([5])).toEqual({ max: 5, median: 5, min: 5, reported: 1, requests: 1, slopePerRequest: null });
    expect(seriesStats([])).toEqual({ max: null, median: null, min: null, reported: 0, requests: 0, slopePerRequest: null });
  });

  it("estimates cost at both list prices, with and without an 85% cache hit", () => {
    expect(costEstimates(1_000_000, 100_000)).toEqual({
      budget: { cached85: 0.0735, noCache: 0.15 },
      frontier: { cached85: 2.94, noCache: 6 }
    });
    expect(costEstimates(null, 10)).toBeNull();
    expect(costEstimates(10, null)).toBeNull();
  });

  it("carries compactions and per-run rows into the scenario summary", () => {
    const run = (overrides: Partial<RunRecord>): RunRecord => ({ blocked: [], compactions: 1, costUsd: null, inputTokens: 1_000_000,
      outputTokens: 100_000, rounds: 200, scenario: "S6", success: true, toolCalls: 250, wallSeconds: 1_800, ...overrides });
    const summary = scenarioSummary("S6", [run({ run: 1 }), run({ compactions: 2, run: 2, requestStats: seriesStats([100, 200]) })]);
    expect(summary).toMatchObject({ compactionsTotal: 3, costEstimates: { frontier: { cached85: 5.88, noCache: 12 } },
      inputTokensTotal: 2_000_000, outputTokensTotal: 200_000 });
    expect(summary.runsDetail).toEqual([
      expect.objectContaining({ compactions: 1, requestStats: null, run: 1 }),
      expect.objectContaining({ compactions: 2, costEstimates: costEstimates(1_000_000, 100_000),
        requestStats: expect.objectContaining({ slopePerRequest: 100 }), run: 2 })
    ]);
    expect(scenarioSummary("S6", [run({ compactions: null })]).compactionsTotal).toBeNull();
  });
});

describe("expected bounds", () => {
  it("only records bounds by default and demands the shipped unlimited defaults when asked", () => {
    expect(boundsExpectation(undefined)).toBe("any");
    expect(boundsExpectation(" unlimited ")).toBe("unlimited");
    expect(() => boundsExpectation("strict")).toThrow("browser_scenarios_expect_bounds_invalid");
    const unlimited = { maxToolCalls: "none", maxToolRounds: "none", turnTimeoutSeconds: 3_600 } as const;
    expect(unexpectedBounds(unlimited, "unlimited")).toEqual([]);
    expect(unexpectedBounds({ maxToolCalls: 320, maxToolRounds: 160, turnTimeoutSeconds: 1_800 }, "unlimited"))
      .toEqual(["tool_calls_limited", "tool_rounds_limited", "turn_timeout_not_3600"]);
    expect(unexpectedBounds({ ...unlimited, turnTimeoutSeconds: "none" }, "unlimited")).toEqual(["turn_timeout_not_3600"]);
    expect(unexpectedBounds({ maxToolCalls: 320, maxToolRounds: 160, turnTimeoutSeconds: 1_800 }, "any")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  BROWSER_SCENARIOS, BROWSER_RESULT_FILE, BROWSER_RESULT_MAX_BYTES, blockedCodes, median, parseBrowserResult, priceValue,
  requireBrowserScenarioStand, runBounds, scenarioSummary, selectedScenarios, toolCallStats, urlOnDomain, usageEvidence,
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

describe("scenario oracles", () => {
  const amazonItem = (index: number, offer: boolean) =>
    ({ currency: "EUR", name: `Item ${index}`, offer, price: 1 + index, url: `https://www.amazon.es/dp/${index}` });

  it("S1 needs 8 priced amazon.es items in euros, 2 of them offers", () => {
    const oracle = BROWSER_SCENARIOS.S1.oracle;
    const items = Array.from({ length: 8 }, (_, index) => amazonItem(index, index < 2));
    expect(oracle({ items })).toEqual([]);
    expect(oracle({ items: items.slice(0, 7) })).toEqual(["items_lt_8"]);
    expect(oracle({ items: items.map((item) => ({ ...item, offer: false })) })).toEqual(["offers_lt_2"]);
    expect(oracle({ items: items.map((item) => ({ ...item, currency: "USD" })) })).toEqual(["items_lt_8", "offers_lt_2"]);
    expect(oracle({ items: items.map((item) => ({ ...item, url: "https://www.amazon.com/dp/1" })) })).toEqual(["items_lt_8", "offers_lt_2"]);
    expect(oracle({})).toEqual(["items_lt_8", "offers_lt_2"]);
  });

  it("S2 needs 3 priced cart lines whose sum matches the subtotal within 0.02", () => {
    const oracle = BROWSER_SCENARIOS.S2.oracle;
    const lines = [{ line_total: 1.15, name: "A", quantity: 1 }, { line_total: "2,30", name: "B", quantity: 1 }, { line_total: 3.05, name: "C" }];
    expect(oracle({ cart: { lines, subtotal: 6.5 } })).toEqual([]);
    expect(oracle({ cart: { lines, subtotal: 6.52 } })).toEqual([]);
    expect(oracle({ cart: { lines, subtotal: 6.55 } })).toEqual(["cart_subtotal_mismatch"]);
    expect(oracle({ cart: { lines: lines.slice(0, 2), subtotal: 3.45 } })).toEqual(["cart_lines_not_3"]);
    expect(oracle({ cart: { lines: [...lines.slice(0, 2), { name: "C", line_total: "n/a" }], subtotal: 6.5 } }))
      .toEqual(["cart_line_price_invalid"]);
    expect(oracle({ cart: { lines } })).toEqual(["cart_subtotal_invalid"]);
    expect(oracle({ blocked: ["bot_wall"] })).toEqual(["cart_missing"]);
  });

  it("S3 needs the overview totals of the two items and an unfinished order", () => {
    const oracle = BROWSER_SCENARIOS.S3.oracle;
    expect(oracle({ checkout: { finished: false, item_total: 39.98, tax: "3.20" } })).toEqual([]);
    expect(oracle({ checkout: { finished: true, item_total: 39.98, tax: 3.2 } })).toEqual(["order_not_proven_unfinished"]);
    expect(oracle({ checkout: { item_total: 29.99, tax: 2.4 } }))
      .toEqual(["item_total_mismatch", "tax_mismatch", "order_not_proven_unfinished"]);
    expect(oracle({})).toEqual(["checkout_missing"]);
  });

  it("S4 needs 5 priced booking.com entries", () => {
    const oracle = BROWSER_SCENARIOS.S4.oracle;
    const items = Array.from({ length: 5 }, (_, index) =>
      ({ currency: "EUR", name: `Hotel ${index}`, price: 200 + index, url: `https://www.booking.com/hotel/es/${index}.html` }));
    expect(oracle({ items })).toEqual([]);
    expect(oracle({ items: [...items.slice(0, 4), { ...items[4], url: "https://www.expedia.es/h" }] })).toEqual(["items_lt_5"]);
  });

  it("keeps S5 unavailable until the handoff harness exists", () => {
    expect(BROWSER_SCENARIOS.S5.availability).toBe("not_available");
    expect(BROWSER_SCENARIOS.S5.interaction).toBeUndefined();
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

describe("selection and evidence", () => {
  it("selects scenarios in canonical order and refuses unknown or repeated ids", () => {
    expect(selectedScenarios(undefined)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(selectedScenarios("s3, S1")).toEqual(["S1", "S3"]);
    expect(() => selectedScenarios("S6")).toThrow("browser_scenarios_scenarios_invalid");
    expect(() => selectedScenarios("S1,S1")).toThrow("browser_scenarios_scenarios_invalid");
  });

  it("counts tool calls, tool rounds, image analyses and failures", () => {
    expect(toolCallStats([
      { roundIndex: 1, state: "complete", toolName: "mcp_workspace_sandbox_exec" },
      { roundIndex: 1, state: "error", toolName: "mcp_workspace_sandbox_exec" },
      { roundIndex: 3, state: "complete", toolName: "analyze_image" }
    ])).toEqual({ analyzeImageCalls: 1, failedToolCalls: 1, rounds: 3, toolCalls: 3 });
    expect(toolCallStats([])).toEqual({ analyzeImageCalls: 0, failedToolCalls: 0, rounds: 0, toolCalls: 0 });
  });

  it("keeps cost unknown unless every usage row carries a provider-reported charge", () => {
    const reported = { costReported: true, estimatedCostMicros: 1_500, inputTokens: 100, outputTokens: 10 };
    expect(usageEvidence([reported, reported])).toEqual({ costUsd: 0.003, inputTokens: 200, outputTokens: 20, usageEvents: 2 });
    expect(usageEvidence([reported, { ...reported, costReported: false }]).costUsd).toBeNull();
    expect(usageEvidence([])).toEqual({ costUsd: null, inputTokens: null, outputTokens: null, usageEvents: 0 });
  });

  it("aggregates one baseline row per scenario", () => {
    const run = (overrides: Partial<RunRecord>): RunRecord => ({ blocked: [], costUsd: null, inputTokens: 1_000,
      outputTokens: 10, rounds: 4, scenario: "S1", success: false, toolCalls: 10, wallSeconds: 100, ...overrides });
    const summary = scenarioSummary("S1", [
      run({ blocked: ["bot_wall"], rounds: 2, toolCalls: 6, wallSeconds: 60.15 }),
      run({ blocked: ["bot_wall", "captcha"], success: true, rounds: 6, outputTokens: null }),
      run({ scenario: "S2", success: true })
    ]);
    expect(summary).toEqual({ blocked: { bot_wall: 2, captcha: 1 }, costKnownRuns: 0, costUsdTotal: null, inputTokensTotal: 2_000,
      medianRounds: 4, medianToolCalls: 8, medianWallSeconds: 80.1, outputTokensTotal: null, runs: 2, scenario: "S1", successes: 1 });
    expect(scenarioSummary("S2", [run({ costUsd: 0.25, scenario: "S2" }), run({ costUsd: 0.5, scenario: "S2" })]).costUsdTotal).toBe(0.75);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });
});

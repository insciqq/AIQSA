import { describe, expect, it } from "vitest";
import type { CatalogModel } from "../lib/contracts/catalog";
import type { ChatDetailWire, ChatMessageWire } from "../lib/contracts/chats";
import type { ContextCompactionStatus } from "../lib/contracts/contextCompaction";
import type { SessionContextStatus } from "../lib/contracts/sessionStatus";
import {
  JOURNEY_CORRECTIONS,
  JOURNEY_LIMITS,
  JourneyFailure,
  codexLbSetupBody,
  catalogReadiness,
  contextWindowUpdate,
  debugHttpLine,
  debugPath,
  deploymentUsability,
  journeyBrief,
  journeyConfig,
  journeyExitCode,
  journeyFiller,
  journeyProse,
  journeyReuseDecision,
  journeyRound,
  journeyRunParams,
  journeyVerdict,
  ledgerInputTokens,
  listItemCount,
  messageText,
  modelInConnection,
  nextFillerTokens,
  probeAnswerCarriesCorrections,
  quickSetupCandidate,
  readConnections,
  settledTurn,
  stableCode,
  type JourneyRound
} from "./context-compaction-journey-support";

// A fake estimate: one token per four UTF-16 units. The real stand estimate is
// never loaded here.
const estimate = (text: string) => Math.ceil(text.length / 4);

function failureCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof JourneyFailure ? error.code : "unexpected";
  }
}

describe("journey configuration", () => {
  it("skips routes without keys and defaults the stand, window and turn bound", () => {
    const config = journeyConfig({});
    expect(config.baseUrl.origin).toBe("http://127.0.0.1:3000");
    expect(config).toMatchObject({ cleanupProviders: false, contextWindow: 32_768, debug: false, explicitRoutes: false, maxTurns: 12 });
    expect(config.routes).toEqual([
      { route: "anthropic", skipped: "api_key_missing" },
      { route: "codex-lb", skipped: "api_key_missing" }
    ]);
  });

  it("reads explicit routes, models, keys and the profile fallback root", () => {
    const config = journeyConfig({
      AIQSA_JOURNEY_ANTHROPIC_MODEL: "claude-test",
      AIQSA_JOURNEY_CLEANUP_PROVIDERS: "1",
      AIQSA_JOURNEY_CONTEXT_WINDOW: "16384",
      AIQSA_JOURNEY_MAX_TURNS: "8",
      AIQSA_JOURNEY_ROUTES: "codex-lb, anthropic",
      ANTHROPIC_API_KEY: "a-key",
      CODEX_LB_API_KEY: "c-key"
    }, () => "https://lb.example.test/v1/");
    expect(config).toMatchObject({ cleanupProviders: true, contextWindow: 16_384, explicitRoutes: true, maxTurns: 8 });
    expect(config.routes).toEqual([
      { apiKey: "c-key", apiRoot: "https://lb.example.test/v1", model: "gpt-5.5", route: "codex-lb" },
      { apiKey: "a-key", model: "claude-test", route: "anthropic" }
    ]);
    expect(journeyConfig({ AIQSA_JOURNEY_ROUTES: "codex-lb", CODEX_LB_API_KEY: "c-key" }).routes)
      .toEqual([{ route: "codex-lb", skipped: "base_url_missing" }]);
    const cliRoot = journeyConfig({ AIQSA_JOURNEY_DEBUG: "1", AIQSA_JOURNEY_ROUTES: "codex-lb", CODEX_LB_API_KEY: "c-key",
      CODEX_LB_BASE_URL: "https://lb.example.test/backend-api/codex/" });
    expect(cliRoot.debug).toBe(true);
    expect(cliRoot.routes[0]).toMatchObject({ apiRoot: "https://lb.example.test/v1" });
  });

  it("rejects unsafe stands, unknown routes and out-of-range bounds", () => {
    expect(failureCode(() => journeyConfig({ AIQSA_JOURNEY_BASE_URL: "http://stand.example.test" }))).toBe("base_url_invalid");
    expect(failureCode(() => journeyConfig({ AIQSA_JOURNEY_BASE_URL: "http://user:pw@127.0.0.1:3000" }))).toBe("base_url_invalid");
    expect(journeyConfig({ AIQSA_JOURNEY_BASE_URL: "https://stand.example.test/app" }).baseUrl.href)
      .toBe("https://stand.example.test/");
    expect(failureCode(() => journeyConfig({ AIQSA_JOURNEY_ROUTES: "openai" }))).toBe("routes_invalid");
    expect(failureCode(() => journeyConfig({ AIQSA_JOURNEY_CONTEXT_WINDOW: "200000" })))
      .toBe("aiqsa_journey_context_window_invalid");
    expect(failureCode(() => journeyConfig({ AIQSA_JOURNEY_MAX_TURNS: "13" }))).toBe("aiqsa_journey_max_turns_invalid");
  });
});

describe("journey text", () => {
  it("generates stable digit-free Cyrillic prose of the requested size", () => {
    const prose = journeyProse(7, 2_000, estimate);
    expect(prose).toBe(journeyProse(7, 2_000, estimate));
    expect(prose).not.toBe(journeyProse(8, 2_000, estimate));
    expect(prose).toMatch(/[а-яё]/iu);
    expect(prose).not.toMatch(/\d/u);
    expect(estimate(prose)).toBeGreaterThanOrEqual(2_000);
    expect(estimate(prose)).toBeLessThan(2_000 + 400);
  });

  it("states the original facts once in the brief and keeps fillers free of numbers", () => {
    const brief = journeyBrief(3_000, estimate);
    expect(brief).toContain("3 недели");
    expect(brief).toContain("120 тысяч евро");
    expect(brief.match(/\d+/gu)).toEqual(["3", "120"]);
    expect(journeyFiller(2, 1_000, estimate)).not.toMatch(/\d/u);
    expect(JOURNEY_CORRECTIONS.join(" ")).toMatch(/5 недель.*175 тысяч/u);
  });

  it("steps fillers toward the trigger without jumping past the pass window", () => {
    expect(nextFillerTokens({ approximateInputTokens: 5_000, budgetTokens: 28_000 })).toBe(3_360);
    expect(nextFillerTokens({ approximateInputTokens: 21_000, budgetTokens: 28_000 })).toBe(3_080);
    expect(nextFillerTokens({ approximateInputTokens: 22_399, budgetTokens: 28_000 })).toBe(1_681);
    expect(nextFillerTokens({ approximateInputTokens: 22_400, budgetTokens: 28_000 })).toBeNull();
    // A tiny budget still sends a meaningful filler rather than an empty one.
    expect(nextFillerTokens({ approximateInputTokens: 700, budgetTokens: 1_000 })).toBe(JOURNEY_LIMITS.fillerMinTokens);
  });
});

describe("probe answer check", () => {
  it("accepts the corrected facts as a three-item list", () => {
    expect(probeAnswerCarriesCorrections("- Срок: 5 недель\n- Бюджет: 175 тысяч евро\n- Исправления учтены")).toBe(true);
    expect(probeAnswerCarriesCorrections("1. Итоговый срок — пять недель.\n2. БЮДЖЕТ — 175 000 евро.\n3. Правило соблюдено.")).toBe(true);
  });

  it("rejects stale facts, missing facts and other list shapes", () => {
    expect(probeAnswerCarriesCorrections("- Срок: 3 недели\n- Бюджет: 120 тысяч евро\n- Готово")).toBe(false);
    expect(probeAnswerCarriesCorrections("- Срок: 5 недель\n- Бюджет: 1750 тысяч\n- Готово")).toBe(false);
    expect(probeAnswerCarriesCorrections("- Срок: 5 недель\n- Бюджет: 175 тысяч евро")).toBe(false);
    expect(probeAnswerCarriesCorrections("Срок 5 недель, бюджет 175 тысяч евро.")).toBe(false);
  });

  it("counts only top-level list items", () => {
    expect(listItemCount("1. a\n   - nested\n   - nested\n2. b\n3) c")).toBe(3);
    expect(listItemCount("plain text")).toBe(0);
  });
});

function catalogModel(overrides: Partial<CatalogModel>): CatalogModel {
  return {
    capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false,
      openRouterPerplexitySearch: false, reasoning: true, streaming: true, toolCalling: true },
    contextWindow: 32_768,
    defaultParams: {},
    displayName: "Model",
    modelId: "model-row",
    parameterControls: {
      background: { defaultValue: false, supported: true },
      maxOutputTokens: { defaultValue: 8_192, maxValue: 64_000 },
      reasoningEffort: { defaultValue: "high", options: ["low", "medium", "high"], supported: true },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "connection-row",
    searchStrategyIds: [],
    ...overrides
  };
}

describe("run parameters", () => {
  it("turns Anthropic thinking off when the model offers no effort", () => {
    const params = journeyRunParams(catalogModel({
      defaultParams: { outputConfig: { effort: "high" }, reasoning: {}, thinking: { enabled: true } },
      parameterControls: { ...catalogModel({}).parameterControls,
        reasoningEffort: { defaultValue: "high", options: ["none", "low", "high"], supported: true } },
      providerFamily: "anthropic"
    }), 2_048);
    expect(params).toEqual({ maxTokens: 2_048, outputConfig: { effort: "none" }, temperature: 1,
      thinking: { budgetTokens: 0, enabled: false, type: "adaptive" } });
  });

  it("uses the lowest compatible Responses effort and the answer ceiling", () => {
    const params = journeyRunParams(catalogModel({
      defaultParams: { reasoning: { summary: "auto" } },
      parameterControls: { ...catalogModel({}).parameterControls, maxOutputTokens: { defaultValue: 4_096, maxValue: 1_000 } },
      providerFamily: "openai_compatible"
    }), 2_048);
    expect(params).toEqual({ background: false, maxOutputTokens: 1_000, reasoning: { effort: "low", summary: "auto" },
      stream: true, temperature: 1 });
    expect(failureCode(() => journeyRunParams(catalogModel({ providerFamily: "gemini" }), 2_048)))
      .toBe("model_family_unsupported");
  });
});

const modelConfig = (upstreamModelId: string, contextWindow?: number) => ({
  adapterKind: "anthropic_messages" as const, answerSelectable: true, defaultParams: {}, modelClass: "answer" as const,
  capabilities: { nativePdfInput: false, nativeSearch: false, pdf: true, reasoning: true, vision: true,
    ...(contextWindow ? { contextWindow } : {}) },
  upstreamModelId
});

const liveModel = { activeConfig: modelConfig("claude-sonnet-5", 200_000), activeVersion: 3, displayName: "Sonnet",
  draftConfig: modelConfig("claude-sonnet-5", 200_000), draftVersion: 4, enabled: true, id: "m-live",
  updatedAt: "2026-09-27T11:00:00.000Z" };
const liveConnection = {
  activeChecks: [{ connectionVersion: 2, credentialId: "k1", credentialVersionId: "kv1", modelVersion: 3,
    providerModelId: "m-live", status: "available" }],
  activeConfig: { apiRoot: "https://api.example.test/" }, activeVersion: 2, defaultCredentialId: "k1",
  credentials: [{ activeVersion: { id: "kv1", revokedAt: null }, enabled: true, id: "k1" }],
  enabled: true, family: "anthropic", id: "c-live", models: [liveModel]
};
// The seed's code-owned template: disabled, keyless and unpublished.
const seededTemplate = {
  activeChecks: [], activeConfig: null, activeVersion: 0, defaultCredentialId: null, credentials: [],
  draftConfig: { apiRoot: "https://api.example.test" }, enabled: false, family: "anthropic", id: "c-template",
  models: [{ activeConfig: null, activeVersion: 0, displayName: "Sonnet", draftConfig: modelConfig("claude-sonnet-5"),
    draftVersion: 1, enabled: true, id: "m-template", updatedAt: "2026-09-27T10:00:00.000Z" }]
};
// Published and keyed, but its only check belongs to an older model version.
const staleConnection = { ...liveConnection, checkRun: { state: "running" }, id: "c-stale",
  activeChecks: [{ ...liveConnection.activeChecks[0]!, modelVersion: 2, providerModelId: "m-stale" }],
  models: [{ ...liveModel, id: "m-stale" }] };
const providersResponse = { connections: [seededTemplate, staleConnection, liveConnection] };

describe("admin provider projection", () => {
  it("reads the connection state the reuse decision needs", () => {
    const connections = readConnections(providersResponse)!;
    expect(connections.map(({ active, apiRoot, checkRunning, defaultCredentialVersionId, id }) =>
      ({ active, apiRoot, checkRunning, defaultCredentialVersionId, id }))).toEqual([
      { active: false, apiRoot: "https://api.example.test", checkRunning: false, defaultCredentialVersionId: null, id: "c-template" },
      { active: true, apiRoot: "https://api.example.test", checkRunning: true, defaultCredentialVersionId: "kv1", id: "c-stale" },
      { active: true, apiRoot: "https://api.example.test", checkRunning: false, defaultCredentialVersionId: "kv1", id: "c-live" }
    ]);
    expect(readConnections({ connections: [{ id: "x" }] })).toBeNull();
  });

  it("reuses only a usable deployment and explains every candidate with booleans", () => {
    const connections = readConnections(providersResponse)!;
    const decision = journeyReuseDecision(connections, { family: "anthropic", upstreamModelId: "claude-sonnet-5" });
    expect(decision.reason).toBe("usable");
    expect(decision.match?.model.id).toBe("m-live");
    expect(decision.candidates).toEqual([
      { checkAvailable: false, connectionActive: false, connectionEnabled: false, credentialActive: false,
        modelActive: false, modelEnabled: true, usable: false },
      { checkAvailable: false, connectionActive: true, connectionEnabled: true, credentialActive: true,
        modelActive: true, modelEnabled: true, usable: false },
      { checkAvailable: true, connectionActive: true, connectionEnabled: true, credentialActive: true,
        modelActive: true, modelEnabled: true, usable: true }
    ]);
    expect(JSON.stringify(decision.candidates)).not.toMatch(/c-|m-|k1|kv1/u);
  });

  it("falls back to setup for the seeded keyless template, a revoked key or another endpoint", () => {
    const template = readConnections({ connections: [seededTemplate] })!;
    expect(journeyReuseDecision(template, { family: "anthropic", upstreamModelId: "claude-sonnet-5" }))
      .toMatchObject({ match: null, reason: "not_usable" });
    const revoked = readConnections({ connections: [{ ...liveConnection,
      credentials: [{ activeVersion: { id: "kv1", revokedAt: "2026-09-27T12:00:00.000Z" }, enabled: true, id: "k1" }] }] })!;
    expect(deploymentUsability(revoked[0]!, revoked[0]!.models[0]!)).toMatchObject({ credentialActive: false, usable: false });
    const connections = readConnections(providersResponse)!;
    expect(journeyReuseDecision(connections, { apiRoot: "https://other.test", family: "anthropic", upstreamModelId: "claude-sonnet-5" }))
      .toMatchObject({ candidates: [], match: null, reason: "no_candidate" });
    expect(journeyReuseDecision(connections, { family: "openai_compatible", upstreamModelId: "claude-sonnet-5" }).reason)
      .toBe("no_candidate");
    expect(modelInConnection(connections[0]!, "claude-sonnet-5")?.id).toBe("m-template");
  });

  it("publishes the journey window as the administrator-set context window only when it differs", () => {
    const model = readConnections(providersResponse)![2]!.models[0]!;
    const update = contextWindowUpdate(model, 32_768)!;
    expect(update).toMatchObject({
      action: "update", activate: true, displayName: "Sonnet", expectedActiveVersion: 3, expectedDisplayName: "Sonnet",
      expectedDraftVersion: 4, expectedUpdatedAt: "2026-09-27T11:00:00.000Z"
    });
    expect((update.configuration as { capabilities: { contextWindow: number; vision: boolean } }).capabilities)
      .toMatchObject({ contextWindow: 32_768, vision: true });
    const applied = { ...model, activeConfig: modelConfig("claude-sonnet-5", 32_768), draftConfig: modelConfig("claude-sonnet-5", 32_768) };
    expect(contextWindowUpdate(applied, 32_768)).toBeNull();
  });

  it("chooses the quick-setup candidate of the requested model", () => {
    const result = { candidates: [{ candidateId: "claude-opus-5", displayName: "Claude Opus 5" },
      { candidateId: "claude-sonnet-5", displayName: "Claude Sonnet 5" }], policyVersion: 2 };
    expect(quickSetupCandidate(result, "claude-sonnet-5")).toEqual({ candidateId: "claude-sonnet-5", policyVersion: 2 });
    expect(quickSetupCandidate(result, "unknown")).toEqual({ candidateId: "claude-opus-5", policyVersion: 2 });
    expect(quickSetupCandidate({ candidates: [], policyVersion: 1 }, "x")).toBeNull();
  });

  it("declares a tool-capable compatible Responses model with the journey window", () => {
    const body = codexLbSetupBody({ apiRoot: "https://lb.test/v1", catalogProof: "proof", connectionDisplayName: "J",
      contextWindow: 32_768, model: "gpt-5.5", secret: "s" });
    expect(body).toMatchObject({ authenticationMode: "bearer", catalogProof: "proof", confirmPaidRequest: true,
      connectionDisplayName: "J",
      modelIds: ["gpt-5.5"], protocol: "responses", capabilities: { contextWindow: 32_768, toolCalling: true } });
    expect(body).not.toHaveProperty("modelId");
    // The manual fallback: no receipt, one explicit id proven by setup's tiny generation.
    const manual = codexLbSetupBody({ apiRoot: "https://lb.test/v1", connectionDisplayName: "J", contextWindow: 16_384,
      model: "gpt-5.5", secret: "s" });
    expect(manual).toMatchObject({ modelId: "gpt-5.5" });
    expect(manual).not.toHaveProperty("catalogProof");
    expect(manual).not.toHaveProperty("modelIds");
  });
});

describe("catalog readiness and debug evidence", () => {
  it("names the last observed catalog state for the timeout code", () => {
    const ready = catalogModel({ providerFamily: "anthropic", upstreamModelId: "claude-sonnet-5" });
    expect(catalogReadiness(undefined, 32_768)).toBe("catalog_model_missing");
    expect(catalogReadiness(catalogModel({}), 32_768)).toBe("catalog_model_identity_missing");
    expect(catalogReadiness({ ...ready, contextWindow: 200_000 }, 32_768)).toBe("catalog_window_not_applied");
    expect(catalogReadiness({ ...ready, capabilities: { ...ready.capabilities, toolCalling: false } }, 32_768))
      .toBe("catalog_tool_calling_unavailable");
    expect(catalogReadiness(ready, 32_768)).toBe("ready");
  });

  it("redacts ids and queries from debug paths", () => {
    expect(debugPath("/api/admin/providers/3f2c9a1e-0000-4000-8000-000000000001/models/cm1abc?x=1"))
      .toBe("/api/admin/providers/<id>/models/<id>");
    expect(debugPath("/api/admin/providers/custom-setup/discover")).toBe("/api/admin/providers/custom-setup/discover");
    expect(debugPath("/api/chats/provider-anthropic/delete-permanently/status")).toBe("/api/chats/<id>/delete-permanently/status");
    expect(debugPath("/api/me/chats/abc/memory-mode")).toBe("/api/me/chats/<id>/memory-mode");
  });

  it("keeps only stable codes of a JSON body in a debug line", () => {
    expect(debugHttpLine({ body: { error: "provider_custom_setup_discovery_failed", message: "sk-secret upstream text",
      secret: "sk-secret" }, method: "POST", path: "/api/admin/providers/custom-setup/discover", stage: "provider_setup",
      status: 422 })).toEqual({ debug: "http", error: "provider_custom_setup_discovery_failed", method: "POST",
      path: "/api/admin/providers/custom-setup/discover", stage: "provider_setup", status: 422 });
    expect(debugHttpLine({ body: { code: "Some Message With Spaces", outcome: "ready", error: "x".repeat(65) },
      method: "GET", path: "/api/me/catalog", stage: "catalog", status: 200 }))
      .toEqual({ debug: "http", method: "GET", outcome: "ready", path: "/api/me/catalog", stage: "catalog", status: 200 });
    expect(debugHttpLine({ method: "GET", path: "/api/admin", stage: "evidence", status: null }))
      .toEqual({ debug: "http", method: "GET", path: "/api/admin", stage: "evidence", status: null });
    expect(stableCode("provider_draft_stale")).toBe("provider_draft_stale");
    expect(stableCode("Bearer abc")).toBeNull();
  });
});

describe("usage ledger", () => {
  const dashboard = { usage: { byUser: [{ providerModels: [
    { inputTokens: 1_200, modelId: "model-row", provider: "connection-row" },
    { inputTokens: 300, modelId: "gpt-5.5", provider: "openai_compatible" },
    { inputTokens: 999, modelId: "other", provider: "connection-row" },
    { inputTokens: null, modelId: "model-row", provider: "anthropic" }
  ], userId: "u1" }] } };
  const keys = { modelIds: ["model-row", "gpt-5.5"], providers: ["connection-row", "openai_compatible", "anthropic"] };

  it("sums provider-reported input tokens of the route's model only", () => {
    expect(ledgerInputTokens(dashboard, "u1", keys)).toBe(1_500);
    expect(ledgerInputTokens(dashboard, "u2", keys)).toBe(0);
    expect(ledgerInputTokens({ usage: {} }, "u1", keys)).toBeNull();
  });
});

function message(overrides: Partial<ChatMessageWire>): ChatMessageWire {
  return { citationMessageId: null, content: { blocks: [] }, createdAt: "2026-09-27T10:00:00.000Z", errorMessage: null,
    id: "m", modelId: null, modelRunId: null, parentMessageId: null, provider: null, role: "user", status: "complete", ...overrides };
}

describe("chat projection", () => {
  it("finds the terminal answer to the message sent after the previous leaf", () => {
    const messages = [
      message({ id: "u1" }),
      message({ content: { blocks: [{ text: "ответ", type: "text" }] }, id: "a1", parentMessageId: "u1", role: "assistant" }),
      message({ id: "u2", parentMessageId: "a1" }),
      message({ id: "a2", parentMessageId: "u2", role: "assistant", status: "streaming" })
    ];
    const detail = { messages } as unknown as ChatDetailWire;
    expect(settledTurn(detail, null)?.assistant.id).toBe("a1");
    expect(settledTurn(detail, "a1")).toBeNull();
    expect(messageText(messages[1]!)).toBe("ответ");
  });
});

const session = (approximateInputTokens: number, phase: SessionContextStatus["phase"] = "after_answer"): SessionContextStatus => ({
  approximateInputTokens, contextWindow: 32_768, droppedMessages: 0, loadedTools: 1, maxOutputTokens: 2_048,
  modelId: "claude-sonnet-5", phase, provider: "anthropic", safetyMarginTokens: 3_276, version: 1
});
const summary = (beforeTokens: number): ContextCompactionStatus => ({
  afterTokens: 9_000, beforeTokens, cycle: 1, outcome: "summary_applied", reducedTokens: beforeTokens - 9_000,
  stage: "settled", state: "complete", version: 1
});

describe("round evidence and verdict", () => {
  it("measures the final request and compares single-round turns only", () => {
    // Budget: 32768 - 2048 - 3276 = 27444.
    expect(journeyRound({ answerTokens: 400, compaction: null, kind: "filler", reportedInputTokens: 11_000,
      session: session(10_400), toolCalls: 0, turn: 5 })).toEqual({
      budgetShare: 0.364, compactionOutcome: null, estimatedInputTokens: 10_000, kind: "filler", ratio: 1.1,
      reportedInputTokens: 11_000, summaryAtBudgetShare: null, turn: 5 });
    const summarized = journeyRound({ answerTokens: 400, compaction: summary(23_328), kind: "filler",
      reportedInputTokens: 40_000, session: session(9_400), toolCalls: 0, turn: 8 });
    expect(summarized).toMatchObject({ compactionOutcome: "summary_applied", ratio: null, summaryAtBudgetShare: 0.85 });
    expect(journeyRound({ answerTokens: 0, compaction: null, kind: "rule", reportedInputTokens: null, session: null,
      toolCalls: 0, turn: 4 })).toMatchObject({ budgetShare: null, estimatedInputTokens: null, ratio: null });
    expect(journeyRound({ answerTokens: 500, compaction: null, kind: "probe", reportedInputTokens: 900,
      session: session(1_000, "request"), toolCalls: 1, turn: 9 })).toMatchObject({ estimatedInputTokens: 1_000, ratio: null });
  });

  const round = (overrides: Partial<JourneyRound>): JourneyRound => ({ budgetShare: 0.5, compactionOutcome: null,
    estimatedInputTokens: 1, kind: "filler", ratio: null, reportedInputTokens: 1, summaryAtBudgetShare: null, turn: 1, ...overrides });

  it("passes only a summary bought inside the window with a correct probe", () => {
    const bought = [round({}), round({ compactionOutcome: "summary_applied", summaryAtBudgetShare: 0.84, turn: 2 })];
    expect(journeyVerdict(bought, true)).toEqual({ code: null, compactionTriggered: true, firstSummaryAtBudgetShare: 0.84, passed: true });
    expect(journeyVerdict(bought, false).code).toBe("probe_answer_missing_corrections");
    expect(journeyVerdict([round({})], true).code).toBe("compaction_not_triggered");
    expect(journeyVerdict([round({ compactionOutcome: "summary_failed" })], true).code).toBe("summary_not_bought");
    expect(journeyVerdict([round({ compactionOutcome: "summary_applied", summaryAtBudgetShare: 0.97 })], true).code)
      .toBe("summary_share_out_of_range");
  });

  it("exits 0 only when every executed route passed and none requested was skipped", () => {
    expect(journeyExitCode([{ status: "passed" }, { status: "skipped" }], false)).toBe(0);
    expect(journeyExitCode([{ status: "passed" }, { status: "skipped" }], true)).toBe(1);
    expect(journeyExitCode([{ status: "passed" }, { status: "failed" }], false)).toBe(1);
    expect(journeyExitCode([{ status: "skipped" }], false)).toBe(1);
  });
});

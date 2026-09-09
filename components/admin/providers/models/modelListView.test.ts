import { describe, expect, it } from "vitest";
import type { ProviderUsageSources } from "@/components/admin/providers/providerListView";
import {
  FIXTURE_NOW,
  fixtureCheck,
  fixtureCheckRun,
  fixtureCredential,
  fixtureModel,
  workingConnection
} from "@/components/admin/providers/providerFixtures";
import type { AdminSystemModelPolicyCatalog } from "@/lib/contracts/adminSystemModelPolicy";
import {
  activeModelCheck,
  checkableCredentials,
  diagnosticCheckRun,
  deriveModelUsage,
  groupProviderModels,
  initialDiagnosticCredentialId,
  modelCheckSummaries,
  modelEditorCheck,
  modelRouteLabel,
  modelSuccessor,
  modelTitle,
  turnOffConsequence
} from "./modelListView";

const NOW = new Date(FIXTURE_NOW);

function candidate(id: string, displayName: string) {
  return { connectionDisplayName: "OpenRouter", connectionId: "conn-or", displayName, id };
}

function sources(overrides: Partial<ProviderUsageSources> = {}): ProviderUsageSources {
  const policy: AdminSystemModelPolicyCatalog["policy"] = {
    chatPdfModel: { ...candidate("model-terra", "GPT-5.6 Terra"), available: true, defaultReasoningEffort: null, forcedToolCall: "verified", reasoningEfforts: [], structuredOutput: "verified" },
    chatPdfReasoningEffort: null,
    reasoningEffort: null,
    rerankerModel: { ...candidate("model-voyage", "Voyage Rerank 2.5"), available: true },
    rerankerRoute: {
      entries: [
        { ...candidate("model-voyage", "Voyage Rerank 2.5"), available: true, position: 0, relevanceScoreFloor: null, role: "primary" },
        { ...candidate("model-cohere", "Cohere Rerank 4 Pro"), available: true, position: 1, relevanceScoreFloor: null, role: "fallback" },
        { ...candidate("model-qwen", "Qwen3 Reranker 8B"), available: false, position: 2, relevanceScoreFloor: 0.01, role: "fallback" }
      ],
      policyVersion: "openrouter-reranker-route-v1"
    },
    systemModel: { ...candidate("model-terra", "GPT-5.6 Terra"), available: true, defaultReasoningEffort: null, forcedToolCall: "verified", reasoningEfforts: [], structuredOutput: "verified" },
    updatedAt: FIXTURE_NOW,
    updatedBy: null,
    version: 1
  };
  return {
    knowledge: null,
    modelPolicy: {
      candidates: [],
      policy: {
        defaultModel: { ...candidate("model-luna", "GPT-5.6 Luna"), available: true, defaultReasoningEffort: null, reasoningEfforts: [] },
        maxMcpToolsPerDiscovery: 8,
        maxToolCalls: 8,
        maxToolRounds: 4,
        mcpAutoDiscoveryMaxOutputTokens: 8192,
        mcpAutoDiscoveryTimeoutSeconds: 30,
        reasoningEffort: null,
        updatedAt: FIXTURE_NOW,
        updatedBy: null,
        version: 1
      }
    },
    search: null,
    systemModelPolicy: {
      candidates: [],
      documentCandidates: [],
      ineligible: { direct_pdf: [], memory: [], vision: [] },
      policy,
      rerankerCandidates: [],
      verificationCandidates: []
    },
    ...overrides
  };
}

describe("groupProviderModels", () => {
  it("orders Chat models, Rerankers, Embeddings, hides empty groups and sorts by name", () => {
    const models = [
      fixtureModel({ connectionId: "c", displayName: "Qwen3 Embedding 8B", draftConfig: { ...fixtureModel({ connectionId: "c", displayName: "x", id: "x" }).draftConfig, modelClass: "embedding" }, id: "emb", modelClass: "embedding" }),
      fixtureModel({ connectionId: "c", displayName: "Gemini Pro Latest", id: "gemini" }),
      fixtureModel({ connectionId: "c", displayName: "Claude Opus 4.8", id: "claude" })
    ];
    expect(groupProviderModels(models).map((group) => [group.title, group.models.map(({ id }) => id)])).toEqual([
      ["Chat models", ["claude", "gemini"]],
      ["Embeddings", ["emb"]]
    ]);
    expect(groupProviderModels([])).toEqual([]);
  });
});

describe("model row copy", () => {
  it("speaks the embedding dimension only in the title and the OpenRouter route only there", () => {
    const base = fixtureModel({ connectionId: "c", displayName: "Qwen3 Embedding 8B", id: "emb" });
    const embedding = {
      ...base,
      activeConfig: { ...base.draftConfig, embedding: { nativeDimension: 4_096, providerFamily: "openrouter" as const, queryInstructionTemplate: null, supportsMrl: true, targetDimension: 1_536 }, modelClass: "embedding" as const }
    };
    expect(modelTitle(embedding)).toBe("Qwen3 Embedding 8B · 1536d");
    expect(modelTitle(base)).toBe("Qwen3 Embedding 8B");

    const routed = { ...base, activeConfig: { ...base.draftConfig, openRouterRouting: { mode: "only_selected" as const, providers: ["anthropic"] } } };
    expect(modelRouteLabel({ family: "openrouter" }, routed)).toBe("via anthropic only");
    expect(modelRouteLabel({ family: "openrouter" }, { ...routed, activeConfig: { ...routed.activeConfig, openRouterRouting: { mode: "only_selected", providers: ["a", "b"] } } })).toBe("via 2 providers");
    expect(modelRouteLabel({ family: "openrouter" }, { ...base, activeConfig: { ...base.draftConfig, openRouterRouting: { mode: "automatic", providers: [] } } })).toBe("automatic routing");
    expect(modelRouteLabel({ family: "openai" }, routed)).toBeNull();
  });
});

describe("deriveModelUsage and successors", () => {
  it("tags each model with its roles and names the next available reranker", () => {
    const usage = deriveModelUsage(sources());
    expect(usage.get("model-terra")).toEqual(["System model", "Chat PDF"]);
    expect(usage.get("model-luna")).toEqual(["Default chat"]);
    expect(usage.get("model-voyage")).toEqual(["Reranker · primary"]);
    expect(usage.get("model-cohere")).toEqual(["Reranker · fallback"]);
    expect(modelSuccessor("model-voyage", sources())).toBe("Cohere Rerank 4 Pro");
    expect(modelSuccessor("model-cohere", sources())).toBeNull();
    expect(modelSuccessor("model-luna", sources())).toBeNull();
    expect(deriveModelUsage({ knowledge: null, modelPolicy: null, search: null, systemModelPolicy: null }).size).toBe(0);
  });

  it("writes the consequence dialog with the successor and the Nothing is deleted line", () => {
    const withSuccessor = turnOffConsequence({ model: { displayName: "Voyage Rerank 2.5" }, successor: "Cohere Rerank 4 Pro", tags: ["Reranker · primary"] });
    expect(withSuccessor?.title).toBe("Turn off Voyage Rerank 2.5?");
    expect(withSuccessor?.body).toBe(
      "It is the primary reranker for Memory and Knowledge. Cohere Rerank 4 Pro takes over automatically, and chats in progress keep using the current model until they finish.\n\nNothing is deleted. You can turn it back on at any time."
    );
    const withoutSuccessor = turnOffConsequence({ model: { displayName: "GPT-5.6 Luna" }, successor: null, tags: ["Default chat", "Perplexity Search"] });
    expect(withoutSuccessor?.body).toContain("It is the default chat model for new chats and the model behind “Perplexity Search” Search.");
    expect(withoutSuccessor?.body).toContain("Nothing takes over automatically");
    expect(turnOffConsequence({ model: { displayName: "x" }, successor: null, tags: [] })).toBeNull();
  });
});

describe("check summaries", () => {
  it("shows an incomplete access-only check, a running check and temporary failure without inventing retained evidence", () => {
    const connection = workingConnection();
    const model = connection.models[0]!;
    expect(modelEditorCheck(connection, model, "cred-primary", NOW)).toMatchObject({ status: "Not checked", summary: null });
    connection.activeChecks = [fixtureCheck({ credentialId: "cred-primary", providerModelId: model.id })];
    expect(modelEditorCheck(connection, model, "cred-primary", NOW)).toMatchObject({
      status: "Check incomplete", summary: expect.stringMatching(/Checked today .* with key Primary/)
    });
    connection.checkRun = fixtureCheckRun({ credentialId: "cred-primary", id: "run", inFlight: [model.id] });
    expect(modelEditorCheck(connection, model, "cred-primary", NOW).status).toBe("Checking");
    connection.checkRun = { ...connection.checkRun, failed: [model.id], inFlight: [], state: "completed" };
    expect(modelEditorCheck(connection, model, "cred-primary", NOW)).toMatchObject({ status: "Check failed", message: expect.stringContaining("Earlier results were kept.") });
    connection.activeChecks = [];
    expect(modelEditorCheck(connection, model, "cred-primary", NOW)).toMatchObject({ status: "Check failed", message: expect.stringContaining("No earlier result is available.") });
  });

  it.each(["credential version", "model version", "connection version", "model removed"])("keeps stale check summaries out of Edit after %s changes", (change) => {
    const connection = workingConnection();
    const model = connection.models[0]!;
    connection.activeChecks = [fixtureCheck({ credentialId: "cred-primary", providerModelId: model.id })];
    if (change === "credential version") connection.credentials[0]!.activeVersion!.id = "replacement";
    if (change === "model version") model.activeVersion += 1;
    if (change === "connection version") connection.activeVersion += 1;
    expect(modelEditorCheck(connection, change === "model removed" ? null : model, "cred-primary", NOW).summary).toBeNull();
  });

  it("selects a live named run, default, or sole key without changing any authority", () => {
    const connection = workingConnection();
    connection.defaultCredentialId = null;
    expect(initialDiagnosticCredentialId(connection)).toBe("cred-primary");
    connection.credentials.push(fixtureCredential({ id: "cred-other", label: "Other" }));
    expect(initialDiagnosticCredentialId(connection)).toBeNull();
    connection.defaultCredentialId = "cred-primary";
    expect(initialDiagnosticCredentialId(connection)).toBe("cred-primary");
    connection.checkRun = fixtureCheckRun({ credentialId: "cred-other", id: "run-other" });
    expect(initialDiagnosticCredentialId(connection)).toBe("cred-other");
    connection.credentials[1]!.enabled = false;
    expect(initialDiagnosticCredentialId(connection)).toBe("cred-primary");
    expect(connection.defaultCredentialId).toBe("cred-primary");
    expect(connection.userAssignments).toEqual([]);
  });

  it("rejects another key's run and runs preceding key or connection replacement", () => {
    const connection = workingConnection();
    connection.checkRun = fixtureCheckRun({ credentialId: "cred-primary", id: "run-primary" });
    expect(diagnosticCheckRun(connection, "cred-primary")).toBe(connection.checkRun);
    expect(diagnosticCheckRun(connection, "cred-other")).toBeNull();
    expect(diagnosticCheckRun(connection, null)).toBeNull();
    connection.credentials[0]!.activeVersion!.activatedAt = "2026-09-08T00:00:00.000Z";
    expect(diagnosticCheckRun(connection, "cred-primary")).toBeNull();
    connection.credentials[0]!.activeVersion!.activatedAt = FIXTURE_NOW;
    connection.activatedAt = "2026-09-08T00:00:00.000Z";
    expect(diagnosticCheckRun(connection, "cred-primary")).toBeNull();
  });

  it("finds and describes only the exact live pair selected for diagnostics", () => {
    const connection = workingConnection();
    connection.credentials.push(fixtureCredential({ id: "cred-research", label: "Research team" }));
    const model = connection.models[0]!;
    connection.activeChecks = [
      fixtureCheck({
        checkedAt: "2026-09-07T12:51:00.000Z",
        credentialId: "cred-primary",
        evidence: {
          compatibility: { directPdf: "verified", forcedToolCall: "not_supported", toolCalling: "verified", modelAccess: "verified", probeVersion: 2, streaming: "verified", structuredOutput: "verified", usage: "verified", vision: "verified" },
          detail: "ok",
          method: "tiny_generation",
          selectedProviders: [],
          upstreamModelId: model.draftConfig.upstreamModelId
        },
        providerModelId: model.id
      }),
      fixtureCheck({
        checkedAt: "2026-09-06T09:00:00.000Z",
        credentialId: "cred-research",
        evidence: {
          compatibility: { directPdf: "not_supported", forcedToolCall: "not_supported", toolCalling: "verified", modelAccess: "verified", probeVersion: 2, streaming: "verified", structuredOutput: "verified", usage: "not_supported" },
          detail: "ok",
          method: "tiny_generation",
          selectedProviders: [],
          upstreamModelId: model.draftConfig.upstreamModelId
        },
        providerModelId: model.id
      }),
      fixtureCheck({ credentialId: "cred-primary", modelVersion: 7, providerModelId: model.id })
    ];
    expect(activeModelCheck(connection, model, connection.credentials[0])?.checkedAt).toBe("2026-09-07T12:51:00.000Z");
    expect(activeModelCheck(connection, model, null)).toBeNull();
    expect(checkableCredentials(connection).map(({ id }) => id)).toEqual(["cred-primary", "cred-research"]);
    const summaries = connection.credentials.flatMap((credential) => modelCheckSummaries(connection, model, credential, NOW));
    // Local clock formatting: the hour depends on the test machine's time zone.
    expect(summaries.map((summary) => summary.sentence.replace(/\d{2}:\d{2}/u, "HH:MM"))).toEqual([
      "Checked today HH:MM with key Primary · tools, JSON and the other checked capabilities work.",
      "Checked Sep 6 HH:MM with key Research team · works without PDF input; tools and JSON output are fine."
    ]);
    expect(summaries.map((summary) => summary.usageMissing)).toEqual([false, true]);
    expect(modelCheckSummaries(connection, model, null, NOW)).toEqual([]);
    expect(modelCheckSummaries(connection, connection.models[1]!, connection.credentials[0], NOW)).toEqual([]);
  });
});

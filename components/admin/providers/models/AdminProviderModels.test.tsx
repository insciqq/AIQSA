import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type { ProviderUsageSources } from "@/components/admin/providers/providerListView";
import {
  FIXTURE_NOW,
  fixtureCheck,
  fixtureCheckRun,
  fixtureConnection,
  fixtureCredential,
  fixtureModel
} from "@/components/admin/providers/providerFixtures";
import type { AdminProviderConnection, AdminProviderTestEvidence } from "@/lib/contracts/adminProviders";
import { AdminProviderModels } from "./AdminProviderModels";

function evidence(upstreamModelId: string, overrides: Partial<NonNullable<AdminProviderTestEvidence["compatibility"]>> = {}): AdminProviderTestEvidence {
  return {
    compatibility: {
      directPdf: "verified",
      forcedToolCall: "verified",
      toolCalling: "verified",
      modelAccess: "verified",
      probeVersion: 2,
      streaming: "verified",
      structuredOutput: "verified",
      usage: "verified",
      vision: "verified",
      ...overrides
    },
    detail: "ok",
    method: "tiny_generation",
    selectedProviders: [],
    upstreamModelId
  };
}

function openRouter(): AdminProviderConnection {
  const opus = fixtureModel({ connectionId: "conn-or", displayName: "Claude Opus 4.8", id: "model-opus" });
  opus.draftConfig = { ...opus.draftConfig, adapterKind: "openrouter_chat_completions", openRouterRouting: { mode: "only_selected", providers: ["anthropic"] }, upstreamModelId: "anthropic/claude-opus-4.8" };
  opus.activeConfig = opus.draftConfig;
  const gemini = fixtureModel({ connectionId: "conn-or", displayName: "Gemini Pro Latest", id: "model-gemini" });
  gemini.draftConfig = { ...gemini.draftConfig, adapterKind: "openrouter_chat_completions", openRouterRouting: { mode: "automatic", providers: [] }, upstreamModelId: "google/gemini-pro-latest" };
  gemini.activeConfig = gemini.draftConfig;
  const sonar = fixtureModel({ connectionId: "conn-or", displayName: "Perplexity Sonar Pro Search", enabled: false, id: "model-sonar" });
  sonar.draftConfig = { ...sonar.draftConfig, adapterKind: "openrouter_chat_completions", upstreamModelId: "perplexity/sonar-pro-search" };
  sonar.activeConfig = sonar.draftConfig;
  const voyage = fixtureModel({ connectionId: "conn-or", displayName: "Voyage Rerank 2.5", id: "model-voyage", modelClass: "reranker" });
  voyage.draftConfig = { ...voyage.draftConfig, adapterKind: "openrouter_rerank", answerSelectable: false, modelClass: "reranker", upstreamModelId: "voyageai/rerank-2.5" };
  voyage.activeConfig = voyage.draftConfig;
  const cohere = fixtureModel({ connectionId: "conn-or", displayName: "Cohere Rerank 4 Pro", id: "model-cohere", modelClass: "reranker" });
  cohere.draftConfig = { ...cohere.draftConfig, adapterKind: "openrouter_rerank", answerSelectable: false, modelClass: "reranker", upstreamModelId: "cohere/rerank-4-pro" };
  cohere.activeConfig = cohere.draftConfig;
  const qwen = fixtureModel({ connectionId: "conn-or", displayName: "Qwen3 Embedding 8B", id: "model-qwen", modelClass: "embedding" });
  qwen.draftConfig = {
    ...qwen.draftConfig,
    adapterKind: "openai_embeddings_compatible",
    answerSelectable: false,
    embedding: { nativeDimension: 4_096, providerFamily: "openrouter", queryInstructionTemplate: null, supportsMrl: true, targetDimension: 1_536 },
    modelClass: "embedding",
    upstreamModelId: "qwen/qwen3-embedding-8b"
  };
  qwen.activeConfig = qwen.draftConfig;
  return fixtureConnection({
    activeChecks: [
      fixtureCheck({ credentialId: "cred-primary", evidence: evidence("anthropic/claude-opus-4.8"), providerModelId: "model-opus" }),
      fixtureCheck({ credentialId: "cred-primary", evidence: evidence("google/gemini-pro-latest", { directPdf: "not_supported", toolCalling: "not_supported", usage: "not_supported" }), providerModelId: "model-gemini" }),
      fixtureCheck({
        credentialId: "cred-primary",
        evidence: { ...evidence("voyageai/rerank-2.5"), compatibility: undefined, reranking: { completeScores: true, probeVersion: 1 } },
        providerModelId: "model-voyage"
      }),
      fixtureCheck({
        credentialId: "cred-primary",
        evidence: { ...evidence("cohere/rerank-4-pro"), compatibility: undefined, reranking: { completeScores: true, probeVersion: 1 } },
        latestRefreshError: { code: "provider_refresh_failed", version: 1 },
        providerModelId: "model-cohere",
        refreshFailedAt: "2026-09-07T12:55:00.000Z"
      })
    ],
    credentials: [
      fixtureCredential({ id: "cred-primary", label: "Primary" }),
      fixtureCredential({ id: "cred-research", label: "Research team" })
    ],
    defaultCredentialId: "cred-primary",
    displayName: "OpenRouter",
    family: "openrouter",
    id: "conn-or",
    models: [qwen, sonar, gemini, voyage, cohere, opus]
  });
}

function candidate(id: string, displayName: string) {
  return { connectionDisplayName: "OpenRouter", connectionId: "conn-or", displayName, id };
}

function usageSources(): ProviderUsageSources {
  return {
    knowledge: null,
    modelPolicy: {
      candidates: [],
      policy: {
        defaultModel: { ...candidate("model-opus", "Claude Opus 4.8"), available: true, defaultReasoningEffort: null, reasoningEfforts: [] },
        maxMcpToolsPerDiscovery: 8,
        maxToolCalls: 8,
        maxToolRounds: 4,
        mcpAutoDiscoveryTimeoutSeconds: 30,
        reasoningEffort: null,
        updatedAt: "2026-09-07T12:00:00.000Z",
        updatedBy: null,
        version: 1
      }
    },
    search: null,
    systemModelPolicy: {
      candidates: [],
      documentCandidates: [],
      ineligible: { direct_pdf: [], memory: [], vision: [] },
      policy: {
        chatPdfModel: null,
        chatPdfReasoningEffort: null,
        reasoningEffort: null,
        rerankerModel: { ...candidate("model-voyage", "Voyage Rerank 2.5"), available: true },
        rerankerRoute: {
          entries: [
            { ...candidate("model-voyage", "Voyage Rerank 2.5"), available: true, position: 0, relevanceScoreFloor: null, role: "primary" },
            { ...candidate("model-cohere", "Cohere Rerank 4 Pro"), available: true, position: 1, relevanceScoreFloor: null, role: "fallback" }
          ],
          policyVersion: "openrouter-reranker-route-v1"
        },
        systemModel: null,
        updatedAt: "2026-09-07T12:00:00.000Z",
        updatedBy: null,
        version: 1
      },
      rerankerCandidates: [],
      verificationCandidates: []
    }
  };
}

function harness(connection = openRouter(), busy = false) {
  const actions = {
    deleteModel: vi.fn(async () => ({ ok: true as const })),
    discoverCompatibleModels: vi.fn(async () => []),
    discoverEndpoints: vi.fn(async () => []),
    discoverModels: vi.fn(async () => []),
    saveModel: vi.fn(async () => ({ ok: true as const })),
    startModelChecks: vi.fn(async () => ({ ok: true as const })),
    updateModel: vi.fn(async () => true)
  };
  const controller = { actions, state: { busy } } as unknown as AdminProvidersController;
  const confirmations: AdminConfirmationRequest[] = [];
  const onError = vi.fn();
  const view = render(
    <AdminProviderModels
      connection={connection}
      controller={controller}
      onError={onError}
      requestConfirmation={(config) => { confirmations.push(config); }}
      usageSources={usageSources()}
    />
  );
  const rerender = (next: AdminProviderConnection) => view.rerender(
    <AdminProviderModels
      connection={next}
      controller={controller}
      onError={onError}
      requestConfirmation={(config) => { confirmations.push(config); }}
      usageSources={usageSources()}
    />
  );
  return { actions, confirmations, onError, rerender, view };
}

describe("AdminProviderModels", () => {
  it.each(["changed", "removed"])("preserves an open model edit when a background catalog reports it %s", async (change) => {
    const connection = openRouter();
    const { actions, rerender } = harness(connection);
    fireEvent.click(screen.getByRole("button", { name: "More actions for Claude Opus 4.8" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit$/ }));
    const sheet = await screen.findByRole("dialog", { name: "Edit model" });
    fireEvent.change(within(sheet).getByLabelText("Display name"), { target: { value: "My edited model" } });
    rerender({
      ...connection,
      models: change === "removed"
        ? connection.models.filter(({ id }) => id !== "model-opus")
        : connection.models.map((model) => model.id === "model-opus"
          ? { ...model, displayName: "Another administrator's model", draftVersion: model.draftVersion + 1 }
          : model)
    });
    expect(within(sheet).getByLabelText("Display name")).toHaveValue("My edited model");
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" })); });
    expect(actions.saveModel).toHaveBeenCalledWith("conn-or", "model-opus", expect.objectContaining({
      displayName: "My edited model", expectedDraftVersion: 1
    }));
  });

  // The fixtures are checked at FIXTURE_NOW; "Checked today" must not depend on the wall clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FIXTURE_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("groups models by class in a fixed order with chips, routes, Used as tags and the dimension in the title", () => {
    harness();
    const table = screen.getByRole("table", { name: "Models" });
    const groups = [...table.querySelectorAll("tbody")].map((body) => body.querySelector("th")?.textContent);
    expect(groups).toEqual(["Chat models · 3", "Rerankers · 2", "Embeddings · 1"]);
    const names = [...table.querySelectorAll("tr[data-testid^='provider-model-']")]
      .map((row) => row.querySelector("button[aria-expanded]")?.textContent);
    expect(names).toEqual([
      "Claude Opus 4.8", "Gemini Pro Latest", "Perplexity Sonar Pro Search",
      "Cohere Rerank 4 Pro", "Voyage Rerank 2.5", "Qwen3 Embedding 8B · 1536d"
    ]);

    const opus = screen.getByTestId("provider-model-model-opus");
    expect(opus).toHaveTextContent("anthropic/claude-opus-4.8 · via anthropic only");
    expect(within(opus).getAllByTestId(/model-chip-/).map((chip) => `${chip.textContent}:${chip.dataset.chipTone}`))
      .toEqual(["Tools:ok", "JSON:ok", "PDF:ok", "Images:ok", "Stream:ok"]);
    expect(within(opus).getByTestId("model-chip-tools")).toHaveAccessibleName(/Ordinary function calling.*Memory calls are checked separately/);
    expect(within(opus).getByTestId("model-chip-json")).toHaveAccessibleName(/strict JSON Schema/);
    expect(within(opus).getByText("Default chat")).toBeInTheDocument();
    expect(within(opus).getByRole("switch", { name: "Claude Opus 4.8 on" })).toBeChecked();

    const gemini = screen.getByTestId("provider-model-model-gemini");
    expect(gemini).toHaveTextContent("automatic routing");
    expect(within(gemini).getAllByTestId(/model-chip-/).map((chip) => `${chip.textContent}:${chip.dataset.chipTone}`))
      .toEqual(["Tools:muted", "JSON:ok", "No PDF:warn", "Images:ok", "Stream:ok"]);

    const sonar = screen.getByTestId("provider-model-model-sonar");
    expect(sonar).toHaveTextContent("not checked yet");
    expect(within(sonar).getByRole("button", { name: "Check model" })).toBeDisabled();
    expect(within(sonar).getByRole("switch", { name: "Perplexity Sonar Pro Search on" })).not.toBeChecked();

    const cohere = screen.getByTestId("provider-model-model-cohere");
    expect(within(cohere).getByTestId("model-chip-reranking")).toHaveTextContent("Reranking");
    expect(cohere).toHaveTextContent("Check failed");
    expect(within(cohere).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(within(screen.getByTestId("provider-model-model-voyage")).getByText("Reranker · primary")).toBeInTheDocument();
    expect(screen.getByTestId("provider-models")).not.toHaveTextContent(/draft|revision|pending|evidence|probe|adapter|fingerprint|dimensions/iu);
  });

  it("expands one row with the last check, and runs Check, Retry, Re-check and Re-check with key through background checks", () => {
    const { actions } = harness();
    const opus = screen.getByTestId("provider-model-model-opus");
    fireEvent.click(within(opus).getByRole("button", { name: "Claude Opus 4.8" }));
    const details = screen.getByTestId("provider-model-model-opus-details");
    expect(details).toHaveTextContent(/Checked today \d{2}:\d{2} with key Primary · tools, JSON and the other checked capabilities work\./u);
    expect(details).toHaveTextContent("Route: via anthropic only.");
    fireEvent.click(within(details).getByRole("button", { name: "Re-check" }));
    expect(actions.startModelChecks).toHaveBeenLastCalledWith("conn-or", "cred-primary", ["model-opus"]);

    fireEvent.click(within(screen.getByTestId("provider-model-model-gemini")).getByRole("button", { name: "Gemini Pro Latest" }));
    expect(screen.queryByTestId("provider-model-model-opus-details")).not.toBeInTheDocument();
    const geminiDetails = screen.getByTestId("provider-model-model-gemini-details");
    expect(geminiDetails).toHaveTextContent("works without tools and PDF input.");
    expect(geminiDetails).toHaveTextContent("No usage reporting — cost accounting for this model will be empty.");

    fireEvent.click(within(screen.getByTestId("provider-model-model-cohere")).getByRole("button", { name: "Retry" }));
    expect(actions.startModelChecks).toHaveBeenLastCalledWith("conn-or", "cred-primary", ["model-cohere"]);

    fireEvent.click(within(opus).getByRole("button", { name: "More actions for Claude Opus 4.8" }));
    const menu = screen.getByRole("menu", { name: "More actions for Claude Opus 4.8" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Edit", "Re-check with key…", "Details", "Turn off", "Remove from AIQSA"
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Re-check with key…" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Research team" }));
    expect(actions.startModelChecks).toHaveBeenLastCalledWith("conn-or", "cred-research", ["model-opus"]);

    fireEvent.click(screen.getByRole("button", { name: "Check models" }));
    expect(actions.startModelChecks).toHaveBeenLastCalledWith("conn-or", "cred-primary", undefined);
  });

  it("asks before turning off a model a role uses, names the successor, and turns off unused models directly", async () => {
    const { actions, confirmations } = harness();
    fireEvent.click(screen.getByRole("switch", { name: "Voyage Rerank 2.5 on" }));
    expect(actions.updateModel).not.toHaveBeenCalled();
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({ confirmLabel: "Turn off", title: "Turn off Voyage Rerank 2.5?", tone: "warning" });
    expect(confirmations[0]!.body).toBe(
      "It is the primary reranker for Memory and Knowledge. Cohere Rerank 4 Pro takes over automatically, and chats in progress keep using the current model until they finish.\n\nNothing is deleted. You can turn it back on at any time."
    );
    await act(async () => { await confirmations[0]!.onConfirm(); });
    expect(actions.updateModel).toHaveBeenCalledWith("conn-or", "model-voyage", { action: "disable" }, "Model turned off.");

    fireEvent.click(screen.getByRole("switch", { name: "Gemini Pro Latest on" }));
    expect(confirmations).toHaveLength(1);
    expect(actions.updateModel).toHaveBeenLastCalledWith("conn-or", "model-gemini", { action: "disable" }, "Model turned off.");
    fireEvent.click(screen.getByRole("switch", { name: "Perplexity Sonar Pro Search on" }));
    expect(actions.updateModel).toHaveBeenLastCalledWith("conn-or", "model-sonar", { action: "enable" }, "Model turned on.");
  });

  it("removes a model only after confirmation and explains server blockers", async () => {
    const { actions, confirmations, onError } = harness();
    actions.deleteModel.mockResolvedValueOnce({
      error: { blockers: [{ count: 2, kind: "assistants" }], code: "provider_delete_conflict", resourceIds: [] },
      message: "Remove the listed references or disable this resource instead.",
      ok: false
    } as never);
    const gemini = screen.getByTestId("provider-model-model-gemini");
    fireEvent.click(within(gemini).getByRole("button", { name: "More actions for Gemini Pro Latest" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from AIQSA" }));
    expect(confirmations[0]).toMatchObject({ confirmLabel: "Remove model", title: "Remove “Gemini Pro Latest” from AIQSA?", tone: "destructive" });
    await act(async () => { await confirmations[0]!.onConfirm(); });
    expect(actions.deleteModel).toHaveBeenCalledWith("conn-or", "model-gemini");
    expect(onError).toHaveBeenCalledWith("“Gemini Pro Latest” was not removed. Used by 2 Assistants — reassign first.");
  });

  it("adds presets with one click and opens the sheet for a chat model", async () => {
    const { actions } = harness();
    fireEvent.click(screen.getByTestId("provider-add-model"));
    const menu = screen.getByRole("menu", { name: "Add model" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Chat model", "Embedding preset", "Reranker preset"
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Reranker preset" }));
    const rerankers = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(rerankers).not.toContain("Voyage Rerank 2.5");
    expect(rerankers).toContain("Qwen3 Reranker 8B");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Qwen3 Reranker 8B" }));
    expect(actions.saveModel).toHaveBeenCalledWith("conn-or", null, {
      configuration: expect.objectContaining({ adapterKind: "openrouter_rerank", modelClass: "reranker", upstreamModelId: "qwen/qwen3-reranker-8b" }),
      displayName: "Qwen3 Reranker 8B"
    });

    fireEvent.click(screen.getByTestId("provider-add-model"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Embedding preset" }));
    const embeddings = within(screen.getByRole("menu", { name: "Add model" })).getAllByRole("menuitem").map((item) => item.textContent);
    expect(embeddings).not.toContain("Qwen3 Embedding 8B · 1536d");
    expect(embeddings).toContain("BGE-M3 · 1024d");
    fireEvent.click(screen.getByRole("menuitem", { name: "BGE-M3 · 1024d" }));
    expect(actions.saveModel).toHaveBeenLastCalledWith("conn-or", null, {
      configuration: expect.objectContaining({ embedding: expect.objectContaining({ targetDimension: 1_024 }), modelClass: "embedding" }),
      displayName: "BGE-M3"
    });

    fireEvent.click(screen.getByTestId("provider-add-model"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Chat model" }));
    expect(await screen.findByRole("dialog", { name: "Add model" })).toBeInTheDocument();
  });

  it("spins on rows being checked, disables Check models during a run and offers a plain Add model without presets", () => {
    const connection = openRouter();
    connection.checkRun = fixtureCheckRun({ credentialId: "cred-primary", current: "model-opus", done: 1, id: "run-1", inFlight: ["model-opus", "model-gemini"], total: 5 });
    const running = harness(connection);
    expect(within(screen.getByTestId("provider-model-model-opus")).getByRole("status")).toHaveTextContent("Checking tools, JSON, PDF, images and streaming…");
    expect(screen.getByTestId("provider-model-model-opus-works-with")).toHaveAttribute("data-works-with", "checking");
    expect(screen.getByTestId("provider-model-model-voyage-works-with")).toHaveAttribute("data-works-with", "checked");
    expect(screen.getByRole("button", { name: "Check models" })).toBeDisabled();
    expect(screen.getByTestId("provider-models")).toHaveTextContent("Models are usable in chat as soon as the key works.");
    running.view.unmount();

    const custom = fixtureConnection({ displayName: "codex-lb", family: "openai_compatible", id: "conn-custom", models: [] });
    harness(custom);
    expect(screen.getByRole("status")).toHaveTextContent("No models yet.");
    expect(screen.getByTestId("provider-add-model")).not.toHaveAttribute("aria-haspopup");
    expect(screen.queryByRole("button", { name: "Check models" })).not.toBeInTheDocument();
  });
});

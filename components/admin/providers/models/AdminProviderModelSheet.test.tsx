import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import {
  fixtureConnection,
  fixtureCheck,
  fixtureCredential,
  fixtureModel,
  workingConnection
} from "@/components/admin/providers/providerFixtures";
import type {
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel
} from "@/lib/contracts/adminProviders";
import { AdminProviderModelSheet } from "./AdminProviderModelSheet";
import type { AdminOpenRouterDiscoverySession, OpenRouterDiscoveryState } from "./useAdminOpenRouterDiscovery";
import type { AdminProviderSetupProgress } from "@/lib/contracts/adminProviderSetupProgress";

const catalogModels: AdminOpenRouterDiscoveredModel[] = [
  {
    contextLength: 1_000_000,
    id: "anthropic/claude-sonnet-5",
    inputModalities: ["text", "image"],
    name: "Anthropic: Claude Sonnet 5",
    outputModalities: ["text"],
    pricing: {},
    supportedParameters: ["tools", "reasoning"]
  },
  {
    contextLength: 200_000,
    id: "google/gemini-3.5-flash",
    inputModalities: ["text"],
    name: "Google: Gemini 3.5 Flash",
    outputModalities: ["text"],
    pricing: {},
    supportedParameters: ["tools"]
  }
];

const endpoints: AdminOpenRouterDiscoveredEndpoint[] = [
  { name: "Anthropic | claude-sonnet-5", providerName: "Anthropic", supportedParameters: [], tag: "anthropic" },
  { name: "Amazon Bedrock | claude-sonnet-5", providerName: "Amazon Bedrock · US", quantization: "fp8", supportedParameters: [], tag: "amazon-bedrock" }
];

function ready<T>(items: readonly T[]): OpenRouterDiscoveryState<T> {
  return { error: null, items, status: items.length ? "success" : "empty" };
}

function discovery(): AdminOpenRouterDiscoverySession {
  return {
    compatibleModels: { get: () => ready([]), load: async () => [], refresh: async () => [], retry: async () => [] },
    endpoints: {
      get: (identity) => identity ? ready(endpoints) : ready([]),
      load: async () => endpoints,
      refresh: async () => endpoints,
      retry: async () => endpoints
    },
    models: {
      get: (identity) => identity ? ready(catalogModels) : ready([]),
      load: async () => catalogModels,
      refresh: async () => catalogModels,
      retry: async () => catalogModels
    }
  };
}

function controller(saveModel: Mock = vi.fn(async () => ({ ok: true as const }))) {
  return {
    actions: { saveModel },
    state: { busy: false }
  } as unknown as AdminProvidersController;
}

describe("AdminProviderModelSheet", () => {
  it("shows capability progress for a new model and preserves a stopped result for review", async () => {
    const connection = workingConnection();
    const saveModel = vi.fn(async (_connectionId: string, _modelId: string | null, _body: unknown, options: { signal: AbortSignal; onProgress(value: AdminProviderSetupProgress): void }) => {
      options.onProgress({ phase: "checking", completed: 0, total: 1, capability: "vision", connectionId: connection.id, credentialId: connection.defaultCredentialId!, runId: "model-run" });
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false as const, error: { blockers: [], code: "request_aborted", resourceIds: [] }, message: "Checking stopped. Saved results are kept." };
    });
    const onSaved = vi.fn();
    render(<AdminProviderModelSheet connection={connection} controller={controller(saveModel)} discovery={discovery()} model={null} onClose={vi.fn()} onSaved={onSaved} open />);
    const sheet = await screen.findByRole("dialog", { name: "Add model" });
    fireEvent.change(within(sheet).getByRole("combobox", { name: "Model" }), { target: { value: "new-model" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    await within(sheet).findByText("Checking Image input…");
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole("button", { name: "Stop checking" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Saved results are kept");
    fireEvent.click(within(sheet).getByRole("button", { name: "View model results" }));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(saveModel).toHaveBeenCalledOnce();
  });
  it("applies JSON locally, preserves unrelated edits and retains the complete draft when Test & Save is rejected", async () => {
    const connection = workingConnection();
    const saveModel = vi.fn(async () => ({ error: { blockers: [], code: "provider_configuration_invalid", resourceIds: [] }, ok: false as const, message: "Default parameters were rejected." }));
    render(<AdminProviderModelSheet connection={connection} controller={controller(saveModel)} discovery={discovery()} model={connection.models[0]!} onClose={vi.fn()} onSaved={vi.fn()} open />);
    const sheet = await screen.findByRole("dialog", { name: "Edit model" });
    fireEvent.change(within(sheet).getByLabelText("Display name"), { target: { value: "My name" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Edit JSON" }));
    const json = screen.getByRole("dialog", { name: "Default parameters · JSON" });
    fireEvent.change(within(json).getByRole("textbox"), { target: { value: '{"nested":{"anything":[true,null,2]}}' } });
    fireEvent.click(within(json).getByRole("button", { name: "Apply to model" }));
    expect(saveModel).not.toHaveBeenCalled();
    expect(within(sheet).getByLabelText("Display name")).toHaveValue("My name");
    expect(within(sheet).getByTestId("model-parameters-preview")).toHaveTextContent('"anything":[true,null,2]');
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Default parameters were rejected.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Review default parameters" }));
    expect(screen.getByRole("textbox", { name: "Default parameters JSON" })).toHaveValue('{"nested":{"anything":[true,null,2]}}');
    expect(saveModel).toHaveBeenCalledWith(connection.id, connection.models[0]!.id, expect.objectContaining({
      configuration: expect.objectContaining({ defaultParams: { nested: { anything: [true, null, 2] } } }), displayName: "My name", expectedDraftVersion: 1
    }), expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) }));
  });

  it("separates alternate diagnostic checks from the default save key and refreshes checks without advancing the form baseline", async () => {
    const connection = workingConnection();
    connection.credentials.push(fixtureCredential({ id: "other", label: "Research" }));
    connection.activeChecks = [fixtureCheck({ checkedAt: "2026-09-07T10:00:00.000Z", credentialId: "other", providerModelId: connection.models[0]!.id })];
    const saveModel = vi.fn(async () => ({ ok: true as const }));
    const props = { connection, controller: controller(saveModel), diagnosticCredentialId: "other", discovery: discovery(), model: connection.models[0]!, onClose: vi.fn(), onSaved: vi.fn(), open: true };
    const view = render(<AdminProviderModelSheet {...props} />);
    const sheet = await screen.findByRole("dialog", { name: "Edit model" });
    expect(within(sheet).getByRole("region", { name: "Last model check" })).toHaveTextContent(/Checked .* with key Research/);
    expect(sheet).toHaveTextContent("Test & Save uses key Primary.");
    fireEvent.change(within(sheet).getByLabelText("Display name"), { target: { value: "Keep draft" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Edit JSON" }));
    const editor = screen.getByRole("textbox", { name: "Default parameters JSON" });
    fireEvent.change(editor, { target: { value: '{"keep":"local JSON"}' } });
    const next = structuredClone(connection);
    next.activeChecks[0]!.checkedAt = "2026-09-08T11:22:00.000Z";
    next.activeChecks[0]!.latestRefreshError = { code: "provider_refresh_failed", version: 1 };
    next.models[0]!.draftVersion += 1;
    next.models[0]!.displayName = "Server replacement";
    view.rerender(<AdminProviderModelSheet {...props} connection={next} />);
    expect(editor).toHaveValue('{"keep":"local JSON"}');
    fireEvent.click(screen.getByRole("button", { name: "Apply to model" }));
    expect(sheet).toHaveTextContent("Last check · Check failed");
    expect(sheet).toHaveTextContent("Earlier results were kept.");
    expect(within(sheet).getByLabelText("Display name")).toHaveValue("Keep draft");
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(saveModel).toHaveBeenCalledWith(connection.id, connection.models[0]!.id, expect.objectContaining({
      configuration: expect.objectContaining({ defaultParams: { keep: "local JSON" } }), displayName: "Keep draft", expectedDraftVersion: 1
    }), expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) })));
  });

  it.each(["embedding", "reranker"] as const)("keeps the applicable %s fields visible without chat capabilities or JSON controls", async (modelClass) => {
    const connection = workingConnection();
    const model = fixtureModel({ connectionId: connection.id, displayName: "Internal model", id: "internal", modelClass });
    model.draftConfig = { ...model.draftConfig, modelClass };
    render(<AdminProviderModelSheet connection={connection} controller={controller()} discovery={discovery()} model={model} onClose={vi.fn()} onSaved={vi.fn()} open />);
    const sheet = await screen.findByRole("dialog", { name: "Edit model" });
    expect(within(sheet).getByLabelText("Response timeout (seconds)")).toBeVisible();
    expect(within(sheet).queryByRole("switch", { name: "Tools" })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Edit JSON" })).not.toBeInTheDocument();
  });

  it("exposes compatible reasoning and streaming usage while preserving protocol conditions", async () => {
    const connection = fixtureConnection({ displayName: "Compatible", family: "openai_compatible", id: "compatible" });
    const model = fixtureModel({ connectionId: connection.id, displayName: "Custom", id: "custom" });
    model.draftConfig = { ...model.draftConfig, adapterKind: "openai_chat_completions_compatible", capabilities: { ...model.draftConfig.capabilities, reasoning: true, streamUsage: true } };
    connection.models = [model];
    render(<AdminProviderModelSheet connection={connection} controller={controller()} discovery={discovery()} model={model} onClose={vi.fn()} onSaved={vi.fn()} open />);
    const sheet = await screen.findByRole("dialog", { name: "Edit model" });
    expect(within(sheet).getByLabelText("Reasoning")).toBeVisible();
    expect(within(sheet).getByLabelText("Reasoning effort field")).toBeVisible();
    expect(within(sheet).getByRole("switch", { name: "Streaming usage totals" })).toBeVisible();
    fireEvent.click(within(sheet).getByRole("switch", { name: "Hosted web search" }));
    expect(within(sheet).getByLabelText("Protocol")).toHaveValue("openai_responses_compatible");
    expect(within(sheet).queryByRole("switch", { name: "Streaming usage totals" })).not.toBeInTheDocument();
    expect(within(sheet).getByLabelText("Reasoning effort field")).toHaveValue("reasoning.effort");
    expect(within(sheet).getByRole("button", { name: "Edit JSON" })).toBeVisible();
  });

  it("adds an OpenRouter model from the catalog with an ordered route and one Test & Save", async () => {
    const connection = fixtureConnection({
      credentials: [fixtureCredential({ id: "cred-primary", label: "Primary" })],
      defaultCredentialId: "cred-primary",
      displayName: "OpenRouter",
      family: "openrouter",
      id: "conn-or"
    });
    const saveModel = vi.fn(async () => ({ ok: true as const }));
    const onSaved = vi.fn();
    render(
      <AdminProviderModelSheet
        connection={connection}
        controller={controller(saveModel)}
        discovery={discovery()}
        model={null}
        onClose={vi.fn()}
        onSaved={onSaved}
        open
      />
    );

    const sheet = await screen.findByRole("dialog", { name: "Add model" });
    expect(sheet).toHaveAccessibleDescription("OpenRouter");
    expect(within(sheet).getByText("Checks supported capabilities with key Primary and enables verified features, including PDF")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Test & Save" })).toBeDisabled();
    expect(within(sheet).getByRole("switch", { name: "Available in chat" })).toBeChecked();
    expect(within(sheet).getByLabelText("Response timeout (seconds)")).toBeVisible();
    expect(within(sheet).queryByText(/^Advanced/)).not.toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole("button", { name: "Model" }));
    fireEvent.click(await screen.findByRole("option", { name: /Claude Sonnet 5/ }));
    expect(within(sheet).getByLabelText("Display name")).toHaveValue("Anthropic: Claude Sonnet 5");
    expect(sheet).toHaveTextContent("1M context · tools, reasoning, image input");

    fireEvent.click(within(sheet).getByLabelText(/Only these providers/));
    const routing = await within(sheet).findByTestId("model-routing-list");
    expect(within(routing).getByPlaceholderText(/Add provider · Amazon Bedrock · US, Anthropic…/)).toBeInTheDocument();
    fireEvent.click(await within(routing).findByRole("button", { name: /^Anthropic/ }));
    fireEvent.click(within(routing).getByRole("button", { name: /Amazon Bedrock · US/ }));
    const ordered = within(routing).getByRole("list", { name: "Providers in order" });
    expect(within(ordered).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "1Anthropicanthropic",
      "2Amazon Bedrock · USamazon-bedrock"
    ]);
    expect(routing).not.toHaveTextContent("fp8");
    fireEvent.click(within(ordered).getByRole("button", { name: "Move Amazon Bedrock · US up" }));
    expect(within(ordered).getAllByRole("listitem")[0]).toHaveTextContent("Amazon Bedrock · US");

    fireEvent.change(within(sheet).getByLabelText("Display name"), { target: { value: "Claude Sonnet 5" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(saveModel).toHaveBeenCalledOnce();
    expect(saveModel).toHaveBeenCalledWith("conn-or", null, {
      configuration: expect.objectContaining({
        adapterKind: "openrouter_chat_completions",
        answerSelectable: true,
        capabilities: expect.objectContaining({ toolCalling: true, vision: true }),
        modelClass: "answer",
        openRouterRouting: { mode: "only_selected", providers: ["amazon-bedrock", "anthropic"] },
        upstreamModelId: "anthropic/claude-sonnet-5"
      }),
      displayName: "Claude Sonnet 5"
    }, expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) }));
    expect(sheet).not.toHaveTextContent(/draft|revision|pending|evidence|probe|adapter|fingerprint/iu);
  });

  it("edits an OpenAI model, shows the server failure inline, and asks before discarding changes", async () => {
    const connection = workingConnection();
    const model = connection.models[0]!;
    const saveModel = vi.fn(async () => ({
      error: { blockers: [], code: "provider_draft_stale", resourceIds: [] },
      message: "This provider changed in another window. Refresh and try again.",
      ok: false as const
    }));
    const onClose = vi.fn();
    render(
      <AdminProviderModelSheet
        connection={connection}
        controller={controller(saveModel)}
        discovery={discovery()}
        model={model}
        onClose={onClose}
        onSaved={vi.fn()}
        open
      />
    );

    const sheet = await screen.findByRole("dialog", { name: "Edit model" });
    const modelField = within(sheet).getByRole("combobox", { name: "Model" });
    expect(modelField).toHaveValue("gpt-5.6-terra");
    expect(within(sheet).queryByText("Routing")).not.toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Test & Save" })).toBeDisabled();

    expect(within(sheet).getByLabelText("Response timeout (seconds)")).toBeVisible();
    expect(within(sheet).getByRole("switch", { name: "Tools" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("switch", { name: "Image input" }));
    fireEvent.change(within(sheet).getByLabelText("Response timeout (seconds)"), { target: { value: "120" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("This provider changed in another window.");
    expect(saveModel).toHaveBeenCalledWith("conn-openai", "model-terra", {
      configuration: expect.objectContaining({
        capabilities: expect.objectContaining({ vision: true }),
        responseTimeoutSeconds: 120,
        upstreamModelId: "gpt-5.6-terra"
      }),
      displayName: "GPT-5.6 Terra",
      expectedDraftVersion: 1
    }, expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) }));

    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    const discard = await screen.findByTestId("provider-model-discard");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(discard).getByRole("button", { name: "Confirm discard changes" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers built-in ids as hints and saves without a check when no key is usable", async () => {
    const connection = fixtureConnection({ displayName: "Anthropic", family: "anthropic", id: "conn-anthropic" });
    render(
      <AdminProviderModelSheet
        connection={connection}
        controller={controller()}
        discovery={discovery()}
        model={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        open
      />
    );
    const sheet = await screen.findByRole("dialog", { name: "Add model" });
    expect(sheet).toHaveAccessibleDescription("Anthropic");
    expect(sheet).toHaveTextContent("Turns the model on without a check");
    const input = within(sheet).getByRole("combobox", { name: "Model" });
    const hints = [...document.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"));
    expect(hints).toContain("claude-sonnet-5");
    fireEvent.change(input, { target: { value: "claude-sonnet-5" } });
    expect(within(sheet).getByLabelText("Display name")).toHaveValue("Claude Sonnet 5");
    expect(within(sheet).getByRole("button", { name: "Test & Save" })).toBeEnabled();
  });
});

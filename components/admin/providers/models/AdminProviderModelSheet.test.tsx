import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import * as providerApi from "@/components/admin/adminProvidersApi";
import { imageModelConfiguration } from "@/lib/domain/imageModels";
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
  { name: "Anthropic | claude-sonnet-5", providerName: "Anthropic", supportedParameters: ["tools"], tag: "anthropic" },
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

function controller(saveModel: Mock = vi.fn(async () => ({ ok: true as const })), renameModel: Mock = vi.fn(async () => ({ ok: true as const })),
  saveModelMetadata: Mock = vi.fn(async () => ({ ok: true as const }))) {
  return {
    actions: { saveModel, renameModel, saveModelMetadata },
    state: { busy: false }
  } as unknown as AdminProvidersController;
}

describe("AdminProviderModelSheet", () => {
  afterEach(() => vi.restoreAllMocks());

  it("saves four decimal prices as metadata with no key, activation or provider check", async () => {
    const connection = workingConnection(); connection.credentials = []; connection.defaultCredentialId = null;
    const model = { ...connection.models[0]!, enabled: false };
    const actions = controller(); const onSaved = vi.fn();
    render(<AdminProviderModelSheet connection={connection} model={model} controller={actions} discovery={discovery()} onClose={vi.fn()} onSaved={onSaved} open />);
    expect(screen.getByLabelText("Input", { exact: true })).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Input", { exact: true }), { target: { value: "0.25" } });
    fireEvent.change(screen.getByLabelText("Cached input", { exact: true }), { target: { value: "0.025" } });
    fireEvent.change(screen.getByLabelText("Output", { exact: true }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(actions.actions.saveModelMetadata).toHaveBeenCalledWith(connection.id, model.id, expect.objectContaining({
      pricing: { mode: "manual", prices: { inputTokenPriceUsdPerMillion: "0.25", cachedInputTokenPriceUsdPerMillion: "0.025",
        cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: "2" } }
    }));
    expect(actions.actions.saveModel).not.toHaveBeenCalled();
    expect(actions.actions.renameModel).not.toHaveBeenCalled();
  });

  it.each(["-1", "bad", "1e3", "0.000000001", "10000000000"])("keeps invalid price %s with its field error and focus", value => {
    const connection = workingConnection(); const actions = controller();
    render(<AdminProviderModelSheet connection={connection} model={connection.models[0]!} controller={actions} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
    const input = screen.getByLabelText("Cached input", { exact: true });
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(input).toHaveValue(value); expect(input).toHaveAttribute("aria-invalid", "true"); expect(input).toHaveFocus();
    expect(screen.getByLabelText("Cached input", { exact: true })).toBe(input);
    expect(input).toHaveAccessibleName("Cached input");
    expect(input).toHaveAccessibleDescription(/non-negative decimal/);
    expect(actions.actions.saveModelMetadata).not.toHaveBeenCalled(); expect(actions.actions.saveModel).not.toHaveBeenCalled();
  });

  it("restores only the server-projected catalog prices with dirty-discard protection", async () => {
    const connection = workingConnection(); const model = connection.models[0]!;
    model.pricing = { source: "admin", prices: { ...model.pricing.prices, inputTokenPriceUsdPerMillion: "9" },
      catalogPrices: { ...model.pricing.prices, inputTokenPriceUsdPerMillion: "0.1", outputTokenPriceUsdPerMillion: "1" } };
    const actions = controller();
    render(<AdminProviderModelSheet connection={connection} model={model} controller={actions} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
    fireEvent.click(screen.getByRole("button", { name: "Use catalog price" }));
    expect(screen.getByLabelText("Input", { exact: true })).toHaveValue("0.1");
    expect(screen.getByLabelText("Cache write", { exact: true })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("provider-model-discard")).toBeVisible();
    fireEvent.click(within(screen.getByTestId("provider-model-discard")).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(actions.actions.saveModelMetadata).toHaveBeenCalledWith(connection.id, model.id,
      expect.objectContaining({ pricing: { mode: "restore_catalog" } })));
  });

  it.each(["embedding", "reranker", "image"] as const)("does not show token prices for %s", modelClass => {
    const connection = workingConnection(); const model = connection.models[0]!;
    model.modelClass = modelClass; model.draftConfig = { ...model.draftConfig, modelClass };
    render(<AdminProviderModelSheet connection={connection} model={model} controller={controller()} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
    expect(screen.queryByLabelText("Input", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use catalog price" })).toBeNull();
  });

  it("keeps mixed price and configuration edits in a single Test & Save request", async () => {
    const connection = workingConnection(); const actions = controller();
    render(<AdminProviderModelSheet connection={connection} model={connection.models[0]!} controller={actions} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText("Input", { exact: true }), { target: { value: "0.25" } });
    fireEvent.change(screen.getByLabelText("Response timeout (seconds)"), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(actions.actions.saveModel).toHaveBeenCalledWith(connection.id, connection.models[0]!.id,
      expect.objectContaining({ configuration: expect.objectContaining({ responseTimeoutSeconds: 120 }),
        pricing: { mode: "manual", prices: expect.objectContaining({ inputTokenPriceUsdPerMillion: "0.25" }) } }), expect.anything()));
    expect(actions.actions.saveModelMetadata).not.toHaveBeenCalled();
  });

  it("has no price section for a Jev decision model, whose cost is provider-reported", () => {
    const connection = workingConnection(); const model = connection.models[0]!;
    model.modelClass = "decision"; model.draftConfig = { ...model.draftConfig, modelClass: "decision" };
    model.pricing = { ...model.pricing, source: "admin", catalogPrices: { ...model.pricing.prices } };
    render(<AdminProviderModelSheet connection={connection} model={model} controller={controller()} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
    expect(screen.queryByRole("group", { name: "Prices" })).toBeNull();
    expect(screen.queryByLabelText("Input", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use catalog price" })).toBeNull();
  });

  it("claims no source for rows without catalog identity until an administrator prices them", async () => {
    const connection = workingConnection(); const model = connection.models[0]!;
    // A custom model created without prices, and a row the upgrade left on the column default.
    for (const source of ["admin", "catalog"] as const) {
      model.pricing = { prices: { ...model.pricing.prices }, source, catalogPrices: null };
      const view = render(<AdminProviderModelSheet connection={connection} model={model} controller={controller()} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
      expect(screen.queryByText("Catalog price")).toBeNull(); expect(screen.queryByText("Edited by an administrator")).toBeNull();
      expect(screen.queryByRole("button", { name: "Use catalog price" })).toBeNull();
      view.unmount();
    }
    model.pricing = { ...model.pricing, source: "catalog", prices: { ...model.pricing.prices, inputTokenPriceUsdPerMillion: "2", outputTokenPriceUsdPerMillion: "9" } };
    const legacy = render(<AdminProviderModelSheet connection={connection} model={model} controller={controller()} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
    expect(screen.queryByText("Catalog price")).toBeNull();
    legacy.unmount();
    model.pricing = { prices: { ...model.pricing.prices, inputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null }, source: "admin", catalogPrices: null };
    const actions = controller();
    const view = render(<AdminProviderModelSheet connection={connection} model={model} controller={actions} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText("Output", { exact: true }), { target: { value: "2" } });
    expect(screen.getByText("Edited by an administrator")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(actions.actions.saveModelMetadata).toHaveBeenCalledWith(connection.id, model.id, expect.objectContaining({
      pricing: { mode: "manual", prices: { ...model.pricing.prices, outputTokenPriceUsdPerMillion: "2" } } })));
    view.unmount();
    model.pricing = { ...model.pricing, prices: { ...model.pricing.prices, outputTokenPriceUsdPerMillion: "2" } };
    render(<AdminProviderModelSheet connection={connection} model={model} controller={controller()} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
    expect(screen.getByText("Edited by an administrator")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Use catalog price" })).toBeNull();
  });

  it("keeps a catalog row clean when the stored price is typed again", () => {
    const connection = workingConnection(); const model = connection.models[0]!;
    const catalog = { ...model.pricing.prices, inputTokenPriceUsdPerMillion: "2", cachedInputTokenPriceUsdPerMillion: "0.2",
      cacheWriteInputTokenPriceUsdPerMillion: "2.5", outputTokenPriceUsdPerMillion: "12" };
    model.pricing = { source: "catalog", prices: catalog, catalogPrices: catalog };
    const onClose = vi.fn(); const actions = controller();
    render(<AdminProviderModelSheet connection={connection} model={model} controller={actions} discovery={discovery()} onClose={onClose} onSaved={vi.fn()} open />);
    const input = screen.getByLabelText("Input", { exact: true });
    expect(screen.getByText("Catalog price")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Use catalog price" })).toBeNull();
    fireEvent.change(input, { target: { value: "3" } });
    expect(screen.getByText("Edited by an administrator")).toBeVisible();
    expect(screen.getByRole("button", { name: "Use catalog price" })).toBeVisible();
    fireEvent.change(input, { target: { value: "2.000" } });
    expect(input).toHaveValue("2.000");
    expect(screen.getByText("Catalog price")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Use catalog price" })).toBeNull();
    expect(screen.getByRole("button", { name: "Test & Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("provider-model-discard")).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    expect(actions.actions.saveModelMetadata).not.toHaveBeenCalled(); expect(actions.actions.renameModel).not.toHaveBeenCalled();
  });

  it("keeps the source when a name change is saved with retyped stored prices", async () => {
    const connection = workingConnection(); const model = connection.models[0]!;
    const catalog = { ...model.pricing.prices, inputTokenPriceUsdPerMillion: "2", outputTokenPriceUsdPerMillion: "12" };
    model.pricing = { source: "catalog", prices: catalog, catalogPrices: catalog };
    const actions = controller();
    render(<AdminProviderModelSheet connection={connection} model={model} controller={actions} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText("Output", { exact: true }), { target: { value: "12.0" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(actions.actions.renameModel).toHaveBeenCalledWith(connection.id, model.id, expect.objectContaining({ displayName: "Renamed" })));
    expect(actions.actions.renameModel).toHaveBeenCalledWith(connection.id, model.id, expect.not.objectContaining({ pricing: expect.anything() }));
    expect(actions.actions.saveModelMetadata).not.toHaveBeenCalled();
  });

  it("attaches a server price rejection to its field and keeps the entered text", async () => {
    const connection = workingConnection(); const model = connection.models[0]!;
    const saveMetadata = vi.fn(async () => ({ ok: false as const, message: "One or more prices are invalid.",
      error: { blockers: [], code: "provider_model_pricing_invalid", field: "outputTokenPriceUsdPerMillion", resourceIds: [] } }));
    const onSaved = vi.fn();
    render(<AdminProviderModelSheet connection={connection} model={model} controller={controller(undefined, undefined, saveMetadata)}
      discovery={discovery()} onClose={vi.fn()} onSaved={onSaved} open />);
    const output = screen.getByLabelText("Output", { exact: true });
    fireEvent.change(output, { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(output).toHaveAttribute("aria-invalid", "true"));
    expect(output).toHaveValue("12.5"); expect(output).toHaveAccessibleName("Output");
    expect(output).toHaveAccessibleDescription(/non-negative decimal/);
    await waitFor(() => expect(output).toHaveFocus());
    expect(screen.getByLabelText("Input", { exact: true })).not.toHaveAttribute("aria-invalid");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("keeps later price text when a prior saved receipt arrives", async () => {
    const connection = workingConnection(); const model = connection.models[0]!;
    let resolve!: (value: { ok: true; persistence: { model: typeof model; receipt: null } }) => void;
    const saveMetadata = vi.fn(() => new Promise<{ ok: true; persistence: { model: typeof model; receipt: null } }>(done => { resolve = done; }));
    const onSaved = vi.fn();
    render(<AdminProviderModelSheet connection={connection} model={model} controller={controller(undefined, undefined, saveMetadata)}
      discovery={discovery()} onClose={vi.fn()} onSaved={onSaved} open />);
    const input = screen.getByLabelText("Input", { exact: true });
    fireEvent.change(input, { target: { value: "0.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // A local draft update can outlive the request which captured the previous value.
    fireEvent.change(input, { target: { value: "0.5" } });
    resolve({ ok: true, persistence: { receipt: null, model: { ...model, pricing: { ...model.pricing,
      source: "admin", prices: { ...model.pricing.prices, inputTokenPriceUsdPerMillion: "0.25" } } } } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(input).toHaveValue("0.5"); expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("provider-model-discard")).toBeVisible();
  });

  it("keeps rejected native-route details collapsed without marking the working model unavailable", () => {
    const connection = workingConnection();
    connection.family = "openrouter";
    const model = connection.models[0]!;
    model.nativeRoutingAdoption = { reason: "native_incompatible", diagnostic: {
      version: 1, stage: "modelAccess", code: "http_error", servingMode: "automatic", provider: "deepseek", httpStatus: 404,
      missing: ["modelAccess"], previouslyUnverified: ["directPdf"]
    } };
    const actions = controller();
    const session = discovery();
    const load = vi.spyOn(session.endpoints, "load");
    render(<AdminProviderModelSheet connection={connection} model={model} controller={actions} discovery={session} onClose={vi.fn()} onSaved={vi.fn()} open />);
    const summary = screen.getByText("Automatic routing kept during native setup");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText(/HTTP 404/)).not.toBeVisible();
    fireEvent.click(summary);
    expect(within(details).getByText(/HTTP 404/)).toBeVisible();
    expect(within(details).getByText(/saved route and model checks were kept/)).toBeVisible();
    expect(within(details).getByText(/Direct PDF/)).toBeVisible();
    expect(load).not.toHaveBeenCalled();
    expect(actions.actions.saveModel).not.toHaveBeenCalled();
  });

  it("defers saved image catalog and endpoint discovery until the picker is opened", async () => {
    const loadModels = vi.spyOn(providerApi, "discoverAdminImageModels").mockResolvedValue({ ok: true, data: [] });
    const loadEndpoints = vi.spyOn(providerApi, "discoverAdminImageEndpoints").mockResolvedValue({ ok: true, data: [] });
    const connection = workingConnection();
    connection.family = "openrouter";
    const configuration = imageModelConfiguration("vendor/image", { profile: "openrouter" });
    const model = fixtureModel({ connectionId: connection.id, displayName: "Image model", id: "image-model",
      modelClass: "image", draftConfig: configuration, activeConfig: configuration });
    const renameModel = vi.fn(async () => ({ ok: true as const }));
    render(<AdminProviderModelSheet connection={{ ...connection, models: [model] }} model={model}
      controller={controller(vi.fn(), renameModel)} discovery={discovery()} onClose={vi.fn()} onSaved={vi.fn()} open />);
    const sheet = screen.getByRole("dialog", { name: "Edit model" });
    fireEvent.change(within(sheet).getByLabelText("Display name"), { target: { value: "Renamed image" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(renameModel).toHaveBeenCalledOnce());
    expect(loadModels).not.toHaveBeenCalled();
    expect(loadEndpoints).not.toHaveBeenCalled();
    const picker = within(sheet).getByRole("button", { name: "Image model" });
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.click(picker);
    await waitFor(() => expect(loadModels).toHaveBeenCalledOnce());
    expect(loadEndpoints).toHaveBeenCalledOnce();
  });

  it.each((["openai", "openai_compatible", "openrouter"] as const).flatMap((family) => [
    { family, workingKey: true }, { family, workingKey: false }
  ]))("renames a disabled $family model (key: $workingKey) without discovery or checks and keeps its frozen guard", async ({ family, workingKey }) => {
    const connection = workingConnection();
    connection.family = family;
    if (!workingKey) { connection.credentials = []; connection.defaultCredentialId = null; }
    const model = { ...connection.models[0]!, enabled: false };
    connection.models[0] = model;
    const renameModel = vi.fn(async () => ({ ok: true as const }));
    const saveModel = vi.fn();
    const session = discovery();
    const modelLoad = vi.spyOn(session.models, "load");
    const compatibleLoad = vi.spyOn(session.compatibleModels, "load");
    const endpointLoad = vi.spyOn(session.endpoints, "load");
    const onSaved = vi.fn();
    const props = { connection, model, controller: controller(saveModel, renameModel), discovery: session, onClose: vi.fn(), onSaved, open: true };
    const view = render(<AdminProviderModelSheet {...props} />);
    const sheet = screen.getByRole("dialog", { name: "Edit model" });
    fireEvent.change(within(sheet).getByLabelText("Display name"), { target: { value: "New label" } });
    expect(within(sheet).getByRole("button", { name: "Save" })).toBeEnabled();
    view.rerender(<AdminProviderModelSheet {...props} model={{ ...model, draftVersion: 2, displayName: "Concurrent name" }} />);
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(renameModel).toHaveBeenCalledWith(connection.id, model.id, {
      displayName: "New label", expectedActiveVersion: model.activeVersion, expectedDisplayName: model.displayName,
      expectedDraftVersion: model.draftVersion, expectedUpdatedAt: model.updatedAt
    });
    expect(saveModel).not.toHaveBeenCalled();
    expect(modelLoad).not.toHaveBeenCalled();
    expect(compatibleLoad).not.toHaveBeenCalled();
    expect(endpointLoad).not.toHaveBeenCalled();
  });

  it("keeps discard protection for an unsaved rename and uses Test & Save after any configuration change", () => {
    const connection = workingConnection();
    const onClose = vi.fn();
    render(<AdminProviderModelSheet connection={connection} model={connection.models[0]!} controller={controller()} discovery={discovery()} onClose={onClose} onSaved={vi.fn()} open />);
    const sheet = screen.getByRole("dialog", { name: "Edit model" });
    fireEvent.change(within(sheet).getByLabelText("Display name"), { target: { value: "New label" } });
    expect(within(sheet).getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.change(within(sheet).getByLabelText("Response timeout (seconds)"), { target: { value: "120" } });
    expect(within(sheet).getByRole("button", { name: "Test & Save" })).toBeEnabled();
    fireEvent.change(within(sheet).getByLabelText("Response timeout (seconds)"), { target: { value: "" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("provider-model-discard")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("allows an unactivated model draft to be published without an artificial edit", async () => {
    const connection = workingConnection();
    const model = { ...connection.models[0]!, activeConfig: null, activeVersion: 0, activatedAt: null };
    const saveModel = vi.fn(async () => ({ ok: true as const }));
    const onSaved = vi.fn();
    render(<AdminProviderModelSheet connection={{ ...connection, models: [model, ...connection.models.slice(1)] }} model={model}
      controller={controller(saveModel)} discovery={discovery()} onClose={vi.fn()} onSaved={onSaved} open />);
    const sheet = screen.getByRole("dialog", { name: "Edit model" });
    expect(within(sheet).getByRole("button", { name: "Test & Save" })).toBeEnabled();
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(saveModel).toHaveBeenCalledOnce());
    expect(saveModel).toHaveBeenCalledWith(connection.id, model.id, expect.objectContaining({
      displayName: model.displayName,
      configuration: expect.objectContaining({ upstreamModelId: model.draftConfig.upstreamModelId })
    }), expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) }));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("keeps a new model draft when its last key is revoked and blocks even form submission", async () => {
    const connection = workingConnection();
    const saveModel = vi.fn(async () => ({ ok: true as const }));
    const props = { connection, controller: controller(saveModel), discovery: discovery(), model: null, onClose: vi.fn(), onSaved: vi.fn(), open: true };
    const view = render(<AdminProviderModelSheet {...props} />);
    const sheet = await screen.findByRole("dialog", { name: "Add model" });
    fireEvent.change(within(sheet).getByRole("combobox", { name: "Model" }), { target: { value: "new-model" } });
    expect(within(sheet).getByRole("button", { name: "Test & Save" })).toBeEnabled();
    view.rerender(<AdminProviderModelSheet {...props} connection={{ ...connection, credentials: [] }} />);
    expect(within(sheet).getByRole("combobox", { name: "Model" })).toHaveValue("new-model");
    expect(within(sheet).getByRole("button", { name: "Test & Save" })).toBeDisabled();
    expect(sheet).toHaveTextContent("Add a working key first, then add models.");
    fireEvent.submit(within(sheet).getByRole("combobox", { name: "Model" }).closest("form")!);
    expect(saveModel).not.toHaveBeenCalled();
  });

  it("shows a canonical output-limit example within the model ceiling without changing defaults", async () => {
    const connection = workingConnection();
    const model = connection.models[0]!;
    model.draftConfig.defaultParams = {};
    model.draftConfig.capabilities.maxOutputTokens = 512;
    const saveModel = vi.fn(async () => ({ ok: true as const }));
    render(<AdminProviderModelSheet connection={connection} controller={controller(saveModel)} discovery={discovery()} model={model} onClose={vi.fn()} onSaved={vi.fn()} open />);
    const sheet = await screen.findByRole("dialog", { name: "Edit model" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Edit JSON" }));
    expect(JSON.parse(screen.getByTestId("model-json-example").textContent!)).toEqual({ maxOutputTokens: 512 });
    fireEvent.click(screen.getByRole("button", { name: "Apply to model" }));
    expect(sheet).toHaveTextContent("No custom parameters");
    expect(saveModel).not.toHaveBeenCalled();
  });

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
    expect(screen.getByTestId("provider-model-discard")).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
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

  it("lets an existing compatible model enable Codex search independently of hosted AIQSA Search", async () => {
    const connection = fixtureConnection({ displayName: "Compatible", family: "openai_compatible", id: "compatible" });
    const model = fixtureModel({ connectionId: connection.id, displayName: "Custom", id: "custom" });
    model.draftConfig = { ...model.draftConfig, adapterKind: "openai_responses_compatible",
      capabilities: { ...model.draftConfig.capabilities, nativeSearch: false } };
    connection.models = [model];
    const saveModel = vi.fn(async () => ({ ok: true as const }));
    render(<AdminProviderModelSheet connection={connection} controller={controller(saveModel)} discovery={discovery()} model={model} onClose={vi.fn()} onSaved={vi.fn()} open />);
    const sheet = await screen.findByRole("dialog", { name: "Edit model" });
    fireEvent.click(within(sheet).getByRole("switch", { name: "Codex web search" }));
    expect(within(sheet).getByRole("switch", { name: "Hosted web search" })).not.toBeChecked();
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(saveModel).toHaveBeenCalledOnce());
    expect(saveModel.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({
      configuration: expect.objectContaining({ capabilities: expect.objectContaining({ codexStandaloneWebSearch: true, nativeSearch: false }) })
    })]));
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

    fireEvent.click(within(sheet).getByLabelText(/Custom providers/));
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
      expectedActiveVersion: 1,
      expectedDisplayName: model.displayName,
      expectedDraftVersion: 1,
      expectedUpdatedAt: model.updatedAt
    }, expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(AbortSignal) }));

    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    const discard = await screen.findByTestId("provider-model-discard");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(discard).getByRole("button", { name: "Confirm discard changes" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers built-in ids as hints with a usable non-default key without changing the save key", async () => {
    const connection = fixtureConnection({ credentials: [fixtureCredential({ id: "non-default", label: "Fixture key" })], displayName: "Anthropic", family: "anthropic", id: "conn-anthropic" });
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

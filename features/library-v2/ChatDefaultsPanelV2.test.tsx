import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import { ChatDefaultsPanelV2 } from "./ChatDefaultsPanelV2";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import type { ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";

type DefaultAssistantView = NonNullable<NonNullable<ShellComposerView["chatDefaults"]>["assistant"]>;

function assistantSummary(id: string, name: string, overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    archived: false,
    audience: { everyone: false, groupNames: [] },
    availability: { ok: true },
    avatar: { accents: [0], backgroundShape: "circle", foregroundShape: "diamond", kind: "generated", paletteId: "ocean", recipeVersion: 1, rotations: [0, 1] },
    category: null,
    description: "",
    featured: false,
    featuredOrder: null,
    fingerprint: { knowledgeLabel: null, knowledgeResourceCount: 0, mcpServerCount: 0, modelLabel: null, reasoningEffort: null, searchOptionCount: 0 },
    id,
    name,
    owned: true,
    ownerDisplayName: "Owner",
    pinned: false,
    published: false,
    rowAvailability: {},
    scope: { kind: "owner" },
    skillLinkCount: 0,
    starterPrompts: [],
    updatedAt: "2026-09-28T00:00:00.000Z",
    ...overrides
  };
}

function renderDefaults(assistant: Partial<DefaultAssistantView>) {
  const view: DefaultAssistantView = {
    assistantId: null,
    assistants: [],
    assistantsState: "ready",
    loadAssistants: vi.fn(),
    set: vi.fn(),
    unavailable: false,
    ...assistant
  };
  render(<ChatDefaultsPanelV2 onNavigate={vi.fn()} composer={{
    catalog: composerGalleryConfig.catalog, knowledge: { bases: [] },
    chatDefaults: { assistant: view, knowledgePlan: null, mcpMode: "auto", skillsMode: "auto",
      searchPlan: { mode: "all_selected", optionIds: [] }, setKnowledgePlan: vi.fn(), setSearchPlan: vi.fn(), setMcpMode: vi.fn() }
  }} />);
  return view;
}

describe("Studio Chat defaults", () => {
  it("keeps the model row and explains unavailable defaults while the catalog is absent", () => {
    render(<ChatDefaultsPanelV2 composer={{ catalog: null, knowledge: { bases: [] } }} onNavigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Default model" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Defaults are unavailable until the model catalog loads.");
    expect(screen.queryByRole("button", { name: "Active instructions" })).toBeNull();
  });

  it("retains an unavailable personal model and writes only an explicit new selection", () => {
    const catalog = structuredClone(composerGalleryConfig.catalog);
    const provider = catalog.providers.find(item => item.id === catalog.models[0].provider)!;
    provider.id = "00000000-0000-4000-8000-000000001104";
    catalog.models[0].provider = provider.id;
    catalog.defaults.personalModelDefault = { provider: "missing-provider", modelId: "missing-model" };
    const makeModelDefault = vi.fn();
    const useOrganizationModelDefault = vi.fn();
    render(<ChatDefaultsPanelV2 composer={{ catalog, knowledge: { bases: [] }, makeModelDefault, useOrganizationModelDefault }} onNavigate={vi.fn()} />);
    const picker = screen.getByRole("button", { name: "Default model" });
    expect(picker).toHaveTextContent("Unavailable model");
    expect(makeModelDefault).not.toHaveBeenCalled();
    expect(useOrganizationModelDefault).not.toHaveBeenCalled();
    fireEvent.click(picker);
    expect(screen.getByRole("menu")).not.toHaveTextContent(provider.id);
    fireEvent.click(screen.getByRole("menuitem", { name: `${catalog.models[0].displayName}${catalog.providers.find(provider => provider.id === catalog.models[0].provider)?.name}` }));
    expect(makeModelDefault).toHaveBeenCalledWith(catalog.models[0]);
  });

  it("routes capability links through the page owner without changing defaults", () => {
    const onNavigate = vi.fn();
    const setMcpMode = vi.fn();
    const setSkillsMode = vi.fn();
    render(<ChatDefaultsPanelV2 onNavigate={onNavigate} composer={{
      catalog: composerGalleryConfig.catalog, knowledge: { bases: [] },
      chatDefaults: { knowledgePlan: null, mcpMode: "auto", skillsMode: "auto", searchPlan: { mode: "all_selected", optionIds: [] },
        setKnowledgePlan: vi.fn(), setSearchPlan: vi.fn(), setMcpMode, setSkillsMode }
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(onNavigate.mock.calls).toEqual([["mcp"], ["skills"]]);
    expect(setMcpMode).not.toHaveBeenCalled();
    expect(setSkillsMode).not.toHaveBeenCalled();
  });

  it("offers None and the Assistants available to the user, pinned first, and saves an explicit choice", () => {
    const view = renderDefaults({ assistants: [
      assistantSummary("zeta", "Zeta"),
      assistantSummary("alpha", "Alpha"),
      assistantSummary("pinned", "Pinned helper", { pinned: true }),
      assistantSummary("archived", "Archived", { archived: true }),
      assistantSummary("blocked", "Blocked", { availability: { ok: false, reason: "model_access" } })
    ] });
    const row = screen.getByTestId("settings-default-assistant");
    expect(row).toHaveTextContent("Assistant");
    expect(row).toHaveTextContent("Starts every new personal chat. Projects use their own.");
    const select = screen.getByRole("button", { name: "Default Assistant" });
    expect(select).toHaveTextContent("None");
    fireEvent.click(select);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["None", "Pinned helper", "Alpha", "Zeta"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Alpha" }));
    expect(view.set).toHaveBeenCalledWith("alpha");
    expect(view.loadAssistants).not.toHaveBeenCalled();
  });

  it("shows the saved default, clears it with None, and loads the list the first time it is missing", () => {
    const view = renderDefaults({ assistantId: "alpha", assistants: [assistantSummary("alpha", "Alpha")] });
    const select = screen.getByRole("button", { name: "Default Assistant" });
    expect(select).toHaveTextContent("Alpha");
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("menuitem", { name: "None" }));
    expect(view.set).toHaveBeenCalledWith(null);
    cleanup();

    const loading = renderDefaults({ assistantId: "alpha", assistants: null, assistantsState: "loading" });
    expect(loading.loadAssistants).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Default Assistant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Default Assistant" })).toHaveTextContent("Loading…");
    cleanup();

    const failed = renderDefaults({ assistants: null, assistantsState: "error" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(failed.loadAssistants).toHaveBeenCalledTimes(2);
  });

  it("names a saved default that is no longer available and clears it only on request", () => {
    const view = renderDefaults({ assistantId: null, assistants: [assistantSummary("alpha", "Alpha")], unavailable: true });
    const row = screen.getByTestId("settings-default-assistant");
    expect(within(row).getByRole("status")).toHaveTextContent("No longer available");
    expect(within(row).queryByRole("button", { name: "Default Assistant" })).toBeNull();
    expect(view.set).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Clear" }));
    expect(view.set).toHaveBeenCalledWith(null);
  });
});

type ImageModelView = NonNullable<NonNullable<ShellComposerView["chatDefaults"]>["imageModel"]>;

const imageModel = { id: "image-1", displayName: "GPT Image 2", providerName: "OpenAI", generation: true, editing: true, unavailableReason: null };
const generationOnly = { id: "image-2", displayName: "Fast Image", providerName: "Gateway", generation: true, editing: false, unavailableReason: null };
const imageSettings = { models: [imageModel, generationOnly], organizationDefaultId: "image-1", selectedId: null,
  effective: { id: "image-1", source: "organization" as const } };

function renderImageModel(patch: Partial<ImageModelView>) {
  const view: ImageModelView = { settings: imageSettings, loadState: "ready", saving: false, loadError: null, saveError: null,
    load: vi.fn(), select: vi.fn(), ...patch };
  render(<ChatDefaultsPanelV2 onNavigate={vi.fn()} composer={{
    catalog: composerGalleryConfig.catalog, knowledge: { bases: [] },
    chatDefaults: { imageModel: view, knowledgePlan: null, mcpMode: "auto", skillsMode: "auto",
      searchPlan: { mode: "all_selected", optionIds: [] }, setKnowledgePlan: vi.fn(), setSearchPlan: vi.fn(), setMcpMode: vi.fn() }
  }} />);
  return { view, row: screen.getByTestId("settings-default-image-model") };
}

describe("Studio Chat defaults image model", () => {
  it("follows the organization default, lists every published model and saves only an explicit choice", () => {
    const { view, row } = renderImageModel({});
    expect(row).toHaveTextContent("Projects use the organization default.");
    expect(view.load).toHaveBeenCalledOnce();
    const select = within(row).getByRole("button", { name: "Image model" });
    expect(select).toHaveTextContent("Organization default · GPT Image 2");
    fireEvent.click(select);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Organization default · GPT Image 2", "GPT Image 2OpenAI · Creates and edits", "Fast ImageGateway · Creates only"
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Fast ImageGateway · Creates only" }));
    expect(view.select).toHaveBeenCalledExactlyOnceWith("image-2");
    cleanup();

    const personal = renderImageModel({ settings: { ...imageSettings, selectedId: "image-2", effective: { id: "image-2", source: "personal" } } });
    expect(within(personal.row).getByRole("button", { name: "Image model" })).toHaveTextContent("Fast Image");
    fireEvent.click(within(personal.row).getByRole("button", { name: "Image model" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Organization default · GPT Image 2" }));
    expect(personal.view.select).toHaveBeenCalledExactlyOnceWith(null);
    expect(within(personal.row).queryByRole("status")).toBeNull();
  });

  it("names why the chosen model is unavailable and offers the organization default without replacing it", () => {
    const broken = { ...generationOnly, generation: false, unavailableReason: "credential_unavailable" as const };
    const { view, row } = renderImageModel({ settings: { ...imageSettings, models: [imageModel, broken], selectedId: "image-2",
      effective: { id: "image-2", source: "personal" } } });
    expect(within(row).getByRole("button", { name: "Image model" })).toHaveTextContent("Fast Image");
    expect(within(row).getByRole("status")).toHaveTextContent(
      "Fast Image is unavailable: its provider key is unavailable. Choose another model or the organization default.");
    expect(view.select).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Use organization default" }));
    expect(view.select).toHaveBeenCalledExactlyOnceWith(null);
    cleanup();

    const defaultBroken = renderImageModel({ settings: { ...imageSettings, models: [{ ...imageModel, unavailableReason: "verification_required" }, generationOnly] } });
    expect(within(defaultBroken.row).getByRole("status")).toHaveTextContent(
      "GPT Image 2 is unavailable: it needs a new check by an administrator. Choose another model.");
    expect(within(defaultBroken.row).queryByRole("button", { name: "Use organization default" })).toBeNull();
  });

  it("keeps loading, failure, an unconfigured organization and a refused save distinct", () => {
    const loading = renderImageModel({ settings: null, loadState: "loading" });
    expect(within(loading.row).getByRole("button", { name: "Image model" })).toBeDisabled();
    expect(within(loading.row).getByRole("button", { name: "Image model" })).toHaveTextContent("Loading…");
    cleanup();

    const failed = renderImageModel({ settings: null, loadState: "error", loadError: "image_models_unavailable" });
    expect(within(failed.row).getByRole("status")).toHaveTextContent("Image models didn't load");
    fireEvent.click(within(failed.row).getByRole("button", { name: "Retry image models" }));
    expect(failed.view.load).toHaveBeenCalledTimes(2);
    cleanup();

    const unconfigured = renderImageModel({ settings: { models: [], organizationDefaultId: null, selectedId: null, effective: null } });
    expect(within(unconfigured.row).getByRole("status")).toHaveTextContent("Not set up by your organization");
    expect(within(unconfigured.row).queryByRole("button", { name: "Image model" })).toBeNull();
    cleanup();

    const refused = renderImageModel({ saveError: "image_model_not_published", saving: false });
    expect(within(refused.row).getByRole("alert")).toHaveTextContent("This image model is no longer published.");
    cleanup();

    const saving = renderImageModel({ saving: true });
    expect(within(saving.row).getByRole("button", { name: "Image model" })).toBeDisabled();
  });
});

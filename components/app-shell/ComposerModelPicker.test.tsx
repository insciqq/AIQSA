import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Catalog, CatalogModel } from "./types";
import { ComposerModelPicker } from "./ComposerModelPicker";

function model(id: string, displayName: string): CatalogModel {
  return {
    capabilities: {
      background: false,
      documentInputMode: "none",
      imageInput: false,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: false,
      streaming: true,
      toolCalling: false
    },
    contextWindow: 32_000,
    defaultParams: {},
    displayName,
    modelId: id,
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 4_096, maxValue: 4_096 },
      reasoningEffort: { defaultValue: "none", options: ["none"], supported: false },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "connection-a",
    searchStrategyIds: ["search-disabled"]
  };
}

describe("composer model picker default facts", () => {
  it("uses stable distinct labels for duplicate provider and model names", () => {
    const first = model("model-a", "Shared model");
    const second = { ...model("model-b", "Shared model"), provider: "connection-b" };
    const catalog: Catalog = {
      defaults: {
        controlValues: {},
        hasPersonalModelDefault: false,
        modelId: first.modelId,
        modelPreferenceSource: "organization",
        organizationModelDefault: { modelId: first.modelId, provider: first.provider },
        personalModelDefault: null,
        provider: first.provider,
        searchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true
      },
      models: [first, second],
      providers: [
        { id: first.provider, models: [first.modelId], name: "OpenAI" },
        { id: second.provider, models: [second.modelId], name: " openai " }
      ],
      searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
    };

    render(<ComposerModelPicker
      catalog={catalog}
      catalogUnavailable={false}
      currentModel={first}
      disabled={false}
      onOpenChange={vi.fn()}
      onSelectModel={vi.fn()}
      open
      selectedModelId={first.modelId}
      selectedProvider={first.provider}
      selectedProviderName="OpenAI"
      streaming={false}
    />);

    const modelActions = screen.getAllByRole("button", { name: /Select model .* Shared model/u });
    expect(modelActions).toHaveLength(2);
    expect(modelActions[0]).not.toHaveAccessibleName(modelActions[1]!.getAttribute("aria-label")!);
    expect(modelActions.map((action) => action.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/^Select model OpenAI · ref [0-9A-Z]{6,} Shared model$/u),
      expect.stringMatching(/^Select model  openai  · ref [0-9A-Z]{6,} Shared model$/u)
    ]);
    expect(screen.getByTitle(/^OpenAI · ref [0-9A-Z]{6,} \/ Shared model$/u)).toBeInTheDocument();
  });

  it("separates Current, My default, and Organization default with peer actions", () => {
    const personal = model("model-personal", "Personal model");
    const current = model("model-current", "Current model");
    const catalog: Catalog = {
      defaults: {
        controlValues: {},
        hasPersonalModelDefault: true,
        modelId: personal.modelId,
        modelPreferenceSource: "personal",
        organizationModelDefault: {
          modelId: current.modelId,
          provider: current.provider
        },
        personalModelDefault: {
          modelId: personal.modelId,
          provider: personal.provider
        },
        provider: personal.provider,
        searchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true
      },
      models: [personal, current],
      providers: [{ id: "connection-a", models: [personal.modelId, current.modelId], name: "Provider A" }],
      searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
    };
    const makeDefault = vi.fn();
    const selectModel = vi.fn();
    const useOrganization = vi.fn();

    render(<ComposerModelPicker
      catalog={catalog}
      catalogUnavailable={false}
      currentModel={current}
      disabled={false}
      onMakeModelDefault={makeDefault}
      onOpenChange={vi.fn()}
      onSelectModel={selectModel}
      onUseOrganizationDefault={useOrganization}
      open
      selectedModelId={current.modelId}
      selectedProvider={current.provider}
      selectedProviderName="Provider A"
      streaming={false}
    />);

    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("My default")).toBeInTheDocument();
    expect(screen.getByText("Organization default")).toBeInTheDocument();
    expect(screen.getByText("Choosing a model changes only the next run.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make Provider A Personal model my default" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Make Provider A Current model my default" }));
    fireEvent.click(screen.getByRole("button", { name: "Use organization default" }));
    expect(makeDefault).toHaveBeenCalledWith(current);
    expect(selectModel).not.toHaveBeenCalled();
    expect(useOrganization).toHaveBeenCalledTimes(1);
  });

  it("offers to make the organization default personal when no personal default exists", () => {
    const organization = model("model-organization", "Organization model");
    const catalog: Catalog = {
      defaults: {
        controlValues: {},
        hasPersonalModelDefault: false,
        modelId: organization.modelId,
        modelPreferenceSource: "organization",
        organizationModelDefault: {
          modelId: organization.modelId,
          provider: organization.provider
        },
        personalModelDefault: null,
        provider: organization.provider,
        searchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true
      },
      models: [organization],
      providers: [{ id: "connection-a", models: [organization.modelId], name: "Provider A" }],
      searchStrategies: [{ displayName: "No Search", kind: "none", strategyId: "search-disabled" }]
    };
    const makeDefault = vi.fn();

    render(<ComposerModelPicker
      catalog={catalog}
      catalogUnavailable={false}
      currentModel={organization}
      disabled={false}
      onMakeModelDefault={makeDefault}
      onOpenChange={vi.fn()}
      onSelectModel={vi.fn()}
      onUseOrganizationDefault={vi.fn()}
      open
      selectedModelId={organization.modelId}
      selectedProvider={organization.provider}
      selectedProviderName="Provider A"
      streaming={false}
    />);

    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("Organization default")).toBeInTheDocument();
    expect(screen.queryByText("My default")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use organization default" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Make Provider A Organization model my default" }));
    expect(makeDefault).toHaveBeenCalledWith(organization);
  });
});

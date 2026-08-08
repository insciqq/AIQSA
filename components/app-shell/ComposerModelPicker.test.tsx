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
    const useOrganization = vi.fn();

    render(<ComposerModelPicker
      catalog={catalog}
      catalogUnavailable={false}
      currentModel={current}
      disabled={false}
      onMakeCurrentDefault={makeDefault}
      onOpenChange={vi.fn()}
      onSelectModel={vi.fn()}
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
    fireEvent.click(screen.getByRole("button", { name: "Make current my default" }));
    fireEvent.click(screen.getByRole("button", { name: "Use organization default" }));
    expect(makeDefault).toHaveBeenCalledTimes(1);
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
      onMakeCurrentDefault={makeDefault}
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

    fireEvent.click(screen.getByRole("button", { name: "Make current my default" }));
    expect(makeDefault).toHaveBeenCalledTimes(1);
  });
});

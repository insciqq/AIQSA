import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import { ChatDefaultsPanelV2 } from "./ChatDefaultsPanelV2";

describe("Studio Chat defaults", () => {
  it("keeps the model row and explains unavailable defaults while the catalog is absent", () => {
    render(<ChatDefaultsPanelV2 composer={{ catalog: null, knowledge: { bases: [] } }} onNavigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Default model" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Defaults are unavailable until the model catalog loads.");
    expect(screen.queryByRole("button", { name: "Active instructions" })).toBeNull();
  });

  it("retains an unavailable personal model and writes only an explicit new selection", () => {
    const catalog = structuredClone(composerGalleryConfig.catalog);
    catalog.defaults.personalModelDefault = { provider: "missing-provider", modelId: "missing-model" };
    const makeModelDefault = vi.fn();
    const useOrganizationModelDefault = vi.fn();
    render(<ChatDefaultsPanelV2 composer={{ catalog, knowledge: { bases: [] }, makeModelDefault, useOrganizationModelDefault }} onNavigate={vi.fn()} />);
    const picker = screen.getByRole("button", { name: "Default model" });
    expect(picker).toHaveTextContent("Unavailable model");
    expect(makeModelDefault).not.toHaveBeenCalled();
    expect(useOrganizationModelDefault).not.toHaveBeenCalled();
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("menuitem", { name: `${catalog.models[0].displayName}${catalog.models[0].provider}` }));
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
});

import { describe, expect, it } from "vitest";
import {
  assistantRowsFromStoredColumns,
  legacyValuesFromAssistantRows,
  storedAssistantControlsPolicy,
  storedAssistantMcpMode,
  storedAssistantSearchPlan,
  storedColumnsFromAssistantRows,
  type StoredAssistantRowColumns
} from "./storedContent";

describe("stored Assistant content", () => {
  it("stores a plan without Search sources as explicit Off and keeps concrete plans", () => {
    for (const mode of ["all_selected", "model_choice"] as const) {
      expect(storedAssistantSearchPlan({ mode, optionIds: [] })).toEqual({ mode: "off" });
    }
    const plan = { mode: "model_choice" as const, optionIds: ["web"] };
    expect(storedAssistantSearchPlan(plan)).toEqual(plan);
  });

  it("derives the MCP mode and controls policy the database requires", () => {
    expect(storedAssistantMcpMode([])).toBe("off");
    expect(storedAssistantMcpMode(["server"])).toBe("exact");
    expect(storedAssistantControlsPolicy({})).toBe("adjustable");
    expect(storedAssistantControlsPolicy({ temperature: 0.2 })).toBe("fixed");
  });
});

/** A definition as the Assistants v2 migration leaves it: every row fixed except empty controls. */
function migrated(overrides: Partial<StoredAssistantRowColumns> = {}): StoredAssistantRowColumns {
  const runControls = overrides.runControls ?? {};
  const mcpServerIds = overrides.mcpServerIds ?? [];
  return {
    controlsPolicy: storedAssistantControlsPolicy(runControls),
    mcpMode: storedAssistantMcpMode(mcpServerIds),
    mcpServerIds,
    modelPolicy: "fixed",
    providerModelId: "model-1",
    runControls,
    searchPlan: { mode: "off" },
    searchPolicy: "fixed",
    skillLinks: [],
    skillsMode: "auto",
    skillsPolicy: "fixed",
    toolsPolicy: "fixed",
    ...overrides
  };
}

describe("stored Assistant rows", () => {
  it("round-trips every stored combination produced by the migration", () => {
    const variants = {
      mcpServerIds: [[], ["server-a", "server-b"]],
      runControls: [{}, { reasoningEffort: "high", temperature: 0.2 }],
      searchPlan: [{ mode: "off" }, { mode: "all_selected", optionIds: ["web"] }, { mode: "model_choice", optionIds: ["web", "news"] }],
      skillLinks: [[], [{ mode: "pinned", skillId: "skill-a" }, { mode: "available", skillId: "skill-b" }]],
      skillsMode: ["auto", "off"]
    } as const;
    let checked = 0;
    for (const mcpServerIds of variants.mcpServerIds) {
      for (const runControls of variants.runControls) {
        for (const searchPlan of variants.searchPlan) {
          for (const skillLinks of variants.skillLinks) {
            for (const skillsMode of variants.skillsMode) {
              const columns = migrated({
                mcpServerIds: [...mcpServerIds], runControls, searchPlan,
                skillLinks: [...skillLinks], skillsMode
              });
              const rows = assistantRowsFromStoredColumns(columns);
              expect(rows).not.toBeNull();
              expect(storedColumnsFromAssistantRows(rows!)).toEqual(columns);
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(48);
  });

  it("reads inherit values distinctly from Off and writes them back unchanged", () => {
    const columns = migrated({
      controlsPolicy: "adjustable",
      mcpMode: "inherit",
      modelPolicy: "adjustable",
      providerModelId: null,
      searchPlan: { mode: "inherit" },
      searchPolicy: "adjustable",
      skillsPolicy: "adjustable",
      toolsPolicy: "adjustable"
    });
    const rows = assistantRowsFromStoredColumns(columns);
    expect(rows).toEqual({
      controls: { policy: "adjustable", value: {} },
      model: { policy: "adjustable", value: { mode: "inherit" } },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
      tools: { policy: "adjustable", value: { mode: "inherit" } }
    });
    expect(storedColumnsFromAssistantRows(rows!)).toEqual(columns);
    // Flat fields cannot express inherit: the model is null, the rest reads as Off.
    expect(legacyValuesFromAssistantRows(rows!)).toEqual({
      mcpServerIds: [],
      providerModelId: null,
      runControls: {},
      searchPlan: { mode: "all_selected", optionIds: [] }
    });
    const off = assistantRowsFromStoredColumns(migrated());
    expect(off?.search.value).toEqual({ mode: "off" });
    expect(off?.tools.value).toEqual({ mode: "off" });
  });

  it("rejects combinations storage must not hold", () => {
    for (const invalid of [
      migrated({ modelPolicy: "fixed", providerModelId: null }),
      migrated({ searchPlan: { mode: "inherit" } }),
      migrated({ mcpMode: "inherit" }),
      migrated({ controlsPolicy: "fixed", runControls: {} }),
      migrated({ mcpMode: "exact", mcpServerIds: [] }),
      migrated({ mcpMode: "off", mcpServerIds: ["server"] }),
      migrated({ runControls: { topP: 1 } })
    ]) {
      expect(assistantRowsFromStoredColumns(invalid)).toBeNull();
    }
  });

  it("never stores a redacted projection", () => {
    const rows = assistantRowsFromStoredColumns(migrated({ mcpServerIds: ["server"] }))!;
    expect(() => storedColumnsFromAssistantRows({
      ...rows,
      tools: { policy: "fixed", value: { hiddenCount: 1, mode: "exact", serverIds: ["server"] } }
    })).toThrow("assistant_rows_redacted");
    expect(() => storedColumnsFromAssistantRows({
      ...rows,
      model: { policy: "fixed", value: { mode: "model", modelId: null } }
    })).toThrow("assistant_rows_redacted");
  });
});

/**
 * Columns as a previous-release writer or a direct insert leaves them: the
 * new columns keep their database defaults (every policy fixed except
 * adjustable controls, MCP mode off, no answer rules) and the Search plan may
 * still be a legacy plan without sources.
 */
function columnDefaults(overrides: Partial<StoredAssistantRowColumns> = {}): StoredAssistantRowColumns {
  return {
    controlsPolicy: "adjustable",
    mcpMode: "off",
    mcpServerIds: [],
    modelPolicy: "fixed",
    providerModelId: "model-1",
    runControls: {},
    searchPlan: { mode: "all_selected", optionIds: [] },
    searchPolicy: "fixed",
    skillLinks: [],
    skillsMode: "auto",
    skillsPolicy: "fixed",
    toolsPolicy: "fixed",
    ...overrides
  };
}

describe("stored Assistant rows written without the v2 columns", () => {
  it("reads a direct-insert fixture with its Search plan as Off", () => {
    expect(assistantRowsFromStoredColumns(columnDefaults({
      providerModelId: "fake-model",
      runControls: {},
      searchPlan: { mode: "all_selected", optionIds: [] }
    }))).toEqual({
      controls: { policy: "adjustable", value: {} },
      model: { policy: "fixed", value: { mode: "model", modelId: "fake-model" } },
      search: { policy: "fixed", value: { mode: "off" } },
      skills: { policy: "fixed", value: { links: [], mode: "auto" } },
      tools: { policy: "fixed", value: { mode: "off" } }
    });
  });

  it("returns rows for every value a previous-release writer or column defaults can store", () => {
    const variants = {
      mcp: [{ mcpMode: "off", mcpServerIds: [] }, { mcpMode: "exact", mcpServerIds: ["server"] }],
      runControls: [{}, { temperature: 0.2 }, null],
      searchPlan: [{ mode: "all_selected", optionIds: [] }, { mode: "model_choice", optionIds: [] }, { mode: "off" },
        { mode: "all_selected", optionIds: ["web"] }],
      skillLinks: [[], [{ mode: "available", skillId: "skill-a" }]]
    } as const;
    let checked = 0;
    for (const mcp of variants.mcp) {
      for (const runControls of variants.runControls) {
        for (const searchPlan of variants.searchPlan) {
          for (const skillLinks of variants.skillLinks) {
            for (const controlsPolicy of ["adjustable", "fixed"] as const) {
              if (controlsPolicy === "fixed" && (runControls === null || Object.keys(runControls).length === 0)) continue;
              const columns = columnDefaults({
                controlsPolicy, ...mcp, mcpServerIds: [...mcp.mcpServerIds], runControls,
                searchPlan, skillLinks: [...skillLinks]
              });
              const rows = assistantRowsFromStoredColumns(columns);
              expect(rows, JSON.stringify(columns)).not.toBeNull();
              expect(rows!.search.value.mode === "off").toBe((searchPlan as { optionIds?: unknown[] }).optionIds?.length !== 1);
              expect(rows!.controls.value).toEqual(runControls ?? {});
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(64);
  });
});

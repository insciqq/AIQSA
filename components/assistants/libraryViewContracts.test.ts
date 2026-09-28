import {
  assistantRowPolicyViolation,
  decodeAssistantDraft,
  type AssistantAvatarRecipe,
  type AssistantContent,
  type AssistantRows,
  type AssistantSummary
} from "@/lib/contracts/assistants";
import type { ModelParameterControls } from "@/lib/contracts/catalog";
import { describe, expect, it } from "vitest";
import {
  assistantCardState,
  assistantCardView,
  assistantDraftFromEditor,
  assistantDraftPolicyErrors,
  defaultAssistantDraftRows,
  draftRowsFromChatSetup,
  editorDraftFromContent,
  filterAssistantGallery,
  reconcileControlsForModel,
  runControlsFromDraft,
  type AssistantChatSetup,
  type AssistantControlsDraft,
  type AssistantDraftValidationContext,
  type AssistantEditorDraft
} from "./libraryViewContracts";

const avatar: AssistantAvatarRecipe = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

function controls(overrides: Partial<ModelParameterControls> = {}): ModelParameterControls {
  return {
    background: { defaultValue: true, supported: true },
    maxOutputTokens: { defaultValue: 4096, maxValue: 8192 },
    reasoningEffort: {
      defaultValue: "medium",
      options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      supported: true
    },
    reasoningMode: {
      defaultValue: "standard",
      options: ["standard", "pro"],
      supported: true
    },
    stream: { defaultValue: true, supported: true },
    temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true },
    ...overrides
  };
}

function controlsDraft(overrides: Partial<AssistantControlsDraft> = {}): AssistantControlsDraft {
  return {
    backgroundMode: null,
    maxOutputTokens: "",
    reasoningEffort: "",
    reasoningMode: "",
    streamMode: null,
    temperature: "",
    ...overrides
  };
}

function draft(overrides: Partial<AssistantEditorDraft> = {}): AssistantEditorDraft {
  return {
    answerRules: null,
    avatar,
    category: "coding",
    description: "Reviews changes.",
    name: "Reviewer",
    responseReminder: "",
    rows: defaultAssistantDraftRows(),
    starterPrompts: [],
    systemPrompt: "Review carefully.",
    ...overrides
  };
}

function withModel(state: AssistantEditorDraft, controlsValue = controlsDraft()): AssistantEditorDraft {
  return {
    ...state,
    rows: {
      ...state.rows,
      controls: { policy: "adjustable", value: controlsValue },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-1" } }
    }
  };
}

const context: AssistantDraftValidationContext = {
  mcpServers: [
    { enabled: true, id: "mcp-ready" },
    { enabled: true, id: "mcp-starting" },
    { enabled: false, id: "mcp-disabled" }
  ],
  model: { controls: controls(), toolCalling: true }
};

function summary(overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    archived: false,
    audience: overrides.owned === false ? null : { everyone: false, groupNames: [] },
    availability: { ok: true },
    avatar,
    category: "coding",
    description: "Reviews code",
    featured: false,
    featuredOrder: null,
    fingerprint: {
      knowledgeLabel: null,
      knowledgeResourceCount: 2,
      mcpServerCount: 1,
      modelLabel: null,
      reasoningEffort: null,
      searchOptionCount: 0
    },
    id: "a",
    name: "Alpha",
    owned: true,
    ownerDisplayName: "Dana",
    pinned: false,
    published: false,
    rowAvailability: {},
    scope: { kind: "owner" },
    skillLinkCount: 0,
    starterPrompts: [],
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides
  };
}

describe("Assistant rows draft", () => {
  it("starts a new Assistant as a persona over the user's own setup", () => {
    expect(defaultAssistantDraftRows()).toEqual({
      controls: { policy: "adjustable", value: controlsDraft() },
      knowledge: { policy: "adjustable", value: { mode: "none" } },
      model: { policy: "adjustable", value: { mode: "inherit" } },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
      tools: { policy: "adjustable", value: { mode: "inherit" } }
    });
  });

  it("saves an untouched new Assistant with inherit rows the contract accepts", () => {
    const result = assistantDraftFromEditor(draft(), { ...context, model: null });

    expect(result).toMatchObject({ draft: { rows: { model: { value: { mode: "inherit" } } } } });
    expect(decodeAssistantDraft("draft" in result ? result.draft : null)).toMatchObject({ ok: true });
  });

  it("reads stored rows with inherit and policies intact and drops projection counts", () => {
    const rows: AssistantRows = {
      controls: { policy: "fixed", value: { temperature: 0.4 } },
      knowledge: { policy: "adjustable", value: { baseIds: ["base-1"], hiddenCount: 1, mode: "explicit", sourceIds: ["doc-1"] } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-1" } },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      skills: { policy: "fixed", value: { links: [{ delivery: "on_demand", skillId: "skill-1" }], mode: "off" } },
      tools: { policy: "adjustable", value: { mode: "off" } }
    };
    const stored = { answerRules: "Be brief.", avatar, category: null, description: "", name: "Reviewer",
      responseReminder: "Check facts.", rows, starterPrompts: ["Review this"], systemPrompt: "Review." } as unknown as AssistantContent;

    expect(editorDraftFromContent(stored)).toEqual({
      answerRules: "Be brief.",
      avatar,
      category: null,
      description: "",
      name: "Reviewer",
      responseReminder: "Check facts.",
      rows: {
        controls: { policy: "fixed", value: controlsDraft({ temperature: "0.4" }) },
        knowledge: { policy: "adjustable", value: { baseIds: ["base-1"], mode: "explicit", sourceIds: ["doc-1"] } },
        model: { policy: "fixed", value: { mode: "model", modelId: "model-1" } },
        search: { policy: "adjustable", value: { mode: "inherit" } },
        skills: { policy: "fixed", value: { links: [{ delivery: "on_demand", skillId: "skill-1" }], mode: "off" } },
        tools: { policy: "adjustable", value: { mode: "off" } }
      },
      starterPrompts: ["Review this"],
      systemPrompt: "Review."
    });
  });

  it("mirrors the contract's policy rules with errors keyed by row", () => {
    const rows = defaultAssistantDraftRows();
    rows.search.policy = "fixed";
    rows.controls = { policy: "fixed", value: controlsDraft() };
    expect(assistantDraftPolicyErrors(rows)).toEqual({
      controls: "Set at least one parameter to fix, or make this row Adjustable.",
      search: "Choose a value to fix, or make this row Adjustable."
    });

    rows.search = { policy: "fixed", value: { mode: "off" } };
    rows.controls = { policy: "fixed", value: controlsDraft({ temperature: "1" }) };
    expect(assistantDraftPolicyErrors(rows)).toEqual({
      controls: "Fix the model before fixing its parameters."
    });
    expect(assistantRowPolicyViolation({
      ...rows,
      controls: { policy: "fixed", value: { temperature: 1 } }
    } as unknown as AssistantRows)).toMatchObject({ code: "assistant_row_controls_require_fixed_model", row: "controls" });
  });

  it("requires a name and keeps starters within the new limits", () => {
    const result = assistantDraftFromEditor(
      draft({ name: "  ", starterPrompts: ["x".repeat(201)] }),
      context
    );
    expect(result).toEqual({
      errors: {
        fields: {
          name: "Enter a name.",
          starterPrompts: "Keep up to 6 starters of up to 200 characters."
        },
        rows: {}
      }
    });
    expect(assistantDraftFromEditor(draft({ name: "x".repeat(81) }), context)).toMatchObject({
      errors: { fields: { name: "Use up to 80 characters." } }
    });
  });

  it("asks for a model before parameters and names a model outside the catalog", () => {
    const parameters = draft();
    parameters.rows.controls.value = controlsDraft({ temperature: "1" });
    expect(assistantDraftFromEditor(parameters, context)).toMatchObject({
      errors: { rows: { controls: "Choose a model to set its parameters." } }
    });
    expect(assistantDraftFromEditor(withModel(draft()), { ...context, model: null })).toMatchObject({
      errors: { rows: { model: "Choose a model from your catalog." } }
    });
  });

  it("blocks a disabled MCP server but not one that is still starting (D-11)", () => {
    const tools = withModel(draft());
    tools.rows.tools.value = { mode: "exact", serverIds: ["mcp-starting"] };
    expect(assistantDraftFromEditor(tools, context)).toMatchObject({
      draft: { rows: { tools: { value: { mode: "exact", serverIds: ["mcp-starting"] } } } }
    });
    tools.rows.tools.value = { mode: "exact", serverIds: ["mcp-disabled"] };
    expect(assistantDraftFromEditor(tools, context)).toMatchObject({
      errors: { rows: { tools: "Remove MCP servers that are disabled or unavailable before saving." } }
    });
    tools.rows.tools.value = { mode: "exact", serverIds: ["mcp-ready"] };
    expect(assistantDraftFromEditor(tools, { ...context, model: { controls: controls(), toolCalling: false } }))
      .toMatchObject({ errors: { rows: { tools: "Choose a model that can call tools, or remove the MCP tools." } } });
  });
});

describe("Assistant editor run-control contracts", () => {
  it("omits every untouched control so the model defaults remain authoritative", () => {
    expect(runControlsFromDraft(controlsDraft(), controls())).toEqual({ controls: {} });
    expect(assistantDraftFromEditor(withModel(draft()), context)).toMatchObject({
      draft: { rows: { controls: { value: {} } } }
    });
  });

  it.each(["0", "-5", "1.5", "8193"])(
    "rejects invalid max output tokens %s instead of silently dropping it",
    (maxOutputTokens) => {
      expect(assistantDraftFromEditor(withModel(draft(), controlsDraft({ maxOutputTokens })), context)).toEqual({
        errors: {
          fields: { maxOutputTokens: "Enter a whole number from 1 to 8192." },
          rows: { controls: "Enter a whole number from 1 to 8192." }
        }
      });
    }
  );

  it("rejects out-of-range and unsupported Temperature values", () => {
    expect(runControlsFromDraft(controlsDraft({ temperature: "3" }), controls()))
      .toMatchObject({ fieldErrors: { temperature: expect.any(String) } });
    expect(runControlsFromDraft(
      controlsDraft({ temperature: "1" }),
      controls({ temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: false } })
    )).toEqual({ fieldErrors: { temperature: "This model does not support Temperature." } });
  });

  it("accepts the exact catalog effort set and rejects stale values", () => {
    expect(runControlsFromDraft(controlsDraft({ reasoningEffort: "max" }), controls()))
      .toEqual({ controls: { reasoningEffort: "max" } });
    expect(runControlsFromDraft(controlsDraft({ reasoningEffort: "ultra" }), controls()))
      .toMatchObject({ fieldErrors: { reasoningEffort: expect.any(String) } });
  });

  it("resets incompatible values without clamping and reports every reset field", () => {
    const result = reconcileControlsForModel(
      controlsDraft({
        backgroundMode: true,
        maxOutputTokens: "8192",
        reasoningEffort: "max",
        reasoningMode: "pro",
        streamMode: false,
        temperature: "2"
      }),
      controls({
        background: { defaultValue: false, supported: false },
        maxOutputTokens: { defaultValue: 1024, maxValue: 2048 },
        reasoningEffort: { defaultValue: "low", options: ["low"], supported: true },
        reasoningMode: undefined,
        stream: { defaultValue: true, supported: true },
        temperature: { defaultValue: 0.5, maxValue: 1, minValue: 0, supported: true }
      })
    );

    expect(result.controls).toEqual(controlsDraft({ streamMode: false }));
    expect(result.resetFields).toEqual([
      "backgroundMode",
      "maxOutputTokens",
      "temperature",
      "reasoningEffort",
      "reasoningMode"
    ]);
  });
});

describe("From current chat", () => {
  const setup: AssistantChatSetup = {
    backgroundMode: false,
    knowledge: { baseIds: ["base-1"], mode: "explicit", sourceIds: ["doc-1"] },
    maxOutputTokens: "2048",
    mcp: { mode: "exact", serverIds: ["mcp-1"] },
    modelId: "model-1",
    reasoningEffort: "high",
    reasoningMode: "",
    search: { mode: "model_choice", optionIds: ["web"] },
    skills: { links: [{ delivery: "on_demand", skillId: "skill-1" }, { delivery: "always", skillId: "skill-2" }], mode: "off" },
    streamMode: true,
    temperature: "0.7"
  };

  it("carries every row of the chat as adjustable values", () => {
    const rows = draftRowsFromChatSetup(setup);
    expect(Object.values(rows).every((row) => row.policy === "adjustable")).toBe(true);
    expect(rows).toMatchObject({
      controls: { value: { backgroundMode: false, maxOutputTokens: "2048", reasoningEffort: "high", streamMode: true, temperature: "0.7" } },
      knowledge: { value: { baseIds: ["base-1"], mode: "explicit", sourceIds: ["doc-1"] } },
      model: { value: { mode: "model", modelId: "model-1" } },
      search: { value: { mode: "model_choice", optionIds: ["web"] } },
      skills: { value: { links: setup.skills.links, mode: "off" } },
      tools: { value: { mode: "exact", serverIds: ["mcp-1"] } }
    });
  });

  it("uses inherit for chat values rows cannot express", () => {
    expect(draftRowsFromChatSetup({ ...setup, knowledge: { mode: "all" }, mcp: { mode: "auto" } })).toMatchObject({
      knowledge: { value: { mode: "inherit" } },
      tools: { value: { mode: "inherit" } }
    });
    expect(draftRowsFromChatSetup({ ...setup, mcp: { enabledServerIds: ["mcp-1", "mcp-2"], mode: "load_all" } }).tools.value)
      .toEqual({ mode: "exact", serverIds: ["mcp-1", "mcp-2"] });
    expect(draftRowsFromChatSetup({ ...setup, mcp: { enabledServerIds: null, mode: "load_all" } }).tools.value)
      .toEqual({ mode: "inherit" });
    expect(draftRowsFromChatSetup({
      ...setup,
      knowledge: { mode: "none" },
      mcp: { mode: "off" },
      modelId: null,
      search: { mode: "all_selected", optionIds: [] }
    })).toMatchObject({
      knowledge: { value: { mode: "none" } },
      model: { value: { mode: "inherit" } },
      search: { value: { mode: "off" } },
      tools: { value: { mode: "off" } }
    });
  });
});

describe("Assistant gallery contracts", () => {
  const assistants = [
    summary({ featured: true, featuredOrder: 0, id: "featured", name: "Featured", owned: false, updatedAt: "2026-09-01T00:00:00.000Z" }),
    summary({ id: "pinned", name: "Pinned", pinned: true, updatedAt: "2026-09-02T00:00:00.000Z" }),
    summary({ category: "writing", id: "newer", name: "Newer", updatedAt: "2026-09-25T00:00:00.000Z" }),
    summary({ id: "older", name: "Older", ownerDisplayName: "Robin", updatedAt: "2026-09-03T00:00:00.000Z" }),
    summary({ archived: true, id: "archived", name: "Archived" })
  ];

  it("counts exactly what each chip lists and keeps archived out of All", () => {
    const result = filterAssistantGallery(assistants, { category: null, filter: "all", search: "" });
    expect(result.counts).toEqual({ all: 4, archived: 1, featured: 1, pinned: 1, shared: 1, yours: 3 });
    expect(result.groups.map((group) => [group.kind, group.cards.map((card) => card.assistant.id)])).toEqual([
      ["featured", ["featured"]],
      ["pinned", ["pinned"]],
      ["rest", ["newer", "older"]]
    ]);
    for (const filter of ["archived", "featured", "pinned", "shared", "yours"] as const) {
      const listed = filterAssistantGallery(assistants, { category: null, filter, search: "" });
      expect(listed.groups.flatMap((group) => group.cards)).toHaveLength(listed.counts[filter]);
    }
  });

  it("orders Featured Assistants by their position under All and the Featured chip", () => {
    const featured = [
      summary({ featured: true, featuredOrder: 2, id: "third", updatedAt: "2026-09-26T00:00:00.000Z" }),
      summary({ featured: true, featuredOrder: 0, id: "first", updatedAt: "2026-09-01T00:00:00.000Z" }),
      summary({ featured: true, featuredOrder: 1, id: "second", updatedAt: "2026-09-10T00:00:00.000Z" }),
      summary({ id: "plain", updatedAt: "2026-09-27T00:00:00.000Z" })
    ];
    const ids = (filter: "all" | "featured") => filterAssistantGallery(featured, { category: null, filter, search: "" })
      .groups.map((group) => [group.kind, group.cards.map((card) => card.assistant.id)]);
    expect(ids("all")).toEqual([["featured", ["first", "second", "third"]], ["rest", ["plain"]]]);
    expect(ids("featured")).toEqual([["rest", ["first", "second", "third"]]]);
  });

  it("fills the capability line from the fingerprint and the Skill link count", () => {
    expect(assistantCardView(summary({ skillLinkCount: 3 })).capabilities)
      .toEqual({ knowledge: 2, search: 0, skills: 3, tools: 1 });
    expect(assistantCardView(summary()).capabilities.skills).toBe(0);
  });

  it("searches name, description and author as one flat list under a category", () => {
    const byAuthor = filterAssistantGallery(assistants, { category: null, filter: "all", search: "robin" });
    expect(byAuthor.groups).toEqual([{ cards: [expect.objectContaining({ assistant: expect.objectContaining({ id: "older" }) })], kind: "rest" }]);
    expect(byAuthor.counts.all).toBe(1);
    expect(filterAssistantGallery(assistants, { category: "writing", filter: "all", search: "" }).counts)
      .toMatchObject({ all: 1, yours: 1 });
  });

  it("names the owner's missing dependencies and stays neutral for consumers", () => {
    expect(assistantCardState(summary({
      availability: { dependencies: [{ kind: "mcp", name: "GitHub" }, { kind: "model", name: "Luna" }], ok: false, reason: "tools_access" }
    }))).toEqual({ count: 2, kind: "attention", names: ["GitHub", "Luna"] });
    expect(assistantCardState(summary({ availability: { ok: false, reason: "tools_access" }, owned: false })))
      .toEqual({ kind: "unavailable" });
    expect(assistantCardState(summary({ archived: true }))).toEqual({ kind: "archived" });
  });
});

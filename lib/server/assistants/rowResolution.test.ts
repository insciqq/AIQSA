import { describe, expect, it } from "vitest";
import {
  assistantRowPolicyViolation,
  type AssistantRowPolicy,
  type AssistantRows,
  type AssistantRowValues,
  type AssistantRunControls
} from "../../contracts/assistants";
import type { ModelParameterControls } from "../../contracts/catalog";
import {
  applyChatAssistantOverridesPatch,
  type ChatAssistantOverrides,
  type ChatAssistantOverrideValues,
  type ChatAssistantRowValues
} from "../../contracts/chats";
import {
  assistantRunRowProvenance,
  materializeAssistantRowControls,
  resolveAssistantRows,
  type AssistantRowAvailableResources,
  type AssistantRowContextDefaults,
  type AssistantRowResolution,
  type AssistantRowResolutionFailure,
  type AssistantRowResolutionInput,
  type ResolvedAssistantRowValues
} from "./rowResolution";

type ResourceRowKey = "knowledge" | "model" | "search" | "tools";

const SAVED_CONTROLS: Readonly<Record<string, AssistantRunControls>> = {
  "model-a": { reasoningEffort: "low" },
  "model-b": { temperature: 0.7 },
  "model-default": { maxOutputTokens: 2048 }
};

const personalDefaults: AssistantRowContextDefaults = {
  controlsForModel: (modelId) => SAVED_CONTROLS[modelId] ?? {},
  knowledge: { mode: "all_my_knowledge" },
  modelId: "model-default",
  search: { mode: "all_selected", optionIds: ["web-default"] },
  tools: { mode: "auto" }
};

const personalAvailable: AssistantRowAvailableResources = {
  allMyKnowledge: true,
  knowledgeBaseIds: new Set(["kb-1", "kb-2"]),
  knowledgeSourceIds: new Set(["src-1"]),
  mcpServerIds: new Set(["mcp-1", "mcp-2"]),
  modelIds: new Set(["model-a", "model-b", "model-default"]),
  searchOptionIds: new Set(["web-1", "web-2", "web-default"]),
  skillIds: new Set(["skill-1", "skill-2"])
};

function rows(overrides: Partial<{ [Key in keyof AssistantRows]: Partial<AssistantRows[Key]> }> = {}): AssistantRows {
  const base: AssistantRows = {
    controls: { policy: "adjustable", value: {} },
    knowledge: { policy: "adjustable", value: { mode: "inherit" } },
    model: { policy: "adjustable", value: { mode: "inherit" } },
    search: { policy: "adjustable", value: { mode: "inherit" } },
    skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
    tools: { policy: "adjustable", value: { mode: "inherit" } }
  };
  return Object.fromEntries(
    Object.entries(base).map(([key, row]) => [key, { ...row, ...overrides[key as keyof AssistantRows] }])
  ) as AssistantRows;
}

function input(overrides: Partial<AssistantRowResolutionInput> = {}): AssistantRowResolutionInput {
  return {
    assistant: rows(),
    available: personalAvailable,
    defaults: personalDefaults,
    requested: {},
    stored: {},
    ...overrides
  };
}

function resolved(value: AssistantRowResolutionInput): AssistantRowResolution {
  const result = resolveAssistantRows(value);
  if (!result.ok) throw new Error(`unexpected failure ${result.code} on ${result.row}`);
  return result;
}

function failed(value: AssistantRowResolutionInput): AssistantRowResolutionFailure {
  const result = resolveAssistantRows(value);
  if (result.ok) throw new Error("unexpected success");
  return result;
}

/*
 * One fixture per resource row. `partial` names one available and one
 * unavailable resource; `unavailable` names only unavailable ones. Tools have
 * no unavailable chat value: chat tools are modes over the runner's servers.
 */
type RowFixture<Key extends ResourceRowKey> = {
  assistantEffective: ResolvedAssistantRowValues[Key];
  chat: ChatAssistantOverrideValues[Key];
  chatEffective: ResolvedAssistantRowValues[Key];
  chatUnavailable: ChatAssistantOverrideValues[Key] | null;
  concrete: AssistantRowValues[Key];
  defaultEffective: ResolvedAssistantRowValues[Key];
  explicitOff: { assistant: AssistantRowValues[Key]; chat: ChatAssistantOverrideValues[Key] | null;
    effective: ResolvedAssistantRowValues[Key] } | null;
  partial: { missing: string[]; value: AssistantRowValues[Key] } | null;
  unavailable: { missing: string[]; value: AssistantRowValues[Key] };
};

const fixtures: { [Key in ResourceRowKey]: RowFixture<Key> } = {
  knowledge: {
    assistantEffective: { baseIds: ["kb-1"], mode: "explicit", sourceIds: ["src-1"] },
    chat: { baseIds: ["kb-2"], mode: "explicit", sourceIds: [] },
    chatEffective: { baseIds: ["kb-2"], mode: "explicit", sourceIds: [] },
    chatUnavailable: { baseIds: ["kb-2", "kb-gone"], mode: "explicit", sourceIds: [] },
    concrete: { baseIds: ["kb-1"], mode: "explicit", sourceIds: ["src-1"] },
    defaultEffective: { mode: "all_my_knowledge" },
    explicitOff: { assistant: { mode: "none" }, chat: { mode: "none" }, effective: { mode: "none" } },
    partial: {
      missing: ["src-gone"],
      value: { baseIds: ["kb-1"], mode: "explicit", sourceIds: ["src-1", "src-gone"] }
    },
    unavailable: {
      missing: ["kb-gone", "src-gone"],
      value: { baseIds: ["kb-gone"], mode: "explicit", sourceIds: ["src-gone"] }
    }
  },
  model: {
    assistantEffective: { mode: "model", modelId: "model-a" },
    chat: { mode: "model", modelId: "model-b" },
    chatEffective: { mode: "model", modelId: "model-b" },
    chatUnavailable: { mode: "model", modelId: "model-gone" },
    concrete: { mode: "model", modelId: "model-a" },
    defaultEffective: { mode: "model", modelId: "model-default" },
    explicitOff: null,
    partial: null,
    unavailable: { missing: ["model-gone"], value: { mode: "model", modelId: "model-gone" } }
  },
  search: {
    assistantEffective: { mode: "model_choice", optionIds: ["web-1", "web-2"] },
    chat: { mode: "all_selected", optionIds: ["web-2"] },
    chatEffective: { mode: "all_selected", optionIds: ["web-2"] },
    chatUnavailable: { mode: "all_selected", optionIds: ["web-1", "web-gone"] },
    concrete: { mode: "model_choice", optionIds: ["web-1", "web-2"] },
    defaultEffective: { mode: "all_selected", optionIds: ["web-default"] },
    explicitOff: { assistant: { mode: "off" }, chat: { mode: "off" }, effective: { mode: "off" } },
    partial: { missing: ["web-gone"], value: { mode: "all_selected", optionIds: ["web-1", "web-gone"] } },
    unavailable: { missing: ["web-gone"], value: { mode: "all_selected", optionIds: ["web-gone"] } }
  },
  tools: {
    assistantEffective: { mode: "exact", serverIds: ["mcp-1", "mcp-2"] },
    chat: { mode: "load_all" },
    chatEffective: { mode: "load_all" },
    chatUnavailable: null,
    concrete: { mode: "exact", serverIds: ["mcp-1", "mcp-2"] },
    defaultEffective: { mode: "auto" },
    explicitOff: { assistant: { mode: "off" }, chat: { mode: "off" }, effective: { mode: "off" } },
    partial: { missing: ["mcp-gone"], value: { mode: "exact", serverIds: ["mcp-1", "mcp-gone"] } },
    unavailable: { missing: ["mcp-gone"], value: { mode: "exact", serverIds: ["mcp-gone"] } }
  }
};

type Scenario = {
  expected:
    | { assistantValueAvailable: boolean; missing: string[]; patch: "clear" | "none" | "persist";
      provenance: "assistant" | "chat" | "default" | "fallback"; value: "assistant" | "chat" | "default" | "off" }
    | { failure: AssistantRowResolutionFailure["code"] };
  name: string;
  policy: AssistantRowPolicy;
  request?: "chat" | "chatUnavailable" | "off";
  stored?: "chat" | "chatUnavailable" | "off";
  value: "concrete" | "inherit" | "off" | "partial" | "unavailable";
};

const scenarios: Scenario[] = [
  { expected: { assistantValueAvailable: true, missing: [], patch: "none", provenance: "default", value: "default" },
    name: "inherit asks the context default", policy: "adjustable", value: "inherit" },
  { expected: { assistantValueAvailable: true, missing: [], patch: "none", provenance: "assistant", value: "assistant" },
    name: "an available adjustable value is the Assistant's", policy: "adjustable", value: "concrete" },
  { expected: { assistantValueAvailable: false, missing: ["*"], patch: "none", provenance: "fallback", value: "default" },
    name: "an unavailable adjustable value falls back to the default", policy: "adjustable", value: "unavailable" },
  { expected: { assistantValueAvailable: false, missing: ["*"], patch: "none", provenance: "fallback", value: "default" },
    name: "a partly unavailable adjustable value falls back as a whole", policy: "adjustable", value: "partial" },
  { expected: { assistantValueAvailable: true, missing: [], patch: "none", provenance: "assistant", value: "off" },
    name: "an explicit Off is the Assistant's value, not inherit", policy: "adjustable", value: "off" },
  { expected: { assistantValueAvailable: true, missing: [], patch: "none", provenance: "chat", value: "chat" },
    name: "a stored adjustable value is the chat's", policy: "adjustable", stored: "chat", value: "concrete" },
  { expected: { assistantValueAvailable: true, missing: [], patch: "none", provenance: "chat", value: "off" },
    name: "a stored Off is a chat value over a concrete Assistant value", policy: "adjustable", stored: "off",
    value: "concrete" },
  { expected: { assistantValueAvailable: false, missing: ["*"], patch: "none", provenance: "chat", value: "chat" },
    name: "a stored value wins over an unavailable Assistant value and keeps the deviation", policy: "adjustable",
    stored: "chat", value: "unavailable" },
  { expected: { assistantValueAvailable: true, missing: [], patch: "clear", provenance: "assistant", value: "assistant" },
    name: "an unavailable stored value is cleared and the chain continues", policy: "adjustable",
    stored: "chatUnavailable", value: "concrete" },
  { expected: { assistantValueAvailable: true, missing: [], patch: "clear", provenance: "default", value: "default" },
    name: "an unavailable stored value over inherit continues to the default", policy: "adjustable",
    stored: "chatUnavailable", value: "inherit" },
  { expected: { assistantValueAvailable: true, missing: [], patch: "persist", provenance: "chat", value: "chat" },
    name: "an available request value is the chat's and is persisted", policy: "adjustable", request: "chat",
    value: "concrete" },
  { expected: { failure: "request_value_not_available" },
    name: "a request value outside the available set is rejected", policy: "adjustable", request: "chatUnavailable",
    value: "concrete" },
  { expected: { assistantValueAvailable: true, missing: [], patch: "none", provenance: "assistant", value: "assistant" },
    name: "an available fixed value is the Assistant's", policy: "fixed", value: "concrete" },
  { expected: { assistantValueAvailable: true, missing: [], patch: "none", provenance: "assistant", value: "off" },
    name: "a fixed Off is the Assistant's value", policy: "fixed", value: "off" },
  { expected: { failure: "assistant_not_available" },
    name: "an unavailable fixed value makes the Assistant unavailable", policy: "fixed", value: "unavailable" },
  { expected: { failure: "assistant_not_available" },
    name: "a partly unavailable fixed value makes the Assistant unavailable", policy: "fixed", value: "partial" },
  { expected: { assistantValueAvailable: true, missing: [], patch: "clear", provenance: "assistant", value: "assistant" },
    name: "a stored value of a fixed row is ignored and cleared", policy: "fixed", stored: "chat", value: "concrete" },
  { expected: { failure: "assistant_overrides_not_allowed" },
    name: "a request value for a fixed row is not allowed", policy: "fixed", request: "chat", value: "concrete" },
  { expected: { failure: "assistant_overrides_not_allowed" },
    name: "a request value for a fixed row is not allowed even when it is available", policy: "fixed",
    request: "off", value: "off" }
];

function applicable(key: ResourceRowKey, scenario: Scenario): boolean {
  const fixture = fixtures[key] as RowFixture<ResourceRowKey>;
  if (scenario.value === "partial" && !fixture.partial) return false;
  if ((scenario.value === "off" || scenario.stored === "off" || scenario.request === "off") && !fixture.explicitOff) {
    return false;
  }
  return !(
    (scenario.stored === "chatUnavailable" || scenario.request === "chatUnavailable") && !fixture.chatUnavailable
  );
}

const table = (["model", "search", "tools", "knowledge"] as const).flatMap((key) =>
  scenarios.filter((scenario) => applicable(key, scenario)).map((scenario) => [key, scenario.name, scenario] as const)
);

function chatValue(fixture: RowFixture<ResourceRowKey>, choice: "chat" | "chatUnavailable" | "off") {
  return choice === "chat" ? fixture.chat : choice === "off" ? fixture.explicitOff!.chat! : fixture.chatUnavailable!;
}

describe("resolveAssistantRows: resource rows by policy, provenance and availability (A-02)", () => {
  it("covers every resource row", () => {
    expect(table.length).toBe(67);
  });

  it.each(table)("%s: %s", (key, _name, scenario) => {
    const fixture = fixtures[key] as RowFixture<ResourceRowKey>;
    const value = scenario.value === "inherit" ? { mode: "inherit" as const }
      : scenario.value === "off" ? fixture.explicitOff!.assistant
        : scenario.value === "partial" ? fixture.partial!.value
          : scenario.value === "unavailable" ? fixture.unavailable.value
            : fixture.concrete;
    const assistant = rows({ [key]: { policy: scenario.policy, value } });
    const stored: ChatAssistantOverrides = scenario.stored ? { [key]: chatValue(fixture, scenario.stored) } : {};
    const requested: ChatAssistantOverrides = scenario.request ? { [key]: chatValue(fixture, scenario.request) } : {};
    const result = resolveAssistantRows(input({ assistant, requested, stored }));

    if ("failure" in scenario.expected) {
      expect(result).toEqual({ code: scenario.expected.failure, ok: false, row: key });
      return;
    }
    if (!result.ok) throw new Error(`unexpected failure ${result.code}`);
    const expected = scenario.expected;
    const effective = expected.value === "assistant" ? fixture.assistantEffective
      : expected.value === "chat" ? (scenario.request ?? scenario.stored) === "off"
        ? fixture.explicitOff!.effective : fixture.chatEffective
        : expected.value === "off" ? fixture.explicitOff!.effective
          : fixture.defaultEffective;
    const missing = expected.missing.length === 0 ? []
      : scenario.value === "partial" ? fixture.partial!.missing : fixture.unavailable.missing;
    expect(result.rows[key]).toEqual({
      assistantValueAvailable: expected.assistantValueAvailable,
      missingResourceIds: missing,
      provenance: expected.provenance,
      value: effective
    });
    expect(result.overridesPatch).toEqual(
      expected.patch === "clear" ? { [key]: null }
        : expected.patch === "persist" ? { [key]: requested[key] }
          : {}
    );
  });
});

describe("resolveAssistantRows: Skills", () => {
  const links = [
    { delivery: "always" as const, skillId: "skill-1" },
    { delivery: "on_demand" as const, skillId: "skill-2" }
  ];

  it.each(["fixed", "adjustable"] as const)("keeps every %s link and the Assistant's mode", (policy) => {
    const result = resolved(input({ assistant: rows({ skills: { policy, value: { links, mode: "off" } } }) }));
    expect(result.rows.skills).toEqual({
      assistantValueAvailable: true,
      missingResourceIds: [],
      provenance: "assistant",
      value: { links, mode: "off" }
    });
  });

  it.each(["fixed", "adjustable"] as const)("fails neutrally when one %s link is unavailable", (policy) => {
    const partial = [...links, { delivery: "always" as const, skillId: "skill-gone" }];
    expect(failed(input({ assistant: rows({ skills: { policy, value: { links: partial, mode: "auto" } } }) })))
      .toEqual({ code: "assistant_not_available", ok: false, row: "skills" });
  });

  it("fails neutrally on an unavailable link even with an accepted chat mode", () => {
    const partial = [{ delivery: "always" as const, skillId: "skill-gone" }];
    expect(failed(input({
      assistant: rows({ skills: { policy: "adjustable", value: { links: partial, mode: "auto" } } }),
      requested: { skills: { mode: "off" } }
    }))).toEqual({ code: "assistant_not_available", ok: false, row: "skills" });
  });

  it("applies a stored and a requested chat mode on top of the Assistant's links", () => {
    const assistant = rows({ skills: { policy: "adjustable", value: { links, mode: "auto" } } });
    const stored = resolved(input({ assistant, stored: { skills: { mode: "off" } } }));
    expect(stored.rows.skills).toMatchObject({ provenance: "chat", value: { links, mode: "off" } });
    expect(stored.overridesPatch).toEqual({});
    const requested = resolved(input({ assistant, requested: { skills: { mode: "off" } } }));
    expect(requested.rows.skills).toMatchObject({ provenance: "chat", value: { links, mode: "off" } });
    expect(requested.overridesPatch).toEqual({ skills: { mode: "off" } });
  });

  it("ignores and clears a stored mode of a fixed row and rejects a requested one", () => {
    const assistant = rows({ skills: { policy: "fixed", value: { links, mode: "auto" } } });
    const result = resolved(input({ assistant, stored: { skills: { mode: "off" } } }));
    expect(result.rows.skills).toMatchObject({ provenance: "assistant", value: { mode: "auto" } });
    expect(result.overridesPatch).toEqual({ skills: null });
    expect(failed(input({ assistant, requested: { skills: { mode: "off" } } })))
      .toEqual({ code: "assistant_overrides_not_allowed", ok: false, row: "skills" });
  });
});

describe("resolveAssistantRows: controls", () => {
  const assistantModel = { policy: "adjustable" as const, value: { mode: "model" as const, modelId: "model-a" } };

  it("A-03: empty Assistant controls with the Assistant's model yield the saved values for that model", () => {
    const result = resolved(input({ assistant: rows({ model: assistantModel }) }));
    expect(result.rows.controls).toMatchObject({
      layers: { assistant: {}, chat: null, saved: { reasoningEffort: "low" } },
      provenance: "default",
      value: { reasoningEffort: "low" }
    });
  });

  it("layers the Assistant's controls over the saved values for its model", () => {
    const result = resolved(input({
      assistant: rows({ controls: { policy: "adjustable", value: { temperature: 0.2 } }, model: assistantModel })
    }));
    expect(result.rows.controls).toMatchObject({
      provenance: "assistant",
      value: { reasoningEffort: "low", temperature: 0.2 }
    });
  });

  it("A-03: with another model the Assistant's controls are absent and the row is editable even when fixed", () => {
    // A fixed controls row needs a fixed model; the rule is still checked on its own here.
    const assistant = rows({
      controls: { policy: "fixed", value: { reasoningEffort: "high", temperature: 0.2 } },
      model: assistantModel
    });
    const result = resolved(input({ assistant, requested: { controls: { temperature: 1.1 }, model: fixtures.model.chat } }));
    expect(result.rows.controls).toEqual({
      assistantValueAvailable: true,
      layers: { assistant: null, chat: { origin: "request", value: { temperature: 1.1 } }, saved: { temperature: 0.7 } },
      missingResourceIds: [],
      provenance: "chat",
      value: { temperature: 1.1 }
    });
    expect(result.overridesPatch).toEqual({ controls: { temperature: 1.1 }, model: fixtures.model.chat });
    const withoutChat = resolved(input({ assistant, stored: { model: fixtures.model.chat } }));
    expect(withoutChat.rows.controls).toMatchObject({ layers: { assistant: null }, provenance: "default",
      value: { temperature: 0.7 } });
  });

  it("does not apply the Assistant's controls to a fallback model", () => {
    const result = resolved(input({
      assistant: rows({
        controls: { policy: "adjustable", value: { temperature: 0.2 } },
        model: { policy: "adjustable", value: { mode: "model", modelId: "model-gone" } }
      })
    }));
    expect(result.rows.model.provenance).toBe("fallback");
    expect(result.rows.controls).toMatchObject({
      layers: { assistant: null, saved: { maxOutputTokens: 2048 } },
      provenance: "default",
      value: { maxOutputTokens: 2048 }
    });
  });

  it("applies the Assistant's controls to the default model when the model row inherits", () => {
    const result = resolved(input({ assistant: rows({ controls: { policy: "adjustable", value: { temperature: 0.2 } } }) }));
    expect(result.rows.controls).toMatchObject({
      provenance: "assistant",
      value: { maxOutputTokens: 2048, temperature: 0.2 }
    });
    const chosen = resolved(input({
      assistant: rows({ controls: { policy: "adjustable", value: { temperature: 0.2 } } }),
      stored: { model: fixtures.model.chat }
    }));
    expect(chosen.rows.controls).toMatchObject({ layers: { assistant: null }, value: { temperature: 0.7 } });
  });

  it("applies the Assistant's controls when the chat chose the Assistant's own model", () => {
    const result = resolved(input({
      assistant: rows({ controls: { policy: "adjustable", value: { temperature: 0.2 } }, model: assistantModel }),
      stored: { model: { mode: "model", modelId: "model-a" } }
    }));
    expect(result.rows.model.provenance).toBe("chat");
    expect(result.rows.controls).toMatchObject({ provenance: "assistant", value: { reasoningEffort: "low", temperature: 0.2 } });
  });

  it("layers adjustable chat controls over the Assistant's", () => {
    const result = resolved(input({
      assistant: rows({ controls: { policy: "adjustable", value: { temperature: 0.2 } }, model: assistantModel }),
      stored: { controls: { temperature: 0.9 } }
    }));
    expect(result.rows.controls).toMatchObject({
      layers: { chat: { origin: "stored", value: { temperature: 0.9 } } },
      provenance: "chat",
      value: { reasoningEffort: "low", temperature: 0.9 }
    });
    expect(result.overridesPatch).toEqual({});
  });

  it("fixed controls ignore and clear stored chat values and reject requested ones", () => {
    const assistant = rows({
      controls: { policy: "fixed", value: { temperature: 0.2 } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-a" } }
    });
    expect(assistantRowPolicyViolation(assistant)).toBeNull();
    const result = resolved(input({ assistant, stored: { controls: { temperature: 0.9 } } }));
    expect(result.rows.controls).toMatchObject({ layers: { chat: null }, provenance: "assistant", value: { temperature: 0.2 } });
    expect(result.overridesPatch).toEqual({ controls: null });
    expect(failed(input({ assistant, requested: { controls: { temperature: 0.9 } } })))
      .toEqual({ code: "assistant_overrides_not_allowed", ok: false, row: "controls" });
  });

  it("rejects requested fixed controls even when the fixed model is unavailable", () => {
    const assistant = rows({
      controls: { policy: "fixed", value: { temperature: 0.2 } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-gone" } }
    });
    expect(failed(input({ assistant }))).toEqual({ code: "assistant_not_available", ok: false, row: "model" });
    expect(failed(input({ assistant, requested: { controls: { temperature: 0.9 } } })))
      .toEqual({ code: "assistant_overrides_not_allowed", ok: false, row: "controls" });
  });
});

function parameterControls(overrides: Partial<ModelParameterControls> = {}): ModelParameterControls {
  return {
    background: { defaultValue: false, supported: true },
    maxOutputTokens: { defaultValue: 4096, maxValue: 128_000 },
    reasoningEffort: { defaultValue: "medium", options: ["low", "medium", "high"], supported: true },
    reasoningMode: { defaultValue: "standard", options: ["standard", "pro"], supported: true },
    stream: { defaultValue: false, supported: true },
    temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true },
    ...overrides
  };
}

const openAiModel = { baseParams: {}, controls: parameterControls(), parameterProvider: "openai" };

describe("materializeAssistantRowControls", () => {
  const assistantModel = { policy: "adjustable" as const, value: { mode: "model" as const, modelId: "model-a" } };

  it("A-03: fills unset fields from the saved values, then from the model's built-ins", () => {
    const result = materializeAssistantRowControls(resolved(input({ assistant: rows({ model: assistantModel }) })), openAiModel);
    if (!result.ok) throw new Error(result.code);
    expect(result.params).toMatchObject({ maxOutputTokens: 4096, reasoning: { effort: "low" }, temperature: 1 });
  });

  it("orders chat over Assistant over saved over built-ins", () => {
    const resolution = resolved(input({
      assistant: rows({
        controls: { policy: "adjustable", value: { maxOutputTokens: 1000, temperature: 0.2 } },
        model: assistantModel
      }),
      stored: { controls: { temperature: 0.9 } }
    }));
    const result = materializeAssistantRowControls(resolution, openAiModel);
    if (!result.ok) throw new Error(result.code);
    expect(result.params).toMatchObject({ maxOutputTokens: 1000, reasoning: { effort: "low" }, temperature: 0.9 });
    expect(result.resolution).toEqual(resolution);
  });

  it("fails closed when an Assistant control the run uses is unsupported", () => {
    const resolution = resolved(input({
      assistant: rows({ controls: { policy: "adjustable", value: { reasoningEffort: "ultra" } }, model: assistantModel })
    }));
    expect(materializeAssistantRowControls(resolution, openAiModel)).toEqual({
      code: "assistant_configuration_unavailable", field: "reasoningEffort", ok: false, row: "controls"
    });
    const replaced = resolved(input({
      assistant: rows({ controls: { policy: "adjustable", value: { reasoningEffort: "ultra" } }, model: assistantModel }),
      stored: { controls: { reasoningEffort: "high" } }
    }));
    const result = materializeAssistantRowControls(replaced, openAiModel);
    expect(result.ok && result.params).toMatchObject({ reasoning: { effort: "high" } });
  });

  it("rejects an unsupported request value and drops an unsupported stored one", () => {
    const assistant = rows({ controls: { policy: "adjustable", value: { temperature: 0.2 } }, model: assistantModel });
    expect(materializeAssistantRowControls(
      resolved(input({ assistant, requested: { controls: { temperature: 5 } } })), openAiModel
    )).toEqual({ code: "request_value_not_available", field: "temperature", ok: false, row: "controls" });
    const stored = materializeAssistantRowControls(
      resolved(input({ assistant, stored: { controls: { temperature: 5 } } })), openAiModel
    );
    if (!stored.ok) throw new Error(stored.code);
    expect(stored.params).toMatchObject({ temperature: 0.2 });
    expect(stored.resolution.rows.controls).toMatchObject({ layers: { chat: null }, provenance: "assistant" });
    expect(stored.resolution.overridesPatch).toEqual({ controls: null });
  });

  it("keeps only the saved fields the model supports", () => {
    const result = materializeAssistantRowControls(
      resolved(input({ assistant: rows({ model: assistantModel }) })),
      { ...openAiModel, controls: parameterControls({ reasoningEffort: { defaultValue: "none", options: [], supported: false } }) }
    );
    if (!result.ok) throw new Error(result.code);
    expect(result.resolution.rows.controls).toMatchObject({ layers: { saved: {} }, provenance: "default", value: {} });
    expect(result.params).toMatchObject({ reasoning: { effort: "none" } });
  });
});

describe("resolveAssistantRows: vocabulary bridge", () => {
  it.each([
    [{ mode: "inherit" as const }, { mode: "load_all" as const }, { mode: "load_all" }],
    [{ mode: "inherit" as const }, { mode: "off" as const }, { mode: "off" }],
    [{ mode: "off" as const }, { mode: "auto" as const }, { mode: "off" }],
    [{ mode: "exact" as const, serverIds: ["mcp-2"] }, { mode: "off" as const }, { mode: "exact", serverIds: ["mcp-2"] }]
  ])("tools %j under the context mode %j resolve to %j", (value, contextMode, expected) => {
    const result = resolved(input({
      assistant: rows({ tools: { policy: "adjustable", value } }),
      defaults: { ...personalDefaults, tools: contextMode }
    }));
    expect(result.rows.tools.value).toEqual(expected);
  });

  it("a chat tools mode replaces an exact allowlist", () => {
    const result = resolved(input({
      assistant: rows({ tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["mcp-1"] } } }),
      requested: { tools: { mode: "auto" } }
    }));
    expect(result.rows.tools).toMatchObject({ provenance: "chat", value: { mode: "auto" } });
  });

  it("a chat may choose All my knowledge only where it can run", () => {
    const assistant = rows({ knowledge: { policy: "adjustable", value: { mode: "none" } } });
    const personal = resolved(input({ assistant, requested: { knowledge: { mode: "all_my_knowledge" } } }));
    expect(personal.rows.knowledge).toMatchObject({ provenance: "chat", value: { mode: "all_my_knowledge" } });
    const restricted = { ...personalAvailable, allMyKnowledge: false };
    expect(failed(input({ assistant, available: restricted, requested: { knowledge: { mode: "all_my_knowledge" } } })))
      .toEqual({ code: "request_value_not_available", ok: false, row: "knowledge" });
    const stored = resolved(input({ assistant, available: restricted, stored: { knowledge: { mode: "all_my_knowledge" } } }));
    expect(stored.rows.knowledge).toMatchObject({ provenance: "assistant", value: { mode: "none" } });
    expect(stored.overridesPatch).toEqual({ knowledge: null });
  });

  it("a context search plan without sources reads as Off", () => {
    const result = resolved(input({ defaults: { ...personalDefaults, search: { mode: "all_selected", optionIds: [] } } }));
    expect(result.rows.search).toMatchObject({ provenance: "default", value: { mode: "off" } });
  });

  it("a redacted Assistant value counts as unavailable", () => {
    const result = resolved(input({
      assistant: rows({
        model: { policy: "adjustable", value: { mode: "model", modelId: null } },
        tools: { policy: "adjustable", value: { hiddenCount: 1, mode: "exact", serverIds: ["mcp-1"] } }
      })
    }));
    expect(result.rows.model).toMatchObject({ assistantValueAvailable: false, missingResourceIds: [], provenance: "fallback" });
    expect(result.rows.tools).toMatchObject({ assistantValueAvailable: false, missingResourceIds: [], provenance: "fallback" });
  });

  it("every effective value is a valid chat projection value", () => {
    const result = resolved(input({ assistant: rows({ knowledge: { policy: "fixed", value: fixtures.knowledge.concrete } }) }));
    const projected: { [Key in keyof ChatAssistantRowValues]: ChatAssistantRowValues[Key] } = {
      controls: result.rows.controls.value,
      knowledge: result.rows.knowledge.value,
      model: result.rows.model.value,
      search: result.rows.search.value,
      skills: result.rows.skills.value,
      tools: result.rows.tools.value
    };
    expect(projected.knowledge).toEqual(fixtures.knowledge.assistantEffective);
  });
});

describe("resolveAssistantRows: Project context", () => {
  const projectDefaults: AssistantRowContextDefaults = {
    controlsForModel: () => ({ temperature: 0.4 }),
    knowledge: { baseIds: ["kb-project"], mode: "explicit", sourceIds: [] },
    modelId: "model-project",
    search: { mode: "all_selected", optionIds: [] },
    tools: { mode: "load_all" }
  };
  const projectAvailable: AssistantRowAvailableResources = {
    allMyKnowledge: false,
    knowledgeBaseIds: new Set(["kb-project"]),
    knowledgeSourceIds: new Set(),
    mcpServerIds: new Set(["mcp-shared"]),
    modelIds: new Set(["model-project", "model-a"]),
    searchOptionIds: new Set(["web-1"]),
    skillIds: new Set(["skill-1"])
  };
  const assistant = rows({
    knowledge: { policy: "adjustable", value: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [] } },
    search: { policy: "adjustable", value: { mode: "all_selected", optionIds: ["web-1", "web-2"] } },
    skills: { policy: "adjustable", value: { links: [{ delivery: "always", skillId: "skill-1" }], mode: "auto" } },
    tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["mcp-1"] } }
  });

  it("resolves inherit and fallback against the Project's defaults and availability only", () => {
    const result = resolved(input({ assistant, available: projectAvailable, defaults: projectDefaults }));
    expect(assistantRunRowProvenance(result)).toEqual({
      controls: "default",
      knowledge: "fallback",
      model: "default",
      search: "fallback",
      skills: "assistant",
      tools: "fallback"
    });
    expect(Object.fromEntries(Object.entries(result.rows).map(([key, row]) => [key, row.value]))).toEqual({
      controls: { temperature: 0.4 },
      knowledge: { baseIds: ["kb-project"], mode: "explicit", sourceIds: [] },
      model: { mode: "model", modelId: "model-project" },
      search: { mode: "off" },
      skills: { links: [{ delivery: "always", skillId: "skill-1" }], mode: "auto" },
      tools: { mode: "load_all" }
    });
  });

  it("the same rows resolve against personal defaults in a personal chat", () => {
    const result = resolved(input({ assistant }));
    expect(assistantRunRowProvenance(result)).toEqual({
      controls: "default",
      knowledge: "assistant",
      model: "default",
      search: "assistant",
      skills: "assistant",
      tools: "assistant"
    });
    expect(result.rows.controls.value).toEqual({ maxOutputTokens: 2048 });
  });

  it("a Project chat rejects a request value outside the Project's catalog", () => {
    expect(failed(input({
      assistant,
      available: projectAvailable,
      defaults: projectDefaults,
      requested: { model: { mode: "model", modelId: "model-b" } }
    }))).toEqual({ code: "request_value_not_available", ok: false, row: "model" });
  });
});

describe("resolveAssistantRows: failures and persistence", () => {
  it("reports a request value for a fixed row before an unavailable resource and before a rejected value", () => {
    const assistant = rows({
      knowledge: { policy: "fixed", value: { mode: "none" } },
      search: { policy: "fixed", value: fixtures.search.unavailable.value }
    });
    expect(failed(input({
      assistant,
      requested: { knowledge: { mode: "none" }, model: fixtures.model.chatUnavailable! }
    }))).toEqual({ code: "assistant_overrides_not_allowed", ok: false, row: "knowledge" });
    expect(failed(input({ assistant, requested: { model: fixtures.model.chatUnavailable! } })))
      .toEqual({ code: "assistant_not_available", ok: false, row: "search" });
  });

  it("the patch turns the stored overrides into the next stored value", () => {
    const assistant = rows({
      search: { policy: "fixed", value: { mode: "off" } },
      tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["mcp-1"] } }
    });
    const stored: ChatAssistantOverrides = {
      model: fixtures.model.chatUnavailable!,
      search: { mode: "all_selected", optionIds: ["web-1"] },
      tools: { mode: "off" }
    };
    const result = resolved(input({ assistant, requested: { knowledge: { mode: "none" } }, stored }));
    expect(result.overridesPatch).toEqual({ knowledge: { mode: "none" }, model: null, search: null });
    expect(applyChatAssistantOverridesPatch(stored, result.overridesPatch)).toEqual({
      knowledge: { mode: "none" },
      tools: { mode: "off" }
    });
  });

  it("does not share arrays with its inputs", () => {
    const assistant = rows({ tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-1"] } } });
    const result = resolved(input({ assistant }));
    (result.rows.tools.value as { serverIds: string[] }).serverIds.push("mcp-2");
    expect(assistant.tools.value).toEqual({ mode: "exact", serverIds: ["mcp-1"] });
  });
});

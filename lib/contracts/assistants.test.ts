import { describe, expect, it } from "vitest";
import {
  assistantAvatarRecipeFromBytes,
  assistantRowsFromLegacyFields,
  decodeAssistantAvatarRecipe,
  decodeAssistantIdentity,
  decodeAssistantDetail,
  decodeAssistantDraft,
  decodeAssistantDuplicateResponse,
  decodeAssistantKnowledgeValue,
  decodeAssistantListResponse,
  decodeAssistantContent,
  decodeAssistantModelValue,
  decodeAssistantRowAvailability,
  decodeAssistantRowKey,
  decodeAssistantRowPolicy,
  decodeAssistantRowProvenance,
  decodeAssistantRows,
  decodeAssistantRunControls,
  decodeAssistantRunRowProvenance,
  decodeAssistantSearchValue,
  decodeAssistantSkillsValue,
  decodeAssistantSummary,
  decodeAssistantToolsValue,
  rotateAssistantAvatarRecipe,
  type AssistantAvatarRecipe
} from "./assistants";

const validRecipe: AssistantAvatarRecipe = {
  accents: [1, 4],
  backgroundShape: "hexagon",
  foregroundShape: "circle",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 3]
};

describe("assistant avatar recipe", () => {
  it("maps fixed byte vectors to exact recipes deterministically", () => {
    const bytes = Uint8Array.from([9, 2, 13, 6, 1, 3, 4, 4, 9, 200]);
    const first = assistantAvatarRecipeFromBytes(bytes);
    const second = assistantAvatarRecipeFromBytes(bytes);

    expect(first).toEqual({
      accents: [4, 5, 1],
      backgroundShape: "diamond",
      foregroundShape: "square",
      kind: "generated",
      paletteId: "ocean",
      recipeVersion: 1,
      rotations: [2, 1]
    });
    expect(second).toEqual(first);
  });

  it("resolves accent slot collisions deterministically instead of dropping accents", () => {
    const bytes = Uint8Array.from([0, 0, 0, 0, 0, 3, 7, 7, 7, 0]);
    expect(assistantAvatarRecipeFromBytes(bytes).accents).toEqual([7, 0, 1]);
  });

  it("rejects byte vectors that are too short", () => {
    expect(() => assistantAvatarRecipeFromBytes(Uint8Array.from([1, 2, 3]))).toThrow(
      "assistant_avatar_recipe_requires_more_bytes"
    );
  });

  it("round-trips every generated recipe through the strict decoder", () => {
    for (let seed = 0; seed < 64; seed += 1) {
      const bytes = Uint8Array.from(
        Array.from({ length: 10 }, (_, index) => (seed * 37 + index * 11) % 256)
      );
      const recipe = assistantAvatarRecipeFromBytes(bytes);
      expect(decodeAssistantAvatarRecipe(JSON.parse(JSON.stringify(recipe)))).toEqual(recipe);
    }
  });

  it("fails closed on unknown versions, kinds, and enum members", () => {
    expect(decodeAssistantAvatarRecipe({ ...validRecipe, recipeVersion: 2 })).toBeNull();
    expect(decodeAssistantAvatarRecipe({ ...validRecipe, kind: "uploaded" })).toBeNull();
    expect(decodeAssistantAvatarRecipe({ ...validRecipe, paletteId: "neon" })).toBeNull();
    expect(decodeAssistantAvatarRecipe({ ...validRecipe, backgroundShape: "star" })).toBeNull();
  });

  it("fails closed on extra keys, oversized arrays, duplicates, and out-of-range values", () => {
    expect(decodeAssistantAvatarRecipe({ ...validRecipe, svg: "<svg/>" })).toBeNull();
    expect(
      decodeAssistantAvatarRecipe({ ...validRecipe, accents: [0, 1, 2, 3, 4] })
    ).toBeNull();
    expect(decodeAssistantAvatarRecipe({ ...validRecipe, accents: [2, 2] })).toBeNull();
    expect(decodeAssistantAvatarRecipe({ ...validRecipe, accents: [8] })).toBeNull();
    expect(decodeAssistantAvatarRecipe({ ...validRecipe, accents: [1.5] })).toBeNull();
    expect(decodeAssistantAvatarRecipe({ ...validRecipe, rotations: [0] })).toBeNull();
    expect(decodeAssistantAvatarRecipe({ ...validRecipe, rotations: [0, 4] })).toBeNull();
    expect(decodeAssistantAvatarRecipe("recipe")).toBeNull();
  });

  it("turns the whole composition a quarter clockwise and wraps rotations and accents", () => {
    const turned = rotateAssistantAvatarRecipe({ ...validRecipe, accents: [7, 1], rotations: [3, 1] });
    expect(turned).toEqual({ ...validRecipe, accents: [1, 3], rotations: [0, 2] });
    expect(decodeAssistantAvatarRecipe(JSON.parse(JSON.stringify(turned)))).toEqual(turned);
  });
});

describe("assistant run controls", () => {
  it("accepts bounded partial controls", () => {
    expect(
      decodeAssistantRunControls({
        backgroundMode: true,
        maxOutputTokens: 4096,
        reasoningEffort: "high",
        temperature: 0.4
      })
    ).toEqual({
      backgroundMode: true,
      maxOutputTokens: 4096,
      reasoningEffort: "high",
      temperature: 0.4
    });
    expect(decodeAssistantRunControls({})).toEqual({});
  });

  it("fails closed on unknown keys and out-of-bound values", () => {
    expect(decodeAssistantRunControls({ topP: 0.5 })).toBeNull();
    expect(decodeAssistantRunControls({ maxOutputTokens: 0 })).toBeNull();
    expect(decodeAssistantRunControls({ maxOutputTokens: 1.5 })).toBeNull();
    expect(decodeAssistantRunControls({ temperature: 999 })).toBeNull();
    expect(decodeAssistantRunControls({ reasoningEffort: "" })).toBeNull();
    expect(decodeAssistantRunControls({ reasoningEffort: "x".repeat(65) })).toBeNull();
  });
});

/** Identity, instructions and starters; drafts add `rows`, content adds its projections. */
function validFields(): Record<string, unknown> {
  return {
    avatar: validRecipe,
    category: "coding",
    description: "Reviews changes for correctness.",
    name: "Code Reviewer",
    starterPrompts: ["Review a diff"],
    systemPrompt: "You review code."
  };
}

function validDraft(): Record<string, unknown> {
  return { ...validFields(), rows: validRows() };
}

function skillRows(value: unknown): Record<string, unknown> {
  return { ...validRows(), skills: { policy: "fixed", value } };
}

describe("assistant draft decode", () => {
  it("preserves literal reminder text and defaults omitted reminders to empty", () => {
    expect(decodeAssistantDraft(validDraft())).toMatchObject({ ok: true, draft: { responseReminder: "" } });
    const responseReminder = "  Отвечай кратко 🙂 {{literal}}\n";
    expect(decodeAssistantDraft({ ...validDraft(), responseReminder }))
      .toMatchObject({ ok: true, draft: { responseReminder } });
  });

  it("accepts a complete bounded draft and trims presentation fields", () => {
    const decoded = decodeAssistantDraft({ ...validDraft(), name: "  Code Reviewer  " });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.draft.rows.knowledge).toEqual({ policy: "fixed", value: { mode: "none" } });
      expect(decoded.draft.name).toBe("Code Reviewer");
      expect(decoded.draft.rows.search).toEqual({
        policy: "fixed",
        value: { mode: "all_selected", optionIds: ["openai-native-web-search"] }
      });
      expect(decoded.draft.answerRules).toBeNull();
    }
  });

  it("fails each bounded field with a stable field-scoped code", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...validDraft(), name: "" }, "assistant_name_invalid"],
      [{ ...validDraft(), name: "x".repeat(81) }, "assistant_name_invalid"],
      [{ ...validDraft(), description: "x".repeat(401) }, "assistant_description_invalid"],
      [{ ...validDraft(), category: "vibes" }, "assistant_category_invalid"],
      [{ ...validDraft(), avatar: { kind: "generated" } }, "assistant_avatar_invalid"],
      [{ ...validDraft(), rows: { ...validRows(), model: { policy: "fixed", value: { mode: "model", modelId: "" } } } }, "assistant_model_invalid"],
      [{ ...validDraft(), systemPrompt: 7 }, "assistant_system_prompt_invalid"],
      [{ ...validDraft(), answerRules: 7 }, "assistant_answer_rules_invalid"],
      [{ ...validDraft(), answerRules: "x".repeat(4001) }, "assistant_answer_rules_invalid"],
      [{ ...validDraft(), systemPrompt: "x".repeat(48_001) }, "assistant_system_prompt_invalid"],
      [{ ...validDraft(), responseReminder: null }, "assistant_response_reminder_invalid"],
      [{ ...validDraft(), responseReminder: "x".repeat(4001) }, "assistant_response_reminder_invalid"],
      [{ ...validDraft(), responseReminder: "\0" }, "assistant_response_reminder_invalid"],
      [
        { ...validDraft(), starterPrompts: ["1", "2", "3", "4", "5", "6", "7"] },
        "assistant_starter_prompts_invalid"
      ],
      [{ ...validDraft(), starterPrompts: ["x".repeat(201)] }, "assistant_starter_prompts_invalid"],
      [{ ...validDraft(), starterPrompts: ["  "] }, "assistant_starter_prompts_invalid"]
    ];

    for (const [draft, code] of cases) {
      const decoded = decodeAssistantDraft(draft);
      expect(decoded.ok, code).toBe(false);
      if (!decoded.ok) {
        expect(decoded.code).toBe(code);
      }
    }
  });

  it("requires rows and no longer reads the flat row fields of the first release", () => {
    const { rows: _rows, ...withoutRows } = validDraft();
    expect(decodeAssistantDraft(withoutRows)).toEqual({ code: "assistant_rows_invalid", ok: false });
    expect(decodeAssistantDraft({
      ...withoutRows,
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpServerIds: [],
      providerModelId: "model-1",
      runControls: {},
      searchPlan: { mode: "all_selected", optionIds: [] },
      skillIds: []
    })).toEqual({ code: "assistant_rows_invalid", ok: false });
    expect(decodeAssistantDraft({ ...validDraft(), providerModelId: "ignored", skillIds: ["ignored"] }))
      .toEqual(decodeAssistantDraft(validDraft()));
  });

  it("preserves the declared Skill order", () => {
    const links = [{ delivery: "always", skillId: "skill-review" }, { delivery: "always", skillId: "skill-finish" }];
    expect(decodeAssistantDraft({ ...validDraft(), rows: skillRows({ links, mode: "auto" }) })).toMatchObject({
      draft: { rows: { skills: { policy: "fixed", value: { links, mode: "auto" } } } },
      ok: true
    });
  });

  it("accepts independent Always and On demand ceilings while preserving all links under Off", () => {
    const always = Array.from({ length: 32 }, (_, index) => ({ delivery: "always", skillId: `pin-${index}` }));
    const onDemand = Array.from({ length: 64 }, (_, index) => ({ delivery: "on_demand", skillId: `available-${index}` }));
    const decoded = decodeAssistantDraft({ ...validDraft(), rows: skillRows({ links: [...always, ...onDemand], mode: "off" }) });
    expect(decoded.ok && decoded.draft.rows.skills.value).toEqual({ links: [...always, ...onDemand], mode: "off" });
    expect(decodeAssistantDraft({ ...validDraft(), rows: skillRows({ links: [...always, { delivery: "always", skillId: "extra" }], mode: "auto" }) }))
      .toEqual({ actual: 33, code: "skills_count_exceeded", field: "pinned", limit: 32, ok: false, row: "skills" });
    expect(decodeAssistantDraft({ ...validDraft(), rows: skillRows({ links: [...onDemand, { delivery: "on_demand", skillId: "extra" }], mode: "auto" }) }))
      .toEqual({ actual: 65, code: "skills_count_exceeded", field: "available", limit: 64, ok: false, row: "skills" });
  });

  it("rejects unknown delivery and Skills modes", () => {
    for (const value of [
      { links: [{ delivery: "optional", skillId: "linked" }], mode: "auto" },
      { links: [], mode: "always" },
      { enabled: true, links: [], mode: "auto" }
    ]) {
      expect(decodeAssistantDraft({ ...validDraft(), rows: skillRows(value) })).toMatchObject({ code: "assistant_skills_invalid", ok: false });
    }
  });

  it("identifies a structurally invalid run-control field", () => {
    expect(decodeAssistantDraft({
      ...validDraft(),
      rows: { ...validRows(), controls: { policy: "fixed", value: { maxOutputTokens: 0 } } }
    })).toEqual({
      code: "assistant_run_controls_invalid",
      field: "maxOutputTokens",
      ok: false,
      row: "controls"
    });
  });
});

function validRows(): Record<string, unknown> {
  return {
    controls: { policy: "fixed", value: { reasoningEffort: "high" } },
    knowledge: { policy: "fixed", value: { mode: "none" } },
    model: { policy: "fixed", value: { mode: "model", modelId: "model-1" } },
    search: { policy: "fixed", value: { mode: "all_selected", optionIds: ["openai-native-web-search"] } },
    skills: { policy: "fixed", value: { links: [], mode: "auto" } },
    tools: { policy: "fixed", value: { mode: "exact", serverIds: ["server-1"] } }
  };
}

function validContent(): Record<string, unknown> {
  return {
    ...validFields(),
    answerRules: null,
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: ["server-1"],
    providerModelId: "model-1",
    rows: validRows(),
    runControls: { reasoningEffort: "high" },
    searchPlan: { mode: "all_selected", optionIds: ["openai-native-web-search"] },
    skillIds: []
  };
}

const ownerAudience = { everyone: false, groupNames: [] };

function validSummary(): Record<string, unknown> {
  return {
    archived: false,
    audience: null,
    availability: { ok: true },
    avatar: validRecipe,
    category: "coding",
    description: "Reviews changes.",
    featured: false,
    featuredOrder: null,
    fingerprint: {
      knowledgeLabel: "Knowledge · 1",
      knowledgeResourceCount: 1,
      mcpServerCount: 2,
      modelLabel: "Claude Sonnet",
      reasoningEffort: "high",
      searchOptionCount: 1
    },
    id: "assistant-1",
    name: "Code Reviewer",
    owned: false,
    ownerDisplayName: "Alex",
    pinned: true,
    published: true,
    rowAvailability: {},
    scope: { groupNames: ["Design"], kind: "group" },
    skillLinkCount: 2,
    starterPrompts: ["Review a diff"],
    updatedAt: "2026-08-06T00:00:00.000Z"
  };
}

describe("assistant wire decoders", () => {
  it("decodes a valid summary and list response", () => {
    expect(decodeAssistantSummary(validSummary())).toMatchObject({ featuredOrder: null, skillLinkCount: 2 });
    const list = (publishableGroups: unknown[]) => decodeAssistantListResponse({
      assistants: [validSummary()],
      publishableGroups,
      recentAssistantIds: ["assistant-1"],
      viewer: { canPublishInstallation: false, defaultAssistantId: "assistant-1" }
    });
    expect(list([{ id: "group-1", memberCount: 4, name: "Design" }])?.publishableGroups)
      .toEqual([{ id: "group-1", memberCount: 4, name: "Design" }]);
    for (const memberCount of [undefined, -1, 1.5, "4", null]) {
      expect(list([{ id: "group-1", memberCount, name: "Design" }]), String(memberCount)).toBeNull();
    }
  });

  it("requires the Skill link count and a Featured position that matches featured", () => {
    expect(decodeAssistantSummary({ ...validSummary(), featured: true, featuredOrder: 3 }))
      .toMatchObject({ featured: true, featuredOrder: 3 });
    expect(decodeAssistantSummary({ ...validSummary(), skillLinkCount: 0 })?.skillLinkCount).toBe(0);
    for (const invalid of [
      { featuredOrder: undefined },
      { featured: true, featuredOrder: null },
      { featured: false, featuredOrder: 0 },
      { featured: true, featuredOrder: -1 },
      { featured: true, featuredOrder: 1.5 },
      { skillLinkCount: undefined },
      { skillLinkCount: -1 },
      { skillLinkCount: 2.5 },
      { skillLinkCount: "2" }
    ]) {
      expect(decodeAssistantSummary({ ...validSummary(), ...invalid }), JSON.stringify(invalid)).toBeNull();
    }
  });

  it("decodes bounded availability dependencies", () => {
    expect(decodeAssistantSummary({
      ...validSummary(),
      audience: ownerAudience,
      owned: true,
      availability: {
        dependencies: [
          { kind: "mcp", name: "GitHub" },
          { kind: "model", name: "GPT-5" }
        ],
        ok: false,
        reason: "tools_access"
      }
    })?.availability).toEqual({
      dependencies: [
        { kind: "mcp", name: "GitHub" },
        { kind: "model", name: "GPT-5" }
      ],
      ok: false,
      reason: "tools_access"
    });
    expect(decodeAssistantSummary({
      ...validSummary(),
      availability: {
        dependencies: [{ kind: "mcp", name: "" }],
        ok: false,
        reason: "tools_access"
      }
    })).toBeNull();
    expect(decodeAssistantSummary({
      ...validSummary(),
      availability: {
        dependencies: [{ kind: "mcp", name: "Private server" }],
        ok: false,
        reason: "tools_access"
      },
      owned: false
    })).toBeNull();
  });

  it("accepts the full supported model display-name length in owner availability", () => {
    const modelName = "M".repeat(160);

    expect(decodeAssistantSummary({
      ...validSummary(),
      availability: {
        dependencies: [{ kind: "model", name: modelName }],
        ok: false,
        reason: "model_access"
      },
      audience: ownerAudience,
      owned: true
    })?.availability).toEqual({
      dependencies: [{ kind: "model", name: modelName }],
      ok: false,
      reason: "model_access"
    });
    expect(decodeAssistantSummary({
      ...validSummary(),
      availability: {
        dependencies: [{ kind: "model", name: `${modelName}M` }],
        ok: false,
        reason: "model_access"
      },
      audience: ownerAudience,
      owned: true
    })).toBeNull();
  });

  it("fails closed on malformed availability, scope, and fingerprint", () => {
    expect(
      decodeAssistantSummary({ ...validSummary(), availability: { ok: false, reason: "secret" } })
    ).toBeNull();
    expect(decodeAssistantSummary({ ...validSummary(), scope: { kind: "everyone" } })).toBeNull();
    expect(
      decodeAssistantSummary({ ...validSummary(), fingerprint: { modelLabel: 4 } })
    ).toBeNull();
    expect(
      decodeAssistantListResponse({
        assistants: [],
        publishableGroups: [{ id: "", name: "Design" }],
        recentAssistantIds: [],
        viewer: { canPublishInstallation: false, defaultAssistantId: null }
      })
    ).toBeNull();
  });

  it("requires and decodes bounded content Knowledge and Skill ids", () => {
    const content = validContent();
    const withoutKnowledge: Record<string, unknown> = { ...content };
    delete withoutKnowledge.knowledgeSelection;
    expect(decodeAssistantContent(withoutKnowledge)).toBeNull();
    expect(decodeAssistantContent({
      ...content,
      knowledgeSelection: {
        baseIds: ["base-a", "base-b"], mode: "explicit", sourceIds: [], version: 1
      }
    })?.knowledgeSelection).toEqual({
      baseIds: ["base-a", "base-b"], mode: "explicit", sourceIds: [], version: 1
    });
    expect(decodeAssistantContent({
      ...content,
      knowledgeSelection: {
        baseIds: ["base-a", "base-a"], mode: "explicit", sourceIds: [], version: 1
      }
    })).toBeNull();
    expect(decodeAssistantContent({
      ...content,
      knowledgeSelection: {
        baseIds: [" "], mode: "explicit", sourceIds: [], version: 1
      }
    })).toBeNull();
    const withoutSkills: Record<string, unknown> = { ...content };
    delete withoutSkills.skillIds;
    expect(decodeAssistantContent(withoutSkills)).toBeNull();
    expect(decodeAssistantContent({
      ...content,
      skillIds: ["skill-review", "skill-finish"]
    })?.skillIds).toEqual(["skill-review", "skill-finish"]);
    expect(decodeAssistantContent({
      ...content,
      skillIds: ["skill-review", "skill-review"]
    })).toBeNull();
  });

  it("accepts only ordered Assistant Skill summaries matching the declared ids", () => {
    const content = {
      ...validContent(),
      skillIds: ["skill-review", "skill-finish"]
    };
    const detail = {
      archived: false,
      audience: null,
      availability: { ok: true },
      featured: false,
      id: "assistant-1",
      owned: false,
      ownerDisplayName: "Alex",
      pinned: false,
      rowAvailability: {},
      scope: { kind: "installation" },
      content,
      updatedAt: "2026-08-06T00:00:00.000Z",
      skills: [
        { id: "skill-review", name: "Careful reviewer", available: false },
        { id: "skill-finish", name: "Action closer", available: true, instructionApproxTokens: 42 }
      ]
    };

    expect(decodeAssistantDetail(detail)?.skills).toEqual(detail.skills);
    for (const instructionApproxTokens of [-1, 1.5, "42", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(decodeAssistantDetail({ ...detail, skills: [detail.skills[0], { ...detail.skills[1], instructionApproxTokens }] })).toBeNull();
    }
    expect(decodeAssistantDetail({ ...detail, skills: [{ ...detail.skills[0], available: "false" }, detail.skills[1]] })).toBeNull();
    expect(decodeAssistantDetail({
      ...detail,
      skills: [...detail.skills].reverse()
    })).toBeNull();
  });
});

describe("accepted Assistant identity", () => {
  it("admits only a bounded display snapshot and excludes private or revision fields", () => {
    const avatar = assistantAvatarRecipeFromBytes(new Uint8Array(10));
    const identity = { name: "Original assistant", avatar };
    expect(decodeAssistantIdentity(identity)).toEqual(identity);
    for (const invalid of [{ ...identity, name: "" }, { ...identity, name: "a".repeat(81) },
      { ...identity, systemPrompt: "private" }, { ...identity, revisionNumber: 1 },
      { ...identity, avatar: { ...avatar, url: "private" } }]) {
      expect(decodeAssistantIdentity(invalid)).toBeNull();
    }
  });
});

const ids = (count: number, prefix = "id") => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

describe("Assistant row vocabulary", () => {
  it("decodes row keys, policies and provenance and rejects anything else", () => {
    expect(["model", "controls", "search", "tools", "knowledge", "skills"].map(decodeAssistantRowKey))
      .toEqual(["model", "controls", "search", "tools", "knowledge", "skills"]);
    expect(decodeAssistantRowPolicy("fixed")).toBe("fixed");
    expect(decodeAssistantRowPolicy("adjustable")).toBe("adjustable");
    expect(["assistant", "chat", "default", "fallback"].map(decodeAssistantRowProvenance))
      .toEqual(["assistant", "chat", "default", "fallback"]);
    for (const invalid of ["Model", "parameters", "", null, 1]) expect(decodeAssistantRowKey(invalid)).toBeNull();
    for (const invalid of ["FIXED", "locked", null]) expect(decodeAssistantRowPolicy(invalid)).toBeNull();
    for (const invalid of ["user", "inherit", undefined]) expect(decodeAssistantRowProvenance(invalid)).toBeNull();
  });

  it("keeps inherit, off or none and concrete values distinct in every row", () => {
    expect(decodeAssistantModelValue({ mode: "inherit" })).toEqual({ mode: "inherit" });
    expect(decodeAssistantModelValue({ mode: "model", modelId: " model-1 " })).toEqual({ mode: "model", modelId: "model-1" });
    expect(decodeAssistantSearchValue({ mode: "inherit" })).toEqual({ mode: "inherit" });
    expect(decodeAssistantSearchValue({ mode: "off" })).toEqual({ mode: "off" });
    expect(decodeAssistantSearchValue({ mode: "model_choice", optionIds: ["web"] }))
      .toEqual({ mode: "model_choice", optionIds: ["web"] });
    expect(decodeAssistantToolsValue({ mode: "inherit" })).toEqual({ mode: "inherit" });
    expect(decodeAssistantToolsValue({ mode: "off" })).toEqual({ mode: "off" });
    expect(decodeAssistantToolsValue({ mode: "exact", serverIds: ["a"] })).toEqual({ mode: "exact", serverIds: ["a"] });
    expect(decodeAssistantKnowledgeValue({ mode: "inherit" })).toEqual({ mode: "inherit" });
    expect(decodeAssistantKnowledgeValue({ mode: "none" })).toEqual({ mode: "none" });
    expect(decodeAssistantKnowledgeValue({ baseIds: ["b"], mode: "explicit", sourceIds: [] }))
      .toEqual({ baseIds: ["b"], mode: "explicit", sourceIds: [] });
    // An empty concrete value is never another name for Off, None or inherit.
    expect(decodeAssistantSearchValue({ mode: "all_selected", optionIds: [] })).toBeNull();
    expect(decodeAssistantToolsValue({ mode: "exact", serverIds: [] })).toBeNull();
    expect(decodeAssistantKnowledgeValue({ baseIds: [], mode: "explicit", sourceIds: [] })).toBeNull();
    expect(decodeAssistantModelValue({ mode: "model", modelId: null })).toBeNull();
    for (const decode of [decodeAssistantModelValue, decodeAssistantSearchValue, decodeAssistantToolsValue, decodeAssistantKnowledgeValue]) {
      expect(decode({ mode: "inherit", optionIds: [] })).toBeNull();
      expect(decode(null)).toBeNull();
    }
    expect(decodeAssistantSearchValue({ mode: "off", optionIds: [] })).toBeNull();
    expect(decodeAssistantKnowledgeValue({ baseIds: [], mode: "none", sourceIds: [], version: 1 })).toBeNull();
  });

  it("enforces resource bounds at their limits", () => {
    expect(decodeAssistantSearchValue({ mode: "all_selected", optionIds: ids(3) })).not.toBeNull();
    expect(decodeAssistantSearchValue({ mode: "all_selected", optionIds: ids(4) })).toBeNull();
    expect(decodeAssistantSearchValue({ mode: "all_selected", optionIds: ["a", "a"] })).toBeNull();
    expect(decodeAssistantToolsValue({ mode: "exact", serverIds: ids(16) })).not.toBeNull();
    expect(decodeAssistantToolsValue({ mode: "exact", serverIds: ids(17) })).toBeNull();
    expect(decodeAssistantToolsValue({ mode: "exact", serverIds: ["a", " a"] })).toBeNull();
    expect(decodeAssistantToolsValue({ mode: "exact", serverIds: ["x".repeat(65)] })).toBeNull();
    expect(decodeAssistantKnowledgeValue({ baseIds: ids(64, "b"), mode: "explicit", sourceIds: ids(64, "s") })).not.toBeNull();
    expect(decodeAssistantKnowledgeValue({ baseIds: ids(65, "b"), mode: "explicit", sourceIds: ids(64, "s") })).toBeNull();
    const links = (count: number, delivery: string) => ids(count, delivery).map((skillId) => ({ delivery, skillId }));
    expect(decodeAssistantSkillsValue({ links: [...links(32, "always"), ...links(64, "on_demand")], mode: "off" })).not.toBeNull();
    expect(decodeAssistantSkillsValue({ links: links(33, "always"), mode: "auto" })).toBeNull();
    expect(decodeAssistantSkillsValue({ links: links(65, "on_demand"), mode: "auto" })).toBeNull();
    expect(decodeAssistantSkillsValue({ links: [{ delivery: "pinned", skillId: "s" }], mode: "auto" })).toBeNull();
    expect(decodeAssistantSkillsValue({ links: [], mode: "inherit" })).toBeNull();
  });

  it("accepts redaction counts and hidden models only in projections", () => {
    const hidden = [
      [decodeAssistantSearchValue, { hiddenCount: 1, mode: "all_selected", optionIds: [] }],
      [decodeAssistantToolsValue, { hiddenCount: 2, mode: "exact", serverIds: ["a"] }],
      [decodeAssistantKnowledgeValue, { baseIds: [], hiddenCount: 3, mode: "explicit", sourceIds: [] }],
      [decodeAssistantSkillsValue, { hiddenCount: 1, links: [], mode: "auto" }],
      [decodeAssistantModelValue, { mode: "model", modelId: null }]
    ] as const;
    for (const [decode, value] of hidden) {
      expect(decode(value, "projection")).toEqual(value);
      expect(decode(value, "draft")).toBeNull();
    }
    expect(decodeAssistantToolsValue({ hiddenCount: 0, mode: "exact", serverIds: ["a"] }, "projection")).toBeNull();
    expect(decodeAssistantToolsValue({ hiddenCount: 16, mode: "exact", serverIds: ["a"] }, "projection")).toBeNull();
    expect(decodeAssistantSearchValue({ hiddenCount: 1.5, mode: "all_selected", optionIds: ["a"] }, "projection")).toBeNull();
  });
});

function draftRows(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    controls: { policy: "adjustable", value: {} },
    knowledge: { policy: "adjustable", value: { mode: "none" } },
    model: { policy: "adjustable", value: { mode: "inherit" } },
    search: { policy: "adjustable", value: { mode: "inherit" } },
    skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
    tools: { policy: "adjustable", value: { mode: "inherit" } },
    ...overrides
  };
}

describe("Assistant rows", () => {
  it("accepts the new Assistant defaults and every concrete fixed row", () => {
    expect(decodeAssistantRows(draftRows())).toMatchObject({ ok: true });
    expect(decodeAssistantRows(validRows())).toMatchObject({ ok: true });
    expect(decodeAssistantRows(draftRows({
      knowledge: { policy: "fixed", value: { mode: "none" } },
      search: { policy: "fixed", value: { mode: "off" } },
      tools: { policy: "fixed", value: { mode: "off" } }
    }))).toMatchObject({ ok: true });
  });

  it("applies the policy rules with stable row-scoped codes", () => {
    for (const row of ["model", "search", "tools", "knowledge"]) {
      expect(decodeAssistantRows(draftRows({ [row]: { policy: "fixed", value: { mode: "inherit" } } })))
        .toEqual({ code: "assistant_row_fixed_requires_value", ok: false, row });
    }
    expect(decodeAssistantRows(draftRows({ controls: { policy: "fixed", value: {} } })))
      .toEqual({ code: "assistant_row_fixed_requires_value", ok: false, row: "controls" });
    expect(decodeAssistantRows(draftRows({
      controls: { policy: "fixed", value: { temperature: 0.2 } },
      model: { policy: "adjustable", value: { mode: "model", modelId: "model-1" } }
    }))).toEqual({ code: "assistant_row_controls_require_fixed_model", ok: false, row: "controls" });
    expect(decodeAssistantRows(draftRows({
      controls: { policy: "fixed", value: { temperature: 0.2 } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-1" } }
    }))).toMatchObject({ ok: true });
  });

  it("rejects malformed rows with the section code of the row", () => {
    const cases: Array<[Record<string, unknown> | unknown, Record<string, unknown>]> = [
      [null, { code: "assistant_rows_invalid" }],
      [{ ...draftRows(), extra: { policy: "fixed", value: {} } }, { code: "assistant_rows_invalid" }],
      [(() => { const rows = draftRows(); delete rows.skills; return rows; })(), { code: "assistant_rows_invalid" }],
      [draftRows({ model: { policy: "locked", value: { mode: "inherit" } } }), { code: "assistant_rows_invalid", row: "model" }],
      [draftRows({ model: { policy: "fixed", value: { mode: "inherit" }, note: "x" } }), { code: "assistant_rows_invalid", row: "model" }],
      [draftRows({ model: { policy: "adjustable", value: { mode: "model", modelId: "" } } }), { code: "assistant_model_invalid", row: "model" }],
      [draftRows({ controls: { policy: "adjustable", value: { maxOutputTokens: 0 } } }),
        { code: "assistant_run_controls_invalid", field: "maxOutputTokens", row: "controls" }],
      [draftRows({ search: { policy: "adjustable", value: { mode: "sometimes" } } }), { code: "assistant_search_plan_invalid", row: "search" }],
      [draftRows({ tools: { policy: "adjustable", value: { mode: "auto" } } }), { code: "assistant_mcp_servers_invalid", row: "tools" }],
      [draftRows({ knowledge: { policy: "adjustable", value: { mode: "all_my_knowledge" } } }),
        { code: "assistant_knowledge_bases_invalid", row: "knowledge" }],
      [draftRows({ skills: { policy: "adjustable", value: { links: ids(33).map((skillId) => ({ delivery: "always", skillId })), mode: "auto" } } }),
        { actual: 33, code: "skills_count_exceeded", field: "pinned", limit: 32, row: "skills" }]
    ];
    for (const [rows, error] of cases) {
      expect(decodeAssistantRows(rows)).toEqual({ ...error, ok: false });
    }
  });

  it("maps legacy flat row fields to fixed rows for fixtures", () => {
    const base = {
      knowledgeSelection: { baseIds: [], mode: "none" as const, sourceIds: [], version: 1 as const },
      mcpServerIds: [],
      providerModelId: "model-1",
      runControls: {},
      searchPlan: { mode: "all_selected" as const, optionIds: [] },
      skillIds: []
    };
    expect(assistantRowsFromLegacyFields(base)).toEqual({
      controls: { policy: "adjustable", value: {} },
      knowledge: { policy: "fixed", value: { mode: "none" } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-1" } },
      search: { policy: "fixed", value: { mode: "off" } },
      skills: { policy: "fixed", value: { links: [], mode: "auto" } },
      tools: { policy: "fixed", value: { mode: "off" } }
    });
    expect(assistantRowsFromLegacyFields({
      ...base,
      knowledgeSelection: { baseIds: ["b"], mode: "explicit", sourceIds: ["s"], version: 1 },
      mcpServerIds: ["server"],
      runControls: { temperature: 0.3 },
      searchPlan: { mode: "model_choice", optionIds: ["web"] },
      skillIds: ["pin", "demand"],
      skillModes: { demand: "available", pin: "pinned" },
      skills: { mode: "off" }
    })).toEqual({
      controls: { policy: "fixed", value: { temperature: 0.3 } },
      knowledge: { policy: "fixed", value: { baseIds: ["b"], mode: "explicit", sourceIds: ["s"] } },
      model: { policy: "fixed", value: { mode: "model", modelId: "model-1" } },
      search: { policy: "fixed", value: { mode: "model_choice", optionIds: ["web"] } },
      skills: { policy: "fixed", value: { links: [
        { delivery: "always", skillId: "pin" }, { delivery: "on_demand", skillId: "demand" }
      ], mode: "off" } },
      tools: { policy: "fixed", value: { mode: "exact", serverIds: ["server"] } }
    });
  });
});

describe("Assistants v2 draft", () => {
  function rowsDraft(): Record<string, unknown> {
    return { ...validFields(), rows: draftRows() };
  }

  it("accepts a rows draft with inherit values and applies the policy rules", () => {
    expect(decodeAssistantDraft(rowsDraft())).toMatchObject({ ok: true, draft: { rows: { model: { value: { mode: "inherit" } } } } });
    expect(decodeAssistantDraft({ ...rowsDraft(), rows: draftRows({ search: { policy: "fixed", value: { mode: "inherit" } } }) }))
      .toEqual({ code: "assistant_row_fixed_requires_value", ok: false, row: "search" });
  });

  it("bounds answer rules, starters and instructions at their new limits and ignores the retired developer prompt", () => {
    const decoded = decodeAssistantDraft({
      ...validDraft(),
      answerRules: "x".repeat(4000),
      developerPrompt: "retired",
      starterPrompts: ids(6).map((id) => id.padEnd(200, "x")),
      systemPrompt: "x".repeat(48_000)
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.draft.answerRules).toHaveLength(4000);
      expect(decoded.draft.starterPrompts).toHaveLength(6);
      expect(decoded.draft).not.toHaveProperty("developerPrompt");
    }
    expect(decodeAssistantDraft({ ...validDraft(), answerRules: "rules\0" }))
      .toEqual({ code: "assistant_answer_rules_invalid", ok: false });
  });
});

describe("Assistants v2 wire additions", () => {
  it("decodes stored starters under the former limit and rejects retired or oversized content", () => {
    expect(decodeAssistantContent({ ...validContent(), starterPrompts: ["x".repeat(400)] })?.starterPrompts).toHaveLength(1);
    expect(decodeAssistantContent({ ...validContent(), starterPrompts: ["x".repeat(401)] })).toBeNull();
    expect(decodeAssistantContent({ ...validContent(), starterPrompts: ids(7) })).toBeNull();
    expect(decodeAssistantContent({ ...validContent(), systemPrompt: "x".repeat(48_001) })).toBeNull();
    expect(decodeAssistantContent({ ...validContent(), rows: undefined })).toBeNull();
    const withoutRules: Record<string, unknown> = validContent();
    delete withoutRules.answerRules;
    expect(decodeAssistantContent(withoutRules)).toBeNull();
    expect(decodeAssistantContent({ ...validContent(), developerPrompt: "retired" })).not.toHaveProperty("developerPrompt");
    expect(decodeAssistantContent({ ...validContent(), answerRules: "Be brief." })?.answerRules).toBe("Be brief.");
  });

  it("decodes Featured, Project scope, archived availability and row deviations", () => {
    expect(decodeAssistantSummary({ ...validSummary(), featured: true, featuredOrder: 0,
      scope: { kind: "project", projectName: "Support" } }))
      .toMatchObject({ featured: true, scope: { kind: "project", projectName: "Support" } });
    expect(decodeAssistantSummary({ ...validSummary(), availability: { ok: false, reason: "archived" } })?.availability)
      .toEqual({ ok: false, reason: "archived" });
    const withoutFeatured: Record<string, unknown> = validSummary();
    delete withoutFeatured.featured;
    expect(decodeAssistantSummary(withoutFeatured)).toBeNull();
    expect(decodeAssistantSummary({ ...validSummary(), scope: { kind: "project" } })).toBeNull();

    const deviations = {
      knowledge: { reason: "knowledge_not_ready" },
      model: { dependencies: [{ kind: "model", name: "Gemini" }], reason: "model_access" },
      search: { reason: "search_access" },
      tools: { reason: "tools_access" }
    };
    expect(decodeAssistantRowAvailability(deviations, true)).toEqual(deviations);
    expect(decodeAssistantRowAvailability(deviations, false)).toBeNull();
    expect(decodeAssistantRowAvailability({ model: { reason: "tools_access" } }, true)).toBeNull();
    expect(decodeAssistantRowAvailability({ controls: { reason: "model_access" } }, true)).toBeNull();
    expect(decodeAssistantRowAvailability({ skills: { reason: "skills_access" } }, true)).toBeNull();
    expect(decodeAssistantRowAvailability({ model: { reason: "archived" } }, true)).toBeNull();
    expect(decodeAssistantSummary({ ...validSummary(), rowAvailability: deviations })).toBeNull();
    expect(decodeAssistantSummary({ ...validSummary(), audience: ownerAudience, owned: true, rowAvailability: deviations })?.rowAvailability)
      .toEqual(deviations);
  });

  it("accepts owner-only detail additions only for the owner", () => {
    const detail = {
      archived: false,
      audience: ownerAudience,
      availability: { ok: true },
      content: validContent(),
      featured: true,
      featuredOrder: 1,
      id: "assistant-1",
      listingRequest: {
        canRequest: false,
        canWithdraw: true,
        listed: false,
        request: {
          createdAt: "2026-09-28T00:00:00.000Z", definitionVersion: 3, id: "request-1", outdated: true,
          reviewNote: null, reviewedAt: null, state: "pending"
        }
      },
      owned: true,
      ownerDisplayName: "Alex",
      pinned: false,
      projects: { otherProjectCount: 2, projects: [{ id: "project-1", name: "Support" }] },
      recentChatCount: 14,
      rowAvailability: {},
      scope: { kind: "owner" },
      updatedAt: "2026-09-28T00:00:00.000Z",
      version: 4
    };
    expect(decodeAssistantDetail(detail)).toMatchObject({
      featuredOrder: 1,
      listingRequest: { canWithdraw: true, request: { id: "request-1", outdated: true, state: "pending" } },
      projects: { otherProjectCount: 2 },
      recentChatCount: 14
    });
    expect(decodeAssistantDetail({ ...detail, listingRequest: null })?.listingRequest).toBeNull();
    for (const field of ["featuredOrder", "listingRequest", "projects", "recentChatCount"]) {
      const consumer: Record<string, unknown> = { ...detail, audience: null, owned: false, featuredOrder: undefined,
        listingRequest: undefined, projects: undefined, recentChatCount: undefined, version: undefined };
      consumer[field] = detail[field as keyof typeof detail];
      expect(decodeAssistantDetail(consumer), field).toBeNull();
    }
    for (const invalid of [
      { featuredOrder: null },
      { featured: false },
      { featuredOrder: -1 },
      { listingRequest: { outdated: true, requestId: "request-1", reviewNote: null, state: "pending" } },
      { listingRequest: { canRequest: false, canWithdraw: true, listed: false, request: null } },
      { projects: { otherProjectCount: 0, projects: [{ id: "p", name: "A" }, { id: "p", name: "B" }] } },
      { recentChatCount: 1.5 }
    ]) {
      expect(decodeAssistantDetail({ ...detail, ...invalid }), JSON.stringify(invalid)).toBeNull();
    }
  });

  it("names the whole audience only to the owner and carries scope and update date in every detail", () => {
    const audience = { everyone: true, groupNames: ["Design", "Support"] };
    const owner = { ...validSummary(), audience, owned: true, scope: { kind: "owner" } };
    expect(decodeAssistantSummary(owner)?.audience).toEqual(audience);
    expect(decodeAssistantSummary(validSummary())?.audience).toBeNull();
    const withoutAudience: Record<string, unknown> = validSummary();
    delete withoutAudience.audience;
    for (const invalid of [
      withoutAudience,
      { ...owner, audience: null },
      { ...owner, audience: undefined },
      { ...validSummary(), audience },
      { ...owner, audience: { everyone: "yes", groupNames: [] } },
      { ...owner, audience: { everyone: false } },
      { ...owner, audience: { everyone: false, groupNames: [""] } },
      { ...owner, audience: { everyone: false, groupIds: ["group-1"], groupNames: ["Design"] } }
    ]) {
      expect(decodeAssistantSummary(invalid), JSON.stringify(invalid)).toBeNull();
    }

    const member = {
      archived: false, audience: null, availability: { ok: true }, content: validContent(), featured: false,
      id: "assistant-1", owned: false, ownerDisplayName: "Alex", pinned: false, rowAvailability: {},
      scope: { kind: "project", projectName: "Support" }, updatedAt: "2026-09-28T00:00:00.000Z"
    };
    expect(decodeAssistantDetail(member)).toMatchObject({
      audience: null, scope: { kind: "project", projectName: "Support" }, updatedAt: "2026-09-28T00:00:00.000Z"
    });
    expect(decodeAssistantDetail({ ...member, audience, owned: true, scope: { kind: "owner" } })?.audience).toEqual(audience);
    for (const invalid of [
      { scope: undefined },
      { scope: { kind: "everyone" } },
      { updatedAt: undefined },
      { updatedAt: "" },
      { audience },
      { audience: undefined },
      { owned: true, scope: { kind: "owner" } }
    ]) {
      expect(decodeAssistantDetail({ ...member, ...invalid }), JSON.stringify(invalid)).toBeNull();
    }
  });

  it("requires recents and the default Assistant to point into the list", () => {
    const list = (recentAssistantIds: unknown, defaultAssistantId: unknown) => decodeAssistantListResponse({
      assistants: [validSummary()],
      publishableGroups: [],
      recentAssistantIds,
      viewer: { canPublishInstallation: true, defaultAssistantId }
    });
    expect(list([], null)).toMatchObject({ recentAssistantIds: [], viewer: { defaultAssistantId: null } });
    expect(list(["assistant-hidden"], null)).toBeNull();
    expect(list(["assistant-1", "assistant-1"], null)).toBeNull();
    expect(list([], "assistant-hidden")).toBeNull();
    expect(list(undefined, null)).toBeNull();
    expect(decodeAssistantListResponse({
      assistants: ids(6, "assistant").map((id) => ({ ...validSummary(), id })),
      publishableGroups: [],
      recentAssistantIds: ids(6, "assistant"),
      viewer: { canPublishInstallation: false, defaultAssistantId: null }
    })).toBeNull();
  });

  it("decodes the duplicate report and the frozen run provenance", () => {
    const detail = { archived: false, audience: ownerAudience, availability: { ok: true }, content: validContent(),
      featured: false, id: "assistant-1", owned: true, ownerDisplayName: "Alex", pinned: false, rowAvailability: {},
      scope: { kind: "owner" }, updatedAt: "2026-09-28T00:00:00.000Z" };
    expect(decodeAssistantDuplicateResponse({ assistant: detail, report: { downgradedRows: ["knowledge"], droppedSkillCount: 1 } }))
      .toMatchObject({ report: { downgradedRows: ["knowledge"], droppedSkillCount: 1 } });
    expect(decodeAssistantDuplicateResponse({ assistant: detail })).toBeNull();
    expect(decodeAssistantDuplicateResponse({ assistant: detail, report: { downgradedRows: ["prompt"], droppedSkillCount: 0 } })).toBeNull();

    const provenance = { controls: "default", knowledge: "assistant", model: "chat", search: "fallback", skills: "assistant", tools: "default" };
    expect(decodeAssistantRunRowProvenance(provenance)).toEqual(provenance);
    expect(decodeAssistantRunRowProvenance({ ...provenance, model: "user" })).toBeNull();
    expect(decodeAssistantRunRowProvenance({ ...provenance, extra: "chat" })).toBeNull();
  });
});

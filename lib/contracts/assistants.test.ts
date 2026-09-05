import { describe, expect, it } from "vitest";
import {
  assistantAvatarRecipeFromBytes,
  decodeAssistantAvatarRecipe,
  decodeAssistantIdentity,
  decodeAssistantDetail,
  decodeAssistantDraft,
  decodeAssistantListResponse,
  decodeAssistantContent,
  decodeAssistantRunControls,
  decodeAssistantSummary,
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

function validDraft(): Record<string, unknown> {
  return {
    avatar: validRecipe,
    category: "coding",
    description: "Reviews changes for correctness.",
    developerPrompt: null,
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: ["server-1"],
    name: "Code Reviewer",
    providerModelId: "model-1",
    runControls: { reasoningEffort: "high" },
    searchPlan: { mode: "all_selected", optionIds: ["openai-native-web-search"] },
    skillIds: [],
    starterPrompts: ["Review a diff"],
    systemPrompt: "You review code."
  };
}

describe("assistant draft decode", () => {
  it("accepts a complete bounded draft and trims presentation fields", () => {
    const decoded = decodeAssistantDraft({ ...validDraft(), name: "  Code Reviewer  " });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.draft.knowledgeSelection).toEqual({
        baseIds: [], mode: "none", sourceIds: [], version: 1
      });
      expect(decoded.draft.name).toBe("Code Reviewer");
      expect(decoded.draft.searchPlan).toEqual({
        mode: "all_selected",
        optionIds: ["openai-native-web-search"]
      });
    }
  });

  it("fails each bounded field with a stable field-scoped code", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...validDraft(), name: "" }, "assistant_name_invalid"],
      [{ ...validDraft(), name: "x".repeat(81) }, "assistant_name_invalid"],
      [{ ...validDraft(), description: "x".repeat(401) }, "assistant_description_invalid"],
      [{ ...validDraft(), category: "vibes" }, "assistant_category_invalid"],
      [{ ...validDraft(), avatar: { kind: "generated" } }, "assistant_avatar_invalid"],
      [{ ...validDraft(), providerModelId: "" }, "assistant_model_invalid"],
      [{ ...validDraft(), systemPrompt: 7 }, "assistant_system_prompt_invalid"],
      [{ ...validDraft(), developerPrompt: 7 }, "assistant_developer_prompt_invalid"],
      [{ ...validDraft(), runControls: { topP: 1 } }, "assistant_run_controls_invalid"],
      [{ ...validDraft(), searchPlan: { mode: "sometimes", optionIds: [] } }, "assistant_search_plan_invalid"],
      [{
        ...validDraft(), knowledgeSelection: { baseIds: ["legacy-base"] }
      }, "assistant_knowledge_bases_invalid"],
      [{
        ...validDraft(),
        knowledgeSelection: {
          baseIds: ["base", "base"], mode: "explicit", sourceIds: [], version: 1
        }
      }, "assistant_knowledge_bases_invalid"],
      [{
        ...validDraft(),
        knowledgeSelection: {
          baseIds: Array.from({ length: 129 }, (_, index) => `base-${index}`),
          mode: "explicit",
          sourceIds: [],
          version: 1
        }
      }, "assistant_knowledge_bases_invalid"],
      [{
        ...validDraft(),
        knowledgeSelection: {
          baseIds: ["  "], mode: "explicit", sourceIds: [], version: 1
        }
      }, "assistant_knowledge_bases_invalid"],
      [{ ...validDraft(), mcpServerIds: ["a", "a"] }, "assistant_mcp_servers_invalid"],
      [{ ...validDraft(), skillIds: ["a", "a"] }, "assistant_skills_invalid"],
      [
        { ...validDraft(), skillIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
        "assistant_skills_invalid"
      ],
      [{ ...validDraft(), skillIds: ["  "] }, "assistant_skills_invalid"],
      [
        { ...validDraft(), starterPrompts: ["one", "two", "three", "four", "five"] },
        "assistant_starter_prompts_invalid"
      ],
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

  it("preserves the declared Skill order", () => {
    const decoded = decodeAssistantDraft({
      ...validDraft(),
      skillIds: ["skill-review", "skill-finish"]
    });
    expect(decoded).toMatchObject({
      draft: { skillIds: ["skill-review", "skill-finish"] },
      ok: true
    });
  });

  it("identifies a structurally invalid run-control field", () => {
    expect(decodeAssistantDraft({
      ...validDraft(),
      runControls: { maxOutputTokens: 0 }
    })).toEqual({
      code: "assistant_run_controls_invalid",
      field: "maxOutputTokens",
      ok: false
    });
  });
});

function validSummary(): Record<string, unknown> {
  return {
    archived: false,
    availability: { ok: true },
    avatar: validRecipe,
    category: "coding",
    description: "Reviews changes.",
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
    scope: { groupNames: ["Design"], kind: "group" },
    starterPrompts: ["Review a diff"],
    updatedAt: "2026-08-06T00:00:00.000Z"
  };
}

describe("assistant wire decoders", () => {
  it("decodes a valid summary and list response", () => {
    expect(decodeAssistantSummary(validSummary())).not.toBeNull();
    expect(
      decodeAssistantListResponse({
        assistants: [validSummary()],
        publishableGroups: [{ id: "group-1", name: "Design" }],
        viewer: { canPublishInstallation: false }
      })
    ).not.toBeNull();
  });

  it("decodes bounded availability dependencies", () => {
    expect(decodeAssistantSummary({
      ...validSummary(),
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
        viewer: { canPublishInstallation: false }
      })
    ).toBeNull();
  });

  it("requires and decodes bounded content Knowledge and Skill ids", () => {
    const content = {
      ...validDraft(),
    };
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
      ...validDraft(),
      skillIds: ["skill-review", "skill-finish"]
    };
    const detail = {
      archived: false,
      availability: { ok: true },
      id: "assistant-1",
      owned: false,
      ownerDisplayName: "Alex",
      pinned: false,
      content,
      skills: [
        { id: "skill-review", name: "Careful reviewer" },
        { id: "skill-finish", name: "Action closer" }
      ]
    };

    expect(decodeAssistantDetail(detail)?.skills).toEqual(detail.skills);
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

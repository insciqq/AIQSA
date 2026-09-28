import type {
  ComposerAssistantRows,
  ComposerBoundAssistant
} from "@/components/app-shell/composerControlStore";
import type {
  AssistantAvatarRecipe,
  AssistantRowKey,
  AssistantRowPolicy
} from "@/lib/contracts/assistants";

export const assistantAvatarFixture: AssistantAvatarRecipe = {
  accents: [0],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 1]
};

/** Rows of an Assistant that sets every row itself; all adjustable unless given. */
export function composerAssistantRowsFixture(
  policies: Partial<Record<AssistantRowKey, AssistantRowPolicy>> = {}
): ComposerAssistantRows {
  return {
    controls: {
      assistantValue: { temperature: 0.3 },
      deviation: null,
      origin: "assistant",
      policy: policies.controls ?? "adjustable"
    },
    knowledge: {
      assistantValue: { mode: "none" },
      deviation: null,
      origin: "assistant",
      policy: policies.knowledge ?? "adjustable"
    },
    model: {
      assistantValue: { mode: "model", modelId: "assistant-model" },
      deviation: null,
      origin: "assistant",
      policy: policies.model ?? "adjustable"
    },
    search: {
      assistantValue: { mode: "off" },
      deviation: null,
      origin: "assistant",
      policy: policies.search ?? "adjustable"
    },
    skills: {
      assistantValue: { links: [], mode: "auto" },
      deviation: null,
      origin: "assistant",
      policy: policies.skills ?? "adjustable"
    },
    tools: {
      assistantValue: { mode: "exact", serverIds: ["server-1"] },
      deviation: null,
      origin: "assistant",
      policy: policies.tools ?? "adjustable"
    }
  };
}

export function boundComposerAssistantFixture(
  overrides: Partial<ComposerBoundAssistant> = {}
): ComposerBoundAssistant {
  return {
    availability: { ok: true },
    avatar: assistantAvatarFixture,
    description: "Focused helper",
    id: "assistant-a",
    includedSkills: [],
    name: "Assistant A",
    owned: true,
    ownerDisplayName: "Owner",
    promptCharacterCount: 42,
    resets: {},
    rows: composerAssistantRowsFixture(),
    starterPrompts: [],
    state: "bound",
    unsyncedRows: [],
    ...overrides
  };
}

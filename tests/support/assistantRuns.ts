import type { AssistantRunControls } from "@/lib/contracts/assistants";
import type { AssistantRowContext, AssistantRowResourceIds } from "@/lib/server/assistants/rowContext";
import type { AssistantRowContextDefaults } from "@/lib/server/assistants/rowResolution";

/**
 * A row-context loader for run admission tests: every named Knowledge base,
 * Source, Skill, MCP server and Search source is usable unless listed in
 * `unavailable`; models are exactly `models` (id to connection).
 */
export function assistantRowContextLoader(input: Readonly<{
  defaultModelId: string;
  defaults?: Partial<Omit<AssistantRowContextDefaults, "controlsForModel" | "modelId">>;
  models: Readonly<Record<string, string>>;
  savedControls?: Readonly<Record<string, AssistantRunControls>>;
  unavailable?: readonly string[];
}>): (request: Readonly<{ ids: AssistantRowResourceIds; userId: string }>) => Promise<AssistantRowContext> {
  const unavailable = new Set(input.unavailable ?? []);
  const usable = { has: (id: string) => !unavailable.has(id) } as unknown as ReadonlySet<string>;
  const models = new Map(Object.entries(input.models));
  return async () => ({
    available: {
      allMyKnowledge: true,
      knowledgeBaseIds: usable,
      knowledgeSourceIds: usable,
      mcpServerIds: usable,
      modelIds: new Set([...models.keys()].filter((id) => !unavailable.has(id))),
      searchOptionIds: usable,
      skillIds: usable
    },
    defaults: {
      controlsForModel: (modelId) => ({ ...input.savedControls?.[modelId] }),
      knowledge: { mode: "none" },
      modelId: input.defaultModelId,
      search: { mode: "off" },
      tools: { mode: "auto" },
      ...input.defaults
    },
    modelConnections: models
  });
}

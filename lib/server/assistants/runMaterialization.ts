import type { AssistantIdentity, AssistantRunControls } from "../../contracts/assistants";
import type { KnowledgeSelection } from "../../contracts/knowledge";
import type { SearchPlan } from "../../contracts/search";

/**
 * Server-resolved execution profile of the currently authorized Assistant
 * definition. Admission materializes model, prompts, controls, Search intent, and
 * the exact MCP allowlist from this snapshot; the browser's expanded copy is
 * never trusted.
 */
export type AssistantRunMaterialization = {
  assistantId: string;
  developerPrompt: string | null;
  knowledgeSelection: KnowledgeSelection;
  mcpServerIds: string[];
  name: string;
  /** The value the run request would carry as `provider` (connection id). */
  provider: string;
  /** The opaque catalog deployment id the run request would carry as `modelId`. */
  providerModelId: string;
  /** Transient optimistic fence, never a historical configuration selector. */
  definitionVersion: number;
  identity: AssistantIdentity;
  runControls: AssistantRunControls;
  searchPlan: SearchPlan;
  skillIds: string[];
  systemPrompt: string;
};

export type AssistantRunResolution =
  | { assistant: AssistantRunMaterialization; ok: true }
  | { code: "assistant_not_available"; ok: false; status: 404 };

export type AssistantRunResolver = {
  resolveForProject?(
    projectId: string,
    assistantId: string
  ): Promise<AssistantRunResolution>;
  /** Resolves one complete current definition under the runner's authority. */
  resolveForRun(userId: string, assistantId: string): Promise<AssistantRunResolution>;
};

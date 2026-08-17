import type { AssistantRunControls } from "../../contracts/assistants";
import type { SearchPlan } from "../../contracts/search";

/**
 * Server-resolved execution profile of the currently authorized Assistant
 * revision. Admission materializes model, prompts, controls, Search intent, and
 * the exact MCP allowlist from this snapshot; the browser's expanded copy is
 * never trusted.
 */
export type AssistantRunMaterialization = {
  assistantId: string;
  developerPrompt: string | null;
  knowledgeBaseIds: string[];
  mcpServerIds: string[];
  name: string;
  /** The value the run request would carry as `provider` (connection id). */
  provider: string;
  /** The opaque catalog deployment id the run request would carry as `modelId`. */
  providerModelId: string;
  revisionId: string;
  revisionNumber: number;
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
  /**
   * Resolves the revision the runner is currently authorized to execute: the
   * owner's current revision, or the highest revision pinned by an active
   * group/installation publication covering the runner. Invisible, archived,
   * and nonexistent Assistants share one privacy-neutral failure.
   */
  resolveForRun(userId: string, assistantId: string): Promise<AssistantRunResolution>;
};

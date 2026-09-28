import type { AssistantIdentity, AssistantRows, AssistantRunControls } from "../../contracts/assistants";
import type { KnowledgeSelection } from "../../contracts/knowledge";
import type { SearchPlan } from "../../contracts/search";

/**
 * Server-resolved execution profile of the currently authorized Assistant
 * definition. Admission resolves model, prompts, controls, Search, Tools,
 * Knowledge and Skills from this snapshot; the browser's expanded copy is
 * never trusted. `rows` is authoritative; admission resolves every row
 * through the chain. The flat fields read an inherited value as unset, Off or
 * None.
 */
export type AssistantRunMaterialization = {
  assistantId: string;
  /** Unrendered author text; null or blank keeps the built-in answer contract. */
  answerRules?: string | null;
  responseReminder?: string;
  knowledgeSelection: KnowledgeSelection;
  mcpServerIds: string[];
  name: string;
  /** The value the run request would carry as `provider` (connection id); null without a runnable concrete model. */
  provider: string | null;
  /** The opaque catalog deployment id the run request would carry as `modelId`; null for an inherited model. */
  providerModelId: string | null;
  /** Transient optimistic fence, never a historical configuration selector. */
  definitionVersion: number;
  identity: AssistantIdentity;
  /** The complete, unredacted rows with their policies. */
  rows: AssistantRows;
  runControls: AssistantRunControls;
  searchPlan: SearchPlan;
  skillIds: string[];
  skills?: { mode: "auto" | "off" };
  skillModes?: Record<string, "pinned" | "available">;
  systemPrompt: string;
};

export type AssistantRunResolution =
  | { assistant: AssistantRunMaterialization; ok: true }
  | { code: "assistant_not_available"; ok: false; status: 404 };

export type AssistantRunResolver = {
  /**
   * Resolves one complete current definition bound to the Project; row
   * dependencies are decided by admission against the Project's resources.
   */
  resolveForProject?(
    projectId: string,
    assistantId: string
  ): Promise<AssistantRunResolution>;
  /**
   * Resolves one complete current definition under the runner's authority.
   * Row dependencies (model, Search, Tools, Knowledge, Skill links) are
   * decided by admission through the row chain, not here.
   */
  resolveForRun(userId: string, assistantId: string): Promise<AssistantRunResolution>;
};

/**
 * The native engine's self-service tools (`20261023002004103-agent-self-service`):
 * the agent knows AIQSA and changes its user's own resources from any chat,
 * without the Workspace VM. They are not part of the old core's tool
 * catalog, which is frozen; the engine registry offers them.
 *
 * - `read_aiqsa_guide` (no effects): the readable guide behind the system
 *   prompt's self-service section (`lib/server/engine/prompts/selfService.ts`).
 * - `manage_secret`, `manage_skill`, `manage_assistant` (`local` in the
 *   registry's terms: the user's own AIQSA state, through its owner, which
 *   settles the call itself, so they are never retried): each change goes
 *   through its owner's Studio path and commits with the call and its card
 *   (`selfServiceCall.ts`, `selfServiceCallStore.ts`); deleting and
 *   publishing only prepare a card the user confirms.
 *   `executeSelfServiceTool` builds their services for one call from the
 *   run's dependencies.
 *
 * Scheduled tasks and artifacts keep their own tools and cards.
 */
import type { PrismaClient } from "@prisma/client";
import type { AssistantHandlerDeps } from "../assistants/handlers";
import { createAgentAssistantService } from "../assistants/agentAssistants";
import type { PrismaAssistantRepository } from "../assistants/prismaRepository";
import type { AssistantDeletionConsequences } from "@/lib/contracts/assistantDeletion";
import type { NormalizedRunRequest } from "../providers/types";
import { createAgentSkillService, runSecretValues } from "../skills/agentSkills";
import type { StorageAdapter } from "../uploads/storage";
import { createAgentSecretService } from "../workspace/secrets/agentSecrets";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import { READ_AIQSA_GUIDE_TOOL_NAME, executeReadAiqsaGuide, readAiqsaGuideTool } from "./aiqsaGuide";
import type { HarnessToolDescriptor } from "./harnessTool";
import { MANAGE_ASSISTANT_TOOL_NAME, executeManageAssistant, manageAssistantTool } from "./manageAssistant";
import { MANAGE_SECRET_TOOL_NAME, executeManageSecret, manageSecretTool } from "./manageSecret";
import { MANAGE_SKILL_TOOL_NAME, executeManageSkill, manageSkillTool } from "./manageSkill";
import type { SelfServiceCallStore } from "./selfServiceCall";
import { skillSaveSecretNeedles } from "./skillSave";
import type { ModelToolCall, ToolExecutionResult } from "./types";

export { READ_AIQSA_GUIDE_TOOL_NAME, executeReadAiqsaGuide, readAiqsaGuideTool } from "./aiqsaGuide";
export { MANAGE_ASSISTANT_TOOL_NAME, assistantChanges, executeManageAssistant, manageAssistantTool, type ManageAssistantContext } from "./manageAssistant";
export { MANAGE_SECRET_LIMITS, MANAGE_SECRET_TOOL_NAME, executeManageSecret, manageSecretTool, secretChangeCard, secretChangedResult } from "./manageSecret";
export { MANAGE_SKILL_LIMITS, MANAGE_SKILL_TOOL_NAME, executeManageSkill, manageSkillTool, type ManageSkillContext } from "./manageSkill";
export {
  commitSelfServiceChange,
  logSelfServiceFailure,
  selfServiceRunAllowedInTransaction,
  type SelfServiceCallStore,
  type SelfServiceChange,
  type SelfServiceClaim,
  type SelfServiceCommitOutcome,
  type SelfServiceScope
} from "./selfServiceCall";
export {
  createAgentAssistantService,
  type AgentAssistant,
  type AgentAssistantCatalog,
  type AgentAssistantRefusal,
  type AgentAssistantService
} from "../assistants/agentAssistants";
export { createAgentSkillService, overlaySkillBundle, runSecretValues, type AgentSkillRefusal, type AgentSkillService } from "../skills/agentSkills";
export {
  createAgentSecretService,
  findAgentSecret,
  listAgentSecrets,
  type AgentSecretRefusal,
  type AgentSecretService,
  type AgentSecretView
} from "../workspace/secrets/agentSecrets";

/** The registry's self-service descriptors, in the order the prompt names them. */
export const SELF_SERVICE_TOOLS: readonly HarnessToolDescriptor[] = Object.freeze([readAiqsaGuideTool, manageSecretTool, manageSkillTool, manageAssistantTool]);

export const SELF_SERVICE_TOOL_NAME_SET: ReadonlySet<string> = new Set(SELF_SERVICE_TOOLS.map((tool) => tool.name));

/** What a run gives its self-service calls; the registry builds it once at admission. */
export type SelfServiceRunDeps = Readonly<{
  db: PrismaClient;
  run: Readonly<{ userId: string; runId: string; chatId: string }>;
  /** The run's frozen Skill manifest, whose aliases name the user's Skills. */
  request: Readonly<Pick<NormalizedRunRequest, "skills">>;
  /** Saved secrets the run may read: the Skill save guard and nothing else uses their values here. */
  secretSource: RunSecretSource;
  /** Conversation files the run admitted, for a secret's value from a file. */
  attachmentIds?: readonly string[];
  storage?: Pick<StorageAdapter, "getObject">;
  /** The Studio Assistant routes' dependencies (`defaultAssistantHandlerDeps`, `defaultAssistantDeletionHandlerDeps.repository`). */
  assistants: Pick<AssistantHandlerDeps, "loadCatalogData"> & Readonly<{
    repository: Pick<PrismaAssistantRepository, "getDetail" | "listForUser" | "listPublishableGroups" | "loadUserAccessibleMcpServerIds" |
      "loadUserMcpRunPlanView">;
    deletion: Readonly<{ loadConsequences(userId: string, assistantId: string): Promise<AssistantDeletionConsequences | null> }>;
  }>;
}>;

/** One self-service call: its persisted `ModelRunToolCall` id and the engine's store that claims and settles it. */
export type SelfServiceCallInput = Readonly<{ callId: string; store: SelfServiceCallStore; signal?: AbortSignal }>;

/**
 * Runs one self-service tool call with services built for that call, or
 * returns null for a tool that is not one of them.
 */
export function executeSelfServiceTool(deps: SelfServiceRunDeps, call: ModelToolCall, input: SelfServiceCallInput): Promise<ToolExecutionResult> | null {
  const scope = { ...deps.run, callId: input.callId };
  const options = { signal: input.signal };
  switch (call.name) {
    case READ_AIQSA_GUIDE_TOOL_NAME:
      return Promise.resolve(executeReadAiqsaGuide(call));
    case MANAGE_SECRET_TOOL_NAME:
      return executeManageSecret(createAgentSecretService({ attachmentIds: deps.attachmentIds, db: deps.db, scope, storage: deps.storage,
        store: input.store }), call, options);
    case MANAGE_SKILL_TOOL_NAME:
      return executeManageSkill(createAgentSkillService({ db: deps.db, scope, store: input.store,
        secretNeedles: async () => skillSaveSecretNeedles(await runSecretValues(deps.secretSource, deps.run)) }), call, deps.request, options);
    case MANAGE_ASSISTANT_TOOL_NAME:
      return executeManageAssistant(createAgentAssistantService({ db: deps.db, deletion: deps.assistants.deletion, handlers: deps.assistants, scope,
        store: input.store }), call, deps.request, options);
    default:
      return null;
  }
}

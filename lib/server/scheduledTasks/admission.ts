import type { PrismaClient } from "@prisma/client";
import { EMPTY_KNOWLEDGE_SELECTION } from "../../contracts/knowledge";
import type { SearchPlan } from "../../contracts/search";
import { reconcileModelSearchPlan } from "../../domain/catalogMatrix";
import type { AuthenticatedUser, RequestAuthResolver } from "../auth/requestAuth";
import { createSendMessageHandler, type RunHandlerDeps } from "../runs/handlers";
import type { ScheduledOccurrenceAdmission } from "../runs/runRepositoryContract";
import type { ScheduledTaskRunCatalog } from "./catalog";

/**
 * A scheduled run is admitted by the ordinary send handler, as the task owner,
 * with a body that mirrors the composer's personal send. Everything the
 * handler checks for a user's own message (catalog, entitlement, active run,
 * context) therefore applies unchanged.
 */

/** The task's usable chat takes the next turn; otherwise a new chat starts with this run. */
export type ScheduledTaskSendTarget =
  | Readonly<{ kind: "existing"; activeLeafMessageId: string | null; chatId: string }>
  | Readonly<{ kind: "new"; chatId: string }>;

/**
 * The run's Search: none when the task has it off; otherwise the owner's
 * preferred selection that the model supports, else the model's first usable
 * option. Null when Search is on but no option can be selected.
 */
export function scheduledTaskSearchPlan(input: Readonly<{
  catalog: ScheduledTaskRunCatalog;
  model: ScheduledTaskRunCatalog["models"][number];
  searchEnabled: boolean;
}>): SearchPlan | null {
  if (!input.searchEnabled) return { mode: "all_selected", optionIds: [] };
  const { model, catalog } = input;
  const preferred = reconcileModelSearchPlan(model, catalog.searchPlan.optionIds, catalog.searchPlan.mode, catalog.searchStrategies);
  if (preferred.optionIds.length > 0) return preferred;
  const concrete = new Set(catalog.searchStrategies.filter((option) => option.kind !== "none").map((option) => option.strategyId));
  const first = model.searchStrategyIds.find((optionId) => concrete.has(optionId));
  const fallback = first ? reconcileModelSearchPlan(model, [first], "all_selected", catalog.searchStrategies) : null;
  return fallback && fallback.optionIds.length > 0 ? fallback : null;
}

/**
 * The composer's personal send for the task prompt: one text block, the task's
 * model with its catalog control defaults (no saved controls or params), its
 * Search plan, the task's time zone for the date and time baseline, and with
 * tools on the owner's MCP and Skills in Auto (never Load all, which fails a
 * whole unattended run when one server is not ready) plus the task's pinned
 * Skills as the composer pins them (`skillIds`), so admission binds each at
 * its current version or refuses the run, and with Workspace on the chat's
 * Workspace. Knowledge and Agent stay off. A new chat is a personal first
 * send with Memory excluded, so daily prompts never feed Memory learning.
 */
export function scheduledTaskSendBody(input: Readonly<{
  admissionId: string;
  modelId: string;
  /** Only with tools on, as the task contract keeps them. */
  pinnedSkillIds: readonly string[];
  prompt: string;
  provider: string;
  searchPlan: SearchPlan;
  target: ScheduledTaskSendTarget;
  timeZone: string;
  toolCalling: boolean;
  toolsEnabled: boolean;
  workspaceEnabled: boolean;
}>): Record<string, unknown> {
  const tools = input.toolsEnabled ? "auto" : "off";
  return {
    admissionId: input.admissionId,
    content: { blocks: [{ text: input.prompt.trim(), type: "text" }] },
    expectedActiveLeafId: input.target.kind === "existing" ? input.target.activeLeafMessageId : null,
    knowledgePlan: EMPTY_KNOWLEDGE_SELECTION,
    mcp: { mode: tools },
    modelId: input.modelId,
    ...(input.target.kind === "new" ? { personalDraft: { folderId: null, memoryMode: "EXCLUDED" } } : {}),
    provider: input.provider,
    searchPlan: { mode: input.searchPlan.mode, optionIds: [...input.searchPlan.optionIds] },
    ...(input.toolsEnabled && input.pinnedSkillIds.length > 0 ? { skillIds: [...input.pinnedSkillIds] } : {}),
    skills: { mode: tools },

    timeZone: input.timeZone,
    // Like the composer, a model without tool calling asks for no tools at all.
    ...(input.toolCalling ? {} : { tools: "none" }),
    workspace: { enabled: input.workspaceEnabled }
  };
}

/** The task owner, while the account is active and the task exists. */
export type ScheduledTaskOwnerLoader = (input: Readonly<{ taskId: string; userId: string }>) =>
  Promise<AuthenticatedUser | null>;

export function createPrismaScheduledTaskOwnerLoader(prisma: PrismaClient): ScheduledTaskOwnerLoader {
  return async ({ taskId, userId }) => {
    const task = await prisma.scheduledTask.findFirst({
      select: { user: { select: { displayName: true, email: true, id: true, role: true, status: true } } },
      // A SCIM deactivation that waits for a Project ownership transfer already ended the
      // owner's access, standing tasks included.
      where: { id: taskId, user: { scimDeactivatedAt: null }, userId }
    });
    return task?.user ?? null;
  };
}

/** Resolves the owner again on every call, so authority lost mid-admission refuses it. */
export function scheduledTaskOwnerAuth(
  loadOwner: ScheduledTaskOwnerLoader,
  input: Readonly<{ taskId: string; userId: string }>
): RequestAuthResolver {
  return async () => {
    const user = await loadOwner(input);
    return user && user.id === input.userId && user.status === "active"
      ? { expiresAt: new Date(Date.now() + 60_000), id: "scheduled-task", user, userId: user.id }
      : null;
  };
}

export type ScheduledTaskSend = (input: Readonly<{
  body: Record<string, unknown>;
  chatId: string;
  occurrence: ScheduledOccurrenceAdmission;
  userId: string;
}>) => Promise<Response>;

/** Sends through a handler bound to the owner and, server-side only, to the occurrence. */
export function createScheduledTaskSend(deps: Readonly<{
  loadOwner: ScheduledTaskOwnerLoader;
  sendDeps: Omit<RunHandlerDeps, "resolveAuth" | "scheduledOccurrence">;
}>): ScheduledTaskSend {
  return ({ body, chatId, occurrence, userId }) => createSendMessageHandler({
    ...deps.sendDeps,
    resolveAuth: scheduledTaskOwnerAuth(deps.loadOwner, { taskId: occurrence.taskId, userId }),
    scheduledOccurrence: occurrence
  })(new Request(`http://localhost/api/chats/${encodeURIComponent(chatId)}/messages`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }), { params: { chatId } });
}

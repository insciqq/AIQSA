import type { Prisma, PrismaClient } from "@prisma/client";
import { decodeAssistantAvatarRecipe, type AssistantDraft, type AssistantPublishableGroup } from "@/lib/contracts/assistants";
import type { AssistantDeletionConsequences } from "@/lib/contracts/assistantDeletion";
import { isPrismaSerializationConflict } from "../runs/prismaRepositoryShared";
import { skillAccessWhere } from "../skills/prismaRepository";
import {
  commitSelfServiceChange,
  type SelfServiceCallStore,
  type SelfServiceChange,
  type SelfServiceCommitOutcome,
  type SelfServiceScope
} from "../tools/selfServiceCall";
import type { ToolExecutionResult } from "../tools/types";
import type { AssistantCatalogView } from "./catalogValidation";
import { assistantDraftCatalogFailure, loadAssistantCatalogView, type AssistantDraftCatalogFailure, type AssistantHandlerDeps } from "./handlers";
import {
  createAssistantInTransaction,
  updateAssistantInTransaction,
  type AssistantContentRow,
  type AssistantDetailData,
  type PrismaAssistantRepository
} from "./prismaRepository";

/**
 * The agent's access to its user's own Assistants (`manage_assistant`): the
 * Studio editor's catalog validation and the repository's create and
 * revise writes, committed with the tool call. Only Assistants the user owns
 * are read or written; any other id reads as missing. Publishing and
 * deleting are never written here: the agent proposes them and the user
 * confirms in the card through the Studio routes.
 */

/** What the user's catalog offers an Assistant: models and MCP servers by name. */
export type AgentAssistantCatalog = Readonly<{
  view: AssistantCatalogView;
  models: readonly Readonly<{ modelId: string; displayName: string }>[];
  mcpServers: readonly Readonly<{ serverId: string; name: string }>[];
}>;

/** One of the user's own Assistants as the agent reads it. */
export type AgentAssistant = Readonly<{
  assistantId: string;
  version: number;
  archived: boolean;
  /** Whom the owner published it to. */
  audience: Readonly<{ everyone: boolean; groupNames: readonly string[] }>;
  draft: AssistantDraft;
  /** Names of the linked Skills the owner can see, by id. */
  skillNames: ReadonlyMap<string, string>;
}>;

export type AgentLinkableSkill = Readonly<{ skillId: string; name: string; own: boolean }>;

export type AgentAssistantWritten = Readonly<{ assistantId: string; version: number }>;

export type AgentAssistantRefusal =
  | Readonly<{ code: "assistant_not_available" | "assistant_version_conflict" | "assistant_archived" | "assistant_skills_not_available" |
      "assistant_skill_audience_mismatch" }>
  | Readonly<{ code: "assistant_catalog"; failure: AssistantDraftCatalogFailure }>;

export type AgentAssistantService = Readonly<{
  catalog(): Promise<AgentAssistantCatalog | null>;
  list(): Promise<readonly AgentAssistant[]>;
  get(assistantId: string): Promise<AgentAssistant | null>;
  /** Skills the user may link: their own and those shared with them; the write rechecks usability. */
  linkableSkills(): Promise<readonly AgentLinkableSkill[]>;
  publishableGroups(): Promise<readonly AssistantPublishableGroup[]>;
  deletionConsequences(assistantId: string): Promise<AssistantDeletionConsequences | null>;
  /** Writes a new Assistant (version 1) and settles the call with `result` in the same transaction. */
  create(draft: AssistantDraft, view: AssistantCatalogView, result: (written: AgentAssistantWritten) => ToolExecutionResult):
    Promise<SelfServiceCommitOutcome<AgentAssistantWritten, AgentAssistantRefusal>>;
  /** Revises the user's Assistant under `expectedVersion` and settles the call in the same transaction. */
  update(assistantId: string, expectedVersion: number, draft: AssistantDraft, view: AssistantCatalogView,
    result: (written: AgentAssistantWritten) => ToolExecutionResult): Promise<SelfServiceCommitOutcome<AgentAssistantWritten, AgentAssistantRefusal>>;
}>;

/** The owner's stored content as the editor's draft, or null when it no longer decodes. */
export function assistantDraftFromContent(content: AssistantContentRow): AssistantDraft | null {
  const avatar = decodeAssistantAvatarRecipe(content.avatar);
  if (!avatar) return null;
  return {
    answerRules: content.answerRules, avatar, category: (content.category ?? null) as AssistantDraft["category"],
    description: content.description, name: content.name, responseReminder: content.responseReminder ?? "", rows: content.rows,
    starterPrompts: [...content.starterPrompts], systemPrompt: content.systemPrompt
  };
}

function agentAssistant(entry: AssistantDetailData | Awaited<ReturnType<PrismaAssistantRepository["listForUser"]>>[number]): AgentAssistant | null {
  const draft = entry.owned ? assistantDraftFromContent(entry.content) : null;
  return draft ? {
    archived: entry.archived, assistantId: entry.id, draft,
    audience: { everyone: entry.audience?.everyone ?? false, groupNames: [...entry.audience?.groupNames ?? []] },
    skillNames: new Map((entry.content.skillSummaries ?? []).map((skill) => [skill.id, skill.name])), version: entry.version
  } : null;
}

const LINKABLE_SKILLS_LIMIT = 500;

export function createAgentAssistantService(input: Readonly<{
  db: Pick<PrismaClient, "$transaction" | "skillDefinition">;
  store: SelfServiceCallStore;
  scope: SelfServiceScope;
  /** The Studio routes' own dependencies (`defaultAssistantHandlerDeps`). */
  handlers: Pick<AssistantHandlerDeps, "loadCatalogData"> & Readonly<{
    repository: Pick<PrismaAssistantRepository, "getDetail" | "listForUser" | "listPublishableGroups" | "loadUserAccessibleMcpServerIds" |
      "loadUserMcpRunPlanView">;
  }>;
  deletion: Readonly<{ loadConsequences(userId: string, assistantId: string): Promise<AssistantDeletionConsequences | null> }>;
  /** Defaults to the Studio editor's catalog (`loadAssistantCatalogView`). */
  loadCatalogView?: (userId: string) => Promise<AssistantCatalogView | null>;
  create?: typeof createAssistantInTransaction;
  update?: typeof updateAssistantInTransaction;
}>): AgentAssistantService {
  const { scope } = input;
  const userId = scope.userId;
  const create = input.create ?? createAssistantInTransaction;
  const update = input.update ?? updateAssistantInTransaction;

  /** The editor's catalog check, then the write and the call's settlement in one transaction. */
  async function write(draft: AssistantDraft, view: AssistantCatalogView,
    apply: (tx: Prisma.TransactionClient) => Promise<SelfServiceChange<AgentAssistantWritten, AgentAssistantRefusal>>):
    Promise<SelfServiceCommitOutcome<AgentAssistantWritten, AgentAssistantRefusal>> {
    const failure = assistantDraftCatalogFailure(draft, view);
    if (failure) return { kind: "refused" as const, value: { code: "assistant_catalog" as const, failure } };
    try {
      return await commitSelfServiceChange<AgentAssistantWritten, AgentAssistantRefusal>(input.db, input.store, apply);
    } catch (error) {
      if (isPrismaSerializationConflict(error)) return { kind: "refused" as const, value: { code: "assistant_version_conflict" as const } };
      throw error;
    }
  }

  return {
    async catalog() {
      const view = await (input.loadCatalogView?.(userId) ?? loadAssistantCatalogView(input.handlers, userId));
      if (!view) return null;
      return {
        mcpServers: [...view.accessibleMcpServerIds].flatMap((serverId) => {
          const name = view.mcpRunPlan.recordsByServerId.get(serverId)?.serverName;
          return name ? [{ name, serverId }] : [];
        }),
        models: [...view.modelById.values()].map((model) => ({ displayName: model.displayName, modelId: model.modelId })),
        view
      };
    },

    async list() {
      const entries = await input.handlers.repository.listForUser(userId);
      return entries.flatMap((entry) => {
        const assistant = agentAssistant(entry);
        return assistant ? [assistant] : [];
      });
    },

    async get(assistantId) {
      const detail = await input.handlers.repository.getDetail(userId, assistantId);
      return detail?.owned ? agentAssistant(detail) : null;
    },

    async linkableSkills() {
      const rows = await input.db.skillDefinition.findMany({
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        select: { currentRevision: { select: { name: true } }, id: true, ownerUserId: true, sharedRevision: { select: { name: true } } },
        take: LINKABLE_SKILLS_LIMIT,
        where: { archivedAt: null, deletedAt: null, ...skillAccessWhere(userId) }
      });
      return rows.flatMap((row) => {
        const own = row.ownerUserId === userId;
        const name = own ? row.currentRevision?.name : row.sharedRevision?.name;
        return name ? [{ name, own, skillId: row.id }] : [];
      });
    },

    publishableGroups: () => input.handlers.repository.listPublishableGroups(userId),
    deletionConsequences: (assistantId) => input.deletion.loadConsequences(userId, assistantId),

    create: (draft, view, result) => write(draft, view, async (tx) => {
      const created = await create(tx, userId, draft);
      if (created.kind !== "ok") return { kind: "refused", value: { code: "assistant_skills_not_available" } };
      const written = { assistantId: created.assistantId, version: 1 };
      return { kind: "changed", result: result(written), value: written };
    }),

    update: (assistantId, expectedVersion, draft, view, result) => write(draft, view, async (tx) => {
      const updated = await update(tx, userId, assistantId, expectedVersion, draft);
      switch (updated.kind) {
        case "ok": {
          const written = { assistantId, version: expectedVersion + 1 };
          return { kind: "changed", result: result(written), value: written };
        }
        case "not_found": return { kind: "refused", value: { code: "assistant_not_available" } };
        case "version_conflict": return { kind: "refused", value: { code: "assistant_version_conflict" } };
        case "archived": return { kind: "refused", value: { code: "assistant_archived" } };
        case "skills_not_available": return { kind: "refused", value: { code: "assistant_skills_not_available" } };
        case "skill_audience_mismatch": return { kind: "refused", value: { code: "assistant_skill_audience_mismatch" } };
      }
    })
  };
}

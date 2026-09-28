import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ASSISTANT_ROW_KEYS,
  decodeAssistantRows,
  type AssistantDecodeError,
  type AssistantRowKey,
  type AssistantRows
} from "../../contracts/assistants";
import {
  decodeStoredChatAssistantOverrides,
  storedChatAssistantOverrides,
  type ChatAssistantOverrides
} from "../../contracts/chats";
import { loadAssistantRows } from "../chats/assistantOverrides";
import {
  loadPersonalChatAssistantContext,
  resolveChatAssistantRows,
  type ChatAssistantCatalogLoader
} from "../chats/assistantProjection";
import { isPrismaSerializationConflict } from "../runs/prismaRepositoryShared";
import type { AssistantRowContextDefaults, AssistantRowResolution } from "./rowResolution";
import { storedColumnsFromAssistantRows } from "./storedContent";

/*
 * "Save chat setup to Assistant" (PRD 8.5, A-10): the rows a personal chat
 * changed for itself become the Assistant's values. Policies never change.
 * Which rows count as changed is decided exactly as the chat projection and
 * run admission decide it, so only rows the owner sees as "changed for this
 * chat" are adopted.
 */

export type AdoptChatSetupInput<Invalid> = Readonly<{
  assistantId: string;
  chatId: string;
  expectedVersion: number;
  userId: string;
  /** The ordinary save's catalog check of the rows to write; a value refuses them. */
  validate(rows: AssistantRows): Invalid | null;
}>;

export type AdoptChatSetupResult<Invalid> =
  | { kind: "adopted"; rows: AssistantRowKey[] }
  | { kind: "active_run" }
  | { kind: "archived" }
  | { invalid: Invalid; kind: "invalid" }
  | { kind: "not_found" }
  | { error: AssistantDecodeError; kind: "rows_invalid" }
  | { kind: "unchanged" }
  | { kind: "version_conflict" };

export type AdoptChatSetup = <Invalid>(input: AdoptChatSetupInput<Invalid>) => Promise<AdoptChatSetupResult<Invalid>>;

/**
 * The definition rows after adopting `adopted`, in definition vocabulary.
 * A chat's Tools mode over the user's own servers (`auto`, `load_all`) and
 * "All my knowledge" have no definition value of their own; they are adopted
 * as inherit only when the owner's Chat defaults resolve inherit to exactly
 * that value, and refused with the row's ordinary validation code otherwise.
 * Controls belong to the model: adopting either row keeps the
 * Assistant's controls only where they applied in the chat, under the chat's.
 */
export function adoptedChatSetupRows(input: Readonly<{
  adopted: readonly AssistantRowKey[];
  assistant: AssistantRows;
  defaults: Pick<AssistantRowContextDefaults, "knowledge" | "tools">;
  resolution: AssistantRowResolution;
}>): { ok: true; rows: AssistantRows } | AssistantDecodeError {
  const { adopted, assistant, defaults } = input;
  const values = input.resolution.rows;
  const next: AssistantRows = { ...assistant };
  for (const key of adopted) {
    if (key === "model") {
      next.model = { policy: assistant.model.policy, value: { mode: "model", modelId: values.model.value.modelId } };
    } else if (key === "search") {
      const search = values.search.value;
      next.search = {
        policy: assistant.search.policy,
        value: search.mode === "off" ? { mode: "off" } : { mode: search.mode, optionIds: [...search.optionIds] }
      };
    } else if (key === "tools") {
      const tools = values.tools.value;
      if (tools.mode === "exact") {
        next.tools = { policy: assistant.tools.policy, value: { mode: "exact", serverIds: [...tools.serverIds] } };
      } else if (tools.mode === "off") {
        next.tools = { policy: assistant.tools.policy, value: { mode: "off" } };
      } else if (defaults.tools.mode === tools.mode) {
        next.tools = { policy: assistant.tools.policy, value: { mode: "inherit" } };
      } else {
        return { code: "assistant_mcp_servers_invalid", ok: false, row: "tools" };
      }
    } else if (key === "knowledge") {
      const knowledge = values.knowledge.value;
      if (knowledge.mode === "explicit") {
        next.knowledge = {
          policy: assistant.knowledge.policy,
          value: { baseIds: [...knowledge.baseIds], mode: "explicit", sourceIds: [...knowledge.sourceIds] }
        };
      } else if (knowledge.mode === "none") {
        next.knowledge = { policy: assistant.knowledge.policy, value: { mode: "none" } };
      } else if (defaults.knowledge.mode === "all_my_knowledge") {
        next.knowledge = { policy: assistant.knowledge.policy, value: { mode: "inherit" } };
      } else {
        return { code: "assistant_knowledge_bases_invalid", ok: false, row: "knowledge" };
      }
    } else if (key === "skills") {
      next.skills = {
        policy: assistant.skills.policy,
        value: { links: assistant.skills.value.links.map((link) => ({ ...link })), mode: values.skills.value.mode }
      };
    }
  }
  if (adopted.includes("model") || adopted.includes("controls")) {
    const { layers } = values.controls;
    next.controls = {
      policy: assistant.controls.policy,
      value: { ...layers.assistant, ...(adopted.includes("controls") ? layers.chat?.value : {}) }
    };
  }
  return { ok: true, rows: next };
}

const activeRunStatuses = ["preparing", "streaming", "queued", "in_progress"] as const;

export function createPrismaAdoptChatSetup(
  client: PrismaClient,
  options: Readonly<{ loadCatalogData?: ChatAssistantCatalogLoader }> = {}
): AdoptChatSetup {
  return async function adoptChatSetup<Invalid>(
    input: AdoptChatSetupInput<Invalid>
  ): Promise<AdoptChatSetupResult<Invalid>> {
    const { assistantId, chatId, userId } = input;
    try {
      return await client.$transaction(async (tx): Promise<AdoptChatSetupResult<Invalid>> => {
        // The definition before the chat, the order admission and deletion take.
        const definitions = await tx.$queryRaw<Array<{ archivedAt: Date | null; version: number }>>`
          SELECT "archivedAt", "version"
          FROM "AssistantDefinition"
          WHERE "id" = ${assistantId} AND "ownerUserId" = ${userId}
          FOR UPDATE
        `;
        const definition = definitions[0];
        if (!definition) return { kind: "not_found" };
        const chats = await tx.$queryRaw<Array<{ archived: boolean; assistantId: string | null; assistantOverrides: unknown }>>`
          SELECT "archived", "assistantId", "assistantOverrides"
          FROM "Chat"
          WHERE "id" = ${chatId}
            AND "userId" = ${userId}
            AND "projectId" IS NULL
            AND "permanentDeletionAt" IS NULL
          FOR UPDATE
        `;
        const chat = chats[0];
        // Another user's chat, a Project chat and a chat bound elsewhere look alike.
        if (!chat || chat.archived || chat.assistantId !== assistantId) return { kind: "not_found" };
        if (definition.version !== input.expectedVersion) return { kind: "version_conflict" };
        if (definition.archivedAt) return { kind: "archived" };
        // Like a chat update, a change to the next run waits for the active one.
        const activeRun = await tx.modelRun.findFirst({
          select: { id: true },
          where: { chatId, status: { in: [...activeRunStatuses] } }
        });
        if (activeRun) return { kind: "active_run" };

        const decoded = decodeStoredChatAssistantOverrides(chat.assistantOverrides);
        const stored = decoded?.kind === "overrides" ? decoded.overrides : {};
        if (Object.keys(stored).length === 0) return { kind: "unchanged" };
        const rows = await loadAssistantRows(tx, assistantId);
        const context = await loadPersonalChatAssistantContext(tx, { rows, stored, userId }, options);
        if (!context) return { kind: "not_found" };
        const { resolution } = resolveChatAssistantRows({ assistant: rows, context, stored });
        const adopted = ASSISTANT_ROW_KEYS.filter((key) => resolution.rows[key].provenance === "chat");
        if (adopted.length === 0) return { kind: "unchanged" };

        const mapped = adoptedChatSetupRows({ adopted, assistant: rows, defaults: context.defaults, resolution });
        if (!mapped.ok) return { error: mapped, kind: "rows_invalid" };
        const checked = decodeAssistantRows(mapped.rows, "draft");
        if (!checked.ok) return { error: checked, kind: "rows_invalid" };
        const invalid = input.validate(checked.rows);
        if (invalid !== null) return { invalid, kind: "invalid" };

        const { skillLinks: _links, ...before } = storedColumnsFromAssistantRows(rows);
        const { skillLinks: _unchangedLinks, ...after } = storedColumnsFromAssistantRows(checked.rows);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          await tx.assistantDefinition.update({
            data: {
              ...after,
              knowledgeSelection: after.knowledgeSelection as unknown as Prisma.InputJsonValue,
              runControls: after.runControls as Prisma.InputJsonValue,
              searchPlan: after.searchPlan as Prisma.InputJsonValue,
              version: { increment: 1 }
            },
            where: { id: assistantId }
          });
        }
        // Exactly the adopted rows; an override admission ignores stays for it to clear.
        const remaining = storedChatAssistantOverrides(Object.fromEntries(
          Object.entries(stored).filter(([key]) => !adopted.includes(key as AssistantRowKey))
        ) as ChatAssistantOverrides);
        await tx.chat.update({
          data: { assistantOverrides: remaining ? remaining as Prisma.InputJsonObject : Prisma.DbNull },
          where: { id: chatId }
        });
        return { kind: "adopted", rows: adopted };
      }, { maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      if (isPrismaSerializationConflict(error)) return { kind: "version_conflict" };
      throw error;
    }
  };
}

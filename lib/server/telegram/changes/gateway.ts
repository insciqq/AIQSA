import { decodeInstructionPreset, type InstructionPreset } from "../../../contracts/instructionPresets";
import { instructionsUndoMutation } from "../../../contracts/resourceChanges";
import { decodeSkillSaveUndoState } from "../../../contracts/skillSaves";
import { decodeSubagentDefaultUndoResponse } from "../../../contracts/subagentDefinitions";
import type { TelegramChangeOperation, TelegramChangeOutcome } from "./plan";

/**
 * How a change button acts: the request the web card sends, to the same
 * Settings route handler, in this process, as the button's user. The routes
 * authenticate through the resolver they are built with (`telegramRequestAuth`:
 * the linked user while the account is active and Telegram access holds,
 * re-read on every call) and check ownership, versions and lifecycle exactly
 * as for the browser, so a button can do nothing its user could not do in
 * the web card. No parallel authorization lives here.
 */

/** The Settings route handlers a change button calls, each bound to the button user's resolver. */
export type TelegramChangeRoutes = Readonly<{
  /** `POST /api/me/workspace/secrets` */
  secrets(request: Request): Promise<Response>;
  /** `DELETE /api/me/proxies/[id]` */
  proxy(request: Request, proxyId: string): Promise<Response>;
  /** `DELETE /api/me/skills/[skillId]` */
  skill(request: Request, skillId: string): Promise<Response>;
  /** `POST /api/me/skills/[skillId]/saves/[saveId]/undo` */
  skillSaveUndo(request: Request, skillId: string, saveId: string): Promise<Response>;
  /** `PATCH` and `DELETE /api/me/assistants/[assistantId]` */
  assistant(request: Request, assistantId: string): Promise<Response>;
  /** `POST /api/me/assistants/[assistantId]/publications` */
  assistantPublication(request: Request, assistantId: string): Promise<Response>;
  /** `POST /api/me/assistants/[assistantId]/listing-requests` */
  assistantListing(request: Request, assistantId: string): Promise<Response>;
  /** `DELETE /api/me/subagents/[definitionId]` */
  subagent(request: Request, definitionId: string): Promise<Response>;
  /** `POST /api/me/subagents/[definitionId]/restore` */
  subagentRestore(request: Request, definitionId: string): Promise<Response>;
  /** `POST /api/me/subagents/default/undo` */
  subagentDefaultUndo(request: Request): Promise<Response>;
  /** `DELETE /api/me/scheduled-tasks/[taskId]` */
  scheduledTask(request: Request, taskId: string): Promise<Response>;
  /** `POST /api/me/instructions` */
  instructions(request: Request): Promise<Response>;
  /** `GET /api/me/instructions/[presetId]` */
  instructionPreset(request: Request, presetId: string): Promise<Response>;
}>;

export type TelegramChangeGateway = Readonly<{
  /** Sends one button's request as the user and reads the route's answer. */
  act(input: Readonly<{ operation: TelegramChangeOperation; userId: string }>): Promise<TelegramChangeOutcome>;
}>;

function request(path: string, method: "DELETE" | "GET" | "PATCH" | "POST", body?: unknown): Request {
  return new Request(`http://localhost${path}`, body === undefined ? { method } : {
    body: JSON.stringify(body), headers: { "content-type": "application/json" }, method
  });
}

const segment = encodeURIComponent;

async function json(response: Response): Promise<Record<string, unknown> | null> {
  const value: unknown = await response.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A refusal's stable code and, for an audience mismatch, the Skills it names. */
async function refusal(response: Response): Promise<Readonly<{ code: string | null; skills?: readonly string[] }>> {
  const body = await json(response);
  const error = body?.error;
  const code = typeof error === "string" ? error : null;
  const named = body?.skills;
  const skills = Array.isArray(named) ? named.filter((name): name is string => typeof name === "string" && name.length > 0).slice(0, 64) : [];
  return { code, ...(skills.length ? { skills } : {}) };
}

/** An ordinary route: success, a version conflict, a resource that is gone, or a failure. */
async function settled(response: Response, codes: Readonly<{ changed?: string; missing: string }>): Promise<TelegramChangeOutcome> {
  if (response.ok) return { kind: "done" };
  const { code } = await refusal(response);
  if (code !== null && code === codes.changed) return { kind: "changed" };
  if (code === codes.missing || response.status === 404) return { kind: "missing" };
  return { kind: "failed" };
}

/** The Assistant routes' answers as the web card reads them (`ResourceChangeCardV2.tsx`). */
async function assistantSettled(response: Response): Promise<TelegramChangeOutcome> {
  if (response.ok) return { kind: "done" };
  if (response.status === 404) return { kind: "missing" };
  const { code, skills } = await refusal(response);
  if (code === "assistant_version_conflict") return { kind: "changed" };
  if (code === "assistant_archived") return { kind: "archived" };
  return code && response.status >= 400 && response.status < 500 && response.status !== 401
    ? { code, kind: "refused", ...(skills ? { skills } : {}) } : { kind: "failed" };
}

const SUBAGENT = { changed: "subagent_definition_conflict", missing: "subagent_not_found" } as const;
const INSTRUCTIONS = { changed: "instruction_preset_conflict", missing: "instruction_preset_not_found" } as const;

export function createTelegramChangeGateway(routes: (userId: string) => TelegramChangeRoutes): TelegramChangeGateway {
  return Object.freeze({
    async act({ operation, userId }) {
      const route = routes(userId);
      switch (operation.kind) {
        case "secret_delete":
          return settled(await route.secrets(request("/api/me/workspace/secrets", "POST",
            { action: "delete", expectedVersionId: operation.versionId, id: operation.secretId })),
          { changed: "workspace_secret_conflict", missing: "workspace_secret_not_found" });
        case "proxy_delete":
          return settled(await route.proxy(request(`/api/me/proxies/${segment(operation.proxyId)}`, "DELETE",
            { expectedVersion: operation.expectedVersion }), operation.proxyId), { changed: "proxy_conflict", missing: "proxy_not_found" });
        case "skill_delete":
          return settled(await route.skill(request(`/api/me/skills/${segment(operation.skillId)}`, "DELETE",
            { expectedVersion: operation.expectedVersion }), operation.skillId), { changed: "skill_version_conflict", missing: "skill_not_available" });
        case "skill_save_undo": {
          const response = await route.skillSaveUndo(request(
            `/api/me/skills/${segment(operation.skillId)}/saves/${segment(operation.saveId)}/undo`, "POST"), operation.skillId, operation.saveId);
          if (!response.ok) return response.status === 404 ? { kind: "missing" } : { kind: "failed" };
          const state = decodeSkillSaveUndoState(await json(response));
          if (state?.state === "undone") return { kind: "skill_save_undone", outcome: state.outcome, revision: state.revision };
          return state?.state === "conflict" ? { kind: "changed" } : state?.state === "unavailable" ? { kind: "missing" } : { kind: "failed" };
        }
        case "assistant_archive":
          return assistantSettled(await route.assistant(request(`/api/me/assistants/${segment(operation.assistantId)}`, "PATCH",
            { archived: true, expectedVersion: operation.expectedVersion }), operation.assistantId));
        case "assistant_delete":
          return assistantSettled(await route.assistant(request(`/api/me/assistants/${segment(operation.assistantId)}`, "DELETE",
            { expectedVersion: operation.expectedVersion }), operation.assistantId));
        case "assistant_publish":
          return assistantSettled(await route.assistantPublication(request(`/api/me/assistants/${segment(operation.assistantId)}/publications`, "POST",
            { expectedVersion: operation.expectedVersion, groupId: operation.groupId, scope: "group" }), operation.assistantId));
        case "assistant_listing":
          return assistantSettled(await route.assistantListing(request(`/api/me/assistants/${segment(operation.assistantId)}/listing-requests`, "POST",
            { expectedVersion: operation.expectedVersion }), operation.assistantId));
        case "subagent_delete":
          return settled(await route.subagent(request(`/api/me/subagents/${segment(operation.definitionId)}`, "DELETE",
            { expectedVersion: operation.expectedVersion }), operation.definitionId), SUBAGENT);
        case "subagent_restore":
          return settled(await route.subagentRestore(request(`/api/me/subagents/${segment(operation.definitionId)}/restore`, "POST",
            { expectedVersion: operation.expectedVersion, revisionId: operation.revisionId }), operation.definitionId), SUBAGENT);
        case "subagent_default_undo": {
          const response = await route.subagentDefaultUndo(request("/api/me/subagents/default/undo", "POST", operation.request));
          if (!response.ok) return settled(response, SUBAGENT);
          const decoded = decodeSubagentDefaultUndoResponse(await json(response));
          return decoded ? { kind: "default_undone", outcome: decoded.outcome } : { kind: "failed" };
        }
        case "scheduled_task_delete":
          return settled(await route.scheduledTask(request(`/api/me/scheduled-tasks/${segment(operation.taskId)}`, "DELETE"), operation.taskId),
            { missing: "scheduled_task_not_found" });
        case "instructions_undo": {
          // An update's Undo writes the earlier text over the preset as its route reads it now; the revision guards both steps.
          const card = operation.card;
          let current: InstructionPreset | null = null;
          if (card.action === "updated") {
            const read = await route.instructionPreset(request(`/api/me/instructions/${segment(card.presetId)}`, "GET"), card.presetId);
            if (!read.ok) return settled(read, INSTRUCTIONS);
            current = decodeInstructionPreset((await json(read))?.preset);
            if (!current) return { kind: "failed" };
          }
          const mutation = instructionsUndoMutation(card, current);
          if (!mutation) return { kind: "changed" };
          return settled(await route.instructions(request("/api/me/instructions", "POST", mutation)), INSTRUCTIONS);
        }
      }
    }
  } satisfies TelegramChangeGateway);
}

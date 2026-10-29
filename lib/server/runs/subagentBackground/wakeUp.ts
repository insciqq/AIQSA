import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedSession, RequestAuthResolver } from "../../auth/requestAuth";
import { logEvent } from "../../observability";
import { branchPathMessageIds } from "../../toolObservations/repository";
import type { SubagentWakeUpAdmitter, SubagentWakeUpOutcome } from "./callbacks";

/**
 * The wake-up turn: when no main-agent answer runs, the server admits one
 * turn as the chat's owner through the ordinary send handler (like a
 * scheduled occurrence), so the current catalog, entitlements, usage limits
 * and active-run rules apply unchanged. Its user message is the server's
 * (`systemTurnKind: subagent_callback`), never the user's speech, and its
 * admission claims the callbacks it renders in the same transaction.
 * The send mirrors the branch's latest main-agent turn: its model, Search
 * sources, tools, Skills and Workspace switch; an Assistant chat takes only
 * what the Assistant leaves to the chat.
 */

export type SubagentWakeUpSend = (input: Readonly<{
  body: Record<string, unknown>;
  chatId: string;
  resolveAuth: RequestAuthResolver;
  wakeUp: Readonly<{ text: string; turnIds: readonly string[] }>;
}>) => Promise<Response>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The send body of a wake-up: the branch's latest main-agent turn's choices, as the composer would send them. */
export function wakeUpSendBody(input: Readonly<{
  activeLeafMessageId: string | null;
  answerBinding: Readonly<{ connectionId: string; providerModelId: string }> | null;
  assistantChat: boolean;
  normalizedRequest: unknown;
}>): Record<string, unknown> {
  const request = record(input.normalizedRequest) ? input.normalizedRequest : {};
  const prompt = record(request.prompt) ? request.prompt : {};
  const baseline = record(prompt.baseline) ? prompt.baseline : null;
  const timeZone = baseline?.timeZoneSource === "client" && typeof baseline.timeZone === "string" ? baseline.timeZone : null;
  const workspace = record(request.workspace) && request.workspace.enabled === true;
  const common: Record<string, unknown> = {
    admissionId: randomUUID(),
    content: { blocks: [] },
    expectedActiveLeafId: input.activeLeafMessageId,
    ...(timeZone ? { timeZone } : {}),
    workspace: { enabled: workspace }
  };
  if (input.assistantChat) return common;
  const searchPlan = record(request.searchPlan) ? request.searchPlan : {};
  const options = Array.isArray(searchPlan.options) ? searchPlan.options : [];
  const skills = record(request.skills) && request.skills.mode === "off" ? "off" : "auto";
  const mcp = request.mcp !== undefined || request.mcpDiscovery !== undefined ? "auto" : "off";
  return {
    ...common,
    mcp: { mode: mcp },
    ...(input.answerBinding ? { modelId: input.answerBinding.providerModelId, provider: input.answerBinding.connectionId } : {}),
    ...(record(request.params) ? { params: request.params } : {}),
    searchPlan: {
      mode: typeof searchPlan.mode === "string" ? searchPlan.mode : "all_selected",
      optionIds: options.flatMap((option) => record(option) && typeof option.optionId === "string" ? [option.optionId] : [])
    },
    skills: { mode: skills }
  };
}

/** The chat's owner while the account is active (SCIM deactivation included), checked again on every call. */
export function subagentOwnerAuth(client: Pick<PrismaClient, "user">, userId: string): RequestAuthResolver {
  return async (): Promise<AuthenticatedSession | null> => {
    const user = await client.user.findFirst({ select: { displayName: true, email: true, id: true, role: true, status: true },
      where: { id: userId, scimDeactivatedAt: null, status: "active" } });
    return user ? { expiresAt: new Date(Date.now() + 60_000), id: "subagent-callback", user, userId: user.id } : null;
  };
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<void> {
  const reader = body?.getReader();
  if (!reader) return;
  try {
    while (!(await reader.read()).done) { /* The run executor persists everything; this stream stays private. */ }
  } finally {
    reader.releaseLock();
  }
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    return record(body) && typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/** How a refused send reads for the callbacks: only a 409 the next attempt can resolve is retried. */
export function wakeUpOutcomeOf(status: number, code: string | null): SubagentWakeUpOutcome {
  if (status === 429) return "usage_limited";
  if (status === 409 && code === "active_run_in_progress") return "busy";
  if (status === 409 && (code === "active_leaf_changed" || code === "subagent_callback_claimed")) return "stale";
  return "failed";
}

export function createSubagentWakeUpAdmitter(deps: Readonly<{
  client: Pick<PrismaClient, "$transaction" | "chat" | "modelRun" | "user">;
  send: SubagentWakeUpSend;
}>): SubagentWakeUpAdmitter {
  return async ({ chatId, text, turnIds, userId }) => {
    const base = await deps.client.$transaction(async (tx) => {
      const chat = await tx.chat.findFirst({ select: { activeLeafMessageId: true, assistantId: true },
        where: { archived: false, id: chatId, permanentDeletionAt: null, userId } });
      if (!chat?.activeLeafMessageId) return null;
      const path = await branchPathMessageIds(tx, chatId, chat.activeLeafMessageId);
      const run = await tx.modelRun.findFirst({ orderBy: { createdAt: "desc" },
        select: { normalizedRequest: true, providerRunBindings: { select: { connectionId: true, providerModelId: true },
          where: { role: "answer" } } },
        where: { assistantMessageId: { in: [...path] }, chatId, subagentTurnId: null, userId } });
      return { chat, run };
    });
    if (!base) return "failed";
    const binding = base.run?.providerRunBindings[0];
    const body = wakeUpSendBody({ activeLeafMessageId: base.chat.activeLeafMessageId,
      answerBinding: binding?.providerModelId && binding.connectionId
        ? { connectionId: binding.connectionId, providerModelId: binding.providerModelId } : null,
      assistantChat: base.chat.assistantId !== null, normalizedRequest: base.run?.normalizedRequest ?? null });
    const response = await deps.send({ body, chatId, resolveAuth: subagentOwnerAuth(deps.client, userId), wakeUp: { text, turnIds } });
    if (response.ok) {
      // The run executes on its own; its stream stays private.
      void drain(response.body).catch(() => undefined);
      return "admitted";
    }
    const code = await errorCode(response);
    const outcome = wakeUpOutcomeOf(response.status, code);
    if (outcome === "failed") {
      logEvent("run_recovery", { code: code && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : "subagent_wake_up_refused",
        httpStatus: response.status, outcome: "failed", stage: "dispatch", subsystem: "run_recovery" });
    }
    return outcome;
  };
}

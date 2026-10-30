import type { PrismaClient } from "@prisma/client";
import type { AcceptedMcpGuardPlan } from "../providerRuntime/mcpGuardPlan";
import type { ProviderConversationMessage } from "../providers/types";
import type { RegenerationFollowups } from "../runs/runFollowups";
import { verifiedFollowups } from "../runs/followupProvenance";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { MCP_GUARD_LIMITS } from "./guardPrompt";

export type McpGuardReference = Readonly<{ kind: "message"; id: string } | { kind: "followup"; id: string; answerId: string }>;
type GuardBinding = Readonly<{ approvedBy?: string; plan: AcceptedMcpGuardPlan }>;
/** Already-admitted legacy runs keep working; new admissions never copy message text. */
export type McpGuardAdmission = GuardBinding & Readonly<
  | { version?: never; userMessages: readonly string[] | null; messages?: never; currentMessageId?: never; unavailable?: never }
  | { version: 2; messages: readonly McpGuardReference[]; currentMessageId?: string; unavailable?: true; userMessages?: never }
>;
export type GuardAuthorityInput = Readonly<{ chatId: string; userId: string; messages: readonly ProviderConversationMessage[];
  currentMessageId?: string; inheritedFollowups?: RegenerationFollowups }>;

/** Keep the newest reference window, including inherited corrections before the original question. */
export async function freezeGuardAuthority(db: PrismaClient, input: GuardAuthorityInput,
  plan: AcceptedMcpGuardPlan): Promise<McpGuardAdmission> {
  const branch = input.messages.filter(message => message.role === "user" && !message.purpose && message.id !== "current-user-message").reverse().slice(0, MCP_GUARD_LIMITS.messages);
  const stored = branch.filter(message => !message.followupOf).map(message => message.id);
  const own = await db.message.findMany({ where: { id: { in: stored }, chatId: input.chatId,
    OR: [{ authorUserId: input.userId }, { authorUserId: null, chat: { userId: input.userId, importSource: null } }],
    role: "user", scheduledTaskPrompt: false, systemTurnKind: null, answerReviewSessionId: null }, select: { id: true } });
  const ids = new Set(own.map(message => message.id));
  const inherited = input.inheritedFollowups;
  const candidates: McpGuardReference[] = [
    ...(inherited ? [...inherited.entries].reverse().map(entry => ({ kind: "followup" as const, id: entry.id, answerId: inherited.messageId })) : []),
    ...(input.currentMessageId ? [{ kind: "message" as const, id: input.currentMessageId }] : []),
    ...branch.flatMap((message): McpGuardReference[] => message.followupOf
      ? [{ kind: "followup", id: message.id, answerId: message.followupOf.answerId }]
      : ids.has(message.id) ? [{ kind: "message", id: message.id }] : [])
  ];
  const unique = new Map<string, McpGuardReference>();
  for (const ref of candidates) if (!unique.has(`${ref.kind}:${ref.id}`)) unique.set(`${ref.kind}:${ref.id}`, ref);
  return { version: 2, plan, messages: [...unique.values()].slice(0, MCP_GUARD_LIMITS.messages),
    ...(input.currentMessageId ? { currentMessageId: input.currentMessageId } : {}) };
}

export type GuardAuthority = Readonly<{ ok: true; messages: readonly string[] } | { ok: false; code: "unavailable" | "too_long" }>;
/** Whole newest messages only: stop at the first one that does not fit, never skip past a correction. */
export function guardAuthorityWindow(entries: readonly (string | null)[]): GuardAuthority {
  const messages: string[] = [];
  for (const text of entries) {
    if (messages.length >= MCP_GUARD_LIMITS.messages) break;
    if (text === null) return { ok: false, code: "unavailable" };
    if (Buffer.byteLength(JSON.stringify([...messages, text])) > MCP_GUARD_LIMITS.authorityBytes) {
      return messages.length ? { ok: true, messages } : { ok: false, code: "too_long" };
    }
    messages.push(text);
  }
  return { ok: true, messages };
}

export async function readGuardAuthority(db: PrismaClient, input: Readonly<{
  admission: McpGuardAdmission; runId: string; userId: string;
}>): Promise<GuardAuthority> {
  const scope = await db.modelRun.findFirst({ where: { id: input.runId, userId: input.userId,
    chat: { userId: input.userId, permanentDeletionAt: null } }, select: { chatId: true, userMessageId: true } });
  if (!scope) return { ok: false, code: "unavailable" };
  // The user's own live corrections only: a sub-agent's callback or the main agent's message to a sub-agent is the
  // server's, neither authority nor a reason to doubt it. A user row without its author still makes it unavailable.
  const live = await db.runFollowup.findMany({ where: { modelRunId: input.runId, deliveredAt: { not: null }, origin: "user" },
    orderBy: { ordinal: "desc" }, take: MCP_GUARD_LIMITS.messages, select: { text: true, authorUserId: true } });
  const newest = live.map(row => row.authorUserId === input.userId ? row.text : null);
  const admission = input.admission;
  if (admission.version !== 2) return admission.userMessages === null ? { ok: false, code: "unavailable" }
    : guardAuthorityWindow([...newest, ...admission.userMessages]);
  if (admission.unavailable) return { ok: false, code: "unavailable" };
  const references = admission.messages;
  const currentId = admission.currentMessageId === scope.userMessageId ? admission.currentMessageId : undefined;
  if (admission.currentMessageId && !currentId) return { ok: false, code: "unavailable" };
  const [messages, followups] = await Promise.all([
    db.message.findMany({ where: { id: { in: references.filter(ref => ref.kind === "message").map(ref => ref.id) }, chatId: scope.chatId,
      OR: [{ authorUserId: input.userId }, { authorUserId: null, chat: { userId: input.userId, importSource: null } },
        ...(currentId ? [{ id: currentId }] : [])],
      role: "user", scheduledTaskPrompt: false, systemTurnKind: null, answerReviewSessionId: null }, select: { id: true, content: true } }),
    verifiedFollowups(db, { chatId: scope.chatId, userId: input.userId,
      references: references.filter((ref): ref is Extract<McpGuardReference, { kind: "followup" }> => ref.kind === "followup") })
  ]);
  const text = new Map(messages.map(row => [row.id, textFromContentBlocks(row.content as { blocks?: unknown[] })]));
  return guardAuthorityWindow([...newest, ...references.map(ref => ref.kind === "message" ? text.get(ref.id) ?? null
    : followups.get(`${ref.answerId}:${ref.id}`)?.text ?? null)]);
}

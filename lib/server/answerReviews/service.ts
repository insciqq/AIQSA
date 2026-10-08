import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ANSWER_REVIEW_MAX_REVIEWERS,
  type AnswerReviewRefusal
} from "../../contracts/answerReviews";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import { resolveChatAccess } from "../projects/access";
import type { RunPreparationDeps } from "../runs/runPreparation";
import {
  decodeAnswerReviewModelRef,
  decodeAnswerReviewSessionRow,
  type AnswerReviewModelRef,
  type AnswerReviewSessionRecord
} from "./repository";

export type AnswerReviewServiceDeps = Readonly<{
  prisma: PrismaClient;
  providerAdmission: NonNullable<RunPreparationDeps["providerAdmission"]>;
}>;

export type AnswerReviewRoundRefusal = AnswerReviewRefusal | "active_leaf_changed";

export type AnswerReviewRoundResult =
  | Readonly<{ ok: true; session: AnswerReviewSessionRecord }>
  | Readonly<{ code: AnswerReviewRoundRefusal; ok: false; status: 400 | 404 | 409 }>;

const refused = (code: AnswerReviewRoundRefusal, status: 400 | 404 | 409 = 409): AnswerReviewRoundResult =>
  ({ code, ok: false, status });

const ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** The reviewers a request names: one or two distinct catalog identities. */
export function decodeAnswerReviewReviewerRequest(value: unknown): Array<Readonly<{ modelId: string; provider: string }>> | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > ANSWER_REVIEW_MAX_REVIEWERS) return null;
  const reviewers: Array<Readonly<{ modelId: string; provider: string }>> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => key !== "modelId" && key !== "provider") ||
      typeof candidate.modelId !== "string" || !ID.test(candidate.modelId) ||
      typeof candidate.provider !== "string" || !ID.test(candidate.provider) ||
      reviewers.some((reviewer) => reviewer.modelId === candidate.modelId && reviewer.provider === candidate.provider)) return null;
    reviewers.push({ modelId: candidate.modelId, provider: candidate.provider });
  }
  return reviewers;
}

/**
 * The model as the user may run it now, with its display snapshot: admitted
 * through the same provider admission a send uses (entitlement, credentials,
 * Project scope), so a name never reaches the session for a model the user
 * cannot use. Null when it is unavailable or cannot call tools.
 */
async function admittedToolModel(
  deps: AnswerReviewServiceDeps,
  model: Readonly<{ modelId: string; provider: string }>,
  scope: Readonly<{ projectId: string | null; userId: string }>
): Promise<AnswerReviewModelRef | null> {
  try {
    const plan = await deps.providerAdmission.load({
      ...(scope.projectId ? { executionScope: "project" as const } : {}),
      providerConnectionId: model.provider,
      providerModelId: model.modelId,
      searchPlan: { mode: "all_selected", optionIds: [] },
      userId: scope.userId
    });
    if (plan.answer.modelConfiguration.capabilities.toolCalling !== true) return null;
    return decodeAnswerReviewModelRef({
      modelId: model.modelId,
      name: Array.from(plan.answer.snapshot.modelDisplayName.trim() || "Model").slice(0, 160).join(""),
      provider: model.provider
    });
  } catch (error) {
    if (error instanceof ProviderAdmissionError || (error instanceof Error && error.name === "ProviderAdmissionError")) return null;
    throw error;
  }
}

const sessionSelect = {
  authorModel: true, chatId: true, id: true, maxRounds: true, mode: true, reviewers: true, round: true,
  sourceAssistantMessageId: true, state: true, stopReason: true, userId: true
} satisfies Prisma.AnswerReviewSessionSelect;

type Target = Readonly<{
  /** The session the answer is the latest version of, when it has one. */
  session: AnswerReviewSessionRecord | null;
  sourceId: string;
}>;

/**
 * Which session a "Review…" on `answerMessageId` continues: the session whose
 * latest version it is (a further round), or none (a new session on it). The
 * answer must be the chat's latest answer: the active leaf itself, or the
 * latest version of a session whose last message is the active leaf.
 */
async function reviewTarget(
  db: Pick<Prisma.TransactionClient, "answerReviewSession" | "message">,
  input: Readonly<{ activeLeafMessageId: string | null; answerMessageId: string; chatId: string }>
): Promise<Target | AnswerReviewRoundRefusal> {
  const answer = await db.message.findFirst({
    select: { answerReviewSessionId: true, id: true, parentMessageId: true, role: true, status: true },
    where: { chatId: input.chatId, id: input.answerMessageId }
  });
  if (!answer || answer.role !== "assistant" || answer.status !== "complete") return "answer_review_not_latest";
  const row = await db.answerReviewSession.findFirst({
    select: sessionSelect,
    where: answer.answerReviewSessionId
      ? { chatId: input.chatId, id: answer.answerReviewSessionId }
      : { chatId: input.chatId, sourceAssistantMessageId: answer.id }
  });
  if (!row) {
    return answer.id === input.activeLeafMessageId ? { session: null, sourceId: answer.id } : "answer_review_not_latest";
  }
  const session = decodeAnswerReviewSessionRow(row);
  if (!session) return "answer_review_unavailable";
  // The group's latest version and the chain's last message, from the session's turns.
  const members = await db.message.findMany({
    orderBy: [{ answerReviewRound: "asc" }, { answerReviewStep: "asc" }],
    select: { answerReviewRound: true, answerReviewStep: true, children: {
      orderBy: { createdAt: "desc" }, select: { id: true, status: true }, take: 1,
      where: { answerReviewSessionId: session.id, role: "assistant" } }, id: true, systemTurnKind: true },
    take: 400,
    where: { answerReviewSessionId: session.id, chatId: input.chatId, role: "user" }
  });
  const last = members.at(-1);
  const lastMessageId = last ? last.children[0]?.id ?? last.id : session.sourceAssistantMessageId;
  const latestVersion = members.filter((turn) => turn.systemTurnKind === "answer_revision_request" &&
    turn.children[0]?.status === "complete").at(-1)?.children[0]?.id ?? session.sourceAssistantMessageId;
  if (lastMessageId !== input.activeLeafMessageId || latestVersion !== answer.id) return "answer_review_not_latest";
  return { session, sourceId: session.sourceAssistantMessageId };
}

/**
 * Starts a review round on the chat's latest answer for its initiator: a new
 * manual session on an answer, or a further round of the session whose latest
 * version the answer is (with the reviewers chosen now). Nothing runs here:
 * the round's first step starts through `startAnswerReviewStep`.
 */
export async function startAnswerReviewRound(
  deps: AnswerReviewServiceDeps,
  input: Readonly<{
    answerMessageId: string;
    chatId: string;
    expectedActiveLeafId: string;
    reviewers: readonly Readonly<{ modelId: string; provider: string }>[];
    userId: string;
  }>
): Promise<AnswerReviewRoundResult> {
  const access = await resolveChatAccess(deps.prisma, {
    chatId: input.chatId, minimumProjectRole: "CONTRIBUTOR", requireMutable: true, userId: input.userId
  });
  if (!access) return refused("answer_review_unavailable", 404);
  const chat = await deps.prisma.chat.findFirst({
    select: { activeLeafMessageId: true, assistantId: true, projectId: true },
    where: { archived: false, id: input.chatId, permanentDeletionAt: null }
  });
  if (!chat) return refused("answer_review_unavailable", 404);
  // The Assistant fixes the model a chat answers with (v1).
  if (chat.assistantId) return refused("answer_review_assistant_unsupported");
  if (chat.activeLeafMessageId !== input.expectedActiveLeafId) return refused("active_leaf_changed");
  const target = await reviewTarget(deps.prisma, { activeLeafMessageId: chat.activeLeafMessageId,
    answerMessageId: input.answerMessageId, chatId: input.chatId });
  if (typeof target === "string") return refused(target);
  const scope = { projectId: chat.projectId, userId: input.userId };

  let author: AnswerReviewModelRef | null = target.session?.authorModel ?? null;
  if (!target.session) {
    const sourceRun = await deps.prisma.modelRun.findFirst({
      orderBy: { createdAt: "desc" },
      select: {
        _count: { select: { knowledgeRunBindings: true } },
        normalizedRequest: true,
        providerRunBindings: { select: { connectionId: true, executionSnapshot: true, providerModelId: true },
          where: { bindingKey: "answer" } },
        workspaceProducedAttachments: { select: { id: true }, take: 1, where: { origin: "IMAGE_OUTPUT" } }
      },
      where: { assistantMessageId: target.sourceId, chatId: input.chatId }
    });
    const request = sourceRun?.normalizedRequest;
    const knowledgePlan = typeof request === "object" && request !== null && !Array.isArray(request)
      ? (request as Record<string, unknown>).knowledgePlan : undefined;
    // Knowledge answers stay bound to their Sources; image answers are not text to revise.
    if ((sourceRun?._count.knowledgeRunBindings ?? 0) > 0 ||
      (typeof knowledgePlan === "object" && knowledgePlan !== null && (knowledgePlan as Record<string, unknown>).mode !== "none")) {
      return refused("answer_review_knowledge_unsupported");
    }
    if ((sourceRun?.workspaceProducedAttachments.length ?? 0) > 0) return refused("answer_review_image_unsupported");
    const binding = sourceRun?.providerRunBindings[0];
    if (!binding?.connectionId || !binding.providerModelId) return refused("answer_review_model_unsupported");
    author = await admittedToolModel(deps, { modelId: binding.providerModelId, provider: binding.connectionId }, scope);
    if (!author) return refused("answer_review_model_unsupported");
  }
  if (!author) return refused("answer_review_model_unsupported");
  const authorRef = author;
  // An independent model reviews: never the author's own.
  if (input.reviewers.some((reviewer) => reviewer.provider === authorRef.provider && reviewer.modelId === authorRef.modelId)) {
    return refused("answer_review_reviewer_unavailable");
  }
  if (chat.projectId) {
    const project = await deps.prisma.project.findUnique({
      select: { modelBindings: { select: { providerModelId: true } } }, where: { id: chat.projectId }
    });
    const allowed = new Set(project?.modelBindings.map((binding) => binding.providerModelId) ?? []);
    if (input.reviewers.some((reviewer) => !allowed.has(reviewer.modelId))) return refused("answer_review_reviewer_unavailable");
  }
  const reviewers: AnswerReviewModelRef[] = [];
  for (const reviewer of input.reviewers) {
    const admitted = await admittedToolModel(deps, reviewer, scope);
    if (!admitted) return refused("answer_review_reviewer_unavailable");
    reviewers.push(admitted);
  }

  return deps.prisma.$transaction(async (tx) => {
    // The chat row orders this against every run admission of the chat.
    const locked = await tx.$queryRaw<Array<{ activeLeafMessageId: string | null }>>(Prisma.sql`
      SELECT "activeLeafMessageId" FROM "Chat"
      WHERE "id" = ${input.chatId} AND "archived" = false AND "permanentDeletionAt" IS NULL
      FOR UPDATE
    `);
    if (!locked[0]) return refused("answer_review_unavailable", 404);
    if (locked[0].activeLeafMessageId !== input.expectedActiveLeafId) return refused("active_leaf_changed");
    const current = await reviewTarget(tx, { activeLeafMessageId: locked[0].activeLeafMessageId,
      answerMessageId: input.answerMessageId, chatId: input.chatId });
    if (typeof current === "string") return refused(current);
    if (current.session) {
      if (current.session.userId !== input.userId) return refused("answer_review_unavailable", 404);
      const stepsThisRound = await tx.message.count({ where: { answerReviewRound: current.session.round,
        answerReviewSessionId: current.session.id, chatId: input.chatId, role: "user" } });
      const row = await tx.answerReviewSession.update({
        data: {
          reviewers: reviewers as unknown as Prisma.InputJsonValue,
          round: stepsThisRound > 0 ? current.session.round + 1 : current.session.round,
          state: "running",
          stopReason: null
        },
        select: sessionSelect,
        where: { id: current.session.id }
      });
      const session = decodeAnswerReviewSessionRow(row);
      return session ? { ok: true as const, session } : refused("answer_review_unavailable", 404);
    }
    const row = await tx.answerReviewSession.create({
      data: {
        authorModel: authorRef as unknown as Prisma.InputJsonValue,
        chatId: input.chatId,
        mode: "manual",
        reviewers: reviewers as unknown as Prisma.InputJsonValue,
        sourceAssistantMessageId: current.sourceId,
        userId: input.userId
      },
      select: sessionSelect
    });
    const session = decodeAnswerReviewSessionRow(row);
    return session ? { ok: true as const, session } : refused("answer_review_unavailable", 404);
  });
}

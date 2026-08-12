import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import type { NormalizedRunRequest } from "../../providers/types";
import {
  MEMORY_MUTATION_AUTHORIZATION_TTL_MS,
  createPrismaMemoryMutationAuthorizationRepository,
  memoryMutationNonceHash,
  memoryTargetAuthorizationPayloadHash,
  type MemoryMutationAuthorizationSnapshot
} from "../persistence/authorizations";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
import type { MemoryActionPlan } from "./intent";

export class MemoryRunActionAuthorizationError extends Error {
  constructor(readonly code: "memory_intent_confirmation_required" | "memory_secret_rejected") {
    super(code);
    this.name = "MemoryRunActionAuthorizationError";
  }
}

function directSpan(
  request: NormalizedRunRequest,
  plan: Exclude<MemoryActionPlan, { kind: "LIST" }>
): string {
  const text = textFromContentBlocks(request.content);
  const span = text.slice(plan.sourceStart, plan.sourceEnd);
  const exactTarget = plan.kind === "SAVE" ? null : plan.targetQuery;
  if (
    !span.trim() ||
    (exactTarget !== null && span !== exactTarget)
  ) {
    throw new MemoryRunActionAuthorizationError("memory_intent_confirmation_required");
  }
  return span;
}

async function exactTarget(
  client: PrismaClient,
  userId: string,
  query: string,
  sourceMode: "AUTOMATIC" | "EXPLICIT"
): Promise<Readonly<{ factId: string; versionId: string }>> {
  const result = await createPrismaExplicitMemoryRepository(client).search(userId, {
    pageSize: 2,
    query,
    scope: { type: "GLOBAL_USER" },
    sourceMode,
    state: "ACTIVE"
  });
  const matches = result.memories.filter((memory) =>
    memory.factState === "ACTIVE" &&
    memory.sourceMode === sourceMode &&
    memory.currentVersionId !== null
  );
  const target = matches[0];
  if (matches.length !== 1 || !target?.currentVersionId) {
    throw new MemoryRunActionAuthorizationError("memory_intent_confirmation_required");
  }
  return { factId: target.id, versionId: target.currentVersionId };
}

/** Mints one short-lived authorization owned by the admitted run and bounded
 * direct-user source span. Targeted mutations remain exact; SAVE may persist a
 * faithful tool-produced paraphrase. The model-visible tool never receives its ID. */
export async function authorizeRunMemoryAction(
  client: PrismaClient,
  input: Readonly<{
    admissionKind: "NORMAL_SEND" | "REGENERATE";
    chatId: string;
    modelRunId: string;
    normalizedRequest: NormalizedRunRequest;
    plan: MemoryActionPlan;
    sourceMessageId: string;
    userId: string;
  }>
): Promise<MemoryMutationAuthorizationSnapshot | null> {
  if (input.plan.kind === "LIST") return null;
  if (input.admissionKind !== "NORMAL_SEND") {
    throw new MemoryRunActionAuthorizationError("memory_intent_confirmation_required");
  }
  directSpan(input.normalizedRequest, input.plan);
  if (input.plan.kind === "SAVE" &&
    memoryExplicitStatementContainsSecret(input.plan.statement)) {
    throw new MemoryRunActionAuthorizationError("memory_secret_rejected");
  }

  const action = input.plan.kind === "SAVE"
    ? "SAVE" as const
    : input.plan.kind === "UPDATE" || input.plan.kind === "MARK_INCORRECT"
      ? "EDIT" as const
      : "FORGET" as const;
  const target = input.plan.kind === "SAVE"
    ? null
    : await exactTarget(
        client,
        input.userId,
        input.plan.targetQuery,
        input.plan.kind === "MARK_INCORRECT" ? "AUTOMATIC" : "EXPLICIT"
      );
  const authorizedPayloadHash = input.plan.kind === "SAVE"
    ? memorySha256(input.plan.statement)
    : memoryTargetAuthorizationPayloadHash({
        action: input.plan.kind === "UPDATE" || input.plan.kind === "MARK_INCORRECT"
          ? "EDIT"
          : "FORGET",
        expectedTargetVersionId: target!.versionId,
        targetFactId: target!.factId
      });
  const now = new Date();
  return createPrismaMemoryMutationAuthorizationRepository(client).mint(input.userId, {
    action,
    authorizedPayloadHash,
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    exactSourceEnd: input.plan.sourceEnd,
    exactSourceStart: input.plan.sourceStart,
    expectedTargetVersionId: target?.versionId,
    expiresAt: new Date(now.getTime() + MEMORY_MUTATION_AUTHORIZATION_TTL_MS),
    modelRunId: input.modelRunId,
    nonceHash: memoryMutationNonceHash(
      input.userId,
      `run:${input.modelRunId}:${action}`
    ),
    requestId: randomUUID(),
    sourceChatId: input.chatId,
    sourceMessageId: input.sourceMessageId,
    targetFactId: target?.factId
  }, now);
}

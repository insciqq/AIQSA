import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { jevModelConfiguration } from "../../domain/decisionModels";
import { prisma } from "../prisma";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { NormalizedRunRequest } from "../providers/types";
import { createOptionalDecisionRepository, type OptionalDecisionOwner } from "./optionalDecisionRepository";

const snapshot: ProviderExecutionSnapshot = { version: 1, connectionId: "fixture-connection", providerModelId: "fixture-model",
  credentialId: "fixture-credential", credentialVersionId: "fixture-version", providerFamily: "openrouter",
  connectionDisplayName: "Fixture", modelDisplayName: "Fixture", model: jevModelConfiguration(),
  connection: { apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 30_000 } };
const receipt = { model: "fixture-model", provider: "TypeSafe", requestId: null,
  usage: { inputTokens: 20, outputTokens: 4, costUsd: 0.00001 } };
const answers = { s0: { type: "noul" as const, noul: 0.9 } };
const hash = "a".repeat(64);
const nonRunPurposes = ["skill_suggestions", "skill_catalog_relevance"] as const;

async function fixture(purpose: typeof nonRunPurposes[number],
  test: (owner: OptionalDecisionOwner, repo: ReturnType<typeof createOptionalDecisionRepository>) => Promise<void>) {
  const user = await prisma.user.create({ data: { email: `optional-${randomUUID()}@example.test`, displayName: "Fixture", status: "active" } });
  try { await test({ userId: user.id, purpose, operationKey: "request" }, createOptionalDecisionRepository(prisma)); }
  finally {
    await prisma.modelRun.deleteMany({ where: { userId: user.id } });
    await prisma.chat.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
}

async function createOwnedRun(userId: string) {
  const chat = await prisma.chat.create({ data: { userId, title: "Optional decision fixture", memoryMode: "EXCLUDED" } });
  const content = textMessageContent("Synthetic optional decision request");
  const question = await prisma.message.create({ data: { chatId: chat.id, role: "user", content } });
  const request: NormalizedRunRequest = {
    attachmentIds: [], chatId: chat.id, content,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
    modelId: "fixture-model", provider: "fake", params: {}, prompt: { developer: null, system: null },
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
  };
  return prisma.modelRun.create({ data: {
    userId, chatId: chat.id, userMessageId: question.id, modelId: request.modelId, provider: request.provider,
    status: "complete", normalizedRequest: request as unknown as Prisma.InputJsonValue
  } });
}
afterAll(() => prisma.$disconnect());

describe.each(nonRunPurposes)("optional decision durable receipt: %s", purpose => {
  it("has one concurrent dispatch winner, retains unknown usage across restart and creates no chat", async () => {
    await fixture(purpose, async (owner, repo) => {
      const claims = await Promise.all([repo.start(owner, hash, snapshot), repo.start(owner, hash, snapshot)]);
      expect(claims.filter(c => c.kind === "new")).toHaveLength(1);
      expect(claims.filter(c => c.kind === "replay")).toEqual([{ kind: "replay", answers: null }]);
      const restarted = createOptionalDecisionRepository(prisma);
      expect(await restarted.start(owner, hash, snapshot)).toEqual({ kind: "replay", answers: null });
      expect(await prisma.usageEvent.findFirstOrThrow({ where: { userId: owner.userId } })).toMatchObject({
        optionalDecision: true, usageCompleteness: "UNAVAILABLE", totalTokens: null, estimatedCostMicros: null,
        modelRunId: null, chatId: null, providerModelId: "fixture-model"
      });
      expect(await prisma.chat.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await prisma.modelRun.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await prisma.optionalDecisionAttempt.findMany({ where: { userId: owner.userId }, select: {
        purpose: true, modelRunId: true, state: true, answers: true
      } })).toEqual([{ purpose, modelRunId: null, state: "dispatched", answers: null }]);
    });
  });
  it("settles once, replays matching answers and cannot retarget the original request", async () => {
    await fixture(purpose, async (owner, repo) => {
      const claim = await repo.start(owner, hash, snapshot); expect(claim.kind).toBe("new"); if (claim.kind !== "new") return;
      await Promise.all([
        repo.settle(owner, claim.id, { receipt, answers, failureCode: null, dispatched: true }),
        repo.settle(owner, claim.id, { receipt, answers, failureCode: null, dispatched: true })
      ]);
      await repo.settle(owner, claim.id, { receipt: null, answers: null, failureCode: "late", dispatched: true });
      expect(await repo.start(owner, hash, snapshot)).toEqual({ kind: "replay", answers });
      expect(await repo.start(owner, "b".repeat(64), snapshot)).toEqual({ kind: "replay", answers: null });
      expect(await prisma.usageEvent.count({ where: { userId: owner.userId } })).toBe(1);
      expect(await prisma.usageEvent.findFirstOrThrow({ where: { userId: owner.userId } })).toMatchObject({
        inputTokens: 20, outputTokens: 4, totalTokens: 24, estimatedCostMicros: 10, usageCompleteness: "COMPLETE"
      });
      await expect(prisma.optionalDecisionAttempt.update({ where: { id: claim.id }, data: { inputHash: "c".repeat(64) } })).rejects.toThrow();
      await expect(prisma.optionalDecisionAttempt.update({ where: { id: claim.id }, data: { answers: {} } })).rejects.toThrow();
    });
  });
  it("enriches timed-out usage without resurrecting a recommendation", async () => {
    await fixture(purpose, async (owner, repo) => {
      const claim = await repo.start(owner, hash, snapshot); if (claim.kind !== "new") throw new Error("fixture_claim_missing");
      await repo.settle(owner, claim.id, { receipt: null, answers: null, failureCode: "timeout", dispatched: true });
      const restarted = createOptionalDecisionRepository(prisma);
      expect(await restarted.start(owner, hash, snapshot)).toEqual({ kind: "replay", answers: null });
      expect(await prisma.optionalDecisionAttempt.findUniqueOrThrow({ where: { id: claim.id } }))
        .toMatchObject({ state: "ambiguous", answers: null, failureCode: "timeout" });
      await expect(restarted.settle(owner, claim.id, { receipt, answers, failureCode: null, dispatched: true }))
        .rejects.toThrow("optional_decision_attempt_immutable");
      await repo.settle(owner, claim.id, { receipt, answers: null, failureCode: "timeout", dispatched: true });
      expect(await repo.start(owner, hash, snapshot)).toEqual({ kind: "replay", answers: null });
      expect(await prisma.usageEvent.findMany({ where: { userId: owner.userId }, select: {
        usageCompleteness: true, totalTokens: true, estimatedCostMicros: true
      } })).toEqual([{ usageCompleteness: "COMPLETE", totalTokens: 24, estimatedCostMicros: 10 }]);
      expect(await prisma.optionalDecisionAttempt.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ state: "settled", answers: null });
    });
  });
  it("retires a proven pre-dispatch failure without inventing a provider charge", async () => {
    await fixture(purpose, async (owner, repo) => {
      const claim = await repo.start(owner, hash, snapshot); if (claim.kind !== "new") throw new Error("fixture_claim_missing");
      await repo.settle(owner, claim.id, { receipt: null, answers: null, failureCode: "credential_revoked", dispatched: false });
      expect(await prisma.usageEvent.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await repo.start(owner, hash, snapshot)).toEqual({ kind: "replay", answers: null });
    });
  });
  it("rejects foreign accounting and run references at the database boundary", async () => {
    await fixture(purpose, async (owner, repo) => fixture(purpose, async other => {
      const claim = await repo.start(owner, hash, snapshot); if (claim.kind !== "new") throw new Error("fixture_claim_missing");
      const run = await createOwnedRun(owner.userId);
      await expect(prisma.usageEvent.updateMany({ where: { optionalDecisionAttemptId: claim.id }, data: { userId: other.userId } })).rejects.toThrow();
      await expect(prisma.usageEvent.updateMany({ where: { optionalDecisionAttemptId: claim.id },
        data: { modelRunId: run.id, chatId: run.chatId } })).rejects.toThrow("optional_decision_usage_owner_mismatch");
      await expect(repo.start({ ...other, purpose: "mcp_discovery", runId: run.id }, hash, snapshot)).rejects.toThrow();
      await repo.settle(other, claim.id, { receipt, answers, failureCode: null, dispatched: true });
      await repo.settle({ ...owner, operationKey: "different-request" }, claim.id, { receipt, answers, failureCode: null, dispatched: true });
      await repo.settle({ ...owner, runId: run.id }, claim.id, { receipt, answers, failureCode: null, dispatched: true });
      expect(await prisma.usageEvent.findFirstOrThrow({ where: { optionalDecisionAttemptId: claim.id } })).toMatchObject({ usageCompleteness: "UNAVAILABLE" });
      expect(await prisma.optionalDecisionAttempt.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ state: "dispatched", answers: null });
      expect(await prisma.optionalDecisionAttempt.count({ where: { userId: other.userId } })).toBe(0);
      expect(await prisma.usageEvent.count({ where: { userId: other.userId } })).toBe(0);
    }));
  });
});

describe("optional decision purpose isolation", () => {
  it("preserves both existing purposes and their receipts when the same owner/key starts catalog relevance", async () => {
    await fixture("skill_suggestions", async (owner, repo) => {
      const run = await createOwnedRun(owner.userId);
      const mcpOwner: OptionalDecisionOwner = { ...owner, purpose: "mcp_discovery", runId: run.id };
      const oldOwners = [owner, mcpOwner];
      for (const oldOwner of oldOwners) {
        const claim = await repo.start(oldOwner, hash, snapshot);
        if (claim.kind !== "new") throw new Error("fixture_claim_missing");
        await repo.settle(oldOwner, claim.id, { receipt, answers, failureCode: null, dispatched: true });
      }
      const oldAttempts = await prisma.optionalDecisionAttempt.findMany({ where: { userId: owner.userId }, orderBy: { id: "asc" } });
      const oldUsage = await prisma.usageEvent.findMany({ where: { userId: owner.userId }, orderBy: { id: "asc" } });
      expect(oldAttempts).toHaveLength(2);
      expect(oldUsage).toHaveLength(2);
      expect(oldUsage.find(event => event.modelRunId === run.id)).toMatchObject({
        chatId: run.chatId, userId: owner.userId, optionalDecision: true, usageCompleteness: "COMPLETE", totalTokens: 24
      });

      const relevanceOwner: OptionalDecisionOwner = { ...owner, purpose: "skill_catalog_relevance" };
      const claim = await repo.start(relevanceOwner, hash, snapshot);
      if (claim.kind !== "new") throw new Error("fixture_claim_missing");
      for (const oldOwner of oldOwners) {
        await repo.settle(oldOwner, claim.id, { receipt, answers, failureCode: null, dispatched: true });
        expect(await repo.start(oldOwner, hash, snapshot)).toEqual({ kind: "replay", answers });
      }
      expect(await repo.start(relevanceOwner, hash, snapshot)).toEqual({ kind: "replay", answers: null });
      await repo.settle(relevanceOwner, claim.id, { receipt, answers, failureCode: null, dispatched: true });
      expect(await createOptionalDecisionRepository(prisma).start(relevanceOwner, hash, snapshot)).toEqual({ kind: "replay", answers });
      expect(await prisma.optionalDecisionAttempt.findMany({ where: { id: { in: oldAttempts.map(attempt => attempt.id) } },
        orderBy: { id: "asc" } })).toEqual(oldAttempts);
      expect(await prisma.usageEvent.findMany({ where: { id: { in: oldUsage.map(event => event.id) } },
        orderBy: { id: "asc" } })).toEqual(oldUsage);
      expect(await prisma.optionalDecisionAttempt.count({ where: { userId: owner.userId } })).toBe(3);
      expect(await prisma.usageEvent.count({ where: { userId: owner.userId } })).toBe(3);
    });
  });

  it("rejects a real owned run for both non-run purposes while preserving the MCP run requirement", async () => {
    await fixture("skill_catalog_relevance", async (owner, repo) => {
      const run = await createOwnedRun(owner.userId);
      for (const purpose of nonRunPurposes) {
        await expect(repo.start({ ...owner, purpose, runId: run.id }, hash, snapshot))
          .rejects.toThrow("OptionalDecisionAttempt_purpose_check");
      }
      await expect(repo.start({ ...owner, purpose: "mcp_discovery" }, hash, snapshot))
        .rejects.toThrow("OptionalDecisionAttempt_purpose_check");
      await expect(prisma.optionalDecisionAttempt.create({ data: {
        userId: owner.userId, purpose: "unknown-purpose", operationKey: owner.operationKey, inputHash: hash,
        executionSnapshot: snapshot as unknown as Prisma.InputJsonValue
      } })).rejects.toThrow("OptionalDecisionAttempt_purpose_check");
      expect(await prisma.optionalDecisionAttempt.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await prisma.usageEvent.count({ where: { userId: owner.userId } })).toBe(0);

      const validMcp = await repo.start({ ...owner, purpose: "mcp_discovery", runId: run.id }, hash, snapshot);
      const validRelevance = await repo.start(owner, hash, snapshot);
      expect(validMcp.kind).toBe("new");
      expect(validRelevance.kind).toBe("new");
      expect(await prisma.optionalDecisionAttempt.count({ where: { userId: owner.userId } })).toBe(2);
      expect(await prisma.usageEvent.count({ where: { userId: owner.userId } })).toBe(2);
    });
  });
});

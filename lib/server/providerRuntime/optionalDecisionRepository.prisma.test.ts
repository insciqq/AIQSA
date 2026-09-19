import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { jevModelConfiguration } from "../../domain/decisionModels";
import { prisma } from "../prisma";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { createOptionalDecisionRepository, type OptionalDecisionOwner } from "./optionalDecisionRepository";

const snapshot: ProviderExecutionSnapshot = { version: 1, connectionId: "fixture-connection", providerModelId: "fixture-model",
  credentialId: "fixture-credential", credentialVersionId: "fixture-version", providerFamily: "openrouter",
  connectionDisplayName: "Fixture", modelDisplayName: "Fixture", model: jevModelConfiguration(),
  connection: { apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 30_000 } };
const receipt = { model: "fixture-model", provider: "TypeSafe", requestId: null,
  usage: { inputTokens: 20, outputTokens: 4, costUsd: 0.00001 } };
const answers = { s0: { type: "noul" as const, noul: 0.9 } };
const hash = "a".repeat(64);

async function fixture(test: (owner: OptionalDecisionOwner, repo: ReturnType<typeof createOptionalDecisionRepository>) => Promise<void>) {
  const user = await prisma.user.create({ data: { email: `optional-${randomUUID()}@example.test`, displayName: "Fixture", status: "active" } });
  try { await test({ userId: user.id, purpose: "skill_suggestions", operationKey: "request" }, createOptionalDecisionRepository(prisma)); }
  finally { await prisma.user.deleteMany({ where: { id: user.id } }); }
}
afterAll(() => prisma.$disconnect());

describe("optional decision durable receipt", () => {
  it("has one concurrent dispatch winner, retains unknown usage across restart and creates no chat", async () => {
    await fixture(async (owner, repo) => {
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
    });
  });
  it("settles once, replays matching answers and cannot retarget the original request", async () => {
    await fixture(async (owner, repo) => {
      const claim = await repo.start(owner, hash, snapshot); expect(claim.kind).toBe("new"); if (claim.kind !== "new") return;
      await repo.settle(owner, claim.id, { receipt, answers, failureCode: null, dispatched: true });
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
    await fixture(async (owner, repo) => {
      const claim = await repo.start(owner, hash, snapshot); if (claim.kind !== "new") throw new Error("fixture_claim_missing");
      await repo.settle(owner, claim.id, { receipt: null, answers: null, failureCode: "timeout", dispatched: true });
      await repo.settle(owner, claim.id, { receipt, answers: null, failureCode: "timeout", dispatched: true });
      expect(await repo.start(owner, hash, snapshot)).toEqual({ kind: "replay", answers: null });
      expect(await prisma.usageEvent.findFirstOrThrow({ where: { userId: owner.userId } })).toMatchObject({ totalTokens: 24 });
      expect(await prisma.optionalDecisionAttempt.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ state: "settled", answers: null });
    });
  });
  it("retires a proven pre-dispatch failure without inventing a provider charge", async () => {
    await fixture(async (owner, repo) => {
      const claim = await repo.start(owner, hash, snapshot); if (claim.kind !== "new") throw new Error("fixture_claim_missing");
      await repo.settle(owner, claim.id, { receipt: null, answers: null, failureCode: "credential_revoked", dispatched: false });
      expect(await prisma.usageEvent.count({ where: { userId: owner.userId } })).toBe(0);
      expect(await repo.start(owner, hash, snapshot)).toEqual({ kind: "replay", answers: null });
    });
  });
  it("rejects foreign accounting and run references at the database boundary", async () => {
    await fixture(async (owner, repo) => fixture(async other => {
      const claim = await repo.start(owner, hash, snapshot); if (claim.kind !== "new") throw new Error("fixture_claim_missing");
      await expect(prisma.usageEvent.updateMany({ where: { optionalDecisionAttemptId: claim.id }, data: { userId: other.userId } })).rejects.toThrow();
      await expect(repo.start({ ...other, purpose: "mcp_discovery", runId: "foreign-run" }, hash, snapshot)).rejects.toThrow();
      await repo.settle(other, claim.id, { receipt, answers, failureCode: null, dispatched: true });
      expect(await prisma.usageEvent.findFirstOrThrow({ where: { optionalDecisionAttemptId: claim.id } })).toMatchObject({ usageCompleteness: "UNAVAILABLE" });
    }));
  });
});

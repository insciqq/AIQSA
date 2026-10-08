import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { mcpApprovalContinuationText } from "../../contracts/mcpApprovals";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { validateMcpDraft } from "../mcp/definitions";
import { namespacedMcpToolName } from "../mcp/runPlan";
import { mcpApprovalAdmission, mcpApprovalRequest, type McpApprovalRequest } from "../mcp/writeApproval";
import {
  consumeMcpApproval,
  countAvailableMcpApprovals,
  decideMcpApproval,
  loadMcpToolConsentServerIds,
  revokeMcpToolConsent
} from "../mcp/writeApprovalRepository";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { mcpApprovalGated } from "./mcpApprovalGate";
import { createPrismaRunRepository } from "./prismaRepository";
import type { CreateRunInput, CreatedRun } from "./runRepositoryContract";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";

const repository = createPrismaRunRepository(prisma);
const cancelPayload = { code: "model_run_cancelled", message: "Model run cancelled" };

type Fixture = Readonly<{
  chatId: string; otherId: string; serverId: string; userId: string;
  create(input?: Partial<CreateRunInput>): Promise<CreatedRun>;
  request(args: Record<string, string>): McpApprovalRequest;
  persist(runId: string, calls: readonly Record<string, string>[]): Promise<readonly PersistedToolLoopCall[]>;
}>;

/** A personal chat with one bound synthetic MCP server whose tool may change data. */
async function fixture<T>(execute: (fixture: Fixture) => Promise<T>): Promise<T> {
  const userId = `mcp-approval-owner-${randomUUID()}`, otherId = `mcp-approval-other-${randomUUID()}`;
  const serverId = randomUUID(), revisionId = randomUUID(), generationId = randomUUID();
  const fingerprint = createHash("sha256").update(generationId).digest("hex");
  const namespace = `approval_${randomUUID().replaceAll("-", "")}`;
  const toolName = namespacedMcpToolName(namespace, "delete_record");
  await prisma.user.createMany({ data: [userId, otherId].map(id => ({ id, displayName: "Synthetic author", status: "active" })) });
  try {
    await prisma.userSettings.create({ data: { userId, defaultControlValues: {},
      defaultProviderModelId: providerTemplateIds.fakeModel, defaultSearchStrategyId: "search-disabled" } });
    await prisma.accessGrant.create({ data: { userId, providerConnectionId: providerTemplateIds.fakeConnection } });
    const configuration = { auth: { mode: "none" }, runtime: { startupTimeoutMs: 30_000, callTimeoutMs: 30_000 },
      source: { kind: "remote", url: "https://mcp.example.test/rpc" }, transport: "streamable_http", slots: [] };
    expect(validateMcpDraft(configuration).ok).toBe(true);
    await prisma.mcpServer.create({ data: { id: serverId, namespace, displayName: "Synthetic Records", enabled: true } });
    await prisma.mcpRevision.create({ data: { id: revisionId, serverId, revisionNumber: 1, configuration,
      validationEvidence: {}, draftHash: "a".repeat(64), identityHash: "b".repeat(64) } });
    await prisma.mcpServer.update({ where: { id: serverId }, data: { activeRevisionId: revisionId } });
    await prisma.mcpGrant.create({ data: { serverId, userId, canUse: true } });
    const userServer = await prisma.mcpUserServer.create({ data: { serverId, userId, enabled: true } });
    await prisma.mcpRuntimeGeneration.create({ data: { id: generationId, revisionId, fingerprint, state: "ready",
      userServerId: userServer.id } });
    const chat = await prisma.chat.create({ data: { userId, memoryMode: "EXCLUDED", title: "MCP approval fixture",
      defaultProviderModelId: providerTemplateIds.fakeModel } });
    const content = textMessageContent("Delete record r-1");
    const input: CreateRunInput = { chatId: chat.id, content, expectedActiveLeafId: null, userId,
      modelId: "fake-qsa", provider: "fake", providerRequestPreview: {},
      defaults: { userId, controlDefaults: {}, modelId: providerTemplateIds.fakeModel,
        provider: providerTemplateIds.fakeConnection, searchPlan: { mode: "all_selected", optionIds: [] } },
      providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { userId,
        providerConnectionId: providerTemplateIds.fakeConnection, providerModelId: providerTemplateIds.fakeModel,
        searchPlan: { mode: "all_selected", optionIds: [] } }),
      normalizedRequest: { attachmentIds: [], chatId: chat.id, content, toolMode: "auto",
        knowledgePlan: { version: 1, mode: "none", baseIds: [], sourceIds: [] },
        mcpApproval: mcpApprovalAdmission([]),
        modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
        modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
        searchPlan: { mode: "all_selected", options: [] } } };
    const request = (args: Record<string, string>) => mcpApprovalRequest({ arguments: args, definitionHash: "d".repeat(64),
      originalName: "delete_record", serverId, serverName: "Synthetic Records", toolName });
    return await execute({
      chatId: chat.id, otherId, serverId, userId, request,
      async create(overrides = {}) {
        // Admission requires the normalized request to carry the turn's own content.
        const content = overrides.content ?? input.content;
        const run = await repository.createRun({ ...input, ...overrides, content,
          normalizedRequest: { ...input.normalizedRequest, content } });
        await prisma.mcpRunBinding.create({ data: { modelRunId: run.runId, runtimeGenerationId: generationId,
          runtimeGenerationFingerprint: fingerprint } });
        return run;
      },
      async persist(runId, calls) {
        expect(await repository.beginToolLoopProviderRound({ userId, runId, roundIndex: 1, providerContinuation: null }))
          .toBe("started");
        const batch = await repository.persistToolLoopCallBatch({ userId, runId, roundIndex: 1, providerContinuation: null,
          calls: calls.map((args, ordinal) => ({ arguments: args, mcpApproval: request(args), ordinal,
            providerCallId: `provider-call-${ordinal}`, runtimeGenerationFingerprint: fingerprint, toolName })) });
        if (batch.kind !== "persisted") throw new Error("mcp_approval_batch_fixture_failed");
        return batch.calls;
      }
    });
  } finally {
    await prisma.mcpRuntimeGeneration.deleteMany({ where: { revisionId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.mcpUserServer.deleteMany({ where: { serverId } });
    await prisma.mcpRevision.deleteMany({ where: { serverId } });
    await prisma.mcpServer.deleteMany({ where: { id: serverId } });
  }
}

/** Run A asks for the call: one gated row, one pending card; its answer settles (cancelled). */
async function askedFirst(f: Fixture) {
  const first = await f.create();
  const [gated] = await f.persist(first.runId, [{ id: "r-1" }]);
  const card = await prisma.mcpToolApproval.findFirstOrThrow({ where: { modelRunId: first.runId } });
  await repository.cancelRun({ runId: first.runId, userId: f.userId, payload: cancelPayload });
  return { card, first, gated: gated! };
}

function decide(f: Fixture, runId: string, approvalId: string, decision: "allow_once" | "allow_server" | "deny", nonce: string,
  userId = f.userId) {
  return decideMcpApproval(prisma, { approvalId, decision, nonce, runId, userId });
}

/** The continuation run: the server-written turn after the user's Allow. */
function continueAfter(f: Fixture, first: CreatedRun) {
  return f.create({ content: textMessageContent(mcpApprovalContinuationText({ serverName: "Synthetic Records",
    toolName: "delete_record" })), expectedActiveLeafId: first.assistantMessageId, systemTurnKind: "mcp_approval_continuation" });
}

describe("MCP write approval storage", () => {
  afterAll(() => prisma.$disconnect());

  it("persists an unapproved write settled and undispatched with one pending card no claim or replay dispatches", async () => fixture(async f => {
    const run = await f.create();
    const [gated] = await f.persist(run.runId, [{ id: "r-1" }]);
    expect(gated).toMatchObject({ state: "error", startedAt: null });
    expect(mcpApprovalGated(gated!)).toBe(true);
    expect(await prisma.mcpToolApproval.findMany({ where: { modelRunId: run.runId } })).toEqual([expect.objectContaining({
      chatId: f.chatId, decision: null, expiresAt: null, serverId: f.serverId, source: "model", toolCallId: gated!.id,
      toolTitle: "delete_record", userId: f.userId })]);
    // Recovery after a restart replays the same claim: the gated row stays settled, nothing starts.
    const claim = await repository.claimToolLoopCall({ callId: gated!.id, followupRevision: 0, mcpApproval: f.request({ id: "r-1" }),
      runId: run.runId, userId: f.userId });
    expect(claim).toMatchObject({ kind: "settled", call: { state: "error", startedAt: null } });
    // A replayed batch reuses the rows and keeps the one card.
    const replay = await repository.persistToolLoopCallBatch({ userId: f.userId, runId: run.runId, roundIndex: 1,
      providerContinuation: null, calls: [{ arguments: { id: "r-1" }, mcpApproval: f.request({ id: "r-1" }), ordinal: 0,
        providerCallId: "provider-call-0", runtimeGenerationFingerprint: gated!.mcpBinding?.runtimeGenerationFingerprint ?? null,
        toolName: gated!.toolName }] });
    expect(replay).toMatchObject({ kind: "reused" });
    expect(await prisma.mcpToolApproval.count({ where: { modelRunId: run.runId } })).toBe(1);
  }));

  it("decides once per nonce, only as the initiator after the answer settles; Deny starts nothing", async () => fixture(async f => {
    const run = await f.create();
    await f.persist(run.runId, [{ id: "r-1" }]);
    const card = await prisma.mcpToolApproval.findFirstOrThrow({ where: { modelRunId: run.runId } });
    expect(await decide(f, run.runId, card.id, "allow_once", "nonce-early")).toEqual({ kind: "run_active" });
    await repository.cancelRun({ runId: run.runId, userId: f.userId, payload: cancelPayload });
    expect(await decide(f, run.runId, card.id, "allow_once", "nonce-other", f.otherId)).toEqual({ kind: "not_found" });
    const denied = await decide(f, run.runId, card.id, "deny", "nonce-0001");
    expect(denied).toMatchObject({ continuation: false, kind: "decided", card: { state: "denied" } });
    expect(await decide(f, run.runId, card.id, "deny", "nonce-0001")).toEqual(denied);
    expect(await decide(f, run.runId, card.id, "allow_once", "nonce-0002")).toMatchObject({ kind: "conflict",
      card: { state: "denied" } });
    expect(await prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({ consumedAt: null,
      decision: "deny", expiresAt: null });
    expect(await countAvailableMcpApprovals(prisma, { chatId: f.chatId, runId: randomUUID(), userId: f.userId },
      f.request({ id: "r-1" }))).toBe(0);
    expect(await prisma.mcpToolConsent.count({ where: { userId: f.userId } })).toBe(0);
    expect(await prisma.modelRun.count({ where: { chatId: f.chatId } })).toBe(1);
  }));

  it("lets one later claim of exactly the approved call consume an Allow once, in the claim transaction", async () => fixture(async f => {
    const { card, first } = await askedFirst(f);
    expect(await decide(f, first.runId, card.id, "allow_once", "nonce-0001")).toMatchObject({ continuation: true, kind: "decided",
      card: { state: "allowed_once" } });
    const second = await continueAfter(f, first);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: second.userMessageId }, select: { systemTurnKind: true } }))
      .toEqual({ systemTurnKind: "mcp_approval_continuation" });
    // One approval serves one call: a repeat of it and another argument ask again.
    const [approved, repeated, other] = await f.persist(second.runId, [{ id: "r-1" }, { id: "r-1" }, { id: "r-2" }]);
    expect(approved).toMatchObject({ state: "pending", startedAt: null });
    expect([mcpApprovalGated(repeated!), mcpApprovalGated(other!)]).toEqual([true, true]);
    const claim = { callId: approved!.id, followupRevision: 0, mcpApproval: f.request({ id: "r-1" }), runId: second.runId,
      userId: f.userId };
    expect(await repository.claimToolLoopCall(claim)).toMatchObject({ kind: "claimed" });
    expect(await prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      consumedAt: expect.any(Date), consumedByRunId: second.runId });
    // The claimed call is in flight; claiming again never consumes or dispatches twice.
    expect(await repository.claimToolLoopCall(claim)).toMatchObject({ kind: "ambiguous", call: { state: "running" } });
    expect(await countAvailableMcpApprovals(prisma, { chatId: f.chatId, runId: randomUUID(), userId: f.userId },
      f.request({ id: "r-1" }))).toBe(0);
    expect(await prisma.mcpToolApproval.count({ where: { modelRunId: second.runId, decision: null } })).toBe(2);
  }));

  it("gives a racing consumption of the same approval exactly one winner", async () => fixture(async f => {
    const { card, first } = await askedFirst(f);
    await decide(f, first.runId, card.id, "allow_once", "nonce-0001");
    const second = await continueAfter(f, first);
    const [pending] = await f.persist(second.runId, [{ id: "r-1" }]);
    const [claim, elsewhere] = await Promise.all([
      repository.claimToolLoopCall({ callId: pending!.id, followupRevision: 0, mcpApproval: f.request({ id: "r-1" }),
        runId: second.runId, userId: f.userId }),
      consumeMcpApproval(prisma, { chatId: f.chatId, runId: randomUUID(), userId: f.userId }, f.request({ id: "r-1" }))
    ]);
    expect([claim.kind === "claimed", elsewhere].filter(Boolean)).toHaveLength(1);
    if (claim.kind !== "claimed") {
      // Lost: settled undispatched, asking again with a card of its own.
      expect(claim).toMatchObject({ kind: "settled", call: { state: "error", startedAt: null } });
      expect(await prisma.mcpToolApproval.count({ where: { modelRunId: second.runId, toolCallId: pending!.id } })).toBe(1);
    }
  }));

  it("never serves an expired Allow once or one of another chat", async () => fixture(async f => {
    const { card, first } = await askedFirst(f);
    await decide(f, first.runId, card.id, "allow_once", "nonce-0001");
    const scope = { runId: randomUUID(), userId: f.userId };
    expect(await countAvailableMcpApprovals(prisma, { ...scope, chatId: randomUUID() }, f.request({ id: "r-1" }))).toBe(0);
    expect(await countAvailableMcpApprovals(prisma, { ...scope, chatId: f.chatId }, f.request({ id: "r-1" }))).toBe(1);
    await prisma.mcpToolApproval.update({ where: { id: card.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const second = await continueAfter(f, first);
    const [asked] = await f.persist(second.runId, [{ id: "r-1" }]);
    expect(mcpApprovalGated(asked!)).toBe(true);
  }));

  it("records Always allow as one consent per server and revokes it", async () => fixture(async f => {
    const { card, first } = await askedFirst(f);
    expect(await decide(f, first.runId, card.id, "allow_server", "nonce-0001")).toMatchObject({ kind: "decided",
      card: { state: "allowed_server" } });
    expect(await prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({ expiresAt: null });
    expect(await loadMcpToolConsentServerIds(prisma, { serverIds: [f.serverId, randomUUID()], userId: f.userId })).toEqual([f.serverId]);
    expect(await loadMcpToolConsentServerIds(prisma, { serverIds: [f.serverId], userId: f.otherId })).toEqual([]);
    expect(await revokeMcpToolConsent(prisma, { serverId: f.serverId, userId: f.otherId })).toBe(false);
    expect(await revokeMcpToolConsent(prisma, { serverId: f.serverId, userId: f.userId })).toBe(true);
    expect(await loadMcpToolConsentServerIds(prisma, { serverIds: [f.serverId], userId: f.userId })).toEqual([]);
  }));

  it("refuses inconsistent rows and removes a chat's approvals with its runs", async () => fixture(async f => {
    const { card, first } = await askedFirst(f);
    await expect(prisma.mcpToolApproval.update({ where: { id: card.id }, data: { decision: "deny" } })).rejects.toThrow();
    await expect(prisma.mcpToolApproval.update({ where: { id: card.id }, data: { consumedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.mcpToolApproval.update({ where: { id: card.id }, data: { toolCallId: null } })).rejects.toThrow();
    await expect(prisma.message.update({ where: { id: first.assistantMessageId },
      data: { systemTurnKind: "mcp_approval_continuation" } })).rejects.toThrow();
    await prisma.chat.delete({ where: { id: f.chatId } });
    expect(await prisma.mcpToolApproval.count({ where: { chatId: f.chatId } })).toBe(0);
  }));
});

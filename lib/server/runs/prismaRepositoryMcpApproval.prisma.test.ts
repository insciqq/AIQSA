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
import { createToolCallStore, type ToolCallRow } from "../engine/toolCallStore";
import { selfServiceRunAllowedInTransaction } from "../tools/selfServiceCall";
import { storedUserRequest } from "./turnProvenance";

const repository = createPrismaRunRepository(prisma);
const cancelPayload = { code: "model_run_cancelled", message: "Model run cancelled" };

type Fixture = Readonly<{
  chatId: string; otherId: string; serverId: string; userId: string;
  create(input?: Partial<CreateRunInput>): Promise<CreatedRun>;
  request(args: Record<string, string>): McpApprovalRequest;
  /** Records each call as the agent engine does before sending it: running, or gated with a card. */
  persist(runId: string, calls: readonly Record<string, string>[]): Promise<readonly ToolCallRow[]>;
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
          normalizedRequest: { ...input.normalizedRequest, ...overrides.normalizedRequest, content } });
        await prisma.mcpRunBinding.create({ data: { modelRunId: run.runId, runtimeGenerationId: generationId,
          runtimeGenerationFingerprint: fingerprint } });
        return run;
      },
      async persist(runId, calls) {
        const store = createToolCallStore(prisma);
        const rows: ToolCallRow[] = [];
        for (const [ordinal, args] of calls.entries()) {
          const begun = await store.begin({ approval: request(args), arguments: args, chatId: chat.id, ordinal,
            providerCallId: `provider-call-${ordinal}`, roundIndex: 1, runId, toolName, userId });
          if (begun.kind === "inactive") throw new Error("mcp_approval_call_fixture_failed");
          rows.push(begun.row);
        }
        return rows;
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

/**
 * The continuation run: the server-written turn after the user's Allow. With `approvalId` it names the Allow it
 * continues, as admission freezes it on every continuation (`runPreparation.ts`).
 */
function continueAfter(f: Fixture, first: CreatedRun, approvalId?: string) {
  return f.create({ content: textMessageContent(mcpApprovalContinuationText({ serverName: "Synthetic Records",
    toolName: "delete_record" })), expectedActiveLeafId: first.assistantMessageId, systemTurnKind: "mcp_approval_continuation",
  ...(approvalId ? { normalizedRequest: { mcpApproval: mcpApprovalAdmission([], undefined, approvalId) } as unknown as
    CreateRunInput["normalizedRequest"] } : {}) });
}

/** A regenerated answer to a stored user message: a later run of the same message, which names no Allow of its own. */
async function answerAgain(f: Fixture, userMessageId: string) {
  const reply = await prisma.message.create({ data: { chatId: f.chatId, content: textMessageContent(""), parentMessageId: userMessageId,
    role: "assistant", status: "streaming" } });
  const run = await prisma.modelRun.create({ data: { assistantMessageId: reply.id, chatId: f.chatId, engine: "native", modelId: "fake-qsa",
    normalizedRequest: {}, provider: "fake", status: "streaming", userId: f.userId, userMessageId } });
  return { assistantMessageId: reply.id, id: run.id };
}

describe("MCP write approval storage", () => {
  afterAll(() => prisma.$disconnect());

  it("records an unapproved write settled and undispatched with one pending card", async () => fixture(async f => {
    const run = await f.create();
    const [gated] = await f.persist(run.runId, [{ id: "r-1" }]);
    expect(gated).toMatchObject({ state: "error", startedAt: null });
    expect(mcpApprovalGated(gated!)).toBe(true);
    expect(await prisma.mcpToolApproval.findMany({ where: { modelRunId: run.runId } })).toEqual([expect.objectContaining({
      chatId: f.chatId, decision: null, expiresAt: null, serverId: f.serverId, source: "model", toolCallId: gated!.id,
      toolTitle: "delete_record", userId: f.userId })]);
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

  it("lets one later call of exactly the approved arguments consume an Allow once, in the transaction that records it", async () => fixture(async f => {
    const { card, first } = await askedFirst(f);
    expect(await decide(f, first.runId, card.id, "allow_once", "nonce-0001")).toMatchObject({ continuation: true, kind: "decided",
      card: { state: "allowed_once" } });
    const second = await continueAfter(f, first);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: second.userMessageId }, select: { systemTurnKind: true } }))
      .toEqual({ systemTurnKind: "mcp_approval_continuation" });
    // One approval serves one call: a repeat of it and another argument ask again.
    const [approved, repeated, other] = await f.persist(second.runId, [{ id: "r-1" }, { id: "r-1" }, { id: "r-2" }]);
    expect(approved).toMatchObject({ state: "running", startedAt: expect.any(String) });
    expect([mcpApprovalGated(repeated!), mcpApprovalGated(other!)]).toEqual([true, true]);
    expect(await prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      consumedAt: expect.any(Date), consumedByRunId: second.runId });
    expect(await countAvailableMcpApprovals(prisma, { chatId: f.chatId, runId: randomUUID(), userId: f.userId },
      f.request({ id: "r-1" }))).toBe(0);
    expect(await prisma.mcpToolApproval.count({ where: { modelRunId: second.runId, decision: null } })).toBe(2);
  }));

  it("gives a racing consumption of the same approval exactly one winner", async () => fixture(async f => {
    const { card, first } = await askedFirst(f);
    await decide(f, first.runId, card.id, "allow_once", "nonce-0001");
    const second = await continueAfter(f, first);
    const [[call], elsewhere] = await Promise.all([
      f.persist(second.runId, [{ id: "r-1" }]),
      consumeMcpApproval(prisma, { chatId: f.chatId, runId: randomUUID(), userId: f.userId }, f.request({ id: "r-1" }))
    ]);
    expect([call!.state === "running", elsewhere].filter(Boolean)).toHaveLength(1);
    if (call!.state !== "running") {
      // Lost: settled undispatched, asking again with a card of its own.
      expect(mcpApprovalGated(call!)).toBe(true);
      expect(await prisma.mcpToolApproval.count({ where: { modelRunId: second.runId, toolCallId: call!.id } })).toBe(1);
    }
  }));

  it("hands the turn after an Allow the computer of the run it gated, none for a run without one", async () => fixture(async f => {
    const computer = { arch: "amd64", cwd: "C:\\Reports", deviceId: randomUUID(), name: "DESKTOP-7Q2", online: true, os: "windows" };
    const load = (approvalId: string, userId = f.userId) =>
      repository.loadMcpApprovalContinuation!({ approvalId, chatId: f.chatId, userId });
    const { card, first } = await askedFirst(f);
    await decide(f, first.runId, card.id, "allow_once", "nonce-0001");
    expect(await load(card.id)).toEqual({ computer: null, serverName: "Synthetic Records", toolName: "delete_record",
      userRequest: true });
    expect(await load(card.id, f.otherId)).toBeNull();

    const withComputer = await f.create({ expectedActiveLeafId: first.assistantMessageId,
      normalizedRequest: { computer } as unknown as CreateRunInput["normalizedRequest"] });
    await f.persist(withComputer.runId, [{ id: "r-2" }]);
    const gatedCard = await prisma.mcpToolApproval.findFirstOrThrow({ where: { modelRunId: withComputer.runId } });
    await repository.cancelRun({ runId: withComputer.runId, userId: f.userId, payload: cancelPayload });
    await decide(f, withComputer.runId, gatedCard.id, "allow_once", "nonce-0002");
    expect(await load(gatedCard.id)).toEqual({ computer, serverName: "Synthetic Records", toolName: "delete_record",
      userRequest: true });
  }));

  it("gives the turn after an Allow the authority of the turn whose call was allowed, followed back to the first turn",
    async () => fixture(async f => {
      const load = (approvalId: string) => repository.loadMcpApprovalContinuation!({ approvalId, chatId: f.chatId, userId: f.userId });
      const turn = (messageId: string) => storedUserRequest(prisma, { messageId, userId: f.userId });
      const fence = (runId: string) => prisma.$transaction((tx) => selfServiceRunAllowedInTransaction(tx, { runId, userId: f.userId }));
      const regenerated = async (messageId: string) =>
        (await repository.findRegenerationSource(messageId, f.userId))?.userMessage.continuesUserRequest === true;

      // The user's own message asks for a call; the user allows it.
      const { card, first } = await askedFirst(f);
      const markFirst = (systemTurnKind: "browser_sign_in_request" | "subagent_callback" | null) =>
        prisma.message.update({ where: { id: first.userMessageId }, data: { systemTurnKind } });
      await decide(f, first.runId, card.id, "allow_once", "nonce-0001");
      expect(await load(card.id)).toMatchObject({ userRequest: true });
      // Its continuation goes on with the user's own request, by the Allow its first run names.
      const second = await continueAfter(f, first, card.id);
      expect(await turn(second.userMessageId)).toBe(true);
      expect(await fence(second.runId)).toBe(true);
      // The continuation asks for another call, which the user allows too: a continuation of a continuation.
      await f.persist(second.runId, [{ id: "r-2" }]);
      const nextCard = await prisma.mcpToolApproval.findFirstOrThrow({ where: { modelRunId: second.runId } });
      await repository.cancelRun({ runId: second.runId, userId: f.userId, payload: cancelPayload });
      await decide(f, second.runId, nextCard.id, "allow_once", "nonce-0002");
      expect(await load(nextCard.id)).toMatchObject({ userRequest: true });
      const third = await continueAfter(f, second, nextCard.id);
      expect(await turn(third.userMessageId)).toBe(true);
      expect(await fence(third.runId)).toBe(true);
      // A regenerate of that continuation is a later run of the same message and keeps its authority.
      await repository.cancelRun({ runId: third.runId, userId: f.userId, payload: cancelPayload });
      const again = await answerAgain(f, third.userMessageId);
      expect(await fence(again.id)).toBe(true);
      expect(await regenerated(third.userMessageId)).toBe(true);
      expect(await regenerated(again.assistantMessageId)).toBe(true);

      // Had the first turn been a sub-agent wake-up or a sign-in request, which authorize nothing, every Allow down the
      // chain covers its one call and nothing more: no admission, fence or regenerate reads a user's request.
      for (const kind of ["subagent_callback", "browser_sign_in_request"] as const) {
        await markFirst(kind);
        expect(await load(nextCard.id), kind).toMatchObject({ userRequest: false });
        expect(await turn(first.userMessageId), kind).toBe(false);
        expect(await turn(second.userMessageId), kind).toBe(false);
        expect(await turn(third.userMessageId), kind).toBe(false);
        expect(await fence(again.id), kind).toBe(false);
        expect(await regenerated(third.userMessageId), kind).toBe(false);
      }

      // A continuation whose runs name no Allow, as in a branch copy, has no authority of the user's either.
      await markFirst(null);
      expect(await turn(third.userMessageId)).toBe(true);
      await repository.cancelRun({ runId: again.id, userId: f.userId, payload: cancelPayload });
      const unlinked = await continueAfter(f, third);
      expect(await turn(unlinked.userMessageId)).toBe(false);
      expect(await fence(unlinked.runId)).toBe(false);
      // Another user never reads this chain.
      expect(await storedUserRequest(prisma, { messageId: third.userMessageId, userId: f.otherId })).toBe(false);
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

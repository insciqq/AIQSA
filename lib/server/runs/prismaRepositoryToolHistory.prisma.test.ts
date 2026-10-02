// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { validateMcpDraft } from "../mcp/definitions";
import { encryptMcpEnvelope, mcpRuntimeGenerationEnvelopeContext } from "../mcp/encryption";
import { namespacedMcpToolName } from "../mcp/runPlan";
import { prisma } from "../prisma";
import { createPrismaToolHistoryOperations } from "./prismaRepositoryToolHistory";
import { toolCallRef, toolHistoryDigest } from "./toolHistoryContract";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const clean of cleanups.splice(0).reverse()) await clean(); }
  finally { vi.unstubAllEnvs(); }
});

const operations = createPrismaToolHistoryOperations(prisma);
const syntheticSecret = "synthetic-tool-history-secret";
const syntheticKey = Buffer.alloc(32, 41);
const ref = (call: Readonly<{ id: string }>) => toolCallRef(call.id)!;

type RunStatus = "complete" | "error" | "in_progress";

async function fixture(options: Readonly<{ project?: boolean; sensitive?: boolean }> = {}) {
  const userIds = Array.from({ length: 3 }, () => randomUUID());
  const [initiatorId, memberId, strangerId] = userIds as [string, string, string];
  const serverId = randomUUID();
  const revisionId = randomUUID();
  const generationId = randomUUID();
  const fingerprint = createHash("sha256").update(generationId).digest("hex");
  const namespace = `history_${randomUUID().replaceAll("-", "")}`;
  const toolName = namespacedMcpToolName(namespace, "records");
  let chatId: string | undefined;
  let projectId: string | null = null;
  cleanups.push(async () => {
    if (chatId) {
      await prisma.modelRun.deleteMany({ where: { chatId } });
      await prisma.chat.updateMany({ where: { id: chatId }, data: { activeLeafMessageId: null } });
      await prisma.message.deleteMany({ where: { chatId } });
      await prisma.chat.deleteMany({ where: { id: chatId } });
    }
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.mcpRuntimeGeneration.deleteMany({ where: { revisionId } });
    await prisma.mcpUserServer.deleteMany({ where: { serverId } });
    await prisma.mcpRevision.deleteMany({ where: { serverId } });
    await prisma.mcpServer.deleteMany({ where: { id: serverId } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await prisma.user.createMany({ data: userIds.map(id => ({ id, displayName: "Synthetic history member", status: "active" })) });
  if (options.project) {
    projectId = (await prisma.project.create({ data: { name: "Synthetic history Project", createdByUserId: initiatorId,
      createdByDisplayName: "Synthetic history member", grants: { create: [{ userId: initiatorId, role: "OWNER" },
        { userId: memberId, role: "CONTRIBUTOR" }] } } })).id;
  }
  const configuration = {
    auth: { mode: options.sensitive ? "static" : "none" },
    runtime: { startupTimeoutMs: 30_000, callTimeoutMs: 30_000 },
    source: { kind: "remote", url: "https://mcp.example.test/rpc" }, transport: "streamable_http",
    slots: options.sensitive ? [{ label: "Authorization", sensitive: true, slotKey: "authorization", valueType: "secret",
      policy: { kind: "shared", allowPersonalOverride: false }, target: { kind: "header", name: "Authorization" } }] : []
  };
  expect(validateMcpDraft(configuration).ok).toBe(true);
  await prisma.mcpServer.create({ data: { id: serverId, namespace, displayName: "Synthetic Records", enabled: true } });
  await prisma.mcpRevision.create({ data: { id: revisionId, serverId, revisionNumber: 1, configuration,
    validationEvidence: {}, draftHash: "a".repeat(64), identityHash: "b".repeat(64) } });
  await prisma.mcpServer.update({ where: { id: serverId }, data: { activeRevisionId: revisionId } });
  await prisma.mcpGrant.createMany({ data: [initiatorId, memberId].map(userId => ({ serverId, userId, canUse: true })) });
  const userServer = await prisma.mcpUserServer.create({ data: { serverId, userId: initiatorId, enabled: true } });
  await prisma.mcpUserServer.create({ data: { serverId, userId: memberId, enabled: true } });
  if (projectId) {
    await prisma.projectMcpBinding.create({ data: { projectId, serverId } });
    await prisma.mcpSharedRuntime.create({ data: { serverId } });
  }
  if (options.sensitive) vi.stubEnv("AIQSA_ENCRYPTION_KEY", syntheticKey.toString("base64"));
  await prisma.mcpRuntimeGeneration.create({ data: {
    id: generationId, revisionId, fingerprint, state: "ready",
    ...(projectId ? { sharedServerId: serverId } : { userServerId: userServer.id }),
    ...(options.sensitive ? { effectiveConfigEnvelope: encryptMcpEnvelope({ version: 1, values: { authorization: syntheticSecret } },
      syntheticKey, mcpRuntimeGenerationEnvelopeContext(generationId, fingerprint)) } : {})
  } });
  const chat = await prisma.chat.create({ data: { title: "Synthetic tool history", memoryMode: "EXCLUDED",
    ...(projectId ? { projectId, createdByUserId: initiatorId, createdByDisplayName: "Synthetic history member" } : { userId: initiatorId }) } });
  chatId = chat.id;
  const accepted = (eligible: boolean) => ({
    workspace: { enabled: true },
    mcp: { version: 1, servers: [{ serverId, revisionId, fingerprint, serverName: "Synthetic Records" }],
      tools: [{ namespacedName: toolName, originalName: "records", serverId, serverName: "Synthetic Records" }] },
    // An option this installation does not have: Search calls of it are no longer available.
    searchPlan: { mode: "all_selected", options: [{ optionId: `synthetic-search-${randomUUID()}`, revisionId: randomUUID(),
      displayName: "Synthetic Search", adapterKind: "searxng" }] },
    ...(eligible ? { toolHistory: { version: 1, turns: [] } } : {})
  });
  let clock = Date.now() - 600_000;
  const question = (parentMessageId: string | null, authorId = initiatorId) => prisma.message.create({ data: {
    chatId: chat.id, role: "user", status: "complete", parentMessageId, content: textMessageContent("Synthetic question"),
    ...(projectId ? { authorUserId: authorId, authorDisplayName: "Synthetic history member",
      authorProjectRole: authorId === initiatorId ? "OWNER" as const : "CONTRIBUTOR" as const } : {}) } });
  /** One run answering `userMessage` with its own new answer message. */
  const answer = async (userMessage: Readonly<{ id: string }>, input: Readonly<{
    eligible?: boolean; status?: RunStatus; userId?: string;
  }> = {}) => {
    const userId = input.userId ?? initiatorId;
    const status = input.status ?? "complete";
    const message = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", parentMessageId: userMessage.id,
      status: status === "in_progress" ? "streaming" : status, content: textMessageContent("Synthetic answer") } });
    const run = await prisma.modelRun.create({ data: { chatId: chat.id, userId, userMessageId: userMessage.id,
      assistantMessageId: message.id, provider: "fake", modelId: "fake-qsa", status, createdAt: new Date(clock += 1000),
      normalizedRequest: accepted(input.eligible ?? true),
      ...(projectId ? { projectRunBinding: { create: { projectId, initiatorUserId: userId,
        acceptedRole: userId === initiatorId ? "OWNER" as const : "CONTRIBUTOR" as const, accessRevision: 1, policyRevision: 1,
        instructionsRevision: 1, memoryRevision: 0, personalMemoryDisabled: true } } } : {}) } });
    const binding = await prisma.mcpRunBinding.create({ data: { modelRunId: run.id, runtimeGenerationId: generationId,
      runtimeGenerationFingerprint: fingerprint } });
    return { answer: message, run, binding, actor: { runId: run.id, userId } };
  };
  /** A persisted call: the MCP tool by default, its result already redacted
   * as execution delivered it. */
  const call = (turn: Awaited<ReturnType<typeof answer>>, input: Readonly<{
    round: number; ordinal: number; item: number; name?: string; state?: "complete" | "error" | "running";
  }>) => {
    const name = input.name ?? toolName;
    const providerCallId = `synthetic-call-${randomUUID()}`;
    return prisma.modelRunToolCall.create({ data: {
      modelRunId: turn.run.id, mcpRunBindingId: name === toolName ? turn.binding.id : null, roundIndex: input.round,
      ordinal: input.ordinal, providerCallId, toolName: name, state: input.state ?? "complete", startedAt: new Date(),
      arguments: { query: `item ${input.item}`, ...(options.sensitive ? { authorization: syntheticSecret } : {}) },
      result: input.state === "running" ? undefined : { callId: providerCallId, name, status: "complete",
        content: [{ type: "text", text: `result ${input.item}` }], rawPreview: { isError: false, unsupportedContentTypes: [] } }
    } });
  };
  return { chat, initiatorId, memberId, strangerId, serverId, toolName, question, answer, call };
}

describe("Prisma cross-turn tool history", () => {
  it("freezes a branch's calls by reference with earlier attempts of its user messages, never other edits or ineligible runs", async () => {
    const f = await fixture();
    const first = await f.question(null);
    const legacy = await f.answer(first, { eligible: false });
    await f.call(legacy, { round: 1, ordinal: 0, item: 0 });
    const attempt = await f.answer(first, { status: "error" });
    const c1 = await f.call(attempt, { round: 1, ordinal: 0, item: 1 });
    await f.call(attempt, { round: 1, ordinal: 1, item: 0, name: "read_tool_result" });
    const c2 = await f.call(attempt, { round: 2, ordinal: 0, item: 2, state: "error" });
    const regenerated = await f.answer(first);
    const c3 = await f.call(regenerated, { round: 1, ordinal: 0, item: 3 });
    await f.call(regenerated, { round: 1, ordinal: 1, item: 0, name: "get_session_status" });
    // Another edit of the first message, with its own calls.
    const edited = await f.answer(await f.question(null));
    await f.call(edited, { round: 1, ordinal: 0, item: 4 });
    const second = await f.question(regenerated.answer.id);
    const current = await f.answer(second, { status: "in_progress" });
    const c5 = await f.call(current, { round: 1, ordinal: 0, item: 5, state: "running" });

    // A send after the regenerated answer: every attempt of the first message, readers counted.
    expect(await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: regenerated.answer.id, userId: f.initiatorId })).toEqual({
      version: 1, turns: [{ turnMessageId: regenerated.answer.id, callRefs: [c1, c2, c3].map(ref),
        digest: toolHistoryDigest([c1, c2, c3]), readerCalls: 2 }] });
    // A regeneration of the second message lists its earlier attempt under that message.
    const regeneration = await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: second.id, userId: f.initiatorId });
    expect(regeneration.turns.map(turn => turn.turnMessageId)).toEqual([regenerated.answer.id, second.id]);
    expect(regeneration.turns[1]).toEqual({ turnMessageId: second.id, callRefs: [ref(c5)], digest: toolHistoryDigest([c5]) });
    // Other users and drafts freeze nothing.
    expect(await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: regenerated.answer.id, userId: f.strangerId }))
      .toEqual({ version: 1, turns: [] });
    expect(await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: null, userId: f.initiatorId }))
      .toEqual({ version: 1, turns: [] });
  });

  it("projects records with the reading run's current authority, marks earlier attempts and fails closed on changed calls", async () => {
    const f = await fixture();
    const first = await f.question(null);
    const attempt = await f.answer(first, { status: "error" });
    const c1 = await f.call(attempt, { round: 1, ordinal: 0, item: 1 });
    const regenerated = await f.answer(first);
    const c2 = await f.call(regenerated, { round: 1, ordinal: 0, item: 2 });
    const search = await f.call(regenerated, { round: 1, ordinal: 1, item: 3, name: "search_engine_1" });
    await f.call(regenerated, { round: 2, ordinal: 0, item: 0, name: "read_tool_result" });
    const current = await f.answer(await f.question(regenerated.answer.id), { status: "in_progress" });
    const toolHistory = await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: regenerated.answer.id, userId: f.initiatorId });
    const project = async (reader = true) =>
      (await operations.projectToolHistory({ actor: current.actor, reader, toolHistory })).blocks;

    const [block] = await project();
    expect(block).toMatchObject({ turnMessageId: regenerated.answer.id, userMessageId: first.id });
    expect(block!.header).toContain("while answering the user message above");
    expect(block!.header).toContain("read_tool_call(call_ref)");
    expect(block!.entries.map(entry => entry.ref)).toEqual([c1, c2, search].map(ref));
    expect(block!.entries[0]!.compact).toContain("(earlier attempt, not the current branch) MCP Synthetic Records › records");
    expect(block!.entries[1]!.compact).not.toContain("earlier attempt");
    expect(block!.entries[1]!.full).toContain('Arguments: {"query":"item 2"}');
    expect(block!.entries[1]!.full).toContain('Result: "result 2"');
    // Search keeps its content with its owner: identity, outcome and call_ref only.
    expect(block!.entries[2]!.full).toBe(block!.entries[2]!.compact);
    expect(block!.entries[2]!.full).toContain("Web search Synthetic Search: executed");
    expect(block!.footer).toBe("- Also 1 read, status or tool-search call (not listed).");
    expect((await project(false))[0]!.header).not.toContain("read_tool_call");

    // A revoked grant leaves identity and outcome; details are never projected.
    await prisma.mcpGrant.delete({ where: { serverId_userId: { serverId: f.serverId, userId: f.initiatorId } } });
    const revoked = (await project())[0]!;
    expect(revoked.entries[1]!.compact).toBe(block!.entries[1]!.compact);
    expect(revoked.entries[1]!.full).toContain("Arguments: unavailable to this run. Result: unavailable to this run.");
    expect(JSON.stringify(revoked)).not.toContain("item 2");
    await prisma.mcpGrant.create({ data: { serverId: f.serverId, userId: f.initiatorId, canUse: true } });

    // A call whose immutable facts no longer match the frozen digest.
    await prisma.modelRunToolCall.update({ where: { id: c2.id }, data: { ordinal: 7 } });
    const changed = (await project())[0]!;
    expect(changed.entries).toEqual([]);
    expect(changed.footer).toContain("3 recorded calls have saved details that are no longer available");
    // A reader without access to the chat learns nothing either.
    const stranger = await operations.projectToolHistory({ reader: false, toolHistory,
      actor: { chatId: f.chat.id, leafMessageId: regenerated.answer.id, userId: f.strangerId } });
    expect(stranger.blocks[0]!.entries).toEqual([]);
  });

  it("redacts known secret values and withholds arguments whose redaction cannot be proven", async () => {
    const f = await fixture({ sensitive: true });
    const answered = await f.answer(await f.question(null));
    await f.call(answered, { round: 1, ordinal: 0, item: 1 });
    const current = await f.answer(await f.question(answered.answer.id), { status: "in_progress" });
    const toolHistory = await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: answered.answer.id, userId: f.initiatorId });
    const entry = async () =>
      (await operations.projectToolHistory({ actor: current.actor, reader: true, toolHistory })).blocks[0]!.entries[0]!;

    const redacted = await entry();
    expect(redacted.full).toContain('Arguments: {"authorization":"[REDACTED]","query":"item 1"}');
    expect(redacted.full).not.toContain(syntheticSecret);
    // Another key cannot open the accepted generation: the sensitive slot is unverified.
    vi.stubEnv("AIQSA_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const unverified = await entry();
    expect(unverified.full).toContain("Arguments: withheld (their secrets cannot be verified as redacted)");
    expect(unverified.full).toContain('Result: "result 1"');
    expect(unverified.full).not.toContain("item 1");
    expect(unverified.full).not.toContain(syntheticSecret);
    vi.stubEnv("AIQSA_ENCRYPTION_KEY", "");
    expect((await entry()).full).toContain("Arguments: withheld (their secrets cannot be verified as redacted)");
  });

  it("authorizes Project records by the reading run's initiator", async () => {
    const f = await fixture({ project: true });
    const answered = await f.answer(await f.question(null));
    const saved = await f.call(answered, { round: 1, ordinal: 0, item: 1 });
    await prisma.mcpToolAccessPolicy.create({ data: { serverId: f.serverId, toolName: "records", restricted: true,
      users: { create: { userId: f.initiatorId } } } });
    const member = await f.answer(await f.question(answered.answer.id, f.memberId), { status: "in_progress", userId: f.memberId });
    const toolHistory = await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: answered.answer.id, userId: f.memberId });
    expect(toolHistory.turns[0]!.callRefs).toEqual([ref(saved)]);
    // The restricted participant sees that the call happened and its outcome, never its details.
    const entry = (await operations.projectToolHistory({ actor: member.actor, reader: true, toolHistory })).blocks[0]!.entries[0]!;
    expect(entry.full).toContain("executed; the tool reported success");
    expect(entry.full).toContain("Arguments: unavailable to this run. Result: unavailable to this run.");
    expect(await operations.readToolCall(member.actor, ref(saved))).toMatchObject({
      arguments: { state: "withheld", reason: "access_unavailable" }, result: { state: "withheld" } });
    expect(await operations.toolCallsAvailable(member.actor, [ref(saved)])).toBe(false);
    // The initiator, whom the restriction allows, reads them in a later turn.
    await prisma.modelRun.update({ where: { id: member.run.id }, data: { status: "complete" } });
    const initiator = await f.answer(await f.question(member.answer.id), { status: "in_progress" });
    expect((await operations.readToolCall(initiator.actor, ref(saved)))?.arguments).toEqual({ state: "available", text: '{"query":"item 1"}' });
    expect(await operations.toolCallsAvailable(initiator.actor, [ref(saved)])).toBe(true);
  });

  it("reads the fifth of ten calls with repeated ordinals and refuses other edits, chats, users and revoked details", async () => {
    const f = await fixture();
    const first = await f.question(null);
    const answered = await f.answer(first);
    const calls = [];
    for (let item = 0; item < 10; item += 1) calls.push(await f.call(answered, { round: 1 + Math.floor(item / 5), ordinal: item % 5, item }));
    const current = await f.answer(await f.question(answered.answer.id), { status: "in_progress" });

    expect(await operations.readToolCall(current.actor, ref(calls[4]!))).toMatchObject({ ref: ref(calls[4]!), previousAttempt: false,
      roundIndex: 1, ordinal: 4, outcome: { status: "succeeded", dispatched: true },
      arguments: { state: "available", text: '{"query":"item 4"}' }, result: { state: "inline", text: "result 4" } });
    // The same ordinal in the next round is another call.
    expect(await operations.readToolCall(current.actor, ref(calls[9]!))).toMatchObject({ roundIndex: 2, ordinal: 4,
      arguments: { text: '{"query":"item 9"}' }, result: { text: "result 9" } });
    // Unknown and malformed references, another user and another chat are refused alike.
    expect(await operations.readToolCall(current.actor, `tcr1_${"0".repeat(32)}`)).toBeNull();
    expect(await operations.readToolCall(current.actor, "tcr1_not-a-call")).toBeNull();
    expect(await operations.readToolCall({ ...current.actor, userId: f.strangerId }, ref(calls[4]!))).toBeNull();
    const other = await fixture();
    const foreign = await other.answer(await other.question(null), { status: "in_progress" });
    expect(await operations.readToolCall(foreign.actor, ref(calls[4]!))).toBeNull();
    expect(await operations.toolCallsAvailable(current.actor, [ref(calls[4]!), ref(calls[9]!)])).toBe(true);
    expect(await operations.toolCallsAvailable(foreign.actor, [ref(calls[4]!)])).toBe(false);

    // Another edit of the first message never reads the original branch's calls.
    await prisma.modelRun.update({ where: { id: current.run.id }, data: { status: "complete" } });
    const edit = await f.answer(await f.question(null), { status: "in_progress" });
    expect(await operations.readToolCall(edit.actor, ref(calls[4]!))).toBeNull();
    expect(await operations.toolCallsAvailable(edit.actor, [ref(calls[4]!)])).toBe(false);
    // A regeneration of the first message reads them as its earlier attempt.
    await prisma.modelRun.update({ where: { id: edit.run.id }, data: { status: "complete" } });
    const regenerated = await f.answer(first, { status: "in_progress" });
    expect(await operations.readToolCall(regenerated.actor, ref(calls[4]!))).toMatchObject({ previousAttempt: true,
      arguments: { state: "available" } });
    // A revocation between two reads is never served from an earlier read.
    await prisma.mcpGrant.delete({ where: { serverId_userId: { serverId: f.serverId, userId: f.initiatorId } } });
    expect(await operations.readToolCall(regenerated.actor, ref(calls[4]!))).toMatchObject({
      outcome: { status: "succeeded" }, arguments: { state: "withheld", reason: "access_unavailable" }, result: { state: "withheld" } });
    expect(await operations.toolCallsAvailable(regenerated.actor, [ref(calls[4]!)])).toBe(false);
  });

  it("treats a Search call of an option that is no longer available as unavailable", async () => {
    const f = await fixture();
    const answered = await f.answer(await f.question(null));
    const search = await f.call(answered, { round: 1, ordinal: 0, item: 1, name: "search_engine_1" });
    const current = await f.answer(await f.question(answered.answer.id), { status: "in_progress" });
    expect(await operations.readToolCall(current.actor, ref(search))).toMatchObject({ kind: "web_search",
      arguments: { state: "not_applicable" }, result: { state: "not_applicable" } });
    expect(await operations.toolCallsAvailable(current.actor, [ref(search)])).toBe(false);
    expect(await operations.toolCallsAvailable(current.actor, [])).toBe(true);
    expect(await operations.toolCallsAvailable(current.actor, ["not-a-ref"])).toBe(false);
  });
});

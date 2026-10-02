// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { validateMcpDraft } from "../mcp/definitions";
import { encryptMcpEnvelope, mcpRuntimeGenerationEnvelopeContext } from "../mcp/encryption";
import { namespacedMcpToolName } from "../mcp/runPlan";
import { prisma } from "../prisma";
import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
import { agentLimits } from "../agents/config";
import { agentPrompts } from "../agents/prompt";
import { createAgentRunStore } from "../agents/store";
import type { ProviderRunRequest } from "../providers/types";
import { createPrismaToolHistoryOperations } from "./prismaRepositoryToolHistory";
import { insertToolHistory } from "./toolHistory";
import { toolCallRef, toolHistoryDigest } from "./toolHistoryContract";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const clean of cleanups.splice(0).reverse()) await clean(); }
  finally { vi.unstubAllEnvs(); }
});

const operations = createPrismaToolHistoryOperations(prisma);
// Quote and backslash: a JSON text result carries this secret only escaped.
const syntheticSecret = 'synthetic-"tool\\history"-secret';
const escapedSecret = JSON.stringify(syntheticSecret).slice(1, -1);
const readers = { call: true, result: true } as const;
const agentConfiguration = { ...agentLimits({ ...DEFAULT_AGENT_POLICY, limitsEnabled: true }, { AIQSA_AGENT_GATEWAY_URL: "http://agent.invalid" }),
  compatibilityHash: "a".repeat(64), mcpMode: "auto" as const };
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
    agent?: boolean; eligible?: boolean; status?: RunStatus; userId?: string;
  }> = {}) => {
    const userId = input.userId ?? initiatorId;
    const status = input.status ?? "complete";
    const message = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", parentMessageId: userMessage.id,
      status: status === "in_progress" ? "streaming" : status, content: textMessageContent("Synthetic answer") } });
    const run = await prisma.modelRun.create({ data: { chatId: chat.id, userId, userMessageId: userMessage.id,
      assistantMessageId: message.id, provider: "fake", modelId: "fake-qsa", status, createdAt: new Date(clock += 1000),
      normalizedRequest: { ...accepted(input.eligible ?? true), ...(input.agent ? { agent: agentConfiguration } : {}) },
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
  return { chat, initiatorId, memberId, strangerId, serverId, revisionId, generationId, fingerprint, toolName, question, answer, call };
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
      version: 1, turns: [{ turnMessageId: regenerated.answer.id, userMessageId: first.id, callRefs: [c1, c2, c3].map(ref),
        digest: toolHistoryDigest([c1, c2, c3]), readerCalls: 2 }] });
    // A regeneration of the second message lists its earlier attempt under that message.
    const regeneration = await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: second.id, userId: f.initiatorId });
    expect(regeneration.turns.map(turn => turn.turnMessageId)).toEqual([regenerated.answer.id, second.id]);
    expect(regeneration.turns[1]).toEqual({ turnMessageId: second.id, userMessageId: second.id, callRefs: [ref(c5)],
      digest: toolHistoryDigest([c5]) });
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
      (await operations.projectToolHistory({ actor: current.actor, readers: { call: reader, result: true }, toolHistory })).blocks;

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
    const stranger = await operations.projectToolHistory({ readers: { call: false, result: false }, toolHistory,
      actor: { chatId: f.chat.id, leafMessageId: regenerated.answer.id, userId: f.strangerId } });
    expect(stranger.blocks[0]!.entries).toEqual([]);
  });

  it("redacts known secret values, escaped ones included, and withholds details whose redaction cannot be proven", async () => {
    const f = await fixture({ sensitive: true });
    const answered = await f.answer(await f.question(null));
    const echoed = await f.call(answered, { round: 1, ordinal: 0, item: 1 });
    // Execution redacted only the raw value; the server echoed it escaped inside JSON text.
    await prisma.modelRunToolCall.update({ where: { id: echoed.id }, data: { result: { callId: echoed.providerCallId, name: echoed.toolName,
      status: "complete", content: [{ type: "text", text: JSON.stringify({ echoed: syntheticSecret, item: 1 }) }],
      rawPreview: { isError: false, unsupportedContentTypes: [] } } } });
    const current = await f.answer(await f.question(answered.answer.id), { status: "in_progress" });
    const toolHistory = await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: answered.answer.id, userId: f.initiatorId });
    const entry = async () =>
      (await operations.projectToolHistory({ actor: current.actor, readers, toolHistory })).blocks[0]!.entries[0]!;

    const redacted = await entry();
    expect(redacted.full).toContain('Arguments: {"authorization":"[REDACTED]","query":"item 1"}');
    expect(redacted.full).toContain("[REDACTED]\\\",\\\"item\\\":1");
    for (const leaked of [syntheticSecret, escapedSecret]) expect(redacted.full).not.toContain(leaked);
    const read = await operations.readToolCall(current.actor, ref(echoed));
    for (const leaked of [syntheticSecret, escapedSecret]) expect(JSON.stringify(read)).not.toContain(leaked);
    // Another key cannot open the accepted generation: the sensitive slot is unverified.
    vi.stubEnv("AIQSA_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const unverified = await entry();
    expect(unverified.full).toContain("executed; the tool reported success");
    expect(unverified.full).toContain("Arguments: withheld (their secrets cannot be verified as redacted)");
    expect(unverified.full).toContain("Result: withheld (its secrets cannot be verified as redacted)");
    for (const leaked of [syntheticSecret, escapedSecret, "item 1"]) expect(unverified.full).not.toContain(leaked);
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
    const entry = (await operations.projectToolHistory({ actor: member.actor, readers, toolHistory })).blocks[0]!.entries[0]!;
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

  it("names saved values too large for a record by size, keeps their outcome and reads them whole on request", async () => {
    const f = await fixture();
    const answered = await f.answer(await f.question(null));
    const large = await f.call(answered, { round: 1, ordinal: 0, item: 1 });
    await prisma.modelRunToolCall.update({ where: { id: large.id }, data: {
      arguments: { query: "item 1", body: "x".repeat(40_000) },
      result: { callId: large.providerCallId, name: large.toolName, status: "error",
        content: [{ type: "text", text: "e".repeat(40_000) }], rawPreview: { isError: true, unsupportedContentTypes: [] } } } });
    await f.call(answered, { round: 1, ordinal: 1, item: 2 });
    const current = await f.answer(await f.question(answered.answer.id), { status: "in_progress" });
    const toolHistory = await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: answered.answer.id, userId: f.initiatorId });
    const [omitted, whole] = (await operations.projectToolHistory({ actor: current.actor, readers, toolHistory })).blocks[0]!.entries;
    expect(omitted!.ref).toBe(ref(large));
    // The envelope still proves the tool's own error; the values are named by size.
    expect(omitted!.full).toContain("executed; the tool reported an error");
    expect(omitted!.full).toContain("Arguments: large, not shown here; read_tool_call returns them");
    expect(omitted!.full).toContain("Result: large, not shown here; read_tool_call returns it");
    expect(omitted!.full).not.toContain("xxxx");
    expect(whole!.full).toContain('Arguments: {"query":"item 2"}');
    // The reader loads the one call whole and pages it.
    const read = await operations.readToolCall(current.actor, ref(large));
    expect(read).toMatchObject({ outcome: { status: "tool_error" }, arguments: { state: "available" }, result: { state: "inline" } });
    expect(read?.arguments.state === "available" ? read.arguments.text.length : 0).toBeGreaterThan(40_000);
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

describe("Agent runs", () => {
  /** Agent turns of one chat on one Workspace session, with their admitted MCP tool. */
  async function agentFixture() {
    const f = await fixture();
    const session = await prisma.workspaceSession.create({ data: { chatId: f.chat.id, sandboxName: `history-${randomUUID()}`,
      imageRef: "aiqsa-workspace:0.1.30", internetEnabled: true, policyRevision: 1, runtimeSandboxId: "fixture-runtime",
      state: "RUNNING", expiresAt: new Date(Date.now() + 600_000) } });
    cleanups.push(async () => {
      await prisma.modelRun.deleteMany({ where: { chatId: f.chat.id } });
      await prisma.workspaceSession.deleteMany({ where: { id: session.id } });
    });
    const agentTurn = async (userMessage: Readonly<{ id: string }>, status: RunStatus) => {
      const turn = await f.answer(userMessage, { agent: true, status });
      await prisma.workspaceRunBinding.create({ data: { modelRunId: turn.run.id, workspaceSessionId: session.id,
        imageRef: session.imageRef, internetEnabled: true, policyRevision: 1, runtimeVersion: "0.6.16", mcpVersion: "0.6.16",
        toolCatalogHash: "a".repeat(64), toolDefinitions: [{ originalName: "sandbox_exec_start", namespacedName: "workspace__sandbox_exec_start",
          description: "Fixture", inputSchema: { type: "object" } }], outputDirectory: `/workspace/output/${turn.run.id}` } });
      await prisma.agentRunBinding.create({ data: { modelRunId: turn.run.id, configuration: agentConfiguration,
        compatibilityHash: agentConfiguration.compatibilityHash,
        ...(status === "complete" ? { startedAt: new Date(), completedAt: new Date(),
          tokenHash: createHash("sha256").update(randomUUID()).digest("hex") } : {}) } });
      await prisma.agentMcpTool.create({ data: { modelRunId: turn.run.id, toolId: f.toolName, version: "v".repeat(64), snapshot: {
        servers: [{ serverId: f.serverId, revisionId: f.revisionId, fingerprint: f.fingerprint, serverName: "Synthetic Records" }],
        tools: [{ namespacedName: f.toolName, originalName: "records", serverId: f.serverId, serverName: "Synthetic Records" }] } } });
      return turn;
    };
    return { ...f, agentTurn };
  }

  it("projects earlier Agent calls into the first prompt of a run whose binding is not armed yet, and reads them once armed", async () => {
    const f = await agentFixture();
    const first = await f.question(null);
    const earlier = await f.agentTurn(first, "complete");
    // The gateway keeps only a content-free settlement of an Agent MCP call.
    const write = await prisma.modelRunToolCall.create({ data: { modelRunId: earlier.run.id, mcpRunBindingId: earlier.binding.id,
      roundIndex: 0, ordinal: 0, providerCallId: `agent-call-${randomUUID()}`, toolName: f.toolName, state: "complete",
      startedAt: new Date(), arguments: { argumentHash: "h".repeat(64) }, result: { state: "COMPLETE", code: null } } });
    const second = await f.question(earlier.answer.id);
    const current = await f.agentTurn(second, "in_progress");
    const toolHistory = await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: earlier.answer.id, userId: f.initiatorId });
    expect(toolHistory.turns.map(turn => turn.callRefs)).toEqual([[ref(write)]]);

    // Before arming: the run's own projection reads; its saved-call reader does not.
    const projection = await operations.projectToolHistory({ actor: current.actor, readers: { call: true, result: false }, toolHistory });
    const [entry] = projection.blocks[0]!.entries;
    expect(entry!.full).toContain(`[${ref(write)}] MCP Synthetic Records › records (tool ${f.toolName}): executed; the tool reported success`);
    expect(entry!.full).toContain("Arguments: not retained");
    expect(await operations.readToolCall(current.actor, ref(write))).toBeNull();
    // A fresh native thread receives it in its full prompt; the real answer stays the predecessor.
    const request = { attachments: [], content: textMessageContent("Did the write happen?"), prompt: { developer: null, system: "baseline" },
      context: { mode: "branch_path", messages: [
        { id: first.id, role: "user", content: textMessageContent("Write the record") },
        { id: earlier.answer.id, role: "assistant", content: textMessageContent("Written.") },
        { id: second.id, role: "user", content: textMessageContent("Did the write happen?") }
      ] } } as unknown as ProviderRunRequest;
    const prompts = agentPrompts(insertToolHistory(request, projection));
    expect(prompts.prompt).toContain(ref(write));
    expect(prompts.prompt).toContain("MCP Synthetic Records › records");
    expect(prompts.previousAssistantMessageId).toBe(earlier.answer.id);

    // A revoked binding is never read, armed or not.
    await prisma.agentRunBinding.update({ where: { modelRunId: current.run.id }, data: { revokedAt: new Date() } });
    const revoked = await operations.projectToolHistory({ actor: current.actor, readers: { call: true, result: false }, toolHistory });
    expect(revoked.blocks[0]!.entries).toEqual([]);
    await prisma.agentRunBinding.update({ where: { modelRunId: current.run.id }, data: { revokedAt: null } });

    // Armed by its executor, the run's reader reads the call.
    await createAgentRunStore(prisma, { runId: current.run.id, userId: f.initiatorId, configuration: agentConfiguration }).arm(null);
    expect(await operations.readToolCall(current.actor, ref(write))).toMatchObject({ ref: ref(write), kind: "mcp",
      outcome: { status: "succeeded" }, arguments: { state: "not_retained" } });
  });
});

describe("admission listing bounds", () => {
  /** A branch of `turns` user turns, each answered with `calls` MCP calls. */
  async function branch(turns: number, calls: number) {
    const f = await fixture();
    const made: Array<Readonly<{ id: string }>> = [];
    let leaf: string | null = null;
    for (let turn = 0; turn < turns; turn += 1) {
      const answered = await f.answer(await f.question(leaf));
      for (let index = 0; index < calls; index += 1) made.push(await f.call(answered, { round: 1, ordinal: index, item: turn * 10 + index }));
      leaf = answered.answer.id;
    }
    return { f, leaf: leaf!, made };
  }

  it("counts every older call beyond the call, turn and scanned-run bounds instead of dropping it", async () => {
    const { f, leaf, made } = await branch(4, 2);
    const load = (bounds: Parameters<typeof createPrismaToolHistoryOperations>[1]) =>
      createPrismaToolHistoryOperations(prisma, bounds).loadToolHistory({ chatId: f.chat.id, leafMessageId: leaf, userId: f.initiatorId });
    const listed = (history: Awaited<ReturnType<typeof load>>) => history.turns.flatMap(turn => turn.callRefs);
    // The newest three calls stay listed.
    const byCalls = await load({ calls: 3 });
    expect(listed(byCalls)).toEqual(made.slice(-3).map(ref));
    expect(byCalls.omittedCalls).toBe(5);
    // Two turns at most: the older turns' calls are counted.
    const byTurns = await load({ turns: 2, scanBatchRuns: 1 });
    expect(byTurns.turns).toHaveLength(2);
    expect(listed(byTurns)).toEqual(made.slice(-4).map(ref));
    expect(byTurns.omittedCalls).toBe(4);
    // Runs beyond the scan bound are counted without being read.
    const byScan = await load({ scannedRuns: 1 });
    expect(listed(byScan)).toEqual(made.slice(-2).map(ref));
    expect(byScan.omittedCalls).toBe(6);
    // Within every bound nothing is omitted.
    const whole = await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: leaf, userId: f.initiatorId });
    expect(listed(whole)).toEqual(made.map(ref));
    expect(whole.omittedCalls).toBeUndefined();
  });

  it("never counts calls of runs admitted before the history contract as omitted", async () => {
    const f = await fixture();
    const made: Array<Readonly<{ id: string }>> = [];
    let leaf: string | null = null;
    // Two turns answered before the contract, then three under it; two calls each.
    for (let turn = 0; turn < 5; turn += 1) {
      const answered = await f.answer(await f.question(leaf), { eligible: turn >= 2 });
      for (let index = 0; index < 2; index += 1) {
        const created = await f.call(answered, { round: 1, ordinal: index, item: turn * 10 + index });
        if (turn >= 2) made.push(created);
      }
      leaf = answered.answer.id;
    }
    const load = (bounds: Parameters<typeof createPrismaToolHistoryOperations>[1]) =>
      createPrismaToolHistoryOperations(prisma, bounds).loadToolHistory({ chatId: f.chat.id, leafMessageId: leaf, userId: f.initiatorId });
    // Beyond the scan bound only the eligible runs' calls are counted, unread.
    const byScan = await load({ scannedRuns: 1 });
    expect(byScan.turns.flatMap(turn => turn.callRefs)).toEqual(made.slice(-2).map(ref));
    expect(byScan.omittedCalls).toBe(4);
    // A scan that reaches them lists every eligible call and counts nothing older.
    const byTurns = await load({ turns: 3, scanBatchRuns: 4 });
    expect(byTurns.turns.flatMap(turn => turn.callRefs)).toEqual(made.map(ref));
    expect(byTurns.omittedCalls).toBeUndefined();
  });
});

describe("history reads of a long chat", () => {
  it("loads and projects a long chat with large accepted requests and values well within the transaction bound", { timeout: 300_000 }, async () => {
    const f = await fixture();
    const turns = 240;
    const filler = "Synthetic accepted context line. ".repeat(3_000);
    const bigValue = "v".repeat(40_000);
    let parent: string | null = null;
    const runIds: string[] = [];
    let clock = Date.now() - 3_600_000;
    for (let turn = 0; turn < turns; turn += 1) {
      const question: Readonly<{ id: string }> = await prisma.message.create({ data: { chatId: f.chat.id, role: "user", status: "complete",
        parentMessageId: parent, content: textMessageContent(`Synthetic question ${turn}`) } });
      const answer: Readonly<{ id: string }> = await prisma.message.create({ data: { chatId: f.chat.id, role: "assistant", status: "complete",
        parentMessageId: question.id, content: textMessageContent(`Synthetic answer ${turn}`) } });
      const run = await prisma.modelRun.create({ data: { chatId: f.chat.id, userId: f.initiatorId, userMessageId: question.id,
        assistantMessageId: answer.id, provider: "fake", modelId: "fake-qsa", status: "complete", createdAt: new Date(clock += 1_000),
        normalizedRequest: { context: { mode: "branch_path", messages: [{ id: question.id, role: "user", content: textMessageContent(filler) }] },
          workspace: { enabled: true }, toolHistory: { version: 1, turns: [] },
          mcp: { version: 1, servers: [{ serverId: f.serverId, revisionId: f.revisionId, fingerprint: f.fingerprint, serverName: "Synthetic Records" }],
            tools: [{ namespacedName: f.toolName, originalName: "records", serverId: f.serverId, serverName: "Synthetic Records" }] } } } });
      runIds.push(run.id);
      parent = answer.id;
    }
    const bindings = await Promise.all(runIds.map(async (modelRunId) => prisma.mcpRunBinding.create({ data: { modelRunId,
      runtimeGenerationId: f.generationId, runtimeGenerationFingerprint: f.fingerprint } })));
    // Three calls per turn; a third carry large arguments and a third large results.
    await prisma.modelRunToolCall.createMany({ data: runIds.flatMap((modelRunId, turn) => [0, 1, 2].map((ordinal) => {
      const providerCallId = `call-${turn}-${ordinal}`;
      return { modelRunId, mcpRunBindingId: bindings[turn]!.id, roundIndex: 1, ordinal, providerCallId, toolName: f.toolName,
        state: "complete" as const, startedAt: new Date(),
        arguments: ordinal === 1 ? { query: `item ${turn}`, body: bigValue } : { query: `item ${turn}` },
        result: { callId: providerCallId, name: f.toolName, status: "complete",
          content: [{ type: "text", text: ordinal === 2 ? bigValue : `result ${turn}-${ordinal}` }],
          rawPreview: { isError: false, unsupportedContentTypes: [] } } };
    })) });
    const current = await f.answer(await f.question(parent), { status: "in_progress" });

    const loadStarted = performance.now();
    const toolHistory = await operations.loadToolHistory({ chatId: f.chat.id, leafMessageId: parent, userId: f.initiatorId });
    const loadMs = performance.now() - loadStarted;
    expect(toolHistory.turns).toHaveLength(turns);
    const cache = new Map<string, unknown>();
    const projectStarted = performance.now();
    const projection = await operations.projectToolHistory({ actor: current.actor, readers, toolHistory, cache });
    const projectMs = performance.now() - projectStarted;
    const repeatStarted = performance.now();
    await operations.projectToolHistory({ actor: current.actor, readers, toolHistory, cache });
    const repeatMs = performance.now() - repeatStarted;
    expect(projection.blocks).toHaveLength(turns);
    expect(projection.blocks.every((block) => block.entries.length === 3)).toBe(true);
    const lines = projection.blocks.flatMap((block) => block.entries.map((entry) => entry.full));
    expect(lines.filter((line) => line.includes("Arguments: large, not shown here"))).toHaveLength(turns);
    expect(lines.filter((line) => line.includes("Result: large, not shown here"))).toHaveLength(turns);
    process.stdout.write(JSON.stringify({ toolHistoryTiming: { turns, calls: turns * 3, loadMs: Math.round(loadMs),
      projectMs: Math.round(projectMs), repeatProjectMs: Math.round(repeatMs) } }) + "\n");
    // Far below the bound a slower read would degrade under.
    for (const duration of [loadMs, projectMs, repeatMs]) expect(duration).toBeLessThan(5_000);
  });
});

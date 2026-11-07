// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { textMessageContent } from "../../domain/content";
import { saveToolResultText } from "../engine/toolResults";
import { namespacedMcpToolName } from "../mcp/runPlan";
import { prisma } from "../prisma";
import type { ToolObservationSourceBinding } from "./contract";
import { createToolObservationRepository, type ObservationActor } from "./repository";
import { createToolObservationService } from "./service";
import { createObservationSourceOwners } from "./sourceOwners";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const ORIGINAL_NAME = "get_card";

/** One user's chat with a main-agent run that holds an accepted binding of an enabled installation MCP server. */
async function fixture() {
  const user = await prisma.user.create({ data: { id: randomUUID(), displayName: "Synthetic MCP observation owner", status: "active" } });
  const chat = await prisma.chat.create({ data: { title: "Synthetic MCP observation chat", userId: user.id } });
  const namespace = `obs${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const server = await prisma.mcpServer.create({ data: { namespace, displayName: "Synthetic tracker", enabled: true } });
  const revision = await prisma.mcpRevision.create({ data: { serverId: server.id, revisionNumber: 1, configuration: {},
    validationEvidence: {}, draftHash: "synthetic-draft", identityHash: "synthetic-identity" } });
  await prisma.mcpServer.update({ where: { id: server.id }, data: { activeRevisionId: revision.id } });
  await prisma.mcpGrant.create({ data: { serverId: server.id, userId: user.id, canUse: true } });
  const userServer = await prisma.mcpUserServer.create({ data: { serverId: server.id, userId: user.id, enabled: true } });
  const fingerprint = createHash("sha256").update(randomUUID()).digest("hex");
  const generation = await prisma.mcpRuntimeGeneration.create({ data: { revisionId: revision.id, fingerprint, userServerId: userServer.id } });
  cleanups.push(async () => {
    await prisma.modelRun.deleteMany({ where: { chatId: chat.id } });
    await prisma.chat.updateMany({ where: { id: chat.id }, data: { activeLeafMessageId: null } });
    await prisma.message.deleteMany({ where: { chatId: chat.id } });
    await prisma.chat.deleteMany({ where: { id: chat.id } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: user.id, targetId: chat.id } });
    await prisma.mcpRuntimeGeneration.deleteMany({ where: { id: generation.id } });
    await prisma.mcpUserServer.deleteMany({ where: { serverId: server.id } });
    await prisma.mcpGrant.deleteMany({ where: { serverId: server.id } });
    await prisma.mcpServer.update({ where: { id: server.id }, data: { activeRevisionId: null } });
    await prisma.mcpRevision.deleteMany({ where: { serverId: server.id } });
    await prisma.mcpServer.deleteMany({ where: { id: server.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  });

  const mainRun = async (status: "complete" | "in_progress" = "in_progress") => {
    const question = await prisma.message.create({ data: { chatId: chat.id, role: "user", status: "complete",
      content: textMessageContent("Read the synthetic card") } });
    const answer = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", status: "streaming",
      parentMessageId: question.id, content: textMessageContent("") } });
    const run = await prisma.modelRun.create({ data: { chatId: chat.id, userId: user.id, userMessageId: question.id,
      assistantMessageId: answer.id, engine: "native", provider: "fake", modelId: "fake-qsa", normalizedRequest: {}, status } });
    const binding = await prisma.mcpRunBinding.create({ data: { modelRunId: run.id, runtimeGenerationId: generation.id,
      runtimeGenerationFingerprint: fingerprint } });
    return { id: run.id, userMessageId: question.id, bindingId: binding.id };
  };
  let ordinal = 0;
  const call = async (runId: string, toolName: string, mcpRunBindingId?: string) => {
    const row = await prisma.modelRunToolCall.create({ data: { modelRunId: runId, roundIndex: 1, ordinal: ordinal++,
      providerCallId: randomUUID(), toolName, arguments: {}, state: "running", ...(mcpRunBindingId ? { mcpRunBindingId } : {}) } });
    return row.id;
  };
  /** A background sub-agent turn's own run, as `backgroundRunner.ts` admits it: it holds no MCP binding rows. */
  const background = async (parentRunId: string, anchorRunId: string, userMessageId: string, parentThreadId?: string) => {
    const parentCall = await call(parentRunId, "call_subagent");
    const thread = await prisma.subagentThread.create({ data: { anchorRunId, chatId: chat.id, name: `agent-${ordinal}`,
      userId: user.id, ...(parentThreadId ? { parentThreadId } : {}) } });
    const turn = await prisma.subagentTurn.create({ data: { chatId: chat.id, mode: "background", modelId: "fake-qsa", parentRunId,
      parentToolCallId: parentCall, provider: "fake", threadId: thread.id, userId: user.id } });
    const run = await prisma.modelRun.create({ data: { chatId: chat.id, engine: "native", modelId: "fake-qsa", normalizedRequest: {},
      provider: "fake", status: "streaming", subagentThreadId: thread.id, subagentTurnId: turn.id, userId: user.id, userMessageId } });
    return { id: run.id, threadId: thread.id };
  };

  const repository = createToolObservationRepository({ prisma, ...createObservationSourceOwners() });
  const service = createToolObservationService({ repository, storage: createMemoryStorageAdapter() });
  const sourceBinding: ToolObservationSourceBinding = { version: 1, source: "mcp", serverId: server.id, originalName: ORIGINAL_NAME,
    revisionId: revision.id, fingerprint };
  const toolName = namespacedMcpToolName(namespace, ORIGINAL_NAME);
  /** Saves a long MCP result the way the engine does, then reads it back by handle as the producing agent would. */
  const saveAndRead = async (runId: string, mcpRunBindingId: string) => {
    const producer = { runId, toolCallId: await call(runId, toolName, mcpRunBindingId), userId: user.id };
    const saved = await saveToolResultText({ outcome: "complete", producer, service, source: "mcp", sourceBinding,
      text: "card ".repeat(8_000) });
    if (!("handle" in saved)) return saved;
    await prisma.modelRunToolCall.update({ where: { id: producer.toolCallId }, data: { state: "complete" } });
    const actor: ObservationActor = { runId, userId: user.id };
    const read = await repository.read(actor, saved.handle.slice(5));
    return { handle: saved.handle, state: read.state };
  };
  return { background, mainRun, saveAndRead };
}

describe("MCP observation source authority", () => {
  it("saves and reads a main-agent run's MCP result under its own binding", async () => {
    const f = await fixture();
    const main = await f.mainRun();
    expect(await f.saveAndRead(main.id, main.bindingId)).toMatchObject({ state: "READY" });
  });

  it("saves and reads a background sub-agent's MCP result under the binding of the main-agent run behind it", async () => {
    const f = await fixture();
    const main = await f.mainRun();
    const child = await f.background(main.id, main.id, main.userMessageId);
    // Every MCP result of a background sub-agent was refused here before the fix (909 of 909 in a week on a production install).
    expect(await f.saveAndRead(child.id, main.bindingId)).toMatchObject({ state: "READY" });
    const grandchild = await f.background(child.id, main.id, main.userMessageId, child.threadId);
    expect(await f.saveAndRead(grandchild.id, main.bindingId)).toMatchObject({ state: "READY" });
  });

  it("refuses a binding held by any other run of the chat", async () => {
    const f = await fixture();
    // One active main-agent run per chat: the other run of the chat has already ended.
    const other = await f.mainRun("complete");
    const main = await f.mainRun();
    const child = await f.background(main.id, main.id, main.userMessageId);
    expect(await f.saveAndRead(child.id, other.bindingId)).toEqual({ unsavedReason: "tool_observation_unavailable" });
    expect(await f.saveAndRead(main.id, other.bindingId)).toEqual({ unsavedReason: "tool_observation_unavailable" });
  });
});

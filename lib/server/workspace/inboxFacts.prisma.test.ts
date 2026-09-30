// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import { prisma } from "../prisma";
import { loadWorkspaceInboxFacts, type WorkspaceInboxFactsInput } from "./inboxFacts";
import { workspaceAncestorMessageIds, workspaceInboxAttachmentWhere } from "./inboxSelection";
import { workspaceFileReferences } from "./fileContext";
import type { ProviderConversationMessage } from "../providers/types";

const cleanups: Array<() => Promise<void>> = [];
const emptyFacts = { hasFiles: false, hasEarlierExports: false };
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
afterAll(async () => { await prisma.$disconnect(); });

async function fixture(project = false) {
  const userIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [userId, contributorId, viewerId, outsiderId] = userIds as [string, string, string, string];
  const chatId = randomUUID();
  const projectId = project ? randomUUID() : null;
  const storagePrefix = `inbox-facts/${chatId}/`;
  cleanups.push(async () => {
    await prisma.attachment.deleteMany({ where: { storageKey: { startsWith: storagePrefix } } });
    await prisma.modelRun.deleteMany({ where: { chatId } });
    await prisma.workspaceSession.deleteMany({ where: { chatId } });
    await prisma.chat.updateMany({ where: { id: chatId }, data: { activeLeafMessageId: null } });
    await prisma.message.deleteMany({ where: { chatId } });
    await prisma.chat.deleteMany({ where: { id: chatId } });
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { startsWith: storagePrefix } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await prisma.user.createMany({ data: userIds.map(id => ({ id, displayName: "Synthetic inbox actor", status: "active" })) });
  if (projectId) await prisma.project.create({ data: {
    id: projectId, name: "Synthetic inbox Project", createdByUserId: userId, createdByDisplayName: "Synthetic inbox actor",
    grants: { create: [{ userId, role: "OWNER" }, { userId: contributorId, role: "CONTRIBUTOR" }, { userId: viewerId, role: "VIEWER" }] }
  } });
  await prisma.chat.create({ data: { id: chatId, title: "Synthetic inbox", workspaceEnabled: true,
    ...(projectId ? { projectId, memoryMode: "EXCLUDED", createdByUserId: userId, createdByDisplayName: "Synthetic inbox actor" } : { userId }) } });
  const question = await prisma.message.create({ data: { chatId, role: "user", status: "complete", content: textMessageContent("Synthetic question"),
    ...(projectId ? { authorUserId: userId, authorDisplayName: "Synthetic inbox actor", authorProjectRole: "OWNER" } : {}) } });
  return { chatId, userId, contributorId, viewerId, outsiderId, projectId, storagePrefix, question,
    input: { chatId, userId, ...(projectId ? { projectId } : {}), leafMessageId: question.id, imageIds: [] } satisfies WorkspaceInboxFactsInput };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function attachment(f: Fixture, patch: Partial<Prisma.AttachmentUncheckedCreateInput> = {}) {
  return prisma.attachment.create({ data: { byteSize: 4, checksum: "a".repeat(64), chatId: f.chatId,
    fileName: "synthetic.txt", kind: "file", messageId: f.question.id, mimeType: "text/plain", metadata: {},
    storageKey: `${f.storagePrefix}${randomUUID()}`, status: "ready", origin: "USER_UPLOAD",
    ...(f.projectId ? { projectId: f.projectId, uploaderUserId: f.userId, uploaderDisplayName: "Synthetic inbox actor" } : { userId: f.userId }),
    ...patch } });
}

async function turn(f: Fixture, parentMessageId: string | null = f.question.id) {
  const question = await prisma.message.create({ data: { chatId: f.chatId, parentMessageId, role: "user", status: "complete", content: textMessageContent("Continue"),
    ...(f.projectId ? { authorUserId: f.userId, authorDisplayName: "Synthetic inbox actor", authorProjectRole: "OWNER" } : {}) } });
  const answer = await prisma.message.create({ data: { chatId: f.chatId, parentMessageId: question.id, role: "assistant", status: "complete", content: textMessageContent("Synthetic answer") } });
  const run = await prisma.modelRun.create({ data: { chatId: f.chatId, userId: f.userId,
    userMessageId: question.id, assistantMessageId: answer.id, status: "complete", normalizedRequest: {}, provider: "fake", modelId: "fake-qsa",
    ...(f.projectId ? { projectRunBinding: { create: { projectId: f.projectId, initiatorUserId: f.userId,
      acceptedRole: "OWNER", accessRevision: 1, policyRevision: 1, instructionsRevision: 1, memoryRevision: 0, personalMemoryDisabled: true } } } : {}) } });
  const session = await prisma.workspaceSession.upsert({ where: { chatId: f.chatId }, update: {}, create: {
    chatId: f.chatId, sandboxName: `inbox-facts-${randomUUID()}`, imageRef: "fixture:inbox", state: "STOPPED",
    internetEnabled: false, policyRevision: 1, expiresAt: new Date(Date.now() + 60_000)
  } });
  await prisma.workspaceRunBinding.create({ data: { modelRunId: run.id, workspaceSessionId: session.id,
    imageRef: "fixture:inbox", internetEnabled: false, policyRevision: 1, runtimeVersion: "fixture", mcpVersion: "fixture",
    toolCatalogHash: "b".repeat(64), toolDefinitions: [{ name: "synthetic_metadata_fixture" }],
    outputDirectory: workspaceRunOutputDirectory(run.id), exportState: "PENDING" } });
  return { question, answer, run, session };
}
type Turn = Awaited<ReturnType<typeof turn>>;

async function exported(f: Fixture, t: Turn, complete = true, status: "ready" | "processing" | "failed" = "ready") {
  await prisma.workspaceRunBinding.update({ where: { modelRunId: t.run.id }, data: { exportState: complete ? "COMPLETE" : "PENDING" } });
  return attachment(f, { origin: "WORKSPACE_OUTPUT", producerModelRunId: t.run.id, messageId: t.answer.id, status,
    workspaceRunOutput: { create: { workspaceRunBindingId: t.run.id, relativePath: `${randomUUID()}.txt`, checksum: "a".repeat(64), byteSize: 4 } } });
}

async function checkpoint(f: Fixture, t: Turn, settled: boolean) {
  const tool = await prisma.modelRunToolCall.create({ data: { modelRunId: t.run.id, workspaceRunBindingId: t.run.id,
    providerCallId: randomUUID(), roundIndex: 1, ordinal: 0, arguments: {}, toolName: "checkpoint_outputs", state: "complete" } });
  const captureId = randomUUID().replaceAll("-", "");
  const relativePath = "project/checkpoint.txt";
  const selection = [{ root: "project", relativePath: "checkpoint.txt" }];
  const operation = { generation: 1, owner: `run:${t.run.id}` };
  await prisma.workspaceSelectedCapture.create({ data: { id: captureId, modelRunId: t.run.id, workspaceSessionId: t.session.id,
    runtimeSandboxId: "synthetic-unstarted-guest", requestKey: randomUUID(), requestHash: "b".repeat(64),
    producerGeneration: 1, producerOwner: operation.owner, selection: { files: selection, producerOperation: operation } } });
  const file = await attachment(f, { origin: "WORKSPACE_OUTPUT", producerModelRunId: t.run.id, messageId: t.answer.id });
  await prisma.workspaceCapturedFile.create({ data: { captureId, relativePath, byteSize: file.byteSize, checksum: file.checksum!,
    mimeType: file.mimeType, storageKey: file.storageKey, storageState: "READY" } });
  await prisma.workspaceSelectedCapture.update({ where: { id: captureId }, data: { state: "CAPTURED", sealedAt: new Date() } });
  const saved = await prisma.workspaceOutputCheckpoint.create({ data: { modelRunId: t.run.id, toolCallId: tool.id,
    requestHash: "b".repeat(64), description: "Synthetic checkpoint", selection, arguments: {}, captureId } });
  await prisma.workspaceCheckpointFile.create({ data: { checkpointId: saved.id, captureId, relativePath, attachmentId: file.id } });
  if (settled) await prisma.workspaceOutputCheckpoint.update({ where: { id: saved.id }, data: { state: "SETTLED", result: {}, settledAt: new Date() } });
  return file;
}

async function image(f: Fixture, t: Turn, status: "ready" | "processing" | "failed" = "ready") {
  const tool = await prisma.modelRunToolCall.create({ data: { modelRunId: t.run.id, providerCallId: randomUUID(),
    roundIndex: 1, ordinal: await prisma.modelRunToolCall.count({ where: { modelRunId: t.run.id } }),
    arguments: {}, toolName: "generate_image", state: "complete" } });
  return attachment(f, { imageToolCallId: tool.id, origin: "IMAGE_OUTPUT", producerModelRunId: t.run.id,
    messageId: t.answer.id, kind: "image", mimeType: "image/png", status });
}

async function selected(f: Fixture, leafMessageId: string | null, imageIds: string[] = [], runId?: string) {
  const ancestorMessageIds = await workspaceAncestorMessageIds(prisma, f.chatId, leafMessageId);
  return (await prisma.attachment.findMany({ select: { id: true }, orderBy: { id: "asc" },
    where: workspaceInboxAttachmentWhere({ ...f.input, ancestorMessageIds, imageIds, runId }) })).map(file => file.id);
}

describe("authorized metadata-only Workspace inbox facts", () => {
  it("finds chat-wide originals outside the bounded reference list and ignores incomplete attachment identity", async () => {
    const f = await fixture();
    expect(await loadWorkspaceInboxFacts(prisma, f.input)).toEqual(emptyFacts);
    await attachment(f, { checksum: null });
    await attachment(f, { checksum: "" });
    await attachment(f, { messageId: null });
    await attachment(f, { kind: "unsupported-kind" });
    // The same user's saved library file is a chat-less personal record, never a chat original.
    await attachment(f, { chatId: null, messageId: null, savedAt: new Date() });
    await attachment(f, { userId: f.outsiderId });
    expect(await loadWorkspaceInboxFacts(prisma, f.input)).toEqual(emptyFacts);
    const original = await attachment(f, { kind: "pdf", status: "failed", processingErrorCode: "parser_unavailable" });
    let leaf = f.question.id;
    const messages: ProviderConversationMessage[] = [{ id: leaf, role: "user",
      content: { blocks: [{ type: "file", attachmentId: original.id }] } }];
    for (let index = 0; index < 15; index += 1) {
      // Later historical references do not guarantee a verified usable file.
      const missing = await attachment(f, { checksum: null });
      const role = index % 2 === 0 ? "assistant" : "user";
      const content = { blocks: [{ type: "file", attachmentId: missing.id }] };
      leaf = (await prisma.message.create({ data: { chatId: f.chatId, parentMessageId: leaf,
        role, status: "complete", content } })).id;
      messages.push({ id: leaf, role, content });
    }
    expect(workspaceFileReferences(messages)).toHaveLength(12);
    expect(workspaceFileReferences(messages).map(file => file.attachmentId)).not.toContain(original.id);
    expect(await selected(f, leaf)).toEqual([original.id]);
    const sibling = await prisma.message.create({ data: { chatId: f.chatId, parentMessageId: f.question.id,
      role: "user", status: "complete", content: textMessageContent("Another branch") } });
    const siblingOriginal = await attachment(f, { messageId: sibling.id, status: "processing" });
    expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, leafMessageId: leaf })).toEqual({ hasFiles: true, hasEarlierExports: false });
    expect(await selected(f, leaf)).toEqual([original.id, siblingOriginal.id].sort());
    // Reading facts does not provision a guest/session or create output state.
    expect(await prisma.workspaceSession.count({ where: { chatId: f.chatId } })).toBe(0);
  });

  it("refuses foreign, inactive, archived, deleted and mismatched personal authority", async () => {
    const f = await fixture();
    await attachment(f);
    expect(await loadWorkspaceInboxFacts(prisma, f.input)).toEqual({ hasFiles: true, hasEarlierExports: false });
    for (const patch of [{ userId: f.outsiderId }, { userId: randomUUID() }, { chatId: randomUUID() }, { projectId: randomUUID() }]) {
      expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, ...patch })).toEqual(emptyFacts);
    }
    await prisma.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
    expect(await loadWorkspaceInboxFacts(prisma, f.input)).toEqual(emptyFacts);
    await prisma.user.update({ where: { id: f.userId }, data: { status: "active" } });
    await prisma.chat.update({ where: { id: f.chatId }, data: { archived: true } });
    expect(await loadWorkspaceInboxFacts(prisma, f.input)).toEqual(emptyFacts);
    await prisma.message.deleteMany({ where: { chatId: f.chatId } });
    await prisma.chat.delete({ where: { id: f.chatId } });
    expect(await loadWorkspaceInboxFacts(prisma, f.input)).toEqual(emptyFacts);
  });

  it("requires current Project contributor access and shares originals independently of their uploader", async () => {
    const f = await fixture(true);
    await attachment(f, { uploaderUserId: f.contributorId });
    for (const userId of [f.userId, f.contributorId]) {
      expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, userId })).toEqual({ hasFiles: true, hasEarlierExports: false });
    }
    for (const patch of [{ userId: f.viewerId }, { userId: f.outsiderId }, { projectId: undefined }, { projectId: randomUUID() }]) {
      expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, ...patch })).toEqual(emptyFacts);
    }
    await prisma.projectGrant.delete({ where: { projectId_userId: { projectId: f.projectId!, userId: f.contributorId } } });
    expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, userId: f.contributorId })).toEqual(emptyFacts);
    await prisma.project.update({ where: { id: f.projectId! }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    expect(await loadWorkspaceInboxFacts(prisma, f.input)).toEqual(emptyFacts);
  });

  it.each([false, true])("includes only ready completed ancestor exports, never sibling, foreign, unready or unpublished output (Project=%s)", async project => {
    const f = await fixture(project);
    const first = await turn(f);
    const next = await turn(f, first.answer.id);
    const sibling = await turn(f);
    const accepted = await exported(f, first);
    await exported(f, first, true, "processing");
    await exported(f, first, true, "failed");
    await exported(f, next, false);
    await exported(f, sibling);
    const foreign = await fixture();
    await exported(foreign, await turn(foreign));
    await attachment(f, { origin: "WORKSPACE_OUTPUT", producerModelRunId: first.run.id, messageId: first.answer.id });
    expect(await selected(f, next.answer.id)).toEqual([accepted.id]);
    expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, leafMessageId: next.answer.id })).toEqual({ hasFiles: true, hasEarlierExports: true });
    if (project) expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, userId: f.contributorId,
      leafMessageId: next.answer.id })).toEqual({ hasFiles: true, hasEarlierExports: true });
    expect(await workspaceAncestorMessageIds(prisma, f.chatId, foreign.question.id)).toEqual([]);
    expect(await workspaceAncestorMessageIds(prisma, f.chatId, null)).toEqual([]);
    expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, leafMessageId: foreign.question.id })).toEqual(emptyFacts);
  });

  it("keeps settled ancestor checkpoints eligible despite failed final export and excludes pending checkpoints", async () => {
    const f = await fixture();
    const prior = await turn(f);
    const accepted = await checkpoint(f, prior, true);
    await prisma.workspaceRunBinding.update({ where: { modelRunId: prior.run.id }, data: { exportState: "FAILED", lastExportErrorCode: "workspace_session_lost" } });
    const next = await turn(f, prior.answer.id);
    await checkpoint(f, next, false);
    const sibling = await turn(f);
    await checkpoint(f, sibling, true);
    expect(await selected(f, next.answer.id)).toEqual([accepted.id]);
    expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, leafMessageId: next.answer.id })).toEqual({ hasFiles: true, hasEarlierExports: true });
    await prisma.attachment.update({ where: { id: accepted.id }, data: { status: "failed" } });
    expect(await selected(f, next.answer.id)).toEqual([]);
    expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, leafMessageId: next.answer.id })).toEqual(emptyFacts);
  });

  it("includes only ready unsaved generated images admitted by reference or the current run", async () => {
    const f = await fixture();
    const prior = await turn(f);
    const referenced = await image(f, prior);
    const unreferenced = await image(f, prior);
    const failed = await image(f, prior, "failed");
    const processing = await image(f, prior, "processing");
    const current = await turn(f, prior.answer.id);
    const currentImage = await image(f, current);
    const foreign = await fixture();
    const foreignImage = await image(foreign, await turn(foreign));
    // Saved Library copies have their own upload identity and no chat binding.
    const savedImage = await attachment(f, { kind: "image", savedAt: new Date(), chatId: null, messageId: null });
    const references = [referenced.id, failed.id, processing.id, foreignImage.id, savedImage.id];
    expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, leafMessageId: current.answer.id, imageIds: [] })).toEqual(emptyFacts);
    expect(await loadWorkspaceInboxFacts(prisma, { ...f.input, leafMessageId: current.answer.id, imageIds: references })).toEqual({ hasFiles: true, hasEarlierExports: false });
    expect(await selected(f, current.answer.id, references)).toEqual([referenced.id]);
    expect(await selected(f, current.answer.id, references, current.run.id)).toEqual([referenced.id, currentImage.id].sort());
    expect(await selected(f, current.answer.id, [unreferenced.id])).toEqual([unreferenced.id]);
  });
});

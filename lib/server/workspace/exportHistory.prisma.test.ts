// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { WORKSPACE_MCP_TOOL_ALLOWLIST, workspaceRunOutputDirectory } from "../../domain/workspace";
import { WORKSPACE_EXPORT_PAGE_SIZE } from "../../contracts/workspaceExports";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import { prisma } from "../prisma";
import { createPrismaWorkspaceCoordinatorRepository } from "./coordinator";
import { createWorkspaceExportHistoryRepository } from "./exportHistoryRepository";
import { namespacedWorkspaceToolName } from "./toolCatalog";

const tools = WORKSPACE_MCP_TOOL_ALLOWLIST.map((name) => ({
  description: "Fixture tool", inputSchema: { type: "object" }, namespacedName: namespacedWorkspaceToolName(name), originalName: name
}));

async function fixture() {
  const user = await prisma.user.create({ data: { displayName: "Export history test", id: `export-history-${randomUUID()}` } });
  const chat = await prisma.chat.create({ data: { title: "Monthly reports", userId: user.id, workspaceEnabled: true } });
  const session = await prisma.workspaceSession.create({ data: {
    chatId: chat.id, expiresAt: new Date(Date.now() + 60_000), imageRef: "fixture:1", internetEnabled: false,
    policyRevision: 1, sandboxName: `aiqsa-ws-${randomUUID()}`, state: "READY"
  } });
  let ordinal = 0;
  async function turn(parentMessageId: string | null, names: string[], complete = true) {
    const question = await prisma.message.create({ data: { chatId: chat.id, content: {}, parentMessageId, role: "user" } });
    const answer = await prisma.message.create({ data: {
      chatId: chat.id, content: {}, createdAt: new Date(Date.UTC(2026, 8, 1, 0, ordinal++)), parentMessageId: question.id, role: "assistant", status: "complete"
    } });
    const run = await prisma.modelRun.create({ data: {
      assistantMessageId: answer.id, chatId: chat.id, modelId: "fake-qsa", normalizedRequest: {},
      provider: "fake", status: "complete", userId: user.id, userMessageId: question.id
    } });
    await prisma.workspaceRunBinding.create({ data: {
      exportCompletedAt: complete ? new Date() : null, exportState: complete ? "COMPLETE" : "PENDING",
      imageRef: "fixture:1", internetEnabled: false, mcpVersion: "0.6.16", modelRunId: run.id,
      outputDirectory: workspaceRunOutputDirectory(run.id), policyRevision: 1, runtimeVersion: "0.6.16",
      toolCatalogHash: hashCanonicalMcpValue(tools), toolDefinitions: tools, workspaceSessionId: session.id
    } });
    const files = [];
    for (const name of names) {
      const file = await prisma.attachment.create({ data: {
        byteSize: 4, chatId: chat.id, checksum: "a".repeat(64), fileName: name, kind: "file",
        messageId: answer.id, metadata: {}, mimeType: "application/octet-stream", origin: "WORKSPACE_OUTPUT",
        producerModelRunId: run.id, storageKey: `export-history-test/${randomUUID()}`, userId: user.id,
        workspaceRunOutput: { create: { byteSize: 4, checksum: "a".repeat(64), relativePath: name, workspaceRunBindingId: run.id } }
      } });
      files.push(file);
    }
    await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: answer.id } });
    return { answer, files, run };
  }
  return {
    chat, user, turn,
    async cleanup() {
      await prisma.attachment.deleteMany({ where: { userId: user.id } });
      await prisma.modelRun.deleteMany({ where: { userId: user.id } });
      await prisma.workspaceSession.deleteMany({ where: { id: session.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  };
}

describe("Workspace export history in PostgreSQL", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("groups files by answer and stages earlier canonical exports from the accepted ancestry", async () => {
    const value = await fixture();
    try {
      const first = await value.turn(null, ["original.xlsx", "report.docx"]);
      const second = await value.turn(first.answer.id, ["purple.xlsx"]);
      const pending = await value.turn(second.answer.id, [], false);
      const history = createWorkspaceExportHistoryRepository(prisma);
      const read = () => history.list({ chatId: value.chat.id, cursor: null, userId: value.user.id });
      expect(await read()).toMatchObject({ exports: [
        { messageId: second.answer.id, files: [{ fileName: "purple.xlsx" }] },
        { messageId: first.answer.id, files: [{ fileName: "original.xlsx" }, { fileName: "report.docx" }] }
      ], nextCursor: null });
      expect(await read()).toEqual(await read());
      expect(await history.list({ chatId: value.chat.id, cursor: null, userId: "another-owner" })).toBeNull();
      const otherBranch = await value.turn(first.answer.id, ["other-branch.pptx"]);
      const coordinator = createPrismaWorkspaceCoordinatorRepository(prisma);
      const accepted = await coordinator.binding({ runId: pending.run.id, userId: value.user.id });
      expect(accepted).not.toBeNull();
      const inputs = await coordinator.attachments(accepted!);
      expect(inputs.map((file) => file.attachmentId).sort()).toEqual([...first.files, ...second.files].map((file) => file.id).sort());
      expect(inputs.every((file) => file.origin === "WORKSPACE_OUTPUT" && file.checksum === "a".repeat(64))).toBe(true);
      expect((await read())!.exports.map((entry) => entry.messageId)).toEqual([otherBranch.answer.id, first.answer.id]);
      expect(await history.list({ chatId: value.chat.id, cursor: otherBranch.answer.id, userId: value.user.id })).toMatchObject({ exports: [{ messageId: first.answer.id }] });
    } finally { await value.cleanup(); }
  });

  it("paginates complete file sets without splitting or dropping an answer", async () => {
    const value = await fixture();
    try {
      let parent: string | null = null;
      const ids: string[] = [];
      for (let i = 0; i <= WORKSPACE_EXPORT_PAGE_SIZE; i++) {
        const item = await value.turn(parent, ["report.txt"]);
        parent = item.answer.id;
        ids.push(parent);
      }
      const history = createWorkspaceExportHistoryRepository(prisma);
      const first = await history.list({ chatId: value.chat.id, cursor: null, userId: value.user.id });
      expect(first!.exports).toHaveLength(WORKSPACE_EXPORT_PAGE_SIZE);
      const second = await history.list({ chatId: value.chat.id, cursor: first!.nextCursor, userId: value.user.id });
      expect(second!.nextCursor).toBeNull();
      expect([...first!.exports, ...second!.exports].map((entry) => entry.messageId)).toEqual(ids.reverse());
    } finally { await value.cleanup(); }
  });
});

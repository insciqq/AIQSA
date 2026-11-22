import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { recordingTransaction } from "../chatSearch/index/markRecorder.testFixtures";
import { createChatContinuationRepository } from "./continuationRepository";
import { TEMPORARY_CHAT_RETENTION_MS } from "./temporaryRetention";

const OWNER = "owner-1";
const UPDATED = new Date("2026-11-01T10:00:00Z");
const SOURCE = { chatId: "chat-1", leafMessageId: "answer-1", transcript: "", updatedAt: UPDATED, userId: OWNER,
  workspaceEnabled: false };

function continuation(memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY", importSource: string | null = null) {
  const recorder = recordingTransaction({
    "chat.findUnique": () => ({ activeLeafMessageId: "answer-1", archived: false, assistantId: null, assistantOverrides: null,
      defaultProviderModelId: null, folderId: null, id: "chat-1", importSource, importSourceModel: null, memoryMode,
      permanentDeletionAt: null, title: "Trip plans", updatedAt: UPDATED, userId: OWNER, workspaceEnabled: false }),
    "chatContinuation.findFirst": () => ({ requestedProviderModelId: null }),
    "user.findFirst": () => ({ id: OWNER })
  });
  return { recorder, repository: createChatContinuationRepository(recorder.client as unknown as PrismaClient) };
}

describe("a continuation's new chat", () => {
  it.each(["NORMAL", "EXCLUDED"] as const)("of a %s chat gets its leaf and a mark in the creating transaction", async (mode) => {
    const { recorder, repository } = continuation(mode);

    const result = await repository.complete(SOURCE, { attemptId: "attempt-1", id: "continuation-1" }, "Summary.");
    if (result.status !== "complete") throw new Error("continuation_not_complete");
    const { chatId } = result;

    const created = recorder.indexOf((call) => call.name === "chat.create");
    const leaf = recorder.indexOf((call) => call.name === "chat.update" &&
      (call.args as { where: { id: string } }).where.id === chatId);
    expect(created).toBeGreaterThan(-1);
    expect(leaf).toBeGreaterThan(created);
    // Eligibility is the mark's own rule: an Excluded copy creates no index state.
    expect(recorder.marks()).toEqual([{ kind: "dirty", values: expect.arrayContaining([chatId, OWNER]) }]);
    expect(recorder.indexOf((call) => call.text?.startsWith("INSERT INTO \"ChatSearchState\"") ?? false))
      .toBeGreaterThan(leaf);
    expect((recorder.calls[created]!.args as { data: { memoryMode: string } }).data.memoryMode).toBe(mode);
  });

  it("of an imported chat stays Excluded and keeps the import marker", async () => {
    const { recorder, repository } = continuation("EXCLUDED", "CHATGPT");

    await repository.complete(SOURCE, { attemptId: "attempt-1", id: "continuation-1" }, "Summary.");

    expect(recorder.calls.find((call) => call.name === "chat.create")?.args).toMatchObject({
      data: { importSource: "CHATGPT", memoryMode: "EXCLUDED" }
    });
  });

  it("of a Temporary chat carries its own deadline and no Memory outbox row", async () => {
    const { recorder, repository } = continuation("TEMPORARY");
    const before = Date.now();

    await repository.complete(SOURCE, { attemptId: "attempt-1", id: "continuation-1" }, "Summary.");

    const { data } = recorder.calls.find((call) => call.name === "chat.create")!.args as {
      data: { temporaryRetentionDeadline: Date };
    };
    expect(data.temporaryRetentionDeadline.getTime()).toBeGreaterThanOrEqual(before + TEMPORARY_CHAT_RETENTION_MS);
    expect(recorder.calls.some((call) => call.name.startsWith("memoryDeletionOutbox."))).toBe(false);
  });
});

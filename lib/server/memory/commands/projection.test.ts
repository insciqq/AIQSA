import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { listChatMemoryCommands } from "./projection";

describe("Memory command feedback", () => {
  it.each([
    ["QUEUED", "PENDING"], ["CLAIMED", "RUNNING"],
    ["TERMINAL_FAILED", "FAILED"], ["STALE", "STALE"],
    ["CANCELLED", "STALE"], ["SUCCEEDED", "UNKNOWN"]
  ])("projects unfinished checkpoints with %s lifecycle as %s", async (state, status) => {
    const chat = { findFirst: vi.fn().mockResolvedValue({ id: "chat" }) };
    const memoryJob = { findMany: vi.fn().mockResolvedValue([{
      sourceMessageId: "source", id: "opaque-command", commandOperation: "UNKNOWN", commandStatus: "PENDING",
      state, updatedAt: new Date("2026-09-28T10:00:00Z"),
      commandIntent: { statement: "private command text" },
      commandResult: { targetId: "private-target" }
    }]) };
    expect((await listChatMemoryCommands({ chat, memoryJob } as unknown as PrismaClient,
      { userId: "owner", chatId: "chat" }))?.commands[0]?.feedback)
      .toEqual({ commandRef: expect.stringMatching(/^mc1\.[a-f0-9]{64}$/u), operation: "UNKNOWN", status,
        updatedAt: "2026-09-28T10:00:00.000Z" });
    expect(memoryJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "owner", chatId: "chat", kind: "MEMORY_COMMAND" }
    }));
  });

  it("retains a committed receipt independently of worker settlement", async () => {
    const chat = { findFirst: vi.fn().mockResolvedValue({ id: "chat" }) };
    const memoryJob = { findMany: vi.fn().mockResolvedValue([{
      sourceMessageId: "source", id: "opaque-command", commandOperation: "SAVE", commandStatus: "COMMITTED",
      state: "CLAIMED", updatedAt: new Date("2026-09-28T10:00:00Z")
    }]) };
    expect((await listChatMemoryCommands({ chat, memoryJob } as unknown as PrismaClient,
      { userId: "owner", chatId: "chat" }))?.commands[0]?.feedback)
      .toMatchObject({ operation: "SAVE", status: "COMMITTED" });
  });
});

describe("chat command projection", () => {
  it("requires a retained personal owner chat before reading any jobs", async () => {
    const chat = { findFirst: vi.fn().mockResolvedValue(null) };
    const memoryJob = { findMany: vi.fn() };
    expect(await listChatMemoryCommands({ chat, memoryJob } as unknown as PrismaClient,
      { chatId: "chat", userId: "owner" })).toBeNull();
    expect(chat.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: "chat", userId: "owner", projectId: null, memoryMode: "NORMAL", permanentDeletionAt: null
    } }));
    expect(memoryJob.findMany).not.toHaveBeenCalled();
  });

  it("returns the latest content-free command per source message", async () => {
    const row = { id: "job-1", sourceMessageId: "message-1", commandOperation: "FORGET",
      commandStatus: "COMMITTED", state: "SUCCEEDED", updatedAt: new Date("2026-09-28T12:00:00Z"),
      commandIntent: { text: "secret" }, commandResult: { targetId: "private-target" } };
    const chat = { findFirst: vi.fn().mockResolvedValue({ id: "chat" }) };
    const memoryJob = { findMany: vi.fn().mockResolvedValue([row, { ...row, id: "older" }]) };
    const result = await listChatMemoryCommands({ chat, memoryJob } as unknown as PrismaClient,
      { chatId: "chat", userId: "owner" });
    expect(result?.commands).toHaveLength(1);
    expect(result?.commands[0]).toMatchObject({ messageId: "message-1", feedback: {
      operation: "FORGET", status: "COMMITTED", commandRef: expect.stringMatching(/^mc1\.[a-f0-9]{64}$/u)
    } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private-target");
    expect(serialized).not.toContain("job-1");
  });
});

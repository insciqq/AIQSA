import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
const { setMemoryMode } = vi.hoisted(() => ({ setMemoryMode: vi.fn() }));
vi.mock("../../lib/server/chats/prismaRepository", () => ({ createPrismaChatRepository: () => ({ setMemoryMode }) }));
import { excludeBenchmarkQuestion } from "./queryIsolation";

function fixture(states = ["SUCCEEDED", "STALE"]) {
  return { memoryJob: { findMany: vi.fn(async () => states.map((state) => ({ state }))) },
    memoryDeletionOutbox: { count: vi.fn(async () => 0) }, memoryRecallChunk: { count: vi.fn(async () => 0) },
    chat: { findFirst: vi.fn(async () => ({ memoryMode: "EXCLUDED" })) } };
}
describe("question exclusion after normal retrieval", () => {
  it("fences the exact owned question and accepts lifecycle-staled work", async () => {
    setMemoryMode.mockResolvedValue({ kind: "ok" });
    const client = fixture();
    await excludeBenchmarkQuestion(client as unknown as PrismaClient, "owner", "question");
    expect(setMemoryMode).toHaveBeenCalledWith({ chatId: "question", userId: "owner", mode: "EXCLUDED" });
    expect(client.memoryRecallChunk.count).toHaveBeenCalledWith({ where: { userId: "owner", chatId: "question", state: "ACTIVE" } });
  });
  it("fails closed when exclusion or cleanup is incomplete", async () => {
    setMemoryMode.mockResolvedValue({ kind: "not_found" });
    await expect(excludeBenchmarkQuestion(fixture() as unknown as PrismaClient, "owner", "question")).rejects.toThrow("exclusion_failed");
    setMemoryMode.mockResolvedValue({ kind: "ok" });
    await expect(excludeBenchmarkQuestion(fixture(["TERMINAL_FAILED"]) as unknown as PrismaClient, "owner", "question")).rejects.toThrow("cleanup_failed");
    await expect(excludeBenchmarkQuestion(fixture() as unknown as PrismaClient, "owner", "question", 0)).rejects.toThrow("cleanup_timeout");
  });
});

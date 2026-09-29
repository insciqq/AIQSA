import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
const mocks = vi.hoisted(() => ({ policy: vi.fn() }));
vi.mock("../execution/policy", () => ({ resolveCurrentMemoryUtilityPolicy: mocks.policy }));
vi.mock("../persistence/transaction", () => ({ withLockedMemoryTransaction: (client: unknown, _userId: string,
  callback: (tx: unknown, settings: unknown) => unknown) => callback(client,
    { useMemoryFacts: true, memoryGeneration: 1, referenceChatHistory: true }) }));
import { admitMemorySearch } from "./admission";
describe("Memory search Assistant admission", () => {
  it("does not expose private recall for a public, foreign or archived Assistant", async () => {
    const assistantDefinition = { findFirst: vi.fn(async () => null) };
    expect(await admitMemorySearch({ userId: "user", timeoutSeconds: 30, assistantId: "foreign" },
      { assistantDefinition } as unknown as PrismaClient)).toBeNull();
    expect(assistantDefinition.findFirst).toHaveBeenCalledWith({ where: {
      id: "foreign", ownerUserId: "user", archivedAt: null }, select: { id: true } });
    expect(mocks.policy).not.toHaveBeenCalled();
  });
});

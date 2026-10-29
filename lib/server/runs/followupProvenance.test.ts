import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { insertAdmittedRunFollowups } from "./prismaRepositoryFollowups";
import type { PreparingRunAdmissionInput } from "./runRepositoryContract";

const entry = { id: "original", ordinal: 1, author: "Owner", text: "Do not send anything, draft only",
  createdAt: "2026-10-29T12:00:00.000Z", delivery: "delivered" };

describe("inherited follow-up authorship", () => {
  it.each(["owner", null, "different-user"])("copies only proven original authorship (%s), including a branch copy", async authorUserId => {
    const source = { id: "copied-answer", branchSourceModelRunId: "original-run", branchFollowups: { available: false, entries: [entry] }, assistantModelRuns: [] };
    const create = vi.fn();
    const tx = { message: { findFirst: async () => source, findMany: async () => [source] },
      runFollowup: { create, findMany: async () => [{ id: entry.id, text: entry.text, authorUserId, modelRunId: "original-run" }] },
      modelRun: { update: vi.fn() } } as unknown as Prisma.TransactionClient;
    const input = { admissionKind: "REGENERATE", chatId: "copy-chat", userId: "owner", preSendAssistantMessageId: "copied-answer",
      followupAdmission: { budgetTokens: 2_000, inherited: { messageId: "copied-answer", revision: 1 } } } as PreparingRunAdmissionInput;
    await insertAdmittedRunFollowups(tx, input, "new-run");
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ modelRunId: "new-run", text: entry.text,
      authorUserId: authorUserId === "owner" ? "owner" : null }) });
  });
});

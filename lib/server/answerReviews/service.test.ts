import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { startAnswerReviewRound, type AnswerReviewServiceDeps } from "./service";

const access = vi.hoisted(() => ({ resolveChatAccess: vi.fn() }));
vi.mock("../chats/access", () => ({ resolveChatAccess: access.resolveChatAccess }));

describe("answer review round access", () => {
  it("starts no review in a chat the user does not own, before reading the chat or admitting a model", async () => {
    access.resolveChatAccess.mockResolvedValue(null);
    const findFirst = vi.fn();
    const load = vi.fn();
    const deps = {
      prisma: { chat: { findFirst } } as unknown as PrismaClient,
      providerAdmission: { load }
    } as unknown as AnswerReviewServiceDeps;

    await expect(startAnswerReviewRound(deps, {
      answerMessageId: "answer-1",
      chatId: "chat-1",
      expectedActiveLeafId: "answer-1",
      reviewers: [{ modelId: "model-b", provider: "connection-b" }],
      userId: "member-1"
    })).resolves.toEqual({ code: "answer_review_unavailable", ok: false, status: 404 });
    expect(access.resolveChatAccess).toHaveBeenCalledWith(deps.prisma, { chatId: "chat-1", userId: "member-1" });
    expect(findFirst).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

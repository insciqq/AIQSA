import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { startAnswerReviewRound, type AnswerReviewServiceDeps } from "./service";

const access = vi.hoisted(() => ({ resolveChatAccess: vi.fn() }));
vi.mock("../projects/access", () => ({ resolveChatAccess: access.resolveChatAccess }));

describe("answer review rounds while Projects are disabled", () => {
  it("starts no review in a Project chat, before reading the chat or admitting a model", async () => {
    access.resolveChatAccess.mockResolvedValue({ kind: "project", project: { projectId: "project-1" }, userId: null });
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
    })).resolves.toEqual({ code: "projects_disabled", ok: false, status: 409 });
    expect(access.resolveChatAccess).toHaveBeenCalledWith(deps.prisma, expect.objectContaining({ requireMutable: true }));
    expect(findFirst).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

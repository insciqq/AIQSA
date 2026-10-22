import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ProjectsDisabledError } from "../projects/disabled";
import type { WorkspaceAvailabilityService } from "../workspace/availability";
import { createPrismaChatRepository } from "./prismaRepository";

const access = vi.hoisted(() => ({ resolveChatAccess: vi.fn() }));
vi.mock("../projects/access", async (importOriginal) => ({
  ...await importOriginal<typeof import("../projects/access")>(),
  resolveChatAccess: access.resolveChatAccess
}));

describe("Project chat changes while Projects are disabled", () => {
  it.each([
    ["title", { title: "Renamed" }],
    ["pin", { pinned: true }],
    ["folder", { folderId: "folder-1" }],
    ["Workspace", { workspaceEnabled: false }],
    ["Assistant", { assistantId: null }],
    ["Search default", { defaultSearchPlan: null }],
    ["Knowledge default", { defaultKnowledgePlan: null }]
  ] as const)("refuses a %s change before writing anything", async (_name, change) => {
    access.resolveChatAccess.mockResolvedValue({ kind: "project", project: { projectId: "project-1" }, userId: null });
    const transaction = vi.fn();
    const repository = createPrismaChatRepository({ $transaction: transaction } as unknown as PrismaClient, {
      loadCatalogData: async () => null,
      workspaceAvailability: { snapshot: async () => ({ available: false }) } as unknown as WorkspaceAvailabilityService
    });

    await expect(repository.updateChat({ chatId: "chat-1", userId: "member-1", ...change }))
      .rejects.toBeInstanceOf(ProjectsDisabledError);
    expect(access.resolveChatAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requireMutable: true }));
    expect(transaction).not.toHaveBeenCalled();
  });
});

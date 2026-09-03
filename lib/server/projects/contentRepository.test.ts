import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectMocks = vi.hoisted(() => ({
  notifyProjectEvent: vi.fn(),
  resolveProjectAccess: vi.fn()
}));

vi.mock("./access", () => ({
  resolveProjectAccess: projectMocks.resolveProjectAccess
}));

vi.mock("./events", () => ({
  notifyProjectEvent: projectMocks.notifyProjectEvent
}));

import { createPrismaProjectContentRepository } from "./contentRepository";

describe("Project content repository authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires Manager access before creating a Project folder", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      projectAuditEvent: { create: vi.fn().mockResolvedValue({}) },
      projectFolder: {
        aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
        create: vi.fn().mockResolvedValue({
          id: "folder-1",
          name: "Research",
          parentId: null,
          sortOrder: 10
        })
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx))
    } as unknown as PrismaClient;
    projectMocks.resolveProjectAccess.mockImplementation(
      (_client: unknown, request: { minimumRole?: string }) =>
        request.minimumRole === "MANAGER" ? null : { effectiveRole: "CONTRIBUTOR" }
    );

    const result = await createPrismaProjectContentRepository(prisma).createFolder({
      actorDisplayName: "Contributor",
      name: "Research",
      projectId: "project-1",
      userId: "user-1"
    });

    expect(result).toEqual({ kind: "not_found" });
    expect(projectMocks.resolveProjectAccess).toHaveBeenCalledWith(tx, {
      minimumRole: "MANAGER",
      projectId: "project-1",
      requireActive: true,
      userId: "user-1"
    });
    expect(tx.projectFolder.create).not.toHaveBeenCalled();
    expect(projectMocks.notifyProjectEvent).not.toHaveBeenCalled();
  });
});

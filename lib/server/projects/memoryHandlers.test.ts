import { describe, expect, it, vi } from "vitest";
import { createTestAuth } from "@/tests/support/auth";
import {
  createProjectMemoryFactHandler,
  createProjectMemoryProposalHandler
} from "./memoryHandlers";

const auth = createTestAuth({
  user: { displayName: "Project Member", id: "project-member" }
});

function request(body: Record<string, unknown>): Request {
  return new Request("http://app.local/api/projects/project-1/memory", {
    body: JSON.stringify(body),
    headers: { cookie: auth.cookie, "content-type": "application/json" },
    method: "POST"
  });
}

describe("Project Memory handlers", () => {
  it("requires a Project message as Contributor proposal evidence", async () => {
    const propose = vi.fn();
    const POST = createProjectMemoryProposalHandler({
      repository: { propose } as never,
      resolveAuth: auth.resolveAuth
    });

    const response = await POST(request({ text: "A proposed fact" }), {
      params: { projectId: "project-1" }
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "project_memory_input_invalid" });
    expect(propose).not.toHaveBeenCalled();
  });

  it("normalizes a direct fact validity deadline before repository admission", async () => {
    const createFact = vi.fn().mockResolvedValue({
      kind: "ok",
      value: {
        createdAt: "2026-08-17T00:00:00.000Z",
        createdByDisplayName: "Project Member",
        factId: "fact-1",
        state: "ACTIVE",
        text: "Release on Tuesday",
        updatedAt: "2026-08-17T00:00:00.000Z",
        validUntil: "2026-09-01T09:30:00.000Z",
        versionId: "version-1",
        versionNumber: 1
      }
    });
    const POST = createProjectMemoryFactHandler({
      repository: { createFact } as never,
      resolveAuth: auth.resolveAuth
    });

    const response = await POST(request({
      text: "Release on Tuesday",
      validUntil: "2026-09-01T09:30:00.000Z"
    }), { params: { projectId: "project-1" } });

    expect(response.status).toBe(201);
    expect(createFact).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      validUntil: new Date("2026-09-01T09:30:00.000Z"),
      userId: "project-member"
    }));
  });
});

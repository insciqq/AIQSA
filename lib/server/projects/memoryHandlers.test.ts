import { describe, expect, it, vi } from "vitest";
import {
  createProjectMemoryFactDeleteHandler,
  createProjectMemoryFactHandler,
  createProjectMemoryFactUpdateHandler,
  createProjectMemoryListHandler,
  createProjectMemoryProposalHandler,
  createProjectMemoryReviewHandler
} from "./memoryHandlers";

describe("dormant Project Memory handlers", () => {
  it.each([
    ["list", (deps: never) => createProjectMemoryListHandler(deps)],
    ["create", (deps: never) => createProjectMemoryFactHandler(deps)],
    ["propose", (deps: never) => createProjectMemoryProposalHandler(deps)],
    ["approve", (deps: never) => createProjectMemoryReviewHandler(deps, true)],
    ["reject", (deps: never) => createProjectMemoryReviewHandler(deps, false)],
    ["edit", (deps: never) => createProjectMemoryFactUpdateHandler(deps)],
    ["forget", (deps: never) => createProjectMemoryFactDeleteHandler(deps)]
  ])("fails the %s route closed without auth or repository access", async (_name, factory) => {
    const resolveAuth = vi.fn();
    const repository = new Proxy({}, {
      get() {
        throw new Error("project_memory_repository_must_remain_dormant");
      }
    });
    const handler = factory({ repository, resolveAuth } as never);

    const response = await handler(new Request(
      "http://app.local/api/projects/project-1/memory",
      { method: "POST" }
    ), {
      params: {
        factId: "fact-1",
        projectId: "project-1",
        proposalId: "proposal-1"
      }
    } as never);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "project_memory_unavailable" });
    expect(resolveAuth).not.toHaveBeenCalled();
  });
});

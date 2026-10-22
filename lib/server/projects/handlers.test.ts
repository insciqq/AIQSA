import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAuth } from "@/tests/support/auth";
import {
  createProjectChatArchiveHandler,
  createProjectChatHandler,
  createProjectFolderDeleteHandler,
  createProjectFolderHandler,
  createProjectFolderUpdateHandler,
  createProjectWorkspaceHandler
} from "./contentHandlers";
import {
  createAddProjectGrantHandler,
  createAddProjectResourceHandler,
  createCreateProjectHandler,
  createDeleteProjectGrantHandler,
  createDeleteProjectResourceHandler,
  createDeleteProjectHandler,
  createGetProjectHandler,
  createLeaveProjectHandler,
  createListProjectsHandler,
  createProjectCandidatesHandler,
  createProjectResourcePreviewHandler,
  createUpdateProjectGrantHandler,
  createUpdateProjectHandler
} from "./handlers";

// The handlers below stay tested with Projects on; the last block turns them off.
const areas = vi.hoisted(() => ({ projects: true }));
vi.mock("../../domain/disabledAreas", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../domain/disabledAreas")>(),
  get PROJECTS_ENABLED() {
    return areas.projects;
  }
}));

const auth = createTestAuth({ user: { displayName: "Project Owner", id: "owner-1" } });

function deps(repository: Record<string, unknown>) {
  return { repository: repository as never, resolveAuth: auth.resolveAuth };
}

function jsonRequest(path: string, body: unknown, method = "POST"): Request {
  return new Request(`http://app.local${path}`, {
    body: JSON.stringify(body),
    headers: { cookie: auth.cookie, "content-type": "application/json" },
    method
  });
}

const projectContext = { params: { projectId: "project-1" } };

describe("Project v2 HTTP handlers", () => {
  it.each(["pending", "failed", "completed"])("reports %s deletion without claiming premature success", async status => {
    const DELETE = createDeleteProjectHandler(deps({ delete: vi.fn().mockResolvedValue({ kind: "ok", value: { id: "project-1", status } }) }));
    const response = await DELETE(new Request("http://app.local/api/projects/project-1", {
      headers: { cookie: auth.cookie }, method: "DELETE"
    }), projectContext);
    expect(response.status).toBe(status === "completed" ? 200 : 202);
    expect(await response.json()).toEqual({ projectId: "project-1", status });
  });

  it("rejects the retired Project Memory toggle without repository access", async () => {
    const update = vi.fn();
    const PATCH = createUpdateProjectHandler(deps({ update }));
    const response = await PATCH(jsonRequest("/api/projects/project-1", {
      expectedMemoryRevision: 3,
      memoryEnabled: true
    }, "PATCH"), projectContext);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "project_input_invalid" });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects personal Knowledge modes as Project defaults before repository access", async () => {
    const update = vi.fn();
    const PATCH = createUpdateProjectHandler(deps({ update }));
    const response = await PATCH(jsonRequest("/api/projects/project-1", {
      defaults: {
        knowledgePlan: {
          baseIds: [], mode: "all_my_knowledge", sourceIds: [], version: 1
        }
      },
      expectedPolicyRevision: 3
    }, "PATCH"), projectContext);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "project_input_invalid" });
    expect(update).not.toHaveBeenCalled();
  });

  it("passes bounded picker search and cursor data without accepting arbitrary offsets", async () => {
    const candidates = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const GET = createProjectCandidatesHandler(deps({ candidates }));

    const response = await GET(new Request(
      "http://app.local/api/projects/project-1/candidates?type=user&q=alex&cursor=20&limit=10",
      { headers: { cookie: auth.cookie } }
    ), projectContext);
    expect(response.status).toBe(200);
    expect(candidates).toHaveBeenCalledWith({
      cursor: "20",
      limit: 10,
      projectId: "project-1",
      query: "alex",
      type: "user",
      userId: "owner-1"
    });

    const invalid = await GET(new Request(
      "http://app.local/api/projects/project-1/candidates?type=user&cursor=10001&limit=10",
      { headers: { cookie: auth.cookie } }
    ), projectContext);
    expect(invalid.status).toBe(400);
    expect(candidates).toHaveBeenCalledTimes(1);
  });

  it("keeps target-not-found distinct from aggregate access loss", async () => {
    const removeResource = vi.fn().mockResolvedValue({
      kind: "target_not_found",
      reason: "project_resource_not_found"
    });
    const DELETE = createDeleteProjectResourceHandler(deps({ removeResource }));
    const response = await DELETE(new Request(
      "http://app.local/api/projects/project-1/resources/stale?expectedPolicyRevision=7",
      { headers: { cookie: auth.cookie }, method: "DELETE" }
    ), { params: { bindingId: "stale", projectId: "project-1" } });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "project_resource_not_found" });
  });

  it("returns a typed eligibility error for a non-shared Project resource", async () => {
    const addResource = vi.fn().mockResolvedValue({
      kind: "unavailable",
      reason: "project_mcp_shared_configuration_required"
    });
    const POST = createAddProjectResourceHandler(deps({ addResource }));
    const response = await POST(jsonRequest("/api/projects/project-1/resources", {
      expectedPolicyRevision: 7,
      resourceId: "mcp-1",
      type: "mcp"
    }), projectContext);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "project_mcp_shared_configuration_required" });
  });

  it("accepts only Assistant add previews and bounded unlink previews", async () => {
    const previewResourceChange = vi.fn().mockResolvedValue({
      kind: "ok",
      value: { action: "remove" }
    });
    const POST = createProjectResourcePreviewHandler(deps({ previewResourceChange }));
    const invalid = await POST(jsonRequest("/api/projects/project-1/resources/preview", {
      action: "add",
      expectedPolicyRevision: 7,
      resourceId: "model-1",
      type: "model"
    }), projectContext);
    expect(invalid.status).toBe(400);

    const valid = await POST(jsonRequest("/api/projects/project-1/resources/preview", {
      action: "remove",
      bindingId: "binding-1",
      expectedPolicyRevision: 7
    }), projectContext);
    expect(valid.status).toBe(200);
    expect(previewResourceChange).toHaveBeenCalledWith(expect.objectContaining({
      action: "remove",
      bindingId: "binding-1",
      projectId: "project-1"
    }));
  });

  it("requires an access revision for explicit leave semantics", async () => {
    const leave = vi.fn().mockResolvedValue({ kind: "ok", value: { accessRemaining: false } });
    const POST = createLeaveProjectHandler(deps({ leave }));
    const invalid = await POST(jsonRequest("/api/projects/project-1/leave", {}), projectContext);
    expect(invalid.status).toBe(400);

    const response = await POST(jsonRequest("/api/projects/project-1/leave", {
      expectedAccessRevision: 4
    }), projectContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accessRemaining: false });
  });
});

describe("Project HTTP handlers while Projects are disabled", () => {
  beforeEach(() => {
    areas.projects = false;
  });
  afterEach(() => {
    areas.projects = true;
  });

  type AnyHandlerFactory = (deps: never) => (request: Request, context: never) => Promise<Response>;

  // Every change, leaving and deleting included, is refused before
  // authentication or any repository access, with one stable code.
  it.each([
    ["create a Project", createCreateProjectHandler],
    ["update a Project", createUpdateProjectHandler],
    ["delete a Project", createDeleteProjectHandler],
    ["leave a Project", createLeaveProjectHandler],
    ["add a grant", createAddProjectGrantHandler],
    ["change a grant", createUpdateProjectGrantHandler],
    ["remove a grant", createDeleteProjectGrantHandler],
    ["link a resource", createAddProjectResourceHandler],
    ["preview a resource change", createProjectResourcePreviewHandler],
    ["unlink a resource", createDeleteProjectResourceHandler],
    ["start a shared chat", createProjectChatHandler],
    ["create a folder", createProjectFolderHandler],
    ["rename a folder", createProjectFolderUpdateHandler],
    ["delete a folder", createProjectFolderDeleteHandler],
    ["archive a shared chat", (handlerDeps: never) => createProjectChatArchiveHandler(handlerDeps, true)],
    ["restore a shared chat", (handlerDeps: never) => createProjectChatArchiveHandler(handlerDeps, false)]
  ] as ReadonlyArray<readonly [string, unknown]>)("refuses to %s with projects_disabled", async (_name, factory) => {
    const resolveAuth = vi.fn();
    const repository = new Proxy({}, {
      get() {
        throw new Error("project_repository_must_stay_untouched");
      }
    });
    const handler = (factory as AnyHandlerFactory)({ repository, resolveAuth } as never);
    const response = await handler(jsonRequest("/api/projects/project-1", { name: "Renamed" }), {
      params: { bindingId: "binding-1", chatId: "chat-1", folderId: "folder-1", grantId: "grant-1", projectId: "project-1" }
    } as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "projects_disabled" });
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it("keeps the reads an existing shared chat needs", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const getDetail = vi.fn().mockResolvedValue({ id: "project-1" });
    const listWorkspace = vi.fn().mockResolvedValue({ chats: [], folders: [] });
    const request = new Request("http://app.local/api/projects", { headers: { cookie: auth.cookie } });

    expect((await createListProjectsHandler(deps({ list }))(request)).status).toBe(200);
    expect((await createGetProjectHandler(deps({ getDetail }))(request, projectContext)).status).toBe(200);
    expect((await createProjectWorkspaceHandler(deps({ listWorkspace }))(request, projectContext)).status).toBe(200);
    expect(getDetail).toHaveBeenCalledWith("owner-1", "project-1");
    expect(listWorkspace).toHaveBeenCalledWith("owner-1", "project-1");
  });
});

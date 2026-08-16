import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import {
  createCreateSkillHandler,
  createDeleteSkillHandler,
  createGetSkillHandler,
  createListSkillsHandler,
  createPublishSkillHandler,
  createRevokeSkillPublicationHandler,
  createUpdateSkillHandler,
  type SkillHandlerDeps
} from "./handlers";
import type { SkillDetailEntry, SkillListEntry } from "./prismaRepository";

function session(role: "admin" | "user" = "user"): AuthenticatedSession {
  return {
    expiresAt: new Date(Date.now() + 60_000),
    id: "session-1",
    user: {
      displayName: "Viewer",
      email: "viewer@example.test",
      id: "user-1",
      role,
      status: "active"
    },
    userId: "user-1"
  };
}

function entry(overrides: Partial<SkillListEntry> = {}): SkillListEntry {
  return {
    archived: false,
    description: "Checks claims",
    id: "skill-1",
    installationScope: false,
    instructionCharacterCount: 30,
    memberWorkspaceNames: [],
    name: "Careful editor",
    owned: true,
    ownerDisplayName: "Viewer",
    updatedAt: new Date("2026-08-16T01:00:00.000Z"),
    version: 2,
    ...overrides
  };
}

function detailEntry(overrides: Partial<SkillDetailEntry> = {}): SkillDetailEntry {
  return {
    ...entry(),
    assistantUsageCount: 0,
    audiences: [{
      id: "publication-1",
      kind: "workspace",
      name: "Design",
      workspaceId: "workspace-1"
    }],
    revision: {
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
      description: "Checks claims",
      id: "revision-2",
      instructions: "Verify claims before answering.",
      name: "Careful editor",
      revisionNumber: 2,
      skillId: "skill-1"
    },
    workspaceUsageCount: 1,
    ...overrides
  };
}

function repository(overrides: Partial<SkillHandlerDeps["repository"]> = {}) {
  return {
    create: vi.fn(async () => "skill-1"),
    delete: vi.fn(async () => "ok" as const),
    getForUser: vi.fn(async () => detailEntry()),
    listForUser: vi.fn(async () => ({ entries: [entry()], nextCursor: null })),
    listPublishableWorkspaces: vi.fn(async () => []),
    publish: vi.fn(async () => ({ id: "publication-1", kind: "ok" as const })),
    resolveForRun: vi.fn(async () => ({ ok: true as const, skills: [] })),
    revise: vi.fn(async () => ({ kind: "ok" as const, skillId: "skill-1" })),
    revokePublication: vi.fn(async () => "ok" as const),
    setArchived: vi.fn(async () => ({ kind: "ok" as const, skillId: "skill-1" })),
    ...overrides
  } satisfies SkillHandlerDeps["repository"];
}

function deps(
  repo = repository(),
  auth: AuthenticatedSession | null = session()
): SkillHandlerDeps {
  return {
    repository: repo,
    resolveAuth: vi.fn(async () => auth)
  };
}

function request(method: string, body: unknown): Request {
  return new Request("http://localhost/api/me/skills", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  });
}

describe("Skill handlers", () => {
  it("requires authentication before listing private Skill metadata", async () => {
    const repo = repository();
    const response = await createListSkillsHandler(deps(repo, null))(
      new Request("http://localhost/api/me/skills")
    );

    expect(response.status).toBe(401);
    expect(repo.listForUser).not.toHaveBeenCalled();
  });

  it("lists metadata without instructions and emits a stable cursor", async () => {
    const next = { id: "skill-1", updatedAt: new Date("2026-08-16T01:00:00.000Z") };
    const repo = repository({
      listForUser: vi.fn(async () => ({
        entries: [entry({
          memberWorkspaceNames: ["Design Workspace"],
          owned: false,
          ownerDisplayName: "Alex"
        })],
        nextCursor: next
      })),
      listPublishableWorkspaces: vi.fn(async () => [{
        id: "workspace-1",
        name: "Design Workspace"
      }])
    });
    const handler = createListSkillsHandler(deps(repo, session("admin")));
    const response = await handler(new Request(
      "http://localhost/api/me/skills?q=claims&limit=1"
    ));
    const value = await response.json();

    expect(response.status).toBe(200);
    expect(repo.listForUser).toHaveBeenCalledWith("user-1", {
      limit: 1,
      query: "claims"
    });
    expect(value).toMatchObject({
      publishableWorkspaces: [{ id: "workspace-1", name: "Design Workspace" }],
      skills: [{
        instructionCharacterCount: 30,
        scope: { kind: "workspace", workspaceNames: ["Design Workspace"] }
      }],
      viewer: { canPublishInstallation: true }
    });
    expect(value.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(value)).not.toContain("Verify claims before answering");

    await handler(new Request(
      `http://localhost/api/me/skills?cursor=${encodeURIComponent(value.nextCursor)}`
    ));
    expect(repo.listForUser).toHaveBeenLastCalledWith("user-1", {
      cursor: next,
      limit: 30
    });
  });

  it("rejects malformed search, cursor, limit, and unknown query fields", async () => {
    const repo = repository();
    const handler = createListSkillsHandler(deps(repo));

    for (const url of [
      "http://localhost/api/me/skills?limit=51",
      "http://localhost/api/me/skills?cursor=not-a-cursor",
      `http://localhost/api/me/skills?q=${"x".repeat(201)}`,
      "http://localhost/api/me/skills?group=private"
    ]) {
      expect((await handler(new Request(url))).status).toBe(400);
    }
    expect(repo.listForUser).not.toHaveBeenCalled();
  });

  it("returns full authorized detail with audiences, impact, and owner capabilities", async () => {
    const response = await createGetSkillHandler(deps(repository()))(
      new Request("http://localhost/api/me/skills/skill-1"),
      { params: { skillId: "skill-1" } }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      skill: {
        assistantUsageCount: 0,
        audiences: [{
          id: "publication-1",
          kind: "workspace",
          name: "Design",
          workspaceId: "workspace-1"
        }],
        canDelete: true,
        canEdit: true,
        canPublish: true,
        canUnshare: true,
        instructions: "Verify claims before answering.",
        owner: { displayName: "Viewer" },
        workspaceUsageCount: 1
      }
    });
  });

  it("uses the same unavailable response for unauthorized or missing detail and delete", async () => {
    const repo = repository({
      delete: vi.fn(async () => "not_found" as const),
      getForUser: vi.fn(async () => null)
    });
    const detailResponse = await createGetSkillHandler(deps(repo))(
      new Request("http://localhost/api/me/skills/private"),
      { params: { skillId: "private" } }
    );
    const deleteResponse = await createDeleteSkillHandler(deps(repo))(
      new Request("http://localhost/api/me/skills/private", { method: "DELETE" }),
      { params: { skillId: "private" } }
    );

    expect(detailResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    await expect(detailResponse.json()).resolves.toEqual({ error: "skill_not_available" });
    await expect(deleteResponse.json()).resolves.toEqual({ error: "skill_not_available" });
  });

  it("creates only strict text-only drafts", async () => {
    const repo = repository();
    const handler = createCreateSkillHandler(deps(repo));
    const created = await handler(request("POST", {
      description: "Checks claims",
      instructions: "Verify claims before answering.",
      name: "Careful editor"
    }));
    const rejected = await handler(request("POST", {
      description: "Checks claims",
      instructions: "Verify claims before answering.",
      name: "Careful editor",
      script: "run.sh"
    }));

    expect(created.status).toBe(201);
    expect(repo.create).toHaveBeenCalledWith("user-1", {
      description: "Checks claims",
      instructions: "Verify claims before answering.",
      name: "Careful editor"
    });
    expect(rejected.status).toBe(400);
    expect(repo.create).toHaveBeenCalledOnce();
  });

  it("creates immutable revisions with optimistic concurrency and strict envelopes", async () => {
    const repo = repository();
    const handler = createUpdateSkillHandler(deps(repo));
    const updated = await handler(request("PATCH", {
      expectedVersion: 2,
      revision: {
        description: "New",
        instructions: "Use the new workflow.",
        name: "Editor v2"
      }
    }), { params: { skillId: "skill-1" } });
    const extra = await handler(request("PATCH", {
      expectedVersion: 2,
      extra: true,
      revision: {
        description: "New",
        instructions: "Use the new workflow.",
        name: "Editor v2"
      }
    }), { params: { skillId: "skill-1" } });

    expect(updated.status).toBe(200);
    expect(repo.revise).toHaveBeenCalledWith("user-1", "skill-1", 2, {
      description: "New",
      instructions: "Use the new workflow.",
      name: "Editor v2"
    });
    expect(extra.status).toBe(400);
    expect(repo.revise).toHaveBeenCalledOnce();
  });

  it("maps Workspace publication and supports explicit Unshare", async () => {
    const repo = repository();
    const published = await createPublishSkillHandler(deps(repo))(
      request("POST", { scope: "workspace", workspaceId: "workspace-1" }),
      { params: { skillId: "skill-1" } }
    );
    const revoked = await createRevokeSkillPublicationHandler(deps(repo))(
      new Request("http://localhost/api/me/skills/skill-1/publications/publication-1", {
        method: "DELETE"
      }),
      { params: { publicationId: "publication-1", skillId: "skill-1" } }
    );

    expect(published.status).toBe(200);
    expect(repo.publish).toHaveBeenCalledWith({
      actorIsAdmin: false,
      groupId: "workspace-1",
      scope: "group",
      skillId: "skill-1",
      userId: "user-1"
    });
    expect(revoked.status).toBe(204);
    expect(repo.revokePublication).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: "publication-1",
      skillId: "skill-1"
    }));
  });

  it("blocks Unshare when a published Assistant still depends on the audience", async () => {
    const repo = repository({
      revokePublication: vi.fn(async () => "dependency_conflict" as const)
    });
    const response = await createRevokeSkillPublicationHandler(deps(repo))(
      new Request("http://localhost/api/me/skills/skill-1/publications/publication-1", {
        method: "DELETE"
      }),
      { params: { publicationId: "publication-1", skillId: "skill-1" } }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "skill_publication_in_use" });
  });

  it("keeps installation publication admin-only and rejects ambiguous payloads", async () => {
    const forbiddenRepo = repository({
      publish: vi.fn(async () => ({ kind: "forbidden" as const }))
    });
    const forbidden = await createPublishSkillHandler(deps(forbiddenRepo))(
      request("POST", { scope: "installation" }),
      { params: { skillId: "skill-1" } }
    );
    const invalid = await createPublishSkillHandler(deps(repository()))(
      request("POST", { scope: "installation", workspaceId: "workspace-1" }),
      { params: { skillId: "skill-1" } }
    );

    expect(forbidden.status).toBe(403);
    expect(invalid.status).toBe(400);
  });
});

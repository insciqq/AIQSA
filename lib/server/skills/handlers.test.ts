import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import {
  createCreateSkillHandler,
  createListSkillsHandler,
  createPublishSkillHandler,
  createUpdateSkillHandler,
  type SkillHandlerDeps
} from "./handlers";
import type { SkillAccessEntry } from "./prismaRepository";

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

function entry(overrides: Partial<SkillAccessEntry> = {}): SkillAccessEntry {
  return {
    archived: false,
    id: "skill-1",
    installationScope: false,
    memberGroupNames: [],
    owned: true,
    ownerDisplayName: "Viewer",
    revision: {
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
      description: "Checks claims",
      id: "revision-2",
      instructions: "Verify claims before answering.",
      name: "Careful editor",
      revisionNumber: 2,
      skillId: "skill-1"
    },
    updatedAt: new Date("2026-08-16T01:00:00.000Z"),
    version: 2,
    ...overrides
  };
}

function repository(overrides: Partial<SkillHandlerDeps["repository"]> = {}) {
  return {
    create: vi.fn(async () => "skill-1"),
    listForUser: vi.fn(async () => [entry()]),
    listPublishableGroups: vi.fn(async () => []),
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
  it("requires authentication before listing private Skill instructions", async () => {
    const repo = repository();
    const response = await createListSkillsHandler(deps(repo, null))(
      new Request("http://localhost/api/me/skills")
    );

    expect(response.status).toBe(401);
    expect(repo.listForUser).not.toHaveBeenCalled();
  });

  it("lists accessible exact revisions and publication authority", async () => {
    const repo = repository({
      listForUser: vi.fn(async () => [entry({
        memberGroupNames: ["Design"],
        owned: false,
        ownerDisplayName: "Alex"
      })]),
      listPublishableGroups: vi.fn(async () => [{ id: "group-1", name: "Design" }])
    });
    const response = await createListSkillsHandler(deps(repo, session("admin")))(
      new Request("http://localhost/api/me/skills")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      publishableGroups: [{ id: "group-1", name: "Design" }],
      skills: [{
        instructions: "Verify claims before answering.",
        scope: { groupNames: ["Design"], kind: "group" }
      }],
      viewer: { canPublishInstallation: true }
    });
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

  it("keeps installation publication admin-only and rejects ambiguous payloads", async () => {
    const forbiddenRepo = repository({
      publish: vi.fn(async () => ({ kind: "forbidden" as const }))
    });
    const forbidden = await createPublishSkillHandler(deps(forbiddenRepo))(
      request("POST", { scope: "installation" }),
      { params: { skillId: "skill-1" } }
    );
    const invalid = await createPublishSkillHandler(deps(repository()))(
      request("POST", { groupId: "group-1", scope: "installation" }),
      { params: { skillId: "skill-1" } }
    );

    expect(forbidden.status).toBe(403);
    expect(invalid.status).toBe(400);
  });
});

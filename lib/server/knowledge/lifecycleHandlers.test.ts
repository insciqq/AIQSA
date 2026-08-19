import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import {
  createKnowledgeLifecycleHandler,
  type KnowledgeLifecycleHandlerDeps
} from "./lifecycleHandlers";

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date(Date.now() + 60_000),
    id: "session-1",
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: "user-1",
      role: "user",
      status: "active"
    },
    userId: "user-1"
  };
}

function repository(
  overrides: Partial<KnowledgeLifecycleHandlerDeps["repository"]> = {}
): KnowledgeLifecycleHandlerDeps["repository"] {
  return {
    permanentlyDeleteBase: vi.fn(async () => ({ kind: "pending" as const })),
    permanentlyDeleteSource: vi.fn(async () => ({ kind: "pending" as const })),
    restoreBase: vi.fn(async () => ({ kind: "ok" as const })),
    restoreSource: vi.fn(async () => ({ kind: "ok" as const })),
    trashBase: vi.fn(async () => ({ kind: "ok" as const })),
    trashSource: vi.fn(async () => ({ kind: "ok" as const })),
    ...overrides
  };
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/me/knowledge", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

describe("Knowledge lifecycle handlers", () => {
  it("authenticates before reading input or touching lifecycle state", async () => {
    const repo = repository();
    const handler = createKnowledgeLifecycleHandler({
      repository: repo,
      resolveAuth: vi.fn(async () => null)
    }, "base", "trash");
    const response = await handler(request({ expectedVersion: 2 }), {
      params: { baseId: "base-1" }
    });
    expect(response.status).toBe(401);
    expect(repo.trashBase).not.toHaveBeenCalled();
  });

  it("keeps lifecycle input strict and maps optimistic conflicts", async () => {
    const repo = repository({
      restoreSource: vi.fn(async () => ({ kind: "version_conflict" as const }))
    });
    const deps = { repository: repo, resolveAuth: vi.fn(async () => session()) };
    const invalid = await createKnowledgeLifecycleHandler(deps, "source", "restore")(
      request({ expectedVersion: 2, ownerUserId: "attacker" }),
      { params: { sourceId: "source-1" } }
    );
    expect(invalid.status).toBe(400);
    expect(repo.restoreSource).not.toHaveBeenCalled();

    const conflict = await createKnowledgeLifecycleHandler(deps, "source", "restore")(
      request({ expectedVersion: 2 }),
      { params: Promise.resolve({ sourceId: "source-1" }) }
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: "knowledge_source_version_conflict"
    });
    expect(repo.restoreSource).toHaveBeenCalledWith("user-1", "source-1", 2);
  });

  it("returns an empty success for reversible lifecycle changes", async () => {
    const repo = repository();
    const response = await createKnowledgeLifecycleHandler({
      repository: repo,
      resolveAuth: vi.fn(async () => session())
    }, "base", "trash")(request({ expectedVersion: 4 }), {
      params: { baseId: "base-1" }
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(repo.trashBase).toHaveBeenCalledWith("user-1", "base-1", 4);
  });

  it("acknowledges durable permanent deletion before kicking background work", async () => {
    const events: string[] = [];
    const repo = repository({
      permanentlyDeleteSource: vi.fn(async () => {
        events.push("admitted");
        return { kind: "pending" as const };
      })
    });
    const response = await createKnowledgeLifecycleHandler({
      kickDeletionWorker: () => events.push("kicked"),
      repository: repo,
      resolveAuth: vi.fn(async () => session())
    }, "source", "delete")(request({ expectedVersion: 7 }), {
      params: { sourceId: "source-1" }
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "pending" });
    expect(events).toEqual(["admitted", "kicked"]);
  });

  it("requires Trash before permanent deletion", async () => {
    const response = await createKnowledgeLifecycleHandler({
      repository: repository({
        permanentlyDeleteBase: vi.fn(async () => ({ kind: "not_trashed" as const }))
      }),
      resolveAuth: vi.fn(async () => session())
    }, "base", "delete")(request({ expectedVersion: 1 }), {
      params: { baseId: "base-1" }
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "knowledge_base_must_be_trashed"
    });
  });
});

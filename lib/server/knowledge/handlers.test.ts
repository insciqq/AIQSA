import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import {
  createCreateKnowledgeBaseHandler,
  createGetKnowledgeBaseHandler,
  createListKnowledgeBasesHandler,
  createPublishKnowledgeBaseHandler,
  createRevokeKnowledgeBasePublicationHandler,
  createUpdateKnowledgeBaseHandler,
  type KnowledgeHandlerDeps
} from "./handlers";
import type { KnowledgeBaseAccessEntry, KnowledgeBaseDetailData } from "./prismaRepository";

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

function accessEntry(overrides: Partial<KnowledgeBaseAccessEntry> = {}): KnowledgeBaseAccessEntry {
  return {
    activeGeneration: {
      chunkingProfileVersion: 1,
      embeddingDeployment: {
        connectionDisplayName: "OpenRouter",
        id: "embedding-1",
        modelDisplayName: "Qwen3 Embedding",
        provider: "openrouter",
        targetDimension: 1536
      },
      id: "generation-1",
      indexedContentRevision: 2,
      vectorSpaceFingerprint: "a".repeat(64)
    },
    archived: false,
    contentRevision: 2,
    description: "Team references",
    id: "base-1",
    installationScope: false,
    memberGroupNames: ["Design"],
    name: "Product docs",
    owned: false,
    ownerDisplayName: "Owner",
    published: true,
    updatedAt: new Date("2026-08-08T10:00:00.000Z"),
    version: 3,
    ...overrides
  };
}

function detail(overrides: Partial<KnowledgeBaseDetailData> = {}): KnowledgeBaseDetailData {
  return {
    ...accessEntry({ owned: true }),
    documentCount: 0,
    publications: [],
    ...overrides
  };
}

function repository(overrides: Partial<KnowledgeHandlerDeps["repository"]> = {}) {
  return {
    create: vi.fn(async () => ({ id: "base-1", kind: "ok" as const })),
    getDetail: vi.fn(async () => detail()),
    listEmbeddingDeployments: vi.fn(async () => [{
      connectionDisplayName: "OpenRouter",
      id: "embedding-1",
      indexSupported: true,
      modelDisplayName: "Qwen3 Embedding",
      provider: "openrouter",
      targetDimension: 1536
    }]),
    listForUser: vi.fn(async () => []),
    listPublishableGroups: vi.fn(async () => []),
    publish: vi.fn(async () => ({ kind: "not_found" as const })),
    revokePublication: vi.fn(async () => ({ kind: "not_found" as const })),
    update: vi.fn(async () => ({ kind: "not_found" as const })),
    ...overrides
  } satisfies KnowledgeHandlerDeps["repository"];
}

function deps(
  repo = repository(),
  auth: AuthenticatedSession | null = session()
): KnowledgeHandlerDeps {
  return {
    repository: repo,
    resolveAuth: vi.fn(async () => auth)
  };
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://localhost/api/me/knowledge-bases", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  });
}

describe("Knowledge Base handlers", () => {
  it("requires authentication before catalog or mutation work", async () => {
    const repo = repository();
    const response = await createListKnowledgeBasesHandler(deps(repo, null))(
      new Request("http://localhost/api/me/knowledge-bases")
    );
    expect(response.status).toBe(401);
    expect(repo.listForUser).not.toHaveBeenCalled();
  });

  it("lists accessible bases while censoring a hidden embedding deployment", async () => {
    const repo = repository({
      listEmbeddingDeployments: vi.fn(async () => []),
      listForUser: vi.fn(async () => [accessEntry()]),
      listPublishableGroups: vi.fn(async () => [{ id: "group-1", name: "Design" }])
    });
    const response = await createListKnowledgeBasesHandler(deps(repo))(
      new Request("http://localhost/api/me/knowledge-bases")
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      knowledgeBases: [{
        activeGeneration: {
          embeddingDeployment: null,
          embeddingDeploymentId: null,
          targetDimension: 1536
        },
        scope: { groupNames: ["Design"], kind: "group" }
      }],
      publishableGroups: [{ id: "group-1", name: "Design" }],
      viewer: { canPublishInstallation: false }
    });
  });

  it("creates only from valid input and maps embedding admission failures", async () => {
    const repo = repository();
    const handler = createCreateKnowledgeBaseHandler(deps(repo));
    const created = await handler(jsonRequest("POST", {
      description: "References",
      embeddingDeploymentId: "embedding-1",
      name: "Docs"
    }));
    expect(created.status).toBe(201);
    expect(repo.create).toHaveBeenCalledWith("user-1", {
      description: "References",
      embeddingDeploymentId: "embedding-1",
      name: "Docs"
    });

    const invalid = await handler(jsonRequest("POST", {
      embeddingDeploymentId: "embedding-1",
      name: ""
    }));
    expect(invalid.status).toBe(400);

    const unavailable = await createCreateKnowledgeBaseHandler(deps(repository({
      create: vi.fn(async () => ({ kind: "embedding_not_available" as const }))
    })))(jsonRequest("POST", {
      embeddingDeploymentId: "embedding-1",
      name: "Docs"
    }));
    expect(unavailable.status).toBe(400);
    await expect(unavailable.json()).resolves.toEqual({ error: "knowledge_embedding_not_available" });
  });

  it("uses one privacy-neutral not-found response even for an admin", async () => {
    const repo = repository({ getDetail: vi.fn(async () => null) });
    const response = await createGetKnowledgeBaseHandler(deps(repo, session("admin")))(
      new Request("http://localhost/api/me/knowledge-bases/private-base"),
      { params: { baseId: "private-base" } }
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "knowledge_base_not_available" });
  });

  it("enforces optimistic updates and returns the refreshed owner detail", async () => {
    const conflict = await createUpdateKnowledgeBaseHandler(deps(repository({
      update: vi.fn(async () => ({ kind: "version_conflict" as const }))
    })))(jsonRequest("PATCH", { expectedVersion: 2, name: "Updated" }), {
      params: { baseId: "base-1" }
    });
    expect(conflict.status).toBe(409);

    const repo = repository({ update: vi.fn(async () => ({ kind: "ok" as const })) });
    const updated = await createUpdateKnowledgeBaseHandler(deps(repo))(
      jsonRequest("PATCH", { archived: true, expectedVersion: 3 }),
      { params: { baseId: "base-1" } }
    );
    expect(updated.status).toBe(200);
    expect(repo.update).toHaveBeenCalledWith(
      "user-1",
      "base-1",
      { archived: true, expectedVersion: 3 }
    );
  });

  it("maps publication authorization and revocation without exposing another base", async () => {
    const forbidden = await createPublishKnowledgeBaseHandler(deps(repository({
      publish: vi.fn(async () => ({ kind: "forbidden" as const }))
    })))(jsonRequest("POST", { groupId: "group-1", scope: "group" }), {
      params: { baseId: "base-1" }
    });
    expect(forbidden.status).toBe(403);

    const published = await createPublishKnowledgeBaseHandler(deps(repository({
      publish: vi.fn(async () => ({
        kind: "ok" as const,
        publication: {
          groupId: "group-1",
          groupName: "Design",
          id: "publication-1",
          scope: "group" as const,
          updatedAt: new Date("2026-08-08T12:00:00.000Z")
        }
      }))
    })))(jsonRequest("POST", { groupId: "group-1", scope: "group" }), {
      params: { baseId: "base-1" }
    });
    expect(published.status).toBe(201);

    const revoked = await createRevokeKnowledgeBasePublicationHandler(deps(repository({
      revokePublication: vi.fn(async () => ({ kind: "ok" as const }))
    })))(new Request("http://localhost", { method: "DELETE" }), {
      params: { baseId: "base-1", publicationId: "publication-1" }
    });
    expect(revoked.status).toBe(204);

    const hidden = await createRevokeKnowledgeBasePublicationHandler(deps(repository()))(
      new Request("http://localhost", { method: "DELETE" }),
      { params: { baseId: "private-base", publicationId: "unknown" } }
    );
    expect(hidden.status).toBe(404);
  });
});

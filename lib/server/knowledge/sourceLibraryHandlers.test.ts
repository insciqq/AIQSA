// @vitest-environment node

import type {
  KnowledgeSourceDetail,
  KnowledgeSourceListResponse,
  KnowledgeSourceSummary
} from "../../contracts/knowledge";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createUploadPermitGate } from "../http/uploadPermitGate";
import {
  createAddKnowledgeSourceMembershipsHandler,
  createFindKnowledgeSourceDuplicateHandler,
  createGetKnowledgeSourceHandler,
  createListKnowledgeSourcesHandler,
  createMoveKnowledgeSourceHandler,
  createRemoveKnowledgeSourceMembershipHandler,
  createReplaceKnowledgeSourceHandler,
  createReprocessKnowledgeSourceHandler,
  createUpdateKnowledgeSourceHandler,
  type KnowledgeSourceLibraryHandlerDeps,
  type KnowledgeSourceVersionHandlerDeps
} from "./sourceLibraryHandlers";

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

function sourceSummary(overrides: Partial<KnowledgeSourceSummary> = {}): KnowledgeSourceSummary {
  return {
    canReprocess: false,
    currentVersion: {
      byteSize: 2_048,
      createdAt: "2026-08-18T10:00:00.000Z",
      fileName: "guide.md",
      isCurrent: true,
      isPending: false,
      pageCount: 4,
      readiness: { state: "ready", supportReference: null, warningCodes: [] },
      versionNumber: 2
    },
    deletionPending: false,
    description: "Product guide",
    id: "source-1",
    membershipCount: 1,
    name: "Guide",
    owned: true,
    ownerDisplayName: "Owner",
    purgeScheduledAt: null,
    readiness: { state: "ready", supportReference: null, warningCodes: [] },
    replacement: { state: "none", supportReference: null },
    tags: ["product"],
    trashed: false,
    trashedAt: null,
    updatedAt: "2026-08-18T10:00:00.000Z",
    version: 3,
    ...overrides
  };
}

function sourceDetail(overrides: Partial<KnowledgeSourceDetail> = {}): KnowledgeSourceDetail {
  const summary = sourceSummary();
  return {
    ...summary,
    eligibleBases: [{ archived: false, id: "base-2", name: "Support" }],
    memberships: [{ archived: false, id: "base-1", name: "Product" }],
    versions: [summary.currentVersion!],
    ...overrides
  };
}

function sourceList(): KnowledgeSourceListResponse {
  return {
    pagination: { page: 1, pageSize: 25, query: "", totalItems: 1, totalPages: 1 },
    sources: [sourceSummary()]
  };
}

function repository(overrides: Partial<KnowledgeSourceLibraryHandlerDeps["repository"]> = {}) {
  return {
    addMemberships: vi.fn(async () => ({ kind: "ok" as const })),
    findOwnedDuplicate: vi.fn(async () => sourceSummary()),
    getDetail: vi.fn(async () => sourceDetail()),
    listForUser: vi.fn(async () => sourceList()),
    moveMembership: vi.fn(async () => ({ kind: "ok" as const })),
    removeMembership: vi.fn(async () => ({ kind: "ok" as const })),
    update: vi.fn(async () => ({ kind: "ok" as const })),
    ...overrides
  } satisfies KnowledgeSourceLibraryHandlerDeps["repository"];
}

function deps(
  repo = repository(),
  auth: AuthenticatedSession | null = session()
): KnowledgeSourceLibraryHandlerDeps {
  return {
    repository: repo,
    resolveAuth: vi.fn(async () => auth)
  };
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  });
}

function versionDeps(overrides: Partial<KnowledgeSourceVersionHandlerDeps> = {}) {
  const repo = {
    createVersion: vi.fn(async () => ({ kind: "ok" as const, sourceVersionId: "version-new" })),
    getDetail: vi.fn(async () => sourceDetail()),
    reprocess: vi.fn(async () => ({ kind: "ok" as const }))
  };
  const storage = {
    deleteObject: vi.fn(async () => undefined),
    putObject: vi.fn(async () => undefined)
  };
  const deletionOutbox = {
    complete: vi.fn(async () => undefined),
    stage: vi.fn(async () => ({ id: "cleanup-1" }))
  };
  return {
    deletionOutbox,
    getBodyConfig: () => ({
      uploadMaxConcurrency: 2,
      uploadMultipartMaxBytes: 2_000_000
    }),
    getConfig: () => ({
      maxChunksPerDocument: 100,
      maxFileBytes: 1_000_000,
      maxNormalizedChars: 1_000_000,
      maxNormalizedObjectBytes: 5_000_000,
      maxPages: 100
    }),
    kickProcessing: vi.fn(),
    repository: repo,
    resolveAuth: vi.fn(async () => session()),
    storage,
    uploadPermitGate: createUploadPermitGate(2),
    ...overrides
  } satisfies KnowledgeSourceVersionHandlerDeps;
}

describe("Knowledge Source Library handlers", () => {
  it("authenticates before listing and validates bounded server-side search", async () => {
    const hiddenRepository = repository();
    const unauthorized = await createListKnowledgeSourcesHandler(deps(hiddenRepository, null))(
      new Request("http://localhost/api/me/knowledge-sources")
    );
    expect(unauthorized.status).toBe(401);
    expect(hiddenRepository.listForUser).not.toHaveBeenCalled();

    const repo = repository();
    const response = await createListKnowledgeSourcesHandler(deps(repo))(
      new Request("http://localhost/api/me/knowledge-sources?filter=shared&page=2&pageSize=10&q=%20guide%20")
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(repo.listForUser).toHaveBeenCalledWith({
      filter: "shared",
      page: 2,
      pageSize: 10,
      query: "guide",
      userId: "user-1"
    });
    const scoped = await createListKnowledgeSourcesHandler(deps(repo))(
      new Request("http://localhost/api/me/knowledge-sources?baseId=base-1")
    );
    expect(scoped.status).toBe(200);
    expect(repo.listForUser).toHaveBeenLastCalledWith({
      baseId: "base-1",
      filter: "all",
      page: 1,
      pageSize: 25,
      query: "",
      userId: "user-1"
    });
    const invalid = await createListKnowledgeSourcesHandler(deps(repo))(
      new Request("http://localhost/api/me/knowledge-sources?filter=private")
    );
    expect(invalid.status).toBe(400);
  });

  it("serializes an explicit Source projection without repository extras", async () => {
    const unsafe = {
      ...sourceDetail(),
      currentVersion: {
        ...sourceDetail().currentVersion!,
        artifactId: "artifact-private",
        normalizedTextStorageKey: "storage-private"
      },
      profileRevisionId: "profile-private",
      versions: [{ ...sourceDetail().versions[0], errorCode: "provider-private" }]
    } as unknown as KnowledgeSourceDetail;
    const response = await createGetKnowledgeSourceHandler(deps(repository({
      getDetail: vi.fn(async () => unsafe)
    })))(new Request("http://localhost/api/me/knowledge-sources/source-1"), {
      params: { sourceId: "source-1" }
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      source: {
        canReprocess: false,
        memberships: [{ name: "Product" }],
        name: "Guide",
        readiness: { state: "ready" },
        versions: [{ fileName: "guide.md", versionNumber: 2 }]
      }
    });
    expect(JSON.stringify(body)).not.toMatch(
      /artifact-private|errorCode|profile-private|storage-private/u
    );
  });

  it("keeps invisible and nonexistent Sources privacy-neutral even for admins", async () => {
    const response = await createGetKnowledgeSourceHandler(deps(repository({
      getDetail: vi.fn(async () => null)
    }), session("admin")))(new Request("http://localhost/api/me/knowledge-sources/private"), {
      params: { sourceId: "private" }
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "knowledge_source_not_available" });
  });

  it("uses optimistic owner updates and strict membership mutations", async () => {
    const conflict = await createUpdateKnowledgeSourceHandler(deps(repository({
      update: vi.fn(async () => ({ kind: "version_conflict" as const }))
    })))(jsonRequest("http://localhost", "PATCH", {
      expectedVersion: 2,
      name: "Updated"
    }), { params: { sourceId: "source-1" } });
    expect(conflict.status).toBe(409);

    const repo = repository();
    const added = await createAddKnowledgeSourceMembershipsHandler(deps(repo))(
      jsonRequest("http://localhost", "POST", { baseIds: ["base-2", "base-3"] }),
      { params: { sourceId: "source-1" } }
    );
    expect(added.status).toBe(200);
    expect(repo.addMemberships).toHaveBeenCalledWith(
      "user-1",
      "source-1",
      ["base-2", "base-3"]
    );

    const moved = await createMoveKnowledgeSourceHandler(deps(repo))(
      jsonRequest("http://localhost", "POST", { fromBaseId: "base-1", toBaseId: "base-2" }),
      { params: { sourceId: "source-1" } }
    );
    expect(moved.status).toBe(200);
    expect(repo.moveMembership).toHaveBeenCalledWith(
      "user-1",
      "source-1",
      "base-1",
      "base-2"
    );

    const removed = await createRemoveKnowledgeSourceMembershipHandler(deps(repo))(
      new Request("http://localhost", { method: "DELETE" }),
      { params: { baseId: "base-1", sourceId: "source-1" } }
    );
    expect(removed.status).toBe(200);
    expect(repo.removeMembership).toHaveBeenCalledWith("user-1", "source-1", "base-1");
  });

  it("checks duplicates only inside the authenticated owner scope and returns null safely", async () => {
    const repo = repository({ findOwnedDuplicate: vi.fn(async () => null) });
    const response = await createFindKnowledgeSourceDuplicateHandler(deps(repo))(
      jsonRequest("http://localhost", "POST", {
        byteSize: 2_048,
        checksum: "a".repeat(64)
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ source: null });
    expect(repo.findOwnedDuplicate).toHaveBeenCalledWith("user-1", {
      byteSize: 2_048,
      checksum: "a".repeat(64)
    });
  });

  it("uploads a replacement against the canonical Source and returns processing detail", async () => {
    const dependencies = versionDeps();
    const form = new FormData();
    form.append("file", new File(["# Replacement"], "replacement.md", {
      type: "text/markdown"
    }));
    const response = await createReplaceKnowledgeSourceHandler(dependencies)(
      new Request("http://localhost/api/me/knowledge-sources/source-1/versions", {
        body: form,
        method: "POST"
      }),
      { params: { sourceId: "source-1" } }
    );

    expect(response.status).toBe(202);
    expect(dependencies.storage.putObject).toHaveBeenCalledOnce();
    expect(dependencies.repository.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      byteSize: 13,
      fileName: "replacement.md",
      mimeType: "text/markdown",
      sourceId: "source-1",
      userId: "user-1"
    }));
    expect(dependencies.kickProcessing).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({ source: { id: "source-1" } });
  });

  it("restarts a failed Source artifact without accepting a base-scoped document id", async () => {
    const dependencies = versionDeps();
    const response = await createReprocessKnowledgeSourceHandler(dependencies)(
      new Request("http://localhost/api/me/knowledge-sources/source-1/reprocess", {
        method: "POST"
      }),
      { params: { sourceId: "source-1" } }
    );

    expect(response.status).toBe(202);
    expect(dependencies.repository.reprocess).toHaveBeenCalledWith(
      "user-1",
      "source-1",
      expect.any(Date)
    );
    expect(dependencies.kickProcessing).toHaveBeenCalledOnce();
  });
});

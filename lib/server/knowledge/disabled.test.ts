// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createAdminKnowledgePolicyHandlers } from "../admin/knowledge/policyHandlers";
import {
  createCreateKnowledgeBaseHandler,
  createListKnowledgeBasesHandler,
  createPublishKnowledgeBaseHandler,
  createRevokeKnowledgeBasePublicationHandler,
  createUpdateKnowledgeBaseHandler
} from "./handlers";
import { createKnowledgeLifecycleHandler } from "./lifecycleHandlers";
import {
  createAddKnowledgeSourceMembershipsHandler,
  createFindKnowledgeSourceDuplicateHandler,
  createListKnowledgeSourcesHandler,
  createMoveKnowledgeSourceHandler,
  createRemoveKnowledgeSourceMembershipHandler,
  createReplaceKnowledgeSourceHandler,
  createReprocessKnowledgeSourceHandler,
  createUpdateKnowledgeSourceHandler
} from "./sourceLibraryHandlers";
import {
  createCancelKnowledgeUploadItemHandler,
  createCheckpointKnowledgeUploadPartHandler,
  createKnowledgeUploadBatchCollectionHandlers,
  createRetryKnowledgeUploadItemHandler,
  createSettleKnowledgeUploadItemHandler,
  createStartKnowledgeUploadItemHandler,
  createStreamKnowledgeUploadItemHandler
} from "./uploadHandlers";

/*
 * Knowledge is disabled (`lib/domain/disabledAreas.ts`, real switch here):
 * every Knowledge change refuses with one stable code before authentication,
 * parsing, storage or repository access, and reads still answer.
 */

type AnyHandler = (request: Request, context: never) => Promise<Response>;

function untouchedDeps() {
  const resolveAuth = vi.fn();
  const untouchable = new Proxy({}, {
    get() {
      throw new Error("knowledge_dependency_must_stay_untouched");
    }
  });
  return { deps: { repository: untouchable, resolveAuth, storage: untouchable } as never, resolveAuth };
}

const context = {
  params: { baseId: "base-1", batchId: "batch-1", itemId: "item-1", partNumber: "1", publicationId: "pub-1", sourceId: "source-1" }
} as never;

function post(method = "POST"): Request {
  return new Request("http://app.local/api/me/knowledge-bases", {
    body: JSON.stringify({ name: "Policies" }),
    headers: { "content-type": "application/json" },
    method
  });
}

describe("Knowledge handlers while Knowledge is disabled", () => {
  it.each([
    ["create a base", (deps: never) => createCreateKnowledgeBaseHandler(deps), "POST"],
    ["update a base", (deps: never) => createUpdateKnowledgeBaseHandler(deps), "PATCH"],
    ["publish a base", (deps: never) => createPublishKnowledgeBaseHandler(deps), "POST"],
    ["revoke a publication", (deps: never) => createRevokeKnowledgeBasePublicationHandler(deps), "DELETE"],
    ["trash a base", (deps: never) => createKnowledgeLifecycleHandler(deps, "base", "trash"), "POST"],
    ["restore a source", (deps: never) => createKnowledgeLifecycleHandler(deps, "source", "restore"), "POST"],
    ["delete a source", (deps: never) => createKnowledgeLifecycleHandler(deps, "source", "delete"), "POST"],
    ["update a source", (deps: never) => createUpdateKnowledgeSourceHandler(deps), "PATCH"],
    ["add a source to bases", (deps: never) => createAddKnowledgeSourceMembershipsHandler(deps), "POST"],
    ["remove a source from a base", (deps: never) => createRemoveKnowledgeSourceMembershipHandler(deps), "DELETE"],
    ["move a source", (deps: never) => createMoveKnowledgeSourceHandler(deps), "POST"],
    ["check a duplicate before upload", (deps: never) => createFindKnowledgeSourceDuplicateHandler(deps), "POST"],
    ["replace a source version", (deps: never) => createReplaceKnowledgeSourceHandler(deps), "POST"],
    ["reprocess a source", (deps: never) => createReprocessKnowledgeSourceHandler(deps), "POST"],
    ["start an upload batch", (deps: never) => createKnowledgeUploadBatchCollectionHandlers(deps).POST, "POST"],
    ["start an upload item", (deps: never) => createStartKnowledgeUploadItemHandler(deps), "POST"],
    ["record an upload part", (deps: never) => createCheckpointKnowledgeUploadPartHandler(deps), "POST"],
    ["stream an upload", (deps: never) => createStreamKnowledgeUploadItemHandler(deps), "PUT"],
    ["settle an upload", (deps: never) => createSettleKnowledgeUploadItemHandler(deps), "POST"],
    ["retry an upload", (deps: never) => createRetryKnowledgeUploadItemHandler(deps), "POST"],
    ["cancel an upload", (deps: never) => createCancelKnowledgeUploadItemHandler(deps), "DELETE"]
  ] as ReadonlyArray<readonly [string, (deps: never) => unknown, string]>)(
    "refuses to %s with knowledge_disabled",
    async (_name, factory, method) => {
      const { deps, resolveAuth } = untouchedDeps();
      const handler = factory(deps) as AnyHandler;
      const response = await handler(post(method), context);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "knowledge_disabled" });
      expect(resolveAuth).not.toHaveBeenCalled();
    }
  );

  it("keeps the Knowledge reads answering", async () => {
    const resolveAuth = vi.fn().mockResolvedValue(null);
    const deps = { repository: {}, resolveAuth } as never;
    const request = new Request("http://app.local/api/me/knowledge-bases");

    expect((await createListKnowledgeBasesHandler(deps)(request)).status).toBe(401);
    expect((await createListKnowledgeSourcesHandler(deps)(request)).status).toBe(401);
    expect(resolveAuth).toHaveBeenCalledTimes(2);
  });

  it("refuses an administrator's Knowledge changes and keeps the settings read", async () => {
    const service = { list: vi.fn().mockResolvedValue({ operations: {} }), retryFailedSearchProjections: vi.fn() };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue({ user: { role: "admin", status: "active" }, userId: "admin-1" }) as never,
      service: service as never
    });
    const json = (method: string, body: unknown) => new Request("http://app.local/api/admin/knowledge", {
      body: JSON.stringify(body), headers: { "content-type": "application/json" }, method
    });

    const activate = await handlers.PATCH(json("PATCH", { action: "update_answer_policy", expectedVersion: 1, maximumKnowledgeSearches: 4 }));
    const retry = await handlers.POST(json("POST", { action: "retry_failed_search_projections" }));
    const read = await handlers.GET(new Request("http://app.local/api/admin/knowledge"));

    expect([activate.status, retry.status]).toEqual([409, 409]);
    await expect(activate.json()).resolves.toEqual({ error: "knowledge_disabled" });
    expect(service.retryFailedSearchProjections).not.toHaveBeenCalled();
    expect(read.status).toBe(200);
    expect(service.list).toHaveBeenCalledOnce();
  });
});

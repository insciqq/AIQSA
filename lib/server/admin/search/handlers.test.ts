import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession, RequestAuthResolver } from "../../auth/requestAuth";
import {
  createAdminSearchActionHandler,
  createAdminSearchCatalogHandler,
  createAdminSearchIntegrationHandler
} from "./handlers";
import { AdminSearchServiceError } from "./service";

type SearchService = Parameters<typeof createAdminSearchCatalogHandler>[0]["service"];

const emptyCatalog = { integrations: [], providerModels: [] };

function auth(role = "admin", status = "active"): AuthenticatedSession {
  return {
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Admin",
      email: "admin@example.test",
      id: "admin-1",
      role,
      status
    },
    userId: "admin-1"
  };
}

function resolver(value: AuthenticatedSession | null): RequestAuthResolver {
  return async () => value;
}

function service(overrides: Partial<SearchService> = {}): SearchService {
  return {
    activate: vi.fn(async () => undefined),
    archive: vi.fn(async () => undefined),
    createDraft: vi.fn(async () => undefined),
    list: vi.fn(async () => emptyCatalog),
    setEnabled: vi.fn(async () => undefined),
    testDraft: vi.fn(async () => undefined),
    updateDraft: vi.fn(async () => undefined),
    ...overrides
  };
}

function jsonRequest(path: string, body: unknown, method = "POST", contentType = "application/json") {
  return new Request(`http://localhost${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": contentType },
    method
  });
}

describe("admin Search HTTP handlers", () => {
  it("allows only active administrators and requires JSON for mutations", async () => {
    const searchService = service();
    const anonymous = createAdminSearchCatalogHandler({
      resolveAuth: resolver(null),
      service: searchService
    });
    const ordinaryUser = createAdminSearchCatalogHandler({
      resolveAuth: resolver(auth("user")),
      service: searchService
    });
    const update = createAdminSearchIntegrationHandler({
      resolveAuth: resolver(auth()),
      service: searchService
    });

    expect((await anonymous.GET(new Request("http://localhost/api/admin/search"))).status).toBe(401);
    expect((await ordinaryUser.GET(new Request("http://localhost/api/admin/search"))).status).toBe(403);
    expect((await update(
      jsonRequest("/api/admin/search/integration-1", {}, "PATCH", "text/plain"),
      { params: { integrationId: "integration-1" } }
    )).status).toBe(415);
  });

  it("passes bounded draft data and the authenticated tester identity to the service", async () => {
    const createDraft = vi.fn(async () => undefined);
    const testDraft = vi.fn(async () => undefined);
    const searchService = service({ createDraft, testDraft });
    const catalogHandlers = createAdminSearchCatalogHandler({
      resolveAuth: resolver(auth()),
      service: searchService
    });
    const action = createAdminSearchActionHandler({
      resolveAuth: resolver(auth()),
      service: searchService
    });
    const draft = {
      adapterKind: "provider_model_client",
      credentialMode: "provider_model",
      maxResults: 8,
      protocol: "openai_responses_web_search",
      providerModelId: "technical-1",
      queryMaxCharacters: 500,
      timeoutMs: 15_000
    };

    const created = await catalogHandlers.POST(jsonRequest("/api/admin/search", {
      description: "Query-only evidence",
      displayName: "Company Search",
      draft
    }));
    const tested = await action(
      jsonRequest("/api/admin/search/integration-1/actions", { action: "test" }),
      { params: { integrationId: "integration-1" } }
    );

    expect(created.status).toBe(201);
    expect(createDraft).toHaveBeenCalledWith({
      description: "Query-only evidence",
      displayName: "Company Search",
      draft
    });
    expect(tested.status).toBe(200);
    expect(testDraft).toHaveBeenCalledWith({ id: "integration-1", userId: "admin-1" });
  });

  it("requires explicit archive confirmation and maps lifecycle conflicts", async () => {
    const archive = vi.fn(async () => undefined);
    const action = createAdminSearchActionHandler({
      resolveAuth: resolver(auth()),
      service: service({ archive })
    });
    const context = { params: { integrationId: "integration-1" } };

    const unconfirmed = await action(
      jsonRequest("/api/admin/search/integration-1/actions", { action: "archive" }),
      context
    );
    expect(unconfirmed.status).toBe(409);
    expect(archive).not.toHaveBeenCalled();

    const conflict = createAdminSearchActionHandler({
      resolveAuth: resolver(auth()),
      service: service({
        activate: vi.fn(async () => {
          throw new AdminSearchServiceError("search_activation_evidence_missing");
        })
      })
    });
    const response = await conflict(
      jsonRequest("/api/admin/search/integration-1/actions", { action: "activate" }),
      context
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "search_activation_evidence_missing" });
  });
});

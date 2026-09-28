import { describe, expect, it, vi } from "vitest";
import type { AdminAssistantListingRequestDetail } from "../../contracts/adminAssistants";
import { ASSISTANT_LISTING_REVIEW_NOTE_MAX_LENGTH, type AssistantListingStatus } from "../../contracts/assistantListing";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { logEvent } from "../observability";
import { createAssistantListingHandlers } from "./listingHandlers";
import { AssistantListingError } from "./listingShared";

vi.mock("../observability", () => ({ logEvent: vi.fn() }));
const timestamp = "2026-09-27T00:00:00.000Z";
const summary = { id: "request-1", state: "pending" as const, definitionVersion: 2, outdated: false, createdAt: timestamp,
  reviewedAt: null, reviewNote: null, assistantId: "assistant-1", name: "Reviewer", avatar: null, ownerDisplayName: "Owner",
  updatedAt: timestamp, canReview: true };
const detail: AdminAssistantListingRequestDetail = { ...summary, definition: null };
const listing: AssistantListingStatus = { listed: false, request: summary, canRequest: false, canWithdraw: true };

function fixture(role: string | null = "admin", status = "active") {
  const session: AuthenticatedSession | null = role ? { id: "session", userId: "actor", expiresAt: new Date(timestamp),
    user: { id: "actor", displayName: "Actor", email: null, role, status } } : null;
  const requests = {
    status: vi.fn(async () => listing), request: vi.fn(async () => {}), withdraw: vi.fn(async () => {}),
    listRequests: vi.fn(async () => ({ state: "requests" as const, requests: [summary], pendingCount: 1, nextCursor: null })),
    detail: vi.fn(async () => detail), decide: vi.fn(async () => ({ ...summary, state: "approved" as const, canReview: false }))
  };
  const listed = {
    list: vi.fn(async () => ({ state: "listed" as const, assistants: [], pendingCount: 1, nextCursor: null })),
    setFeatured: vi.fn(async () => [{ assistantId: "assistant-1", featuredOrder: 0 }]), unlist: vi.fn(async () => {})
  };
  return { requests, listed, handlers: createAssistantListingHandlers({ requests, listed, resolveAuth: async () => session }) };
}
const context = { params: { assistantId: "assistant-1", requestId: "request-1" } };
const request = (body?: unknown, method = "POST", query = "") => new Request(`http://localhost/api/admin/assistants${query}`, {
  method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
});

describe("Assistant listing HTTP boundary", () => {
  it.each([
    ["list", "list", "listed"], ["detail", "detail", "requests"], ["decide", "decide", "requests"],
    ["featured", "setFeatured", "listed"], ["unlist", "unlist", "listed"]
  ] as const)("denies a non-administrator %s before any read", async (handler, method, owner) => {
    const f = fixture("user");
    expect((await f.handlers[handler](request({ action: "approve", order: 0 }), context)).status).toBe(403);
    expect((f[owner] as Record<string, ReturnType<typeof vi.fn>>)[method]).not.toHaveBeenCalled();
  });

  it("requires an active session for owner requests", async () => {
    expect((await fixture(null).handlers.request(request({ expectedVersion: 2 }), context)).status).toBe(401);
    const inactive = fixture("user", "suspended");
    expect((await inactive.handlers.request(request({ expectedVersion: 2 }), context)).status).toBe(403);
    expect(inactive.requests.request).not.toHaveBeenCalled();
  });

  it("returns the owner's listing status privately after a request and a withdrawal", async () => {
    const f = fixture("user");
    const response = await f.handlers.request(request({ expectedVersion: 2 }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(f.requests.request).toHaveBeenCalledWith("actor", "assistant-1", 2);
    expect(f.requests.status).toHaveBeenCalledWith("actor", "assistant-1", false);
    expect(await response.json()).toEqual({ listing });
    expect((await f.handlers.withdraw(request(undefined, "DELETE"), context)).status).toBe(200);
    expect(f.requests.withdraw).toHaveBeenCalledWith("actor", "assistant-1", "request-1");
  });

  it("names the Skills that block listing", async () => {
    const f = fixture("user");
    f.requests.request.mockRejectedValueOnce(new AssistantListingError("assistant_skill_audience_mismatch", 409, ["Private draft"]));
    const response = await f.handlers.request(request({ expectedVersion: 2 }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "assistant_skill_audience_mismatch", skills: ["Private draft"] });
    expect(f.requests.status).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies before the service", async () => {
    const f = fixture();
    for (const body of [{ expectedVersion: 0 }, { expectedVersion: 2, note: "x" }, {}]) {
      expect((await f.handlers.request(request(body), context)).status).toBe(400);
    }
    for (const body of [{ action: "approve", note: "a".repeat(ASSISTANT_LISTING_REVIEW_NOTE_MAX_LENGTH + 1) },
      { action: "publish" }, { action: "approve", definitionVersion: 2 }]) {
      expect((await f.handlers.decide(request(body), context)).status).toBe(400);
    }
    for (const body of [{ order: 8 }, { order: -1 }, { order: 1.5 }, {}, { order: 0, assistantId: "other" }]) {
      expect((await f.handlers.featured(request(body), context)).status).toBe(400);
    }
    expect(f.requests.request).not.toHaveBeenCalled();
    expect(f.requests.decide).not.toHaveBeenCalled();
    expect(f.listed.setFeatured).not.toHaveBeenCalled();
  });

  it("accepts Featured positions and removal", async () => {
    const f = fixture();
    expect((await f.handlers.featured(request({ order: 7 }), context)).status).toBe(200);
    const response = await f.handlers.featured(request({ order: null }), context);
    expect(await response.json()).toEqual({ featured: [{ assistantId: "assistant-1", featuredOrder: 0 }] });
    expect(f.listed.setFeatured).toHaveBeenLastCalledWith("actor", "assistant-1", null);
  });

  it("records only content-free decision evidence", async () => {
    vi.mocked(logEvent).mockClear();
    const f = fixture();
    const response = await f.handlers.decide(request({ action: "reject", note: "  Private review note  " }), context);
    expect(response.status).toBe(200);
    expect(f.requests.decide).toHaveBeenCalledWith("actor", "request-1", "reject", "Private review note");
    expect(logEvent).toHaveBeenCalledWith("service_operation", { subsystem: "admin", stage: "write", outcome: "completed", code: "assistant_listing_request_rejected" });
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toMatch(/Private review note|Reviewer|request-1|assistant-1|actor/);
  });

  it("hides unexpected failures behind a stable code", async () => {
    vi.mocked(logEvent).mockClear();
    const f = fixture();
    f.listed.unlist.mockRejectedValueOnce(new Error("connection lost to db host"));
    const response = await f.handlers.unlist(request(undefined, "DELETE"), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "assistant_listing_failed" });
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toContain("db host");
    const unlisted = fixture();
    expect((await unlisted.handlers.unlist(request(undefined, "DELETE"), context)).status).toBe(204);
  });

  it("validates the list state, limit and cursor before reading", async () => {
    const f = fixture();
    for (const query of ["?state=private", "?limit=51", "?cursor=invalid", "?state=listed&state=requests",
      `?state=listed&cursor=${Buffer.from(JSON.stringify({ id: "x", createdAt: timestamp })).toString("base64url")}`]) {
      expect((await f.handlers.list(request(undefined, "GET", query))).status).toBe(400);
    }
    expect(f.listed.list).not.toHaveBeenCalled();
    expect(f.requests.listRequests).not.toHaveBeenCalled();
    const cursor = Buffer.from(JSON.stringify({ id: "x", createdAt: timestamp, featuredOrder: null })).toString("base64url");
    expect((await f.handlers.list(request(undefined, "GET", `?cursor=${cursor}&limit=10`))).status).toBe(200);
    expect(f.listed.list).toHaveBeenCalledWith("actor", { limit: 10, cursor: { id: "x", createdAt: new Date(timestamp), featuredOrder: null } });
    const requestsCursor = Buffer.from(JSON.stringify({ id: "x", createdAt: timestamp })).toString("base64url");
    expect((await f.handlers.list(request(undefined, "GET", `?state=requests&cursor=${requestsCursor}`))).status).toBe(200);
    expect(f.requests.listRequests).toHaveBeenCalledWith("actor", { limit: 30, cursor: { id: "x", createdAt: new Date(timestamp) } });
  });
});

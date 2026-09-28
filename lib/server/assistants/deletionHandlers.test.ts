import { describe, expect, it, vi } from "vitest";
import { decodeAssistantDeletionConsequencesResponse } from "../../contracts/assistantDeletion";
import type { AuthenticatedSession } from "../auth/requestAuth";
import {
  createAssistantDeletionConsequencesHandler,
  createDeleteAssistantHandler,
  type AssistantDeletionHandlerDeps
} from "./deletionHandlers";

function session(role: "admin" | "user" = "user"): AuthenticatedSession {
  return {
    expiresAt: new Date(Date.now() + 60_000),
    id: "session-1",
    user: { displayName: "Owner", email: "owner@example.test", id: "user-1", role, status: "active" },
    userId: "user-1"
  };
}

const consequences = {
  audiences: { groupNames: ["Design"], installation: true },
  chatCount: 4,
  hiddenProjectCount: 1,
  pendingListingRequest: true,
  projects: [{ isDefault: true, name: "Launch" }],
  version: 7
};

function deps(
  repository: Partial<AssistantDeletionHandlerDeps["repository"]> = {},
  options: { role?: "admin" | "user"; signedIn?: boolean } = {}
): AssistantDeletionHandlerDeps & { repository: AssistantDeletionHandlerDeps["repository"] } {
  return {
    repository: {
      delete: vi.fn(async () => ({ kind: "not_found" as const })),
      loadConsequences: vi.fn(async () => null),
      ...repository
    },
    resolveAuth: async () => options.signedIn === false ? null : session(options.role)
  };
}

const context = { params: { assistantId: "assistant-1" } };

function deleteRequest(body: unknown): Request {
  return new Request("http://test/api/me/assistants/assistant-1", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    method: "DELETE"
  });
}

describe("Assistant deletion consequences", () => {
  it("returns the owner's consequences in the published wire shape", async () => {
    const loadConsequences = vi.fn(async () => consequences);
    const response = await createAssistantDeletionConsequencesHandler(deps({ loadConsequences }))(
      new Request("http://test/api/me/assistants/assistant-1/consequences"), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(decodeAssistantDeletionConsequencesResponse(body)).toEqual({ consequences });
    expect(loadConsequences).toHaveBeenCalledWith("user-1", "assistant-1");
  });

  it("answers anyone but the owner, including administrators, with the neutral 404", async () => {
    const response = await createAssistantDeletionConsequencesHandler(deps({}, { role: "admin" }))(
      new Request("http://test/api/me/assistants/assistant-1/consequences"), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "assistant_not_available" });
  });

  it("requires a session", async () => {
    const loadConsequences = vi.fn(async () => consequences);
    const response = await createAssistantDeletionConsequencesHandler(deps({ loadConsequences }, { signedIn: false }))(
      new Request("http://test/api/me/assistants/assistant-1/consequences"), context);
    expect(response.status).toBe(401);
    expect(loadConsequences).not.toHaveBeenCalled();
  });
});

describe("Assistant delete", () => {
  it("deletes with the expected version and returns 204", async () => {
    const remove = vi.fn(async () => ({ kind: "deleted" as const }));
    const response = await createDeleteAssistantHandler(deps({ delete: remove }))(deleteRequest({ expectedVersion: 7 }), context);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(remove).toHaveBeenCalledWith("user-1", "assistant-1", 7);
  });

  it("reports a stale version as the existing version conflict", async () => {
    const response = await createDeleteAssistantHandler(deps({
      delete: vi.fn(async () => ({ kind: "version_conflict" as const }))
    }))(deleteRequest({ expectedVersion: 6 }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "assistant_version_conflict" });
  });

  it.each(["user", "admin"] as const)("keeps a missing, foreign or repeated delete neutral for a %s", async (role) => {
    const remove = vi.fn(async () => ({ kind: "not_found" as const }));
    const response = await createDeleteAssistantHandler(deps({ delete: remove }, { role }))(
      deleteRequest({ expectedVersion: 7 }), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "assistant_not_available" });
    expect(remove).toHaveBeenCalledWith("user-1", "assistant-1", 7);
  });

  it.each([
    ["no body", ""],
    ["a missing version", {}],
    ["a zero version", { expectedVersion: 0 }],
    ["a fractional version", { expectedVersion: 1.5 }],
    ["a string version", { expectedVersion: "7" }],
    ["an unknown key", { expectedVersion: 7, force: true }],
    ["a non-object body", [7]]
  ])("rejects %s before touching the definition", async (_label, body) => {
    const remove = vi.fn(async () => ({ kind: "deleted" as const }));
    const response = await createDeleteAssistantHandler(deps({ delete: remove }))(deleteRequest(body), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "assistant_draft_invalid" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    const remove = vi.fn(async () => ({ kind: "deleted" as const }));
    const response = await createDeleteAssistantHandler(deps({ delete: remove }, { signedIn: false }))(
      deleteRequest({ expectedVersion: 7 }), context);
    expect(response.status).toBe(401);
    expect(remove).not.toHaveBeenCalled();
  });
});

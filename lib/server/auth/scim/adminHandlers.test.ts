import { describe, expect, it, vi } from "vitest";
import type { AdminScimToken } from "@/lib/contracts/adminScim";
import { createTestUser } from "@/tests/support/auth";
import type { AuthenticatedSession } from "../requestAuth";
import { createAdminScimTokenHandlers } from "./adminHandlers";
import type { ScimTokenRepository } from "./tokens";

const NEW_TOKEN = "aiqsa_scim_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const listed: AdminScimToken[] = [{
  createdAt: "2026-10-08T10:00:00.000Z",
  displayPrefix: "aiqsa_scim_0123",
  id: "token-1",
  lastUsedAt: null,
  revokedAt: null
}];

function session(role: "admin" | "user" = "admin"): AuthenticatedSession {
  const user = createTestUser({ id: "admin-1", role });
  return { expiresAt: new Date("2026-10-15T00:00:00.000Z"), id: "session-1", user, userId: user.id };
}

function setup(input: { session?: AuthenticatedSession | null; tokens?: Partial<ScimTokenRepository> } = {}) {
  const tokens: ScimTokenRepository = {
    authenticate: vi.fn(async () => false),
    create: vi.fn(async () => ({ token: NEW_TOKEN })),
    list: vi.fn(async () => listed),
    revoke: vi.fn(async () => true),
    rotate: vi.fn(async () => ({ token: NEW_TOKEN })),
    ...input.tokens
  };
  const handlers = createAdminScimTokenHandlers({
    now: () => new Date("2026-10-08T12:00:00.000Z"),
    resolveAuth: async () => input.session === undefined ? session() : input.session,
    tokens
  });
  const post = (body: unknown, contentType = "application/json") => handlers.POST(new Request("https://aiqsa.example/api/admin/sign-in/scim/tokens", {
    body: JSON.stringify(body),
    headers: { "content-type": contentType },
    method: "POST"
  }));
  return { handlers, post, tokens };
}

describe("SCIM token administration", () => {
  it("lists tokens without their values and never caches the answer", async () => {
    const { handlers } = setup();
    const response = await handlers.GET(new Request("https://aiqsa.example/api/admin/sign-in/scim/tokens"));

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ tokens: listed });
  });

  it("is for active administrators only", async () => {
    expect((await setup({ session: null }).post({ action: "create" })).status).toBe(401);
    const forbidden = setup({ session: session("user") });
    expect((await forbidden.post({ action: "create" })).status).toBe(403);
    expect(forbidden.tokens.create).not.toHaveBeenCalled();
    expect((await setup().post({ action: "create" }, "text/plain")).status).toBe(415);
  });

  it("shows a new token once on create and rotate", async () => {
    const { post, tokens } = setup();

    const created = await post({ action: "create" });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(await created.json()).toEqual({ token: NEW_TOKEN, tokens: listed });
    expect(tokens.create).toHaveBeenCalledWith({ actorUserId: "admin-1", now: new Date("2026-10-08T12:00:00.000Z") });

    const rotated = await post({ action: "rotate", tokenId: "token-1" });
    expect(await rotated.json()).toEqual({ token: NEW_TOKEN, tokens: listed });
    expect(tokens.rotate).toHaveBeenCalledWith(expect.objectContaining({ tokenId: "token-1" }));
  });

  it("revokes, and reports the limit and unknown tokens", async () => {
    const { post } = setup();
    expect(await (await post({ action: "revoke", tokenId: "token-1" })).json()).toEqual({ tokens: listed });

    const limited = setup({ tokens: { create: vi.fn(async () => null) } });
    const refused = await limited.post({ action: "create" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "scim_token_limit" });

    const gone = setup({ tokens: { revoke: vi.fn(async () => false), rotate: vi.fn(async () => null) } });
    expect(await (await gone.post({ action: "revoke", tokenId: "token-9" })).json()).toEqual({ error: "scim_token_not_found" });
    expect((await gone.post({ action: "rotate", tokenId: "token-9" })).status).toBe(404);
  });

  it.each([
    [{ action: "create", extra: true }],
    [{ action: "revoke" }],
    [{ action: "revoke", tokenId: "" }],
    [{ action: "rotate", tokenId: 7 }],
    [{ action: "delete", tokenId: "token-1" }],
    [[]]
  ])("refuses the malformed request %j", async (body) => {
    const response = await setup().post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "scim_token_invalid_request" });
  });
});

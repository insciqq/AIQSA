import { describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "../config";
import { createFixedWindowLoginRateLimiter } from "../rateLimit";
import type { ResolvedSignInMethod } from "../signInMethods";
import { entra, GROUP_ID, okta, USER_ID } from "./clients.testFixtures";
import { createScimHandler, type ScimOutcomeCode } from "./handlers";
import type { ScimGroupRecord, ScimUserRecord } from "./protocol";
import type { ScimRepository } from "./repository";
import { issueScimToken } from "./tokens";

const VALID = issueScimToken().token;
const REVOKED = issueScimToken().token;
const BASE = "https://aiqsa.example/scim/v2";
const scim: ResolvedSignInMethod<"scim"> = {
  activeVersion: 3,
  config: { linkMethod: "oidc" },
  method: "scim",
  secrets: {},
  source: "admin"
};

const user: ScimUserRecord = {
  createdAt: new Date("2026-10-08T10:00:00.000Z"),
  displayName: "Ada Lovelace",
  email: "ada.lovelace@contoso.example",
  groups: [],
  id: USER_ID,
  scimExternalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
  status: "active",
  updatedAt: new Date("2026-10-08T10:00:00.000Z")
};

const group: ScimGroupRecord = {
  createdAt: new Date("2026-10-08T10:00:00.000Z"),
  id: GROUP_ID,
  members: [{ displayName: "Ada Lovelace", id: USER_ID }],
  name: "Engineering",
  scimExternalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
  updatedAt: new Date("2026-10-08T10:00:00.000Z")
};

function fakeRepository(overrides: Partial<ScimRepository> = {}): ScimRepository {
  return {
    createGroup: vi.fn(async () => ({ groupId: GROUP_ID, kind: "ok" as const })),
    createUser: vi.fn(async () => ({ kind: "ok" as const, userId: USER_ID })),
    deactivateUser: vi.fn(async () => ({ kind: "ok" as const, userId: USER_ID })),
    deleteGroup: vi.fn(async () => ({ groupId: GROUP_ID, kind: "ok" as const })),
    getGroup: vi.fn(async (_id: string, members: boolean) => ({ ...group, members: members ? group.members : null })),
    getUser: vi.fn(async () => user),
    listGroups: vi.fn(async (query: { members: boolean }) => ({
      resources: [{ ...group, members: query.members ? group.members : null }],
      totalResults: 1
    })),
    listUsers: vi.fn(async () => ({ resources: [user], totalResults: 1 })),
    patchGroup: vi.fn(async () => ({ groupId: GROUP_ID, kind: "ok" as const })),
    patchUser: vi.fn(async () => ({ kind: "ok" as const, userId: USER_ID })),
    replaceGroup: vi.fn(async () => ({ groupId: GROUP_ID, kind: "ok" as const })),
    replaceUser: vi.fn(async () => ({ kind: "ok" as const, userId: USER_ID })),
    ...overrides
  };
}

function setup(options: { enabled?: boolean; repository?: Partial<ScimRepository> } = {}) {
  const outcomes: ScimOutcomeCode[] = [];
  const repository = fakeRepository(options.repository);
  const authenticate = vi.fn(async (token: string) => token === VALID);
  let now = Date.parse("2026-10-08T12:00:00.000Z");
  const handler = createScimHandler({
    clock: () => now,
    getConfig: () => getAuthConfig({
      AIQSA_APP_BASE_URL: "https://aiqsa.example",
      AIQSA_AUTH_SESSION_SECRET: "scim-handler-test-secret",
      AIQSA_TRUST_PROXY_HEADERS: "1"
    }),
    rateLimiter: createFixedWindowLoginRateLimiter({ maxAttempts: 3, windowMs: 15 * 60_000 }),
    recordOutcome: async (_method, code) => {
      outcomes.push(code);
    },
    repository,
    resolveScim: async () => options.enabled === false ? null : scim,
    sleep: async () => undefined,
    tokens: { authenticate }
  });
  const call = (method: string, path: string, init: { body?: unknown; contentType?: string; source?: string; token?: string | null } = {}) => {
    const headers = new Headers({ "x-forwarded-for": init.source ?? "203.0.113.10" });
    if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? VALID}`);
    if (init.body !== undefined) headers.set("content-type", init.contentType ?? "application/scim+json");
    const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    return handler(new Request(`${BASE}/${path}`, { body, headers, method }), segments);
  };
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    authenticate,
    call,
    outcomes,
    repository
  };
}

const UNAUTHORIZED = {
  detail: "Authentication failed.",
  schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
  status: "401"
};

describe("SCIM endpoint authentication", () => {
  it("answers a missing, malformed, unknown or revoked token and a disabled SCIM with the same 401", async () => {
    for (const { enabled, token } of [
      { enabled: true, token: null },
      { enabled: true, token: "not-a-scim-token" },
      { enabled: true, token: REVOKED },
      { enabled: false, token: VALID }
    ]) {
      const { call, repository } = setup({ enabled });
      const response = await call("GET", `Users/${USER_ID}`, { token });

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer realm=\"SCIM\"");
      expect(await response.json()).toEqual(UNAUTHORIZED);
      expect(repository.getUser).not.toHaveBeenCalled();
    }
  });

  it("records a failed token on the health line only when it has a SCIM token's shape", async () => {
    const { call, outcomes } = setup();

    await call("GET", "Users", { token: "garbage" });
    await call("GET", "Users", { token: null });
    expect(outcomes).toEqual([]);
    await call("GET", "Users", { token: REVOKED });
    expect(outcomes).toEqual(["token_invalid"]);
  });

  it("rate-limits failed attempts per source and gives authenticated requests their attempt back", async () => {
    const { call } = setup();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await call("GET", "Users", { source: "198.51.100.7", token: REVOKED })).status).toBe(401);
    }
    const limited = await call("GET", "Users", { source: "198.51.100.7" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ status: "429" });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await call("GET", "Users", { source: "203.0.113.20" })).status).toBe(200);
    }
  });

  it("bounds and types the body before any token lookup", async () => {
    const { authenticate, call } = setup();

    const tooLarge = await call("POST", "Users", { body: JSON.stringify({ padding: "x".repeat(300 * 1_024) }) });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "413" });
    expect((await call("POST", "Users", { body: "{}", contentType: "text/plain" })).status).toBe(415);
    expect(authenticate).not.toHaveBeenCalled();

    expect((await call("POST", "Users", { body: entra.createUser, contentType: "application/json; charset=utf-8" })).status).toBe(201);
  });
});

describe("SCIM endpoint routing", () => {
  it("serves the discovery endpoints", async () => {
    const { call } = setup();

    expect(await (await call("GET", "ServiceProviderConfig")).json()).toMatchObject({ patch: { supported: true } });
    const types = await (await call("GET", "ResourceTypes")).json();
    expect(types).toMatchObject({ itemsPerPage: 2, totalResults: 2 });
    expect(await (await call("GET", "ResourceTypes/User")).json()).toMatchObject({ endpoint: "/Users" });
    expect(await (await call("GET", "Schemas/urn:ietf:params:scim:schemas:core:2.0:User")).json()).toMatchObject({ name: "User" });
    expect((await call("GET", "Schemas/unknown")).status).toBe(404);
    expect((await call("POST", "ServiceProviderConfig", { body: {} })).status).toBe(405);
    expect((await call("POST", "Bulk", { body: {} })).status).toBe(501);
    expect((await call("GET", "Nothing")).status).toBe(404);
    expect((await call("GET", "")).status).toBe(404);
  });

  it("lists users with the filter and page the client sent", async () => {
    const { call, repository } = setup();

    const response = await call("GET", `Users?${okta.userFilterPage}`);
    expect(response.headers.get("content-type")).toBe("application/scim+json; charset=utf-8");
    expect(await response.json()).toMatchObject({
      Resources: [{ id: USER_ID, userName: "ada.lovelace@contoso.example" }],
      itemsPerPage: 1,
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      startIndex: 1,
      totalResults: 1
    });
    expect(repository.listUsers).toHaveBeenCalledWith({
      clauses: [{ attribute: "userName", value: "grace.hopper@okta.example" }],
      count: 100,
      startIndex: 1
    });

    const refused = await call("GET", `Users?filter=${encodeURIComponent("userName co \"ada\"")}`);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ scimType: "invalidFilter" });
  });

  it("creates a user from an Entra ID request and answers 201 with its location", async () => {
    const { call, outcomes, repository } = setup();

    const response = await call("POST", "Users", { body: entra.createUser });
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(`${BASE}/Users/${USER_ID}`);
    expect(await response.json()).toMatchObject({ active: true, externalId: user.scimExternalId, id: USER_ID });
    expect(repository.createUser).toHaveBeenCalledWith(expect.objectContaining({
      active: true,
      email: "ada.lovelace@contoso.example",
      externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef"
    }), expect.any(Date));
    expect(outcomes).toEqual(["accepted"]);
  });

  it("maps refusals to SCIM errors and content-free health codes", async () => {
    const cases = [
      { code: "uniqueness", result: { kind: "uniqueness" }, scimType: "uniqueness" },
      { code: "owner_transfer_required", result: { kind: "owner_transfer_required", projectCount: 2 }, scimType: undefined },
      { code: "admin_disabled", result: { kind: "admin_disabled" }, scimType: undefined },
      { code: "last_admin", result: { kind: "last_admin" }, scimType: undefined }
    ] as const;
    for (const entry of cases) {
      const { call, outcomes } = setup({ repository: { patchUser: vi.fn(async () => entry.result) } });
      const response = await call("PATCH", `Users/${USER_ID}`, { body: entra.disableUserLegacy });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.scimType).toBe(entry.scimType);
      expect(outcomes).toEqual([entry.code]);
    }
    const ownerTransfer = setup({ repository: { deactivateUser: vi.fn(async () => ({ kind: "owner_transfer_required" as const, projectCount: 1 })) } });
    const deleted = await ownerTransfer.call("DELETE", `Users/${USER_ID}`);
    expect(deleted.status).toBe(409);
    expect((await deleted.json()).detail).toBe("Transfer Project ownership first; the account's access is already revoked.");
  });

  it("deactivates on DELETE and answers PATCH and PUT with the resource", async () => {
    const { call, repository } = setup();

    expect((await call("DELETE", `Users/${USER_ID}`)).status).toBe(204);
    expect(repository.deactivateUser).toHaveBeenCalledWith(USER_ID, expect.any(Date));
    expect((await call("PATCH", `Users/${USER_ID}`, { body: okta.deactivateUser })).status).toBe(200);
    expect(repository.patchUser).toHaveBeenCalledWith(USER_ID, { active: false, ignored: 0 }, expect.any(Date));
    expect(await (await call("PUT", `Users/${USER_ID}`, { body: okta.replaceUser })).json()).toMatchObject({ id: USER_ID });

    const missing = setup({ repository: { getUser: vi.fn(async () => null), patchUser: vi.fn(async () => ({ kind: "not_found" as const })) } });
    expect(await (await missing.call("GET", "Users/unknown-id")).json()).toEqual({
      detail: "Resource not found.",
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404"
    });
    expect((await missing.call("PATCH", "Users/unknown-id", { body: entra.disableUser })).status).toBe(404);
  });

  it("serves groups, honouring excludedAttributes=members", async () => {
    const { call, repository } = setup();

    expect(await (await call("GET", `Groups/${GROUP_ID}?excludedAttributes=members`)).json()).not.toHaveProperty("members");
    expect(repository.getGroup).toHaveBeenLastCalledWith(GROUP_ID, false);
    const listed = await (await call("GET", `Groups?filter=${encodeURIComponent(entra.groupFilter)}&excludedAttributes=members`)).json();
    expect(listed.Resources[0]).not.toHaveProperty("members");
    expect(repository.listGroups).toHaveBeenCalledWith({
      clauses: [{ attribute: "displayName", value: "Engineering" }],
      count: 100,
      members: false,
      startIndex: 1
    });
    const created = await call("POST", "Groups", { body: okta.createGroup });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ members: [{ value: USER_ID }] });
    expect((await call("PATCH", `Groups/${GROUP_ID}`, { body: entra.addMembers })).status).toBe(204);
    expect((await call("DELETE", `Groups/${GROUP_ID}`)).status).toBe(204);
    const conflict = setup({ repository: { createGroup: vi.fn(async () => ({ detail: "An archived group has this name.", kind: "uniqueness" as const })) } });
    expect(await (await conflict.call("POST", "Groups", { body: entra.createGroup })).json()).toMatchObject({
      detail: "An archived group has this name.",
      scimType: "uniqueness",
      status: "409"
    });
  });

  it("refuses malformed JSON and hides unexpected failures", async () => {
    const { call, outcomes } = setup({ repository: { listUsers: vi.fn(async () => { throw new Error("connection to db-internal:5432 refused"); }) } });

    const malformed = await call("POST", "Users", { body: "{not json" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ scimType: "invalidSyntax" });
    expect(outcomes).toEqual(["invalid_request"]);

    const failed = await call("GET", "Users");
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("db-internal");
  });

  it("refreshes an accepted health line at most once a minute, and right after a failure", async () => {
    const { advance, call, outcomes } = setup();

    await call("GET", "Users");
    await call("GET", "Users");
    expect(outcomes).toEqual(["accepted"]);
    await call("PATCH", `Users/${USER_ID}`, { body: { Operations: [] } });
    await call("GET", "Users");
    expect(outcomes).toEqual(["accepted", "invalid_request", "accepted"]);
    advance(61_000);
    await call("GET", "Users");
    expect(outcomes).toEqual(["accepted", "invalid_request", "accepted", "accepted"]);
  });
});

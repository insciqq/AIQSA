import { describe, expect, it } from "vitest";
import {
  isScimJsonContentType,
  scimBaseUrl,
  scimError,
  scimExcludedAttributes,
  scimGroupResource,
  scimPage,
  ScimRequestError,
  scimResourceTypes,
  scimSchemas,
  scimServiceProviderConfig,
  scimUserResource,
  visibleExternalId
} from "./protocol";

const BASE = "https://aiqsa.example/scim/v2";
const created = new Date("2026-10-08T10:00:00.000Z");
const updated = new Date("2026-10-08T11:00:00.000Z");

describe("SCIM protocol", () => {
  it("answers errors with the SCIM envelope and nothing else", async () => {
    const response = scimError(409, "A user with this userName or externalId already exists.", "uniqueness");

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("application/scim+json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      detail: "A user with this userName or externalId already exists.",
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      scimType: "uniqueness",
      status: "409"
    });
    expect(await scimError(401, "Authentication failed.").json()).toEqual({
      detail: "Authentication failed.",
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "401"
    });
  });

  it("advertises patch and filtering, and no bulk, sort, ETags or password change", () => {
    expect(scimServiceProviderConfig(BASE)).toMatchObject({
      authenticationSchemes: [{ primary: true, type: "oauthbearertoken" }],
      bulk: { supported: false },
      changePassword: { supported: false },
      etag: { supported: false },
      filter: { maxResults: 100, supported: true },
      patch: { supported: true },
      sort: { supported: false }
    });
    expect(scimResourceTypes(BASE).map((type) => type.endpoint)).toEqual(["/Users", "/Groups"]);
    expect(scimResourceTypes(BASE, "group")).toHaveLength(1);
    expect(scimSchemas(BASE).map((schema) => schema.id)).toEqual([
      "urn:ietf:params:scim:schemas:core:2.0:User",
      "urn:ietf:params:scim:schemas:core:2.0:Group"
    ]);
    expect(scimSchemas(BASE, "urn:ietf:params:scim:schemas:core:2.0:Group")[0]!.attributes.map((attribute) => attribute.name))
      .toEqual(["displayName", "externalId", "members"]);
  });

  it("projects a user: email as userName, status as active, the client's externalId only", () => {
    const user = {
      createdAt: created,
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      groups: [{ id: "g-1", name: "Engineering" }],
      id: "u-1",
      scimExternalId: "ext-1",
      status: "active" as const,
      updatedAt: updated
    };

    expect(scimUserResource(user, BASE)).toEqual({
      active: true,
      displayName: "Ada Lovelace",
      emails: [{ primary: true, type: "work", value: "ada@example.test" }],
      externalId: "ext-1",
      groups: [{ $ref: `${BASE}/Groups/g-1`, display: "Engineering", value: "g-1" }],
      id: "u-1",
      meta: {
        created: "2026-10-08T10:00:00.000Z",
        lastModified: "2026-10-08T11:00:00.000Z",
        location: `${BASE}/Users/u-1`,
        resourceType: "User"
      },
      name: { formatted: "Ada Lovelace" },
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "ada@example.test"
    });
    const keyedById = scimUserResource({ ...user, scimExternalId: "u-1", status: "disabled" }, BASE, { excludeGroups: true });
    expect(keyedById).not.toHaveProperty("externalId");
    expect(keyedById).not.toHaveProperty("groups");
    expect(keyedById.active).toBe(false);
    expect(scimUserResource({ ...user, email: null }, BASE)).toMatchObject({ emails: [], userName: "u-1" });
  });

  it("projects a group with or without its members", () => {
    const group = { createdAt: created, id: "g-1", members: [{ displayName: "Ada", id: "u-1" }], name: "Engineering", scimExternalId: "g-1", updatedAt: updated };

    expect(scimGroupResource(group, BASE)).toMatchObject({
      displayName: "Engineering",
      members: [{ $ref: `${BASE}/Users/u-1`, display: "Ada", type: "User", value: "u-1" }]
    });
    expect(scimGroupResource(group, BASE)).not.toHaveProperty("externalId");
    expect(scimGroupResource({ ...group, members: null }, BASE)).not.toHaveProperty("members");
    expect(visibleExternalId(null, "g-1")).toBeNull();
    expect(visibleExternalId("ext", "g-1")).toBe("ext");
  });

  it("bounds pagination as RFC 7644 allows and refuses non-integers", () => {
    expect(scimPage(new URLSearchParams())).toEqual({ count: 100, startIndex: 1 });
    expect(scimPage(new URLSearchParams("startIndex=0&count=-5"))).toEqual({ count: 0, startIndex: 1 });
    expect(scimPage(new URLSearchParams("startIndex=201&count=500"))).toEqual({ count: 100, startIndex: 201 });
    expect(() => scimPage(new URLSearchParams("count=ten"))).toThrow(ScimRequestError);
    expect(() => scimPage(new URLSearchParams("startIndex=1.5"))).toThrow(ScimRequestError);
  });

  it("reads excluded attributes, content types and the base URL", () => {
    expect([...scimExcludedAttributes(new URLSearchParams("excludedAttributes=members,urn:ietf:params:scim:schemas:core:2.0:User:groups"))])
      .toEqual(["members", "groups"]);
    expect(isScimJsonContentType("application/scim+json; charset=utf-8")).toBe(true);
    expect(isScimJsonContentType("application/json")).toBe(true);
    expect(isScimJsonContentType("text/plain")).toBe(false);
    expect(isScimJsonContentType(null)).toBe(false);
    expect(scimBaseUrl("https://aiqsa.example/")).toBe(BASE);
  });
});

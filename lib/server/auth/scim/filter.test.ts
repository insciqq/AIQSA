import { describe, expect, it } from "vitest";
import { entra, okta } from "./clients.testFixtures";
import { parseScimFilter, SCIM_GROUP_FILTER_ATTRIBUTES, SCIM_USER_FILTER_ATTRIBUTES } from "./filter";
import { ScimRequestError } from "./protocol";

function users(filter: string) {
  return parseScimFilter(filter, SCIM_USER_FILTER_ATTRIBUTES);
}

function groups(filter: string) {
  return parseScimFilter(filter, SCIM_GROUP_FILTER_ATTRIBUTES);
}

function refusal(run: () => unknown): ScimRequestError {
  try {
    run();
  } catch (error) {
    if (error instanceof ScimRequestError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("SCIM filter parser", () => {
  it("parses the lookups Entra ID, Okta and Authentik send", () => {
    expect(users(entra.userFilter)).toEqual([{ attribute: "userName", value: "ada.lovelace@contoso.example" }]);
    expect(users(new URLSearchParams(okta.userFilterPage).get("filter")!))
      .toEqual([{ attribute: "userName", value: "grace.hopper@okta.example" }]);
    expect(groups(entra.groupFilter)).toEqual([{ attribute: "displayName", value: "Engineering" }]);
    expect(users("externalId eq \"00ujl29u0le5T6Aj10h7\"")).toEqual([{ attribute: "externalId", value: "00ujl29u0le5T6Aj10h7" }]);
    expect(users("emails.value eq \"a@example.test\"")).toEqual([{ attribute: "emails.value", value: "a@example.test" }]);
    expect(users("emails eq \"a@example.test\"")).toEqual([{ attribute: "emails.value", value: "a@example.test" }]);
  });

  it("accepts any case for attribute names and keywords, the core schema URN and escaped values", () => {
    expect(users("USERNAME Eq \"x@example.test\"")).toEqual([{ attribute: "userName", value: "x@example.test" }]);
    expect(users("urn:ietf:params:scim:schemas:core:2.0:User:userName eq \"x@example.test\""))
      .toEqual([{ attribute: "userName", value: "x@example.test" }]);
    expect(groups("displayName eq \"Quote \\\" and \\\\ slash\"")).toEqual([{ attribute: "displayName", value: "Quote \" and \\ slash" }]);
    // Values keep their case: externalIds are case-exact.
    expect(users("externalid eq \"AbC\"")).toEqual([{ attribute: "externalId", value: "AbC" }]);
  });

  it("joins clauses with and, including the members value path", () => {
    expect(groups(`id eq "g-1" and members[value eq "u-1"]`)).toEqual([
      { attribute: "id", value: "g-1" },
      { attribute: "members.value", value: "u-1" }
    ]);
    expect(groups("members.value eq \"u-2\"")).toEqual([{ attribute: "members.value", value: "u-2" }]);
  });

  it.each([
    "userName co \"ada\"",
    "userName sw \"ada\"",
    "userName pr",
    "userName eq \"a\" or externalId eq \"b\"",
    "not (userName eq \"a\")",
    "(userName eq \"a\")",
    "userName eq ada",
    "userName eq true",
    "userName eq \"unterminated",
    "displayName eq \"Engineering\"",
    "emails[type eq \"work\"].value eq \"a@example.test\"",
    "userName eq \"a\" and",
    "userName eq \"a\" extra",
    "",
    `userName eq "${"x".repeat(513)}"`,
    Array.from({ length: 5 }, (_, index) => `id eq "${index}"`).join(" and ")
  ])("refuses %j with invalidFilter", (filter) => {
    expect(refusal(() => users(filter))).toMatchObject({ scimType: "invalidFilter", status: 400 });
  });

  it("bounds the filter length", () => {
    expect(refusal(() => users(`userName eq "${"a".repeat(1_100)}"`))).toMatchObject({ scimType: "invalidFilter" });
  });
});

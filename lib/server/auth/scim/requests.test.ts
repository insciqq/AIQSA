import { describe, expect, it } from "vitest";
import { authentik, entra, GROUP_ID, okta, OTHER_USER_ID, USER_ID } from "./clients.testFixtures";
import { ScimRequestError } from "./protocol";
import {
  applyScimMemberOperations,
  parseScimGroupBody,
  parseScimGroupPatch,
  parseScimUserBody,
  parseScimUserPatch,
  resolveScimUserPatch,
  scimBoolean
} from "./requests";

function refusal(run: () => unknown): ScimRequestError {
  try {
    run();
  } catch (error) {
    if (error instanceof ScimRequestError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const patchOp = (...Operations: unknown[]) => ({
  Operations,
  schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
});

describe("SCIM user bodies", () => {
  it("maps an Entra ID create: userName is the email, the extension and roles are left out", () => {
    expect(parseScimUserBody(entra.createUser)).toEqual({
      active: true,
      displayName: "Ada Lovelace",
      email: "ada.lovelace@contoso.example",
      externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
      ignored: 2
    });
  });

  it("maps an Okta create and PUT: the password and locale are never applied", () => {
    expect(parseScimUserBody(okta.createUser)).toEqual({
      active: true,
      displayName: "Grace Hopper",
      email: "grace.hopper@okta.example",
      externalId: "00ujl29u0le5T6Aj10h7",
      ignored: 2
    });
    expect(parseScimUserBody(okta.replaceUser)).toMatchObject({ displayName: "Grace Brewster Hopper", ignored: 1 });
  });

  it("falls back to the primary email when userName is not an email (Authentik's default mapping)", () => {
    expect(parseScimUserBody(authentik.createUser)).toMatchObject({
      displayName: "Katherine Johnson",
      email: "katherine.johnson@authentik.example"
    });
    expect(parseScimUserBody(authentik.deactivateUser)).toMatchObject({ active: false });
  });

  it("normalizes the email and builds the display name from the name parts", () => {
    expect(parseScimUserBody({ name: { familyName: "Doe", givenName: " Jane " }, userName: " Jane.Doe@Example.Test " }))
      .toEqual({ displayName: "Jane Doe", email: "jane.doe@example.test", ignored: 0 });
    expect(parseScimUserBody({ userName: "j@example.test" })).toEqual({ email: "j@example.test", ignored: 0 });
  });

  it.each([
    [{ userName: "not-an-email" }, "invalidValue"],
    [{ emails: [{ value: "nope" }], userName: "jdoe" }, "invalidValue"],
    [{ active: "maybe", userName: "a@example.test" }, "invalidValue"],
    [{ externalId: "", userName: "a@example.test" }, "invalidValue"],
    [{ name: "Jane", userName: "a@example.test" }, "invalidValue"],
    [["not", "an", "object"], "invalidSyntax"]
  ])("refuses %j", (body, scimType) => {
    expect(refusal(() => parseScimUserBody(body))).toMatchObject({ scimType, status: 400 });
  });
});

describe("SCIM PATCH engine for users", () => {
  it("accepts Entra's capitalized ops and string booleans", () => {
    expect(parseScimUserPatch(entra.disableUser)).toEqual({ active: false, ignored: 0 });
    expect(parseScimUserPatch(entra.disableUserLegacy)).toEqual({ active: false, ignored: 0 });
    expect(parseScimUserPatch(entra.updateUserLegacyNoPath)).toEqual({
      active: true,
      displayName: "Ada King",
      givenName: "Ada",
      ignored: 0
    });
    expect(scimBoolean("TRUE", "active")).toBe(true);
  });

  it("reads multi-valued and dotted paths", () => {
    expect(parseScimUserPatch(entra.replaceMultiValued)).toEqual({
      familyName: "King",
      ignored: 0,
      primaryEmail: "ada@contoso.example"
    });
    expect(parseScimUserPatch(entra.replaceUserName)).toEqual({ ignored: 0, userName: "ada.king@contoso.example" });
    expect(parseScimUserPatch(patchOp({ op: "replace", path: "name", value: { familyName: "Doe", givenName: "Jo" } })))
      .toEqual({ familyName: "Doe", givenName: "Jo", ignored: 0 });
  });

  it("applies Okta's path-less deactivation", () => {
    expect(parseScimUserPatch(okta.deactivateUser)).toEqual({ active: false, ignored: 0 });
  });

  it("counts unmapped attributes and never applies them", () => {
    expect(parseScimUserPatch(patchOp(
      { op: "replace", path: "title", value: "CTO" },
      { op: "add", path: "phoneNumbers[type eq \"mobile\"].value", value: "+1" },
      { op: "replace", path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department", value: "R&D" },
      { op: "replace", value: { "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { manager: "x" }, active: true } }
    ))).toEqual({ active: true, ignored: 4 });
  });

  it("lets later operations win and removes the externalId", () => {
    expect(parseScimUserPatch(patchOp(
      { op: "replace", path: "active", value: false },
      { op: "replace", path: "active", value: "true" },
      { op: "remove", path: "externalId" }
    ))).toEqual({ active: true, externalId: null, ignored: 0 });
  });

  it.each([
    [{ Operations: [] }, "invalidSyntax"],
    [{ Operations: [{ op: "move", path: "active", value: true }] }, "invalidSyntax"],
    [patchOp({ op: "remove" }), "noTarget"],
    [patchOp({ op: "replace", value: "x" }), "invalidValue"],
    [patchOp({ op: "replace", path: "active", value: "no" }), "invalidValue"],
    [patchOp({ op: "remove", path: "userName" }), "mutability"],
    [patchOp({ op: "replace", path: 7, value: true }), "invalidPath"]
  ])("refuses %j", (body, scimType) => {
    expect(refusal(() => parseScimUserPatch(body))).toMatchObject({ scimType, status: 400 });
  });

  it("resolves the next email and display name against the current account", () => {
    const current = { displayName: "Ada Lovelace", email: "ada.lovelace@contoso.example" };

    expect(resolveScimUserPatch(current, parseScimUserPatch(entra.replaceUserName)))
      .toEqual({ displayName: "Ada Lovelace", email: "ada.king@contoso.example" });
    // An email change alone follows userName, which already is the email; a name part alone
    // has nothing to combine with.
    expect(resolveScimUserPatch(current, parseScimUserPatch(entra.replaceMultiValued))).toEqual(current);
    expect(resolveScimUserPatch(current, parseScimUserPatch(patchOp(
      { op: "replace", path: "name.givenName", value: "Augusta" },
      { op: "replace", path: "name.familyName", value: "King" }
    )))).toEqual({ ...current, displayName: "Augusta King" });
    expect(resolveScimUserPatch({ displayName: "No email", email: null }, parseScimUserPatch(patchOp(
      { op: "add", path: "emails", value: [{ primary: true, value: "New@Example.Test" }] }
    )))).toEqual({ displayName: "No email", email: "new@example.test" });
    expect(refusal(() => resolveScimUserPatch({ displayName: "x", email: null }, parseScimUserPatch(patchOp(
      { op: "replace", path: "userName", value: "jdoe" }
    ))))).toMatchObject({ scimType: "invalidValue" });
  });
});

describe("SCIM group bodies and PATCH engine", () => {
  it("maps group creates of every client", () => {
    expect(parseScimGroupBody(entra.createGroup)).toEqual({
      displayName: "Engineering",
      externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
      ignored: 0,
      members: []
    });
    expect(parseScimGroupBody(okta.createGroup)).toEqual({ displayName: "Compilers", ignored: 0, members: [USER_ID] });
    expect(parseScimGroupBody(authentik.createGroup)).toMatchObject({ members: [USER_ID] });
  });

  it.each([
    [{ displayName: "x" }],
    [{ displayName: "Bad\u0000name" }],
    [{ displayName: "Team", members: [{ display: "no value" }] }],
    [{ displayName: "Team", members: "u-1" }]
  ])("refuses %j", (body) => {
    expect(refusal(() => parseScimGroupBody(body))).toMatchObject({ scimType: "invalidValue" });
  });

  it("reads Entra's member value lists and Okta's member filter", () => {
    expect(parseScimGroupPatch(entra.addMembers)).toEqual({
      ignored: 0,
      members: [{ kind: "add", values: [USER_ID, OTHER_USER_ID] }]
    });
    expect(parseScimGroupPatch(entra.removeMembers)).toEqual({ ignored: 0, members: [{ kind: "remove", values: [USER_ID] }] });
    expect(parseScimGroupPatch(okta.removeMember)).toEqual({ ignored: 0, members: [{ kind: "remove", values: [USER_ID] }] });
    expect(parseScimGroupPatch(okta.addMembers)).toEqual({ ignored: 0, members: [{ kind: "add", values: [OTHER_USER_ID] }] });
    expect(parseScimGroupPatch(authentik.removeMembers)).toEqual({ ignored: 0, members: [{ kind: "remove", values: [OTHER_USER_ID] }] });
  });

  it("reads renames with and without a path, ignoring the echoed id", () => {
    expect(parseScimGroupPatch(entra.renameGroup)).toEqual({ displayName: "Platform Engineering", ignored: 0, members: [] });
    expect(parseScimGroupPatch(okta.renameGroup)).toEqual({ displayName: "Compiler Team", ignored: 0, members: [] });
    expect(parseScimGroupPatch(patchOp(
      { op: "replace", value: { externalId: "ext-1", members: [{ value: USER_ID }] } },
      { op: "remove", path: "members" },
      { op: "replace", path: "description", value: "ignored" }
    ))).toEqual({
      externalId: "ext-1",
      ignored: 1,
      members: [{ kind: "replace", values: [USER_ID] }, { kind: "remove_all" }]
    });
  });

  it.each([
    [patchOp({ op: "add", path: `members[value eq "${USER_ID}"]` }), "invalidPath"],
    [patchOp({ op: "remove", path: "displayName" }), "mutability"],
    [patchOp({ op: "add", path: "members" }), "invalidValue"]
  ])("refuses %j", (body, scimType) => {
    expect(refusal(() => parseScimGroupPatch(body))).toMatchObject({ scimType });
  });

  it("applies member operations in order to the current members", () => {
    const current = new Set([USER_ID, GROUP_ID]);

    expect([...applyScimMemberOperations(current, [
      { kind: "remove", values: [GROUP_ID] },
      { kind: "add", values: [OTHER_USER_ID, OTHER_USER_ID] }
    ])].sort()).toEqual([OTHER_USER_ID, USER_ID].sort());
    expect([...applyScimMemberOperations(current, [{ kind: "replace", values: [OTHER_USER_ID] }])]).toEqual([OTHER_USER_ID]);
    expect([...applyScimMemberOperations(current, [{ kind: "remove_all" }, { kind: "add", values: [USER_ID] }])]).toEqual([USER_ID]);
    expect([...current].sort()).toEqual([GROUP_ID, USER_ID].sort());
  });
});

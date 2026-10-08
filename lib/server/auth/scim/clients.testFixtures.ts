/**
 * SCIM request shapes of the clients AIQSA supports, written from their public documentation:
 * Microsoft Entra ID ("Develop and plan provisioning for a SCIM endpoint", including the
 * pre-2020 non-compliant forms Entra still sends without the `aadOptscim062020` flag), Okta
 * ("SCIM 2.0 protocol reference") and Authentik (its SCIM provider with the default property
 * mappings). Identifiers are synthetic; `USER_ID`/`GROUP_ID` stand for AIQSA resource ids.
 */

export const USER_ID = "2819c223-7f76-453a-919d-413861904646";
export const OTHER_USER_ID = "902c246b-6245-4190-8e05-00816be7344a";
export const GROUP_ID = "e9e30dba-f08f-4109-8486-d5c6a331660a";

export const entra = {
  createUser: {
    active: true,
    emails: [{ primary: true, type: "work", value: "ada.lovelace@contoso.example" }],
    externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
    meta: { resourceType: "User" },
    name: { familyName: "Lovelace", formatted: "Ada Lovelace", givenName: "Ada" },
    roles: [],
    schemas: [
      "urn:ietf:params:scim:schemas:core:2.0:User",
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
    ],
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Engineering" },
    userName: "ada.lovelace@contoso.example"
  },
  /** Entra matches users by `userName` before it creates one. */
  userFilter: "userName eq \"ada.lovelace@contoso.example\"",
  replaceMultiValued: {
    Operations: [
      { op: "Replace", path: "emails[type eq \"work\"].value", value: "ada@contoso.example" },
      { op: "Replace", path: "name.familyName", value: "King" }
    ],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  replaceUserName: {
    Operations: [{ op: "Replace", path: "userName", value: "ada.king@contoso.example" }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  disableUser: {
    Operations: [{ op: "Replace", path: "active", value: false }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  /** Without the compliance flag: a capitalized op and a string boolean. */
  disableUserLegacy: {
    Operations: [{ op: "Replace", path: "active", value: "False" }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  /** Without the compliance flag: attributes as an object without a path. */
  updateUserLegacyNoPath: {
    Operations: [{ op: "Replace", value: { active: "True", displayName: "Ada King", "name.givenName": "Ada" } }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  createGroup: {
    displayName: "Engineering",
    externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
    meta: { resourceType: "Group" },
    schemas: [
      "urn:ietf:params:scim:schemas:core:2.0:Group",
      "http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group"
    ]
  },
  groupFilter: "displayName eq \"Engineering\"",
  renameGroup: {
    Operations: [{ op: "Replace", path: "displayName", value: "Platform Engineering" }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  addMembers: {
    Operations: [{ op: "Add", path: "members", value: [{ $ref: null, value: USER_ID }, { $ref: null, value: OTHER_USER_ID }] }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  removeMembers: {
    Operations: [{ op: "Remove", path: "members", value: [{ $ref: null, value: USER_ID }] }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  }
} as const;

export const okta = {
  createUser: {
    active: true,
    displayName: "Grace Hopper",
    emails: [{ primary: true, type: "work", value: "grace.hopper@okta.example" }],
    externalId: "00ujl29u0le5T6Aj10h7",
    groups: [],
    locale: "en-US",
    name: { familyName: "Hopper", givenName: "Grace" },
    password: "1mz050nq",
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "grace.hopper@okta.example"
  },
  userFilterPage: "filter=userName%20eq%20%22grace.hopper%40okta.example%22&startIndex=1&count=100",
  replaceUser: {
    active: true,
    displayName: "Grace Brewster Hopper",
    emails: [{ primary: true, type: "work", value: "grace.hopper@okta.example" }],
    externalId: "00ujl29u0le5T6Aj10h7",
    groups: [],
    id: USER_ID,
    locale: "en-US",
    meta: { created: "2026-10-01T10:00:00.000Z", lastModified: "2026-10-01T10:00:00.000Z", resourceType: "User" },
    name: { familyName: "Hopper", givenName: "Grace", middleName: "Brewster" },
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "grace.hopper@okta.example"
  },
  /** Okta deactivates with an object of attributes and no path. */
  deactivateUser: {
    Operations: [{ op: "replace", value: { active: false } }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  /** Okta pushes groups without an externalId. */
  createGroup: {
    displayName: "Compilers",
    members: [{ display: "grace.hopper@okta.example", value: USER_ID }],
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"]
  },
  renameGroup: {
    Operations: [{ op: "replace", value: { displayName: "Compiler Team", id: GROUP_ID } }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  addMembers: {
    Operations: [{ op: "add", path: "members", value: [{ display: "user@okta.example", value: OTHER_USER_ID }] }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  removeMember: {
    Operations: [{ op: "remove", path: `members[value eq "${USER_ID}"]` }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  }
} as const;

export const authentik = {
  /** The default mapping sends the username as `userName` and the email in `emails`. */
  createUser: {
    active: true,
    displayName: "Katherine Johnson",
    emails: [{ primary: true, type: "other", value: "katherine.johnson@authentik.example" }],
    externalId: "b3c4b1f6a1c45e0e3a5e0d2c3d9c5b8f2b1e4c7a9d0e1f2a3b4c5d6e7f8a9b0c",
    name: { familyName: "Johnson", formatted: "Katherine Johnson", givenName: "Katherine" },
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "kjohnson"
  },
  /** Profile updates and deactivation are a PUT of the whole user. */
  deactivateUser: {
    active: false,
    displayName: "Katherine Johnson",
    emails: [{ primary: true, type: "other", value: "katherine.johnson@authentik.example" }],
    externalId: "b3c4b1f6a1c45e0e3a5e0d2c3d9c5b8f2b1e4c7a9d0e1f2a3b4c5d6e7f8a9b0c",
    id: USER_ID,
    name: { familyName: "Johnson", formatted: "Katherine Johnson", givenName: "Katherine" },
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "kjohnson"
  },
  createGroup: {
    displayName: "mission-control",
    externalId: "5d2f1c8e-3b4a-4e6f-9a1b-2c3d4e5f6a7b",
    members: [{ value: USER_ID }],
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"]
  },
  addMembers: {
    Operations: [{ op: "add", path: "members", value: [{ value: OTHER_USER_ID }] }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  },
  removeMembers: {
    Operations: [{ op: "remove", path: "members", value: [{ value: OTHER_USER_ID }] }],
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"]
  }
} as const;

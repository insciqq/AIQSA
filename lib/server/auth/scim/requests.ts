import { normalizeAdminGroupName } from "../adminRepositoryInputs";
import { isPlausibleEmail, normalizeAuthEmail } from "../password";
import { invalidScimValue, normalizeScimAttributePath } from "./protocol";

/**
 * Request bodies of the SCIM Users and Groups endpoints, decoded into the changes AIQSA maps.
 * The decoders tolerate what Entra ID, Okta and Authentik send (capitalized `op` values, string
 * booleans, operations with or without a path, value-path member removal) and count, but never
 * apply, attributes AIQSA does not map.
 */

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const EMAIL_MAX_LENGTH = 320;
const EXTERNAL_ID_MAX_LENGTH = 256;
const MEMBER_ID_MAX_LENGTH = 128;
const NAME_PART_MAX_LENGTH = 160;
const PATCH_OPERATIONS_MAX = 1_000;
export const SCIM_DISPLAY_NAME_MAX_LENGTH = 160;

/** Envelope and read-only attributes clients echo back; never counted as ignored. */
const ENVELOPE_ATTRIBUTES = new Set(["groups", "id", "meta", "schemas"]);
const GROUP_ENVELOPE_ATTRIBUTES = new Set(["id", "meta", "schemas"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Attribute names are case-insensitive (RFC 7643 2.1); the first spelling wins. */
function field(record: Record<string, unknown>, name: string): unknown {
  const lower = name.toLowerCase();
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : record[key];
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length > max || CONTROL_CHARACTERS.test(value)) {
    throw invalidScimValue(`${name} must be text of at most ${max} characters.`);
  }
  return value;
}

/** `true`/`false`, or the strings Entra ID sends (`"True"`, `"False"`). */
export function scimBoolean(value: unknown, name: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw invalidScimValue(`${name} must be true or false.`);
}

/** A display name as stored: trimmed, single-spaced, bounded; null when empty. */
function displayNameText(value: unknown, name = "displayName"): string | null {
  if (value === null) return null;
  const normalized = text(value, name, 1_024).trim().replace(/\s+/gu, " ").slice(0, SCIM_DISPLAY_NAME_MAX_LENGTH);
  return normalized || null;
}

function namePart(value: unknown, name: string): string | null {
  if (value === null) return null;
  return text(value, name, NAME_PART_MAX_LENGTH).trim() || null;
}

function externalIdText(value: unknown): string {
  const externalId = text(value, "externalId", EXTERNAL_ID_MAX_LENGTH);
  if (!externalId.trim()) throw invalidScimValue("externalId must not be empty.");
  return externalId;
}

/** The primary email of an `emails` list: `primary`, else `type: work`, else the first entry. */
function primaryEmail(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const entries = (Array.isArray(value) ? value : [value]).filter(isRecord);
  const chosen = entries.find((entry) => field(entry, "primary") === true || String(field(entry, "primary")).toLowerCase() === "true") ??
    entries.find((entry) => String(field(entry, "type")).toLowerCase() === "work") ??
    entries[0];
  const email = chosen ? field(chosen, "value") : undefined;
  return typeof email === "string" ? text(email, "emails.value", EMAIL_MAX_LENGTH) : null;
}

/**
 * The account email: `userName` when it is an email address, otherwise the primary email (an
 * Authentik default mapping sends the username as `userName`). Null when neither is one.
 */
export function scimAccountEmail(userName: string | null, email: string | null): string | null {
  for (const candidate of [userName, email]) {
    if (candidate !== null && isPlausibleEmail(candidate)) return normalizeAuthEmail(candidate);
  }
  return null;
}

function displayNameFromParts(givenName: string | null, familyName: string | null): string | null {
  const joined = [givenName, familyName].filter(Boolean).join(" ").trim();
  return joined ? joined.slice(0, SCIM_DISPLAY_NAME_MAX_LENGTH) : null;
}

/** A POST or PUT User body. */
export type ScimUserInput = {
  /** Absent: unchanged (PUT) or active (POST). */
  active?: boolean;
  /** From `displayName`, `name.formatted` or the name parts; absent keeps the current one. */
  displayName?: string;
  email: string;
  /** Absent keeps the current externalId. */
  externalId?: string;
  /** Attributes AIQSA does not map, which were left out. */
  ignored: number;
};

const USER_ATTRIBUTES = new Set(["active", "displayname", "emails", "externalid", "name", "username"]);

export function parseScimUserBody(body: unknown): ScimUserInput {
  if (!isRecord(body)) throw invalidScimValue("The body must be a SCIM User resource.", "invalidSyntax");
  const userName = field(body, "userName");
  const email = scimAccountEmail(
    userName === undefined || userName === null ? null : text(userName, "userName", EMAIL_MAX_LENGTH),
    primaryEmail(field(body, "emails"))
  );
  if (!email) throw invalidScimValue("userName must be the user's email address.");

  const name = field(body, "name");
  if (name !== undefined && name !== null && !isRecord(name)) throw invalidScimValue("name must be an object.");
  const nameRecord = isRecord(name) ? name : {};
  const displayName = displayNameText(field(body, "displayName") ?? null) ??
    displayNameText(field(nameRecord, "formatted") ?? null, "name.formatted") ??
    displayNameFromParts(
      namePart(field(nameRecord, "givenName") ?? null, "name.givenName"),
      namePart(field(nameRecord, "familyName") ?? null, "name.familyName")
    );
  const externalId = field(body, "externalId");
  const active = field(body, "active");
  const ignored = Object.keys(body).filter((key) =>
    !USER_ATTRIBUTES.has(key.toLowerCase()) && !ENVELOPE_ATTRIBUTES.has(key.toLowerCase())).length;

  return {
    ...(active === undefined || active === null ? {} : { active: scimBoolean(active, "active") }),
    ...(displayName ? { displayName } : {}),
    email,
    ...(externalId === undefined || externalId === null ? {} : { externalId: externalIdText(externalId) }),
    ignored
  };
}

type PatchOperation = { op: "add" | "remove" | "replace"; path: string | null; value: unknown };

/** `Operations` of a PatchOp body; `op` is case-insensitive (Entra ID sends `Replace`). */
function patchOperations(body: unknown): PatchOperation[] {
  if (!isRecord(body)) throw invalidScimValue("The body must be a SCIM PatchOp.", "invalidSyntax");
  const operations = field(body, "Operations");
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > PATCH_OPERATIONS_MAX) {
    throw invalidScimValue(`Operations must list 1 to ${PATCH_OPERATIONS_MAX} operations.`, "invalidSyntax");
  }
  return operations.map((operation) => {
    if (!isRecord(operation)) throw invalidScimValue("Each operation must be an object.", "invalidSyntax");
    const opValue = field(operation, "op");
    const op = typeof opValue === "string" ? opValue.trim().toLowerCase() : "";
    if (op !== "add" && op !== "remove" && op !== "replace") {
      throw invalidScimValue("op must be add, replace or remove.", "invalidSyntax");
    }
    const path = field(operation, "path");
    if (path !== undefined && path !== null && (typeof path !== "string" || path.length > 512 || CONTROL_CHARACTERS.test(path))) {
      throw invalidScimValue("path must be an attribute path.", "invalidPath");
    }
    return { op, path: typeof path === "string" && path.trim() ? path.trim() : null, value: field(operation, "value") };
  });
}

/** The changes of a User PATCH, applied in order; later operations win. */
export type ScimUserPatch = {
  active?: boolean;
  /** `displayName` or `name.formatted`; null when removed. */
  displayName?: string | null;
  /** Null when removed: the account stays SCIM-managed under its own id. */
  externalId?: string | null;
  familyName?: string | null;
  givenName?: string | null;
  ignored: number;
  primaryEmail?: string;
  userName?: string;
};

const EMAIL_VALUE_PATH = /^emails(?:\[[^\]]*\])?\.value$/u;

function applyUserAttribute(patch: ScimUserPatch, op: PatchOperation["op"], rawPath: string, value: unknown): void {
  const path = normalizeScimAttributePath(rawPath);
  if (ENVELOPE_ATTRIBUTES.has(path)) return;
  if (op === "remove") {
    switch (path) {
      case "externalid":
        patch.externalId = null;
        return;
      case "displayname":
      case "name.formatted":
        patch.displayName = null;
        return;
      case "name.givenname":
        patch.givenName = null;
        return;
      case "name.familyname":
        patch.familyName = null;
        return;
      case "username":
        throw invalidScimValue("userName cannot be removed.", "mutability");
      default:
        patch.ignored += 1;
        return;
    }
  }
  switch (path) {
    case "active":
      patch.active = scimBoolean(value, "active");
      return;
    case "username":
      patch.userName = text(value, "userName", EMAIL_MAX_LENGTH);
      return;
    case "displayname":
      patch.displayName = displayNameText(value);
      return;
    case "externalid":
      patch.externalId = value === null ? null : externalIdText(value);
      return;
    case "name":
      if (!isRecord(value)) throw invalidScimValue("name must be an object.");
      for (const [key, part] of Object.entries(value)) applyUserAttribute(patch, op, `name.${key}`, part);
      return;
    case "name.givenname":
      patch.givenName = namePart(value, "name.givenName");
      return;
    case "name.familyname":
      patch.familyName = namePart(value, "name.familyName");
      return;
    case "name.formatted":
      patch.displayName = displayNameText(value, "name.formatted");
      return;
    case "emails": {
      const email = primaryEmail(value);
      if (email !== null) patch.primaryEmail = email;
      return;
    }
    default:
      if (EMAIL_VALUE_PATH.test(path)) {
        patch.primaryEmail = text(value, "emails.value", EMAIL_MAX_LENGTH);
        return;
      }
      patch.ignored += 1;
  }
}

/**
 * Decodes a User PatchOp: `add` and `replace` set an attribute, with a path or as an object of
 * attributes without one (Okta's `{"op":"replace","value":{"active":false}}`).
 */
export function parseScimUserPatch(body: unknown): ScimUserPatch {
  const patch: ScimUserPatch = { ignored: 0 };
  for (const operation of patchOperations(body)) {
    if (operation.path !== null) {
      applyUserAttribute(patch, operation.op, operation.path, operation.value);
      continue;
    }
    if (operation.op === "remove") throw invalidScimValue("A remove operation needs a path.", "noTarget");
    if (!isRecord(operation.value)) throw invalidScimValue("An operation without a path needs an object value.");
    for (const [key, value] of Object.entries(operation.value)) applyUserAttribute(patch, operation.op, key, value);
  }
  return patch;
}

/**
 * The user's next email and display name after a PATCH. A new `userName` (or, when it is not an
 * email address, the primary email) replaces the email; email changes alone follow `userName`,
 * which already is the email. A name part alone keeps the display name: the stored name has
 * no parts to combine it with.
 */
export function resolveScimUserPatch(
  current: { displayName: string; email: string | null },
  patch: ScimUserPatch
): { displayName: string; email: string | null } {
  let email = current.email;
  if (patch.userName !== undefined) {
    email = scimAccountEmail(patch.userName, patch.primaryEmail ?? current.email);
    if (!email) throw invalidScimValue("userName must be the user's email address.");
  } else if (current.email === null && patch.primaryEmail !== undefined) {
    email = scimAccountEmail(null, patch.primaryEmail);
  }
  const parts = patch.givenName && patch.familyName ? displayNameFromParts(patch.givenName, patch.familyName) : null;
  return { displayName: patch.displayName ?? parts ?? current.displayName, email };
}

/** A POST or PUT Group body. */
export type ScimGroupInput = {
  displayName: string;
  externalId?: string;
  ignored: number;
  /** AIQSA user ids; a PUT without `members` empties the group. */
  members: string[];
};

const GROUP_ATTRIBUTES = new Set(["displayname", "externalid", "members"]);

function groupName(value: unknown): string {
  const name = typeof value === "string" && value.length <= 1_024 ? normalizeAdminGroupName(value) : null;
  if (!name || CONTROL_CHARACTERS.test(name)) throw invalidScimValue("displayName must be 2 to 80 characters.");
  return name;
}

function memberIds(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => {
    const id = isRecord(entry) ? field(entry, "value") : undefined;
    if (typeof id !== "string" || !id || id.length > MEMBER_ID_MAX_LENGTH || CONTROL_CHARACTERS.test(id)) {
      throw invalidScimValue("Each member needs a value: the AIQSA user id.");
    }
    return id;
  });
}

export function parseScimGroupBody(body: unknown): ScimGroupInput {
  if (!isRecord(body)) throw invalidScimValue("The body must be a SCIM Group resource.", "invalidSyntax");
  const externalId = field(body, "externalId");
  const members = field(body, "members");
  return {
    displayName: groupName(field(body, "displayName")),
    ...(externalId === undefined || externalId === null ? {} : { externalId: externalIdText(externalId) }),
    ignored: Object.keys(body).filter((key) =>
      !GROUP_ATTRIBUTES.has(key.toLowerCase()) && !GROUP_ENVELOPE_ATTRIBUTES.has(key.toLowerCase())).length,
    members: members === undefined || members === null ? [] : memberIds(members)
  };
}

export type ScimMemberOperation =
  | { kind: "add" | "remove" | "replace"; values: string[] }
  | { kind: "remove_all" };

/** The changes of a Group PATCH; member operations apply in order to the current members. */
export type ScimGroupPatch = {
  displayName?: string;
  /** Null when removed: the group stays SCIM-managed under its own id. */
  externalId?: string | null;
  ignored: number;
  members: ScimMemberOperation[];
};

const MEMBER_VALUE_FILTER = /^members\[\s*value\s+eq\s+("(?:[^"\\]|\\.)*")\s*\]$/iu;
const GROUP_SCHEMA_PREFIX = /^urn:ietf:params:scim:schemas:core:2\.0:group:/iu;

function applyGroupAttribute(patch: ScimGroupPatch, op: PatchOperation["op"], rawPath: string, value: unknown): void {
  const path = normalizeScimAttributePath(rawPath);
  if (GROUP_ENVELOPE_ATTRIBUTES.has(path)) return;
  if (path === "members") {
    if (op === "remove" && (value === undefined || value === null)) {
      patch.members.push({ kind: "remove_all" });
    } else {
      patch.members.push({ kind: op, values: memberIds(value) });
    }
    return;
  }
  // Okta removes one member as `members[value eq "<id>"]`; the id keeps its case.
  const memberFilter = MEMBER_VALUE_FILTER.exec(rawPath.trim().replace(GROUP_SCHEMA_PREFIX, ""));
  if (memberFilter) {
    if (op !== "remove") throw invalidScimValue("Only remove may target a member by filter.", "invalidPath");
    let id: unknown;
    try {
      id = JSON.parse(memberFilter[1]!);
    } catch {
      throw invalidScimValue("The member filter is malformed.", "invalidPath");
    }
    patch.members.push({ kind: "remove", values: memberIds({ value: id }) });
    return;
  }
  if (path === "displayname") {
    if (op === "remove") throw invalidScimValue("displayName cannot be removed.", "mutability");
    patch.displayName = groupName(value);
    return;
  }
  if (path === "externalid") {
    patch.externalId = op === "remove" || value === null ? null : externalIdText(value);
    return;
  }
  patch.ignored += 1;
}

/**
 * Decodes a Group PatchOp: `displayName`, `externalId` and member changes in every form the
 * supported clients send (`path: "members"` with a value list, `members[value eq "<id>"]`, or
 * an object of attributes without a path).
 */
export function parseScimGroupPatch(body: unknown): ScimGroupPatch {
  const patch: ScimGroupPatch = { ignored: 0, members: [] };
  for (const operation of patchOperations(body)) {
    if (operation.path !== null) {
      applyGroupAttribute(patch, operation.op, operation.path, operation.value);
      continue;
    }
    if (operation.op === "remove") throw invalidScimValue("A remove operation needs a path.", "noTarget");
    if (!isRecord(operation.value)) throw invalidScimValue("An operation without a path needs an object value.");
    for (const [key, value] of Object.entries(operation.value)) applyGroupAttribute(patch, operation.op, key, value);
  }
  return patch;
}

/** The member set after a PATCH's member operations. */
export function applyScimMemberOperations(
  current: ReadonlySet<string>,
  operations: readonly ScimMemberOperation[]
): Set<string> {
  const next = new Set(current);
  for (const operation of operations) {
    if (operation.kind === "remove_all" || operation.kind === "replace") next.clear();
    if (operation.kind === "remove") {
      for (const value of operation.values) next.delete(value);
    } else if (operation.kind !== "remove_all") {
      for (const value of operation.values) next.add(value);
    }
  }
  return next;
}

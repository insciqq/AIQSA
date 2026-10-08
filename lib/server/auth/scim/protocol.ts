/**
 * SCIM 2.0 wire format (RFC 7643/7644) for the provisioning endpoints under `/scim/v2`: schema
 * URNs, the error envelope, list responses, pagination and the resource projections. Pure: the
 * repository supplies records, the handler sends what these functions build.
 */

export const SCIM_SCHEMAS = {
  error: "urn:ietf:params:scim:api:messages:2.0:Error",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  listResponse: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  patchOp: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  resourceType: "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
  schema: "urn:ietf:params:scim:schemas:core:2.0:Schema",
  serviceProviderConfig: "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  user: "urn:ietf:params:scim:schemas:core:2.0:User"
} as const;

export const SCIM_BASE_PATH = "/scim/v2";
export const SCIM_BODY_MAX_BYTES = 256 * 1_024;
/** `filter.maxResults`: the largest page a list returns. */
export const SCIM_PAGE_MAX = 100;
/** Members one request may add to or remove from a group. */
export const SCIM_MEMBER_CHANGES_MAX = 1_000;
export const SCIM_CONTENT_TYPE = "application/scim+json; charset=utf-8";

export type ScimErrorType =
  | "invalidFilter"
  | "invalidPath"
  | "invalidSyntax"
  | "invalidValue"
  | "mutability"
  | "noTarget"
  | "uniqueness";

/** A request the SCIM client must fix; the handler answers it with the SCIM error envelope. */
export class ScimRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly scimType: ScimErrorType | null,
    readonly detail: string
  ) {
    super("scim_request_invalid");
    this.name = "ScimRequestError";
  }
}

export function invalidScimValue(detail: string, scimType: ScimErrorType = "invalidValue"): ScimRequestError {
  return new ScimRequestError(400, scimType, detail);
}

export function scimBaseUrl(appBaseUrl: string): string {
  return `${appBaseUrl.replace(/\/+$/u, "")}${SCIM_BASE_PATH}`;
}

export function scimJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "cache-control": "no-store", "content-type": SCIM_CONTENT_TYPE, ...headers },
    status
  });
}

/** The SCIM error envelope: status, an optional `scimType` and a short detail, nothing else. */
export function scimError(
  status: number,
  detail: string,
  scimType: ScimErrorType | null = null,
  headers: Record<string, string> = {}
): Response {
  return scimJson({
    detail,
    schemas: [SCIM_SCHEMAS.error],
    ...(scimType ? { scimType } : {}),
    status: String(status)
  }, status, headers);
}

/** `application/scim+json` and `application/json`, with any parameters. */
export function isScimJsonContentType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/scim+json" || mediaType === "application/json";
}

export type ScimPage = { count: number; startIndex: number };

const INTEGER = /^-?\d{1,12}$/u;

function integerParameter(value: string | null, name: string): number | null {
  if (value === null || value.trim() === "") return null;
  if (!INTEGER.test(value.trim())) throw invalidScimValue(`${name} must be an integer.`);
  return Number(value.trim());
}

/**
 * `startIndex` (1-based) and `count`: a start below 1 means 1, a negative count means 0 and a
 * count above `SCIM_PAGE_MAX` returns `SCIM_PAGE_MAX` resources, as RFC 7644 3.4.2.4 allows.
 */
export function scimPage(params: URLSearchParams): ScimPage {
  const startIndex = integerParameter(params.get("startIndex"), "startIndex") ?? 1;
  const count = integerParameter(params.get("count"), "count") ?? SCIM_PAGE_MAX;
  return {
    count: Math.min(Math.max(count, 0), SCIM_PAGE_MAX),
    startIndex: Math.max(startIndex, 1)
  };
}

const CORE_ATTRIBUTE_PREFIX = /^urn:ietf:params:scim:schemas:core:2\.0:(?:user|group):/u;

/** A lowercase attribute path without the core schema URN (`userName`, `name.givenName`). */
export function normalizeScimAttributePath(path: string): string {
  return path.trim().toLowerCase().replace(CORE_ATTRIBUTE_PREFIX, "");
}

/** The `excludedAttributes` query parameter as normalized attribute paths. */
export function scimExcludedAttributes(params: URLSearchParams): ReadonlySet<string> {
  const value = params.get("excludedAttributes");
  if (!value) return new Set();
  return new Set(value.split(",").map(normalizeScimAttributePath).filter(Boolean).slice(0, 32));
}

export type ScimUserRecord = {
  createdAt: Date;
  displayName: string;
  email: string | null;
  /** Active groups the user belongs to. */
  groups: readonly { id: string; name: string }[];
  id: string;
  scimExternalId: string | null;
  status: "active" | "denied" | "disabled" | "pending";
  updatedAt: Date;
};

export type ScimGroupRecord = {
  createdAt: Date;
  id: string;
  /** Null when the members were not loaded (`excludedAttributes=members`). */
  members: readonly { displayName: string; id: string }[] | null;
  name: string;
  scimExternalId: string | null;
  updatedAt: Date;
};

/**
 * The client's externalId. A resource SCIM manages without one is keyed by its own id, which is
 * not shown back as an externalId.
 */
export function visibleExternalId(scimExternalId: string | null, id: string): string | null {
  return scimExternalId === null || scimExternalId === id ? null : scimExternalId;
}

function meta(resourceType: "Group" | "User", location: string, record: { createdAt: Date; updatedAt: Date }) {
  return {
    created: record.createdAt.toISOString(),
    lastModified: record.updatedAt.toISOString(),
    location,
    resourceType
  };
}

/**
 * The User projection: `userName` and the one primary email are the account email, `active`
 * is the account status (a deactivation that waits for an ownership transfer still reads
 * active), and `groups` lists the active groups the user belongs to.
 */
export function scimUserResource(
  user: ScimUserRecord,
  baseUrl: string,
  options: { excludeGroups?: boolean } = {}
) {
  const externalId = visibleExternalId(user.scimExternalId, user.id);
  return {
    active: user.status === "active",
    displayName: user.displayName,
    emails: user.email ? [{ primary: true, type: "work", value: user.email }] : [],
    ...(externalId ? { externalId } : {}),
    ...(options.excludeGroups
      ? {}
      : {
          groups: user.groups.map((group) => ({
            $ref: `${baseUrl}/Groups/${group.id}`,
            display: group.name,
            value: group.id
          }))
        }),
    id: user.id,
    meta: meta("User", `${baseUrl}/Users/${user.id}`, user),
    name: { formatted: user.displayName },
    schemas: [SCIM_SCHEMAS.user],
    userName: user.email ?? user.id
  };
}

export function scimGroupResource(group: ScimGroupRecord, baseUrl: string) {
  const externalId = visibleExternalId(group.scimExternalId, group.id);
  return {
    displayName: group.name,
    ...(externalId ? { externalId } : {}),
    id: group.id,
    ...(group.members === null
      ? {}
      : {
          members: group.members.map((member) => ({
            $ref: `${baseUrl}/Users/${member.id}`,
            display: member.displayName,
            type: "User",
            value: member.id
          }))
        }),
    meta: meta("Group", `${baseUrl}/Groups/${group.id}`, group),
    schemas: [SCIM_SCHEMAS.group]
  };
}

export function scimListResponse(resources: readonly unknown[], input: { startIndex: number; totalResults: number }) {
  return {
    Resources: resources,
    itemsPerPage: resources.length,
    schemas: [SCIM_SCHEMAS.listResponse],
    startIndex: input.startIndex,
    totalResults: input.totalResults
  };
}

export function scimServiceProviderConfig(baseUrl: string) {
  return {
    authenticationSchemes: [{
      description: "A bearer token generated on the SCIM card of the AIQSA admin panel.",
      name: "OAuth Bearer Token",
      primary: true,
      type: "oauthbearertoken"
    }],
    bulk: { maxOperations: 0, maxPayloadSize: 0, supported: false },
    changePassword: { supported: false },
    etag: { supported: false },
    filter: { maxResults: SCIM_PAGE_MAX, supported: true },
    meta: { location: `${baseUrl}/ServiceProviderConfig`, resourceType: "ServiceProviderConfig" },
    patch: { supported: true },
    schemas: [SCIM_SCHEMAS.serviceProviderConfig],
    sort: { supported: false }
  };
}

const RESOURCE_TYPES = {
  group: { endpoint: "/Groups", id: "Group", schema: SCIM_SCHEMAS.group },
  user: { endpoint: "/Users", id: "User", schema: SCIM_SCHEMAS.user }
} as const;

function resourceType(entry: (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES], baseUrl: string) {
  return {
    description: entry.id,
    endpoint: entry.endpoint,
    id: entry.id,
    meta: { location: `${baseUrl}/ResourceTypes/${entry.id}`, resourceType: "ResourceType" },
    name: entry.id,
    schema: entry.schema,
    schemas: [SCIM_SCHEMAS.resourceType]
  };
}

/** The User and Group resource types, or one by its id (`User`, `Group`). */
export function scimResourceTypes(baseUrl: string, id?: string) {
  const all = [resourceType(RESOURCE_TYPES.user, baseUrl), resourceType(RESOURCE_TYPES.group, baseUrl)];
  return id === undefined ? all : all.filter((entry) => entry.id.toLowerCase() === id.toLowerCase());
}

type AttributeDefinition = {
  caseExact?: boolean;
  multiValued?: boolean;
  mutability?: "readOnly" | "readWrite";
  name: string;
  required?: boolean;
  returned?: "always" | "default";
  subAttributes?: AttributeDefinition[];
  type: "boolean" | "complex" | "reference" | "string";
  uniqueness?: "none" | "server";
};

type SchemaAttribute = Required<Omit<AttributeDefinition, "subAttributes">> & { subAttributes?: SchemaAttribute[] };

function attribute(definition: AttributeDefinition): SchemaAttribute {
  return {
    caseExact: definition.caseExact ?? false,
    multiValued: definition.multiValued ?? false,
    mutability: definition.mutability ?? "readWrite",
    name: definition.name,
    required: definition.required ?? false,
    returned: definition.returned ?? "default",
    ...(definition.subAttributes ? { subAttributes: definition.subAttributes.map(attribute) } : {}),
    type: definition.type,
    uniqueness: definition.uniqueness ?? "none"
  };
}

const USER_ATTRIBUTES: AttributeDefinition[] = [
  { name: "userName", required: true, type: "string", uniqueness: "server" },
  { caseExact: true, name: "externalId", type: "string", uniqueness: "server" },
  {
    name: "name",
    subAttributes: [
      { name: "formatted", type: "string" },
      { name: "givenName", type: "string" },
      { name: "familyName", type: "string" }
    ],
    type: "complex"
  },
  { name: "displayName", type: "string" },
  {
    multiValued: true,
    name: "emails",
    subAttributes: [
      { name: "value", type: "string" },
      { name: "type", type: "string" },
      { name: "primary", type: "boolean" }
    ],
    type: "complex"
  },
  { name: "active", type: "boolean" },
  {
    multiValued: true,
    mutability: "readOnly",
    name: "groups",
    subAttributes: [
      { mutability: "readOnly", name: "value", type: "string" },
      { mutability: "readOnly", name: "display", type: "string" }
    ],
    type: "complex"
  }
];

const GROUP_ATTRIBUTES: AttributeDefinition[] = [
  { caseExact: true, name: "displayName", required: true, type: "string", uniqueness: "server" },
  { caseExact: true, name: "externalId", type: "string", uniqueness: "server" },
  {
    multiValued: true,
    name: "members",
    subAttributes: [
      { name: "value", type: "string" },
      { mutability: "readOnly", name: "display", type: "string" }
    ],
    type: "complex"
  }
];

/** Minimal User and Group schemas: the attributes AIQSA maps, or one schema by its URN. */
export function scimSchemas(baseUrl: string, id?: string) {
  const all = [
    { attributes: USER_ATTRIBUTES, id: SCIM_SCHEMAS.user, name: "User" },
    { attributes: GROUP_ATTRIBUTES, id: SCIM_SCHEMAS.group, name: "Group" }
  ].map((schema) => ({
    attributes: schema.attributes.map(attribute),
    id: schema.id,
    meta: { location: `${baseUrl}/Schemas/${schema.id}`, resourceType: "Schema" },
    name: schema.name,
    schemas: [SCIM_SCHEMAS.schema]
  }));
  return id === undefined ? all : all.filter((schema) => schema.id === id);
}

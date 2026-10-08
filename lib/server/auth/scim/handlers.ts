import { readBoundedRequestBody, RequestBodyTooLargeError } from "../../http/requestBody";
import { logEvent } from "../../observability";
import { resolveLoginRateLimitIdentity } from "../clientIdentity";
import type { AuthConfig } from "../config";
import type { LoginRateLimiter } from "../rateLimit";
import { waitForAuthResponseFloor } from "../responseFloor";
import type { ResolvedSignInMethod } from "../signInMethods";
import {
  parseScimFilter,
  SCIM_GROUP_FILTER_ATTRIBUTES,
  SCIM_USER_FILTER_ATTRIBUTES,
  type ScimFilterAttributes,
  type ScimFilterClause
} from "./filter";
import {
  isScimJsonContentType,
  SCIM_BODY_MAX_BYTES,
  scimBaseUrl,
  scimError,
  scimExcludedAttributes,
  scimGroupResource,
  scimJson,
  scimListResponse,
  scimPage,
  ScimRequestError,
  scimResourceTypes,
  scimSchemas,
  scimServiceProviderConfig,
  scimUserResource
} from "./protocol";
import type { ScimGroupWriteResult, ScimRepository, ScimUserWriteResult } from "./repository";
import { parseScimGroupBody, parseScimGroupPatch, parseScimUserBody, parseScimUserPatch } from "./requests";
import { isScimTokenFormat, type ScimTokenRepository } from "./tokens";

export type ScimHandlerDeps = Readonly<{
  clock?: () => number;
  getConfig: () => AuthConfig;
  /** Failed authentication per source; a request that authenticates gives its attempt back. */
  rateLimiter: LoginRateLimiter;
  recordOutcome(method: ResolvedSignInMethod<"scim">, code: ScimOutcomeCode): Promise<void>;
  repository: ScimRepository;
  /** The active SCIM configuration; null while SCIM is off. */
  resolveScim(): Promise<ResolvedSignInMethod<"scim"> | null>;
  sleep?: (milliseconds: number) => Promise<void>;
  tokens: Pick<ScimTokenRepository, "authenticate">;
}>;

/** Content-free outcomes for the SCIM card's health line. */
export type ScimOutcomeCode =
  | "accepted"
  | "admin_disabled"
  | "invalid_request"
  | "last_admin"
  | "owner_transfer_required"
  | "token_invalid"
  | "uniqueness";

const AUTHORIZATION_MAX_LENGTH = 512;
const RESOURCE_ID_MAX_LENGTH = 128;
/** Accepted requests refresh the health line at most this often; failures always do. */
const ACCEPTED_HEALTH_INTERVAL_MS = 60_000;
const BEARER = /^Bearer\s+(\S+)\s*$/iu;

type Outcome = { code: ScimOutcomeCode; response: Response };

const accepted = (response: Response): Outcome => ({ code: "accepted", response });

function bearerToken(header: string | null): string | null {
  if (!header || header.length > AUTHORIZATION_MAX_LENGTH) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

function rateLimitKey(request: Request, config: AuthConfig): string | null {
  const identity = resolveLoginRateLimitIdentity(request, config);
  if (identity.status === "unavailable") return null;
  return `scim-auth:${identity.status === "available" ? identity.key : "installation"}`;
}

function resourceId(value: string | undefined): string | null {
  return value && value.length <= RESOURCE_ID_MAX_LENGTH && !/[\u0000-\u001f\u007f/]/u.test(value) ? value : null;
}

function filterClauses<Attribute extends string>(
  params: URLSearchParams,
  attributes: ScimFilterAttributes<Attribute>
): ScimFilterClause<Attribute>[] {
  const filter = params.get("filter");
  return filter?.trim() ? parseScimFilter(filter, attributes) : [];
}

const notFound = (): Outcome => accepted(scimError(404, "Resource not found."));

function methodNotAllowed(allow: string): Outcome {
  return accepted(scimError(405, "Method not allowed.", null, { allow }));
}

function userWriteOutcome(result: ScimUserWriteResult, success: (userId: string) => Promise<Outcome>): Promise<Outcome> | Outcome {
  switch (result.kind) {
    case "ok":
      return success(result.userId);
    case "not_found":
      return notFound();
    case "uniqueness":
      return { code: "uniqueness", response: scimError(409, "A user with this userName or externalId already exists.", "uniqueness") };
    case "admin_disabled":
      return {
        code: "admin_disabled",
        response: scimError(409, "An administrator disabled this account in AIQSA; SCIM cannot re-enable it.")
      };
    case "last_admin":
      return { code: "last_admin", response: scimError(409, "AIQSA keeps at least one active administrator.") };
    case "owner_transfer_required":
      return {
        code: "owner_transfer_required",
        response: scimError(409, "Transfer Project ownership first; the account's access is already revoked.")
      };
  }
}

function groupWriteOutcome(result: ScimGroupWriteResult, success: (groupId: string) => Promise<Outcome>): Promise<Outcome> | Outcome {
  switch (result.kind) {
    case "ok":
      return success(result.groupId);
    case "not_found":
      return notFound();
    case "uniqueness":
      return { code: "uniqueness", response: scimError(409, result.detail, "uniqueness") };
  }
}

function logIgnored(count: number): void {
  if (count > 0) {
    logEvent("service_operation", { code: "scim_attributes_ignored", count, outcome: "skipped", stage: "write", subsystem: "admin" });
  }
}

/**
 * The SCIM 2.0 endpoints under `/scim/v2`. Outside `/api`, so the bearer token is the only
 * gate: the body is bounded before any lookup, failed authentication is rate-limited per
 * source, and every refusal before authentication (missing, malformed, unknown or revoked
 * token, SCIM off) is the same 401 without resource clues.
 */
export function createScimHandler(deps: ScimHandlerDeps) {
  const clock = deps.clock ?? Date.now;
  let acceptedRecordedAt: number | null = null;

  async function recordOutcome(scim: ResolvedSignInMethod<"scim">, code: ScimOutcomeCode): Promise<void> {
    const now = clock();
    if (code === "accepted") {
      if (acceptedRecordedAt !== null && now - acceptedRecordedAt < ACCEPTED_HEALTH_INTERVAL_MS) return;
      acceptedRecordedAt = now;
    } else {
      acceptedRecordedAt = null;
    }
    await deps.recordOutcome(scim, code);
  }

  async function users(method: string, id: string | undefined, url: URL, body: unknown, baseUrl: string): Promise<Outcome> {
    const repository = deps.repository;
    const params = url.searchParams;
    const userResponse = async (userId: string, status: number): Promise<Outcome> => {
      const user = await repository.getUser(userId);
      if (!user) return notFound();
      const headers: Record<string, string> = status === 201 ? { location: `${baseUrl}/Users/${user.id}` } : {};
      return accepted(scimJson(scimUserResource(user, baseUrl), status, headers));
    };

    if (id === undefined) {
      if (method === "GET") {
        const page = scimPage(params);
        const excluded = scimExcludedAttributes(params);
        const list = await repository.listUsers({ ...page, clauses: filterClauses(params, SCIM_USER_FILTER_ATTRIBUTES) });
        return accepted(scimJson(scimListResponse(
          list.resources.map((user) => scimUserResource(user, baseUrl, { excludeGroups: excluded.has("groups") })),
          { startIndex: page.startIndex, totalResults: list.totalResults }
        )));
      }
      if (method === "POST") {
        const input = parseScimUserBody(body);
        logIgnored(input.ignored);
        return userWriteOutcome(await repository.createUser(input, new Date(clock())), (userId) => userResponse(userId, 201));
      }
      return methodNotAllowed("GET, POST");
    }

    const userId = resourceId(id);
    if (!userId) return notFound();
    switch (method) {
      case "GET": {
        const user = await repository.getUser(userId);
        return user
          ? accepted(scimJson(scimUserResource(user, baseUrl, { excludeGroups: scimExcludedAttributes(params).has("groups") })))
          : notFound();
      }
      case "PUT": {
        const input = parseScimUserBody(body);
        logIgnored(input.ignored);
        return userWriteOutcome(await repository.replaceUser(userId, input, new Date(clock())), (next) => userResponse(next, 200));
      }
      case "PATCH": {
        const patch = parseScimUserPatch(body);
        logIgnored(patch.ignored);
        return userWriteOutcome(await repository.patchUser(userId, patch, new Date(clock())), (next) => userResponse(next, 200));
      }
      case "DELETE":
        return userWriteOutcome(
          await repository.deactivateUser(userId, new Date(clock())),
          async () => accepted(new Response(null, { headers: { "cache-control": "no-store" }, status: 204 }))
        );
      default:
        return methodNotAllowed("GET, PUT, PATCH, DELETE");
    }
  }

  async function groups(method: string, id: string | undefined, url: URL, body: unknown, baseUrl: string): Promise<Outcome> {
    const repository = deps.repository;
    const params = url.searchParams;
    const members = !scimExcludedAttributes(params).has("members");
    const groupResponse = async (groupId: string, status: number): Promise<Outcome> => {
      const group = await repository.getGroup(groupId, members);
      if (!group) return notFound();
      const headers: Record<string, string> = status === 201 ? { location: `${baseUrl}/Groups/${group.id}` } : {};
      return accepted(scimJson(scimGroupResource(group, baseUrl), status, headers));
    };
    const noContent = async (): Promise<Outcome> => accepted(new Response(null, { headers: { "cache-control": "no-store" }, status: 204 }));

    if (id === undefined) {
      if (method === "GET") {
        const page = scimPage(params);
        const list = await repository.listGroups({ ...page, clauses: filterClauses(params, SCIM_GROUP_FILTER_ATTRIBUTES), members });
        return accepted(scimJson(scimListResponse(
          list.resources.map((group) => scimGroupResource(group, baseUrl)),
          { startIndex: page.startIndex, totalResults: list.totalResults }
        )));
      }
      if (method === "POST") {
        const input = parseScimGroupBody(body);
        logIgnored(input.ignored);
        return groupWriteOutcome(await repository.createGroup(input), (groupId) => groupResponse(groupId, 201));
      }
      return methodNotAllowed("GET, POST");
    }

    const groupId = resourceId(id);
    if (!groupId) return notFound();
    switch (method) {
      case "GET":
        return groupResponse(groupId, 200);
      case "PUT": {
        const input = parseScimGroupBody(body);
        logIgnored(input.ignored);
        return groupWriteOutcome(await repository.replaceGroup(groupId, input), (next) => groupResponse(next, 200));
      }
      case "PATCH": {
        const patch = parseScimGroupPatch(body);
        logIgnored(patch.ignored);
        return groupWriteOutcome(await repository.patchGroup(groupId, patch), noContent);
      }
      case "DELETE":
        return groupWriteOutcome(await repository.deleteGroup(groupId), noContent);
      default:
        return methodNotAllowed("GET, PUT, PATCH, DELETE");
    }
  }

  async function route(method: string, path: readonly string[], url: URL, body: unknown): Promise<Outcome> {
    const baseUrl = scimBaseUrl(deps.getConfig().appBaseUrl);
    const [resource, id, ...rest] = path;
    if (rest.length) return notFound();
    switch (resource?.toLowerCase()) {
      case "users":
        return users(method, id, url, body, baseUrl);
      case "groups":
        return groups(method, id, url, body, baseUrl);
      case "serviceproviderconfig":
        if (method !== "GET") return methodNotAllowed("GET");
        return id === undefined ? accepted(scimJson(scimServiceProviderConfig(baseUrl))) : notFound();
      case "resourcetypes":
      case "schemas": {
        if (method !== "GET") return methodNotAllowed("GET");
        const all = resource.toLowerCase() === "schemas" ? scimSchemas(baseUrl, id) : scimResourceTypes(baseUrl, id);
        if (id !== undefined) return all[0] ? accepted(scimJson(all[0])) : notFound();
        return accepted(scimJson(scimListResponse(all, { startIndex: 1, totalResults: all.length })));
      }
      case "bulk":
      case "me":
        return accepted(scimError(501, "Not supported."));
      default:
        return notFound();
    }
  }

  return async function handleScimRequest(request: Request, path: readonly string[]): Promise<Response> {
    const startedAtMs = clock();
    const method = request.method.toUpperCase();
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
    if (hasBody && !isScimJsonContentType(request.headers.get("content-type"))) {
      return scimError(415, "Send application/scim+json or application/json.");
    }

    let bytes: Uint8Array | null = null;
    if (hasBody) {
      try {
        bytes = await readBoundedRequestBody(request, { maxBytes: SCIM_BODY_MAX_BYTES });
      } catch (error) {
        if (request.signal.aborted) throw error;
        return error instanceof RequestBodyTooLargeError
          ? scimError(413, `The body exceeds ${SCIM_BODY_MAX_BYTES} bytes.`)
          : scimError(400, "The body could not be read.", "invalidSyntax");
      }
    }

    const config = deps.getConfig();
    const key = rateLimitKey(request, config);
    if (!key) return scimError(503, "The client address cannot be determined.");
    const admission = await deps.rateLimiter.check(key);
    if (!admission.allowed) {
      return scimError(429, "Too many failed authentication attempts.", null, { "retry-after": String(admission.retryAfterSeconds) });
    }

    const token = bearerToken(request.headers.get("authorization"));
    const scim = await deps.resolveScim();
    if (!scim || !token || !(await deps.tokens.authenticate(token, new Date(clock())))) {
      // A token of the right shape that no longer works is the usual misconfiguration.
      if (scim && token && isScimTokenFormat(token)) await recordOutcome(scim, "token_invalid");
      await waitForAuthResponseFloor({ clock, sleep: deps.sleep, startedAtMs });
      return scimError(401, "Authentication failed.", null, { "www-authenticate": "Bearer realm=\"SCIM\"" });
    }
    await deps.rateLimiter.release(key);

    let outcome: Outcome;
    try {
      let body: unknown;
      if (bytes) {
        try {
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw new ScimRequestError(400, "invalidSyntax", "The body is not valid JSON.");
        }
      }
      outcome = await route(method, path, new URL(request.url), body);
    } catch (error) {
      if (!(error instanceof ScimRequestError)) {
        logEvent("service_operation", { code: "scim_request_failed", error, outcome: "failed", stage: "write", subsystem: "admin" });
        return scimError(500, "The request could not be completed.");
      }
      outcome = { code: "invalid_request", response: scimError(error.status, error.detail, error.scimType) };
    }
    await recordOutcome(scim, outcome.code);
    return outcome.response;
  };
}

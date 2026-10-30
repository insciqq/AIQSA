import {
  SUBAGENT_DEFINITION_CODES,
  decodeSubagentDefinitionDeleteRequest,
  decodeSubagentDefinitionRestoreRequest,
  decodeSubagentDefinitionUpdateRequest,
  type SubagentDefinitionErrorBody
} from "../../contracts/subagentDefinitions";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import type { SubagentDefinitionOutcome, SubagentDefinitionRefusal, SubagentDefinitionService } from "./definitionService";

/**
 * Owner-only routes of the user's custom sub-agents (`/api/me/subagents`).
 * Every call authenticates, and the service reads and writes only the
 * caller's own definitions: another user's definition, administrators
 * included, answers exactly like a missing one (404 `subagent_not_found`).
 */

const headers = { "cache-control": "private, no-store" };
const CODES = SUBAGENT_DEFINITION_CODES;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

type RouteContext = { params: Promise<Record<string, string | undefined>> | Record<string, string | undefined> };

const json = (body: unknown, status = 200) => Response.json(body, { headers, status });
const error = (body: SubagentDefinitionErrorBody, status: number) => json(body, status);
const notFound = () => error({ error: CODES.notFound }, 404);

function statusOf(code: string): number {
  switch (code) {
    case CODES.notFound: return 404;
    case CODES.definitionExists:
    case CODES.definitionConflict: return 409;
    case CODES.catalogUnavailable: return 503;
    default: return 400;
  }
}

function refusalResponse(refusal: SubagentDefinitionRefusal): Response {
  return error({ error: refusal.code, ...(refusal.field ? { field: refusal.field } : {}) }, statusOf(refusal.code));
}

export function createSubagentDefinitionHandlers(deps: Readonly<{ resolveAuth: RequestAuthResolver; service: SubagentDefinitionService }>) {
  /** The caller's id, or the refusal: no session (401) or an account that is not active (403). */
  async function owner(request: Request): Promise<string | Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return error({ error: "unauthorized" }, 401);
    if (auth.user.status !== "active") return error({ error: "forbidden" }, 403);
    return auth.userId;
  }

  async function body(request: Request): Promise<unknown> {
    return readJsonBodyOrNull(request, "json");
  }

  async function definitionId(context: RouteContext): Promise<string | null> {
    const id = (await context.params).definitionId;
    return typeof id === "string" && ID_PATTERN.test(id) ? id : null;
  }

  async function guarded(work: () => Promise<Response>): Promise<Response> {
    try {
      return await work();
    } catch (failure) {
      logEvent("service_operation", { error: failure, subsystem: "configuration", stage: "write", outcome: "failed", code: "subagent_definitions_failed" });
      return error({ error: "subagent_definitions_unavailable" }, 503);
    }
  }

  const respond = <T>(outcome: SubagentDefinitionOutcome<T>, render: (value: T) => Response) =>
    outcome.ok ? render(outcome.value) : refusalResponse(outcome.refusal);

  return {
    async GET(request: Request): Promise<Response> {
      const userId = await owner(request);
      if (userId instanceof Response) return userId;
      return guarded(async () => json(await deps.service.list(userId)));
    },

    async POST(request: Request): Promise<Response> {
      const userId = await owner(request);
      if (userId instanceof Response) return userId;
      const raw = await body(request);
      const tooLarge = requestBodyErrorResponse(raw);
      if (tooLarge) return tooLarge;
      return guarded(async () => respond(await deps.service.create(userId, raw), (definition) => json({ definition }, 201)));
    },

    async detailGET(request: Request, context: RouteContext): Promise<Response> {
      const userId = await owner(request);
      if (userId instanceof Response) return userId;
      const id = await definitionId(context);
      if (!id) return notFound();
      return guarded(async () => {
        const definition = await deps.service.get(userId, id);
        return definition ? json({ definition }) : notFound();
      });
    },

    async detailPATCH(request: Request, context: RouteContext): Promise<Response> {
      const userId = await owner(request);
      if (userId instanceof Response) return userId;
      const id = await definitionId(context);
      if (!id) return notFound();
      const raw = await body(request);
      const tooLarge = requestBodyErrorResponse(raw);
      if (tooLarge) return tooLarge;
      const update = decodeSubagentDefinitionUpdateRequest(raw);
      if (!update) return error({ error: CODES.definitionInvalid }, 400);
      return guarded(async () => respond(await deps.service.update(userId, id, update.expectedVersion, update.draft), (definition) => json({ definition })));
    },

    async detailDELETE(request: Request, context: RouteContext): Promise<Response> {
      const userId = await owner(request);
      if (userId instanceof Response) return userId;
      const id = await definitionId(context);
      if (!id) return notFound();
      const raw = await body(request);
      const tooLarge = requestBodyErrorResponse(raw);
      if (tooLarge) return tooLarge;
      const decoded = decodeSubagentDefinitionDeleteRequest(raw);
      if (!decoded) return error({ error: CODES.definitionInvalid }, 400);
      return guarded(async () => respond(await deps.service.remove(userId, id, decoded.expectedVersion), () => new Response(null, { headers, status: 204 })));
    },

    async restorePOST(request: Request, context: RouteContext): Promise<Response> {
      const userId = await owner(request);
      if (userId instanceof Response) return userId;
      const id = await definitionId(context);
      if (!id) return notFound();
      const raw = await body(request);
      const tooLarge = requestBodyErrorResponse(raw);
      if (tooLarge) return tooLarge;
      const decoded = decodeSubagentDefinitionRestoreRequest(raw);
      if (!decoded) return error({ error: CODES.definitionInvalid }, 400);
      return guarded(async () => respond(await deps.service.restore(userId, id, decoded.expectedVersion, decoded.revisionId),
        (definition) => json({ definition })));
    }
  };
}

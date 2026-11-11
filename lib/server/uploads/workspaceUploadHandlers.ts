import type { RequestAuthResolver } from "../auth/requestAuth";
import { isAllowedMutationOrigin } from "../auth/csrf";
import { applyRuntimeSecurityHeaders } from "../security/headers";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../http/requestBody";
import { WorkspaceUploadError, isWorkspaceUploadError } from "./workspaceUploadRepository";
import { decodeWorkspaceUploadCreate, type WorkspaceUploadService } from "./workspaceUploadService";
import type { UploadRefusalOperation } from "../observability/events";
import { declaredContentLength, refuseUpload, type UploadRefusalFacts } from "./uploadRefusal";

export type UploadRouteContext = { params: Promise<{ uploadId: string; partNumber?: string }> };

export function createWorkspaceUploadHandlers(deps: {
  resolveAuth: RequestAuthResolver; service: WorkspaceUploadService; env?: Record<string, string | undefined>;
}) {
  const env = deps.env ?? process.env;
  // Every error response of these routes is built here, so each one logs its
  // code once (`refuseUpload`); an operation adds the size and type it learned.
  const handle = (name: UploadRefusalOperation,
    operation: (request: Request, userId: string, context: UploadRouteContext | undefined, facts: UploadRefusalFacts) => Promise<Response>) =>
    async (request: Request, context?: UploadRouteContext) => {
      let response: Response;
      const facts: UploadRefusalFacts = {};
      try {
        if (request.method !== "GET" && !isAllowedMutationOrigin({ appBaseUrl: env.AIQSA_APP_BASE_URL,
          requestOrigin: new URL(request.url).origin, origin: request.headers.get("origin"), secFetchSite: request.headers.get("sec-fetch-site") })) {
          facts.stage = "origin";
          throw new WorkspaceUploadError("invalid_origin", 403);
        }
        const auth = await deps.resolveAuth(request);
        if (!auth) {
          facts.stage = "auth";
          throw new WorkspaceUploadError("unauthorized", 401);
        }
        response = await operation(request, auth.userId, context, facts);
      } catch (error) {
        const known = isWorkspaceUploadError(error);
        const code = known ? error.code : error instanceof RequestBodyTooLargeError ? "request_body_too_large" : "upload_unavailable";
        const status = known ? error.status : error instanceof RequestBodyTooLargeError ? 413 : 503;
        response = refuseUpload({ ...facts, code, operation: name, status,
          ...(code === "upload_unavailable" ? request.signal.aborted ? { clientAborted: true } : { error } : {}),
          ...(status === 429 ? { headers: { "retry-after": "2" } } : {}) });
      }
      if (!request.bodyUsed) await request.body?.cancel().catch(() => undefined);
      response.headers.set("cache-control", "private, no-store");
      applyRuntimeSecurityHeaders(response.headers, env);
      return response;
    };
  const params = async (context?: UploadRouteContext) => {
    const value = await context?.params;
    if (!value || !/^[a-zA-Z0-9-]{1,64}$/u.test(value.uploadId)) throw new WorkspaceUploadError("upload_not_found", 404);
    return value;
  };
  return {
    config: handle("session_config", async () => Response.json(await deps.service.config())),
    create: handle("session_create", async (request, userId, _context, facts) => {
      let value: unknown;
      facts.stage = "body";
      try { value = JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, { maxBytes: 4096 }))); }
      catch (error) { if (error instanceof RequestBodyTooLargeError) throw error; throw new WorkspaceUploadError("upload_invalid", 400); }
      const decoded = decodeWorkspaceUploadCreate(value);
      if (!decoded) throw new WorkspaceUploadError("upload_invalid", 400);
      // The service refuses the declared file, an unavailable Workspace or a
      // conflicting session; its code says which, so no stage is claimed.
      facts.byteSize = decoded.byteSize;
      facts.mimeType = decoded.mimeType;
      delete facts.stage;
      return Response.json(await deps.service.create(decoded, userId), { status: 201 });
    }),
    get: handle("session_status", async (_request, userId, context) => Response.json(await deps.service.get((await params(context)).uploadId, userId))),
    cancel: handle("session_cancel", async (_request, userId, context) => Response.json(await deps.service.cancel((await params(context)).uploadId, userId))),
    complete: handle("session_complete", async (_request, userId, context) => Response.json(await deps.service.complete((await params(context)).uploadId, userId), { status: 202 })),
    part: handle("session_part", async (request, userId, context, facts) => {
      facts.byteSize = declaredContentLength(request);
      const p = await params(context);
      if (!p.partNumber || !/^[1-9]\d?$/u.test(p.partNumber)) throw new WorkspaceUploadError("upload_invalid_part", 400);
      await deps.service.part(request, p.uploadId, userId, Number(p.partNumber));
      return new Response(null, { status: 204 });
    })
  };
}

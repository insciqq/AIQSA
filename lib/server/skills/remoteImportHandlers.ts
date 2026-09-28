import { decodeSkillSourceImportRequest, decodeSkillSourcePreviewRequest } from "../../contracts/skillSources";
import { isAllowedMutationOrigin } from "../auth/csrf";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../http/requestBody";
import { getRequestBodyConfig } from "../http/requestBodyConfig";
import { resolveUploadPermitGate } from "../http/uploadPermitGate";
import { SkillBundleError } from "./bundleErrors";
import { SkillRemoteSourceError } from "./remoteSource";
import type { RemoteSkillImportService } from "./remoteImportService";

export type RemoteSkillImportHandlerDeps = { resolveAuth: RequestAuthResolver; service: () => RemoteSkillImportService };

export function createRemoteSkillImportHandlers(deps: RemoteSkillImportHandlerDeps) {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "private, no-store", vary: "Cookie" } });
  const handle = (commit: boolean) => async (request: Request) => {
    const session = await deps.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (session.user.status !== "active") return json({ error: "forbidden" }, 403);
    if (!isAllowedMutationOrigin({ appBaseUrl: process.env.AIQSA_APP_BASE_URL, requestOrigin: new URL(request.url).origin,
      origin: request.headers.get("origin"), secFetchSite: request.headers.get("sec-fetch-site") })) return json({ error: "invalid_origin" }, 403);
    const release = resolveUploadPermitGate(getRequestBodyConfig().uploadMaxConcurrency).tryAcquire();
    if (!release) {
      const response = json({ error: "upload_busy" }, 429);
      response.headers.set("retry-after", "1");
      return response;
    }
    try {
      const bytes = await readBoundedRequestBody(request, { maxBytes: 256 * 1_024 });
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: "skill_source_request_invalid" }, 400); }
      if (commit) {
        const input = decodeSkillSourceImportRequest(value);
        if (!input) return json({ error: "skill_source_request_invalid" }, 400);
        return json(await deps.service().importSelected(session.userId, input, { signal: request.signal }));
      }
      const input = decodeSkillSourcePreviewRequest(value);
      if (!input) return json({ error: "skill_source_request_invalid" }, 400);
      return json(await deps.service().preview(session.userId, input, { signal: request.signal }));
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof RequestBodyTooLargeError) return json({ error: "request_body_too_large", limit: error.limitBytes }, 413);
      const issue = error instanceof SkillBundleError ? error.issue : error instanceof SkillRemoteSourceError ? { code: error.code } : { code: "skill_source_unavailable" };
      const { code, ...details } = issue;
      return json({ error: code, ...details }, code === "skill_not_available" ? 404 :
        ["skill_version_conflict", "skill_source_changed"].includes(code) ? 409 : code === "skill_source_unavailable" ? 503 : 400);
    } finally { release(); }
  };
  return { preview: handle(false), importSelected: handle(true) };
}

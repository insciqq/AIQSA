import {
  OAuthError, OAuthErrorCode, bearerAuthChallengeResponse, createMcpHandler,
  hostHeaderValidationResponse, localhostAllowedHostnames, originValidationResponse, requireBearerAuth, type AuthInfo
} from "@modelcontextprotocol/server";
import { SKILLS_MCP_TOOL_MAX_BYTES, SKILLS_MCP_TRANSFER_MAX_BYTES } from "../../contracts/skillsMcp";
import { isLoopbackHostname, resolveLoginRateLimitIdentity } from "../auth/clientIdentity";
import { getAuthConfig } from "../auth/config";
import { hashToken } from "../auth/token";
import { createPrismaLoginRateLimiter } from "../auth/prismaRateLimit";
import type { LoginRateLimiter } from "../auth/rateLimit";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../http/requestBody";
import { createUploadPermitGate } from "../http/uploadPermitGate";
import { defaultInboundMcpOAuthConfiguration, defaultInboundMcpOAuthService } from "../memoryMcp/oauth/default";
import { assertInboundMcpSkillsAuthority, type InboundMcpSkillsAuthorization } from "../memoryMcp/oauth/repository";
import { inboundMcpProtectedResourceMetadataUrl } from "../memoryMcp/oauth/resources";
import type { InboundMcpOAuthService } from "../memoryMcp/oauth/service";
import { prisma } from "../prisma";
import { createS3StorageAdapter } from "../uploads/storage";
import { decodeTransferBundle, downloadSkillSchema, transferWriteSchema } from "./contracts";
import { createSkillsMcpServer, skillsStoreErrorCode } from "./server";
import { createSkillsStoreService, SkillsStoreError, type SkillsStoreAuthority, type SkillsStoreService } from "./service";

const defaultLimiter = createPrismaLoginRateLimiter({
  keySecret: () => getAuthConfig().sessionSecret, maxAttempts: 120, prisma, windowMs: 60_000
});
// MCP and binary-transfer routes share process admission, including a per-owner/client bound.
const requestGate = createUploadPermitGate(8);
const transferGate = createUploadPermitGate(2);
const activePrincipals = new Map<string, number>();
function acquire(auth: AuthInfo, transfer: boolean): (() => void) | null {
  const snapshot = auth.extra!.authorization as InboundMcpSkillsAuthorization;
  const key = `${transfer ? "transfer" : "mcp"}:${hashToken(`${snapshot.userId}:${snapshot.clientId}`)}`;
  const active = activePrincipals.get(key) ?? 0;
  if (active >= (transfer ? 1 : 4)) return null;
  const releaseGate = (transfer ? transferGate : requestGate).tryAcquire();
  if (!releaseGate) return null;
  activePrincipals.set(key, active + 1);
  let released = false;
  return () => {
    if (released) return; released = true; releaseGate();
    const remaining = (activePrincipals.get(key) ?? 1) - 1;
    if (remaining) activePrincipals.set(key, remaining); else activePrincipals.delete(key);
  };
}
function json(value: object, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });
}
function errorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) return json({ error: "request_body_too_large", limit: error.limitBytes }, 413);
  const code = skillsStoreErrorCode(error);
  const status = code === "authorization_required" ? 401 : code === "insufficient_scope" ? 403 : code === "skill_not_available" ? 404
    : ["skill_version_conflict", "operation_key_conflict"].includes(code) ? 409 : code === "skills_store_unavailable" ? 503 : 400;
  return json({ error: code }, status);
}
/** Keep admission while an MCP result or archive response is still being consumed. */
function releaseWithResponse(response: Response, release: () => void, signal: AbortSignal): Response {
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  const finish = () => { signal.removeEventListener("abort", abort); release(); };
  const abort = () => { void reader.cancel().catch(() => undefined); finish(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { finish(); controller.close(); } else controller.enqueue(next.value);
      } catch { finish(); controller.error(new Error("skills_response_unavailable")); }
    },
    async cancel() { try { await reader.cancel(); } finally { finish(); } }
  }), { headers: new Headers({ ...Object.fromEntries(response.headers), "cache-control": "no-store" }), status: response.status });
}

export function createSkillsMcpHandler(input: {
  issuer?: string;
  oauthService?: Pick<InboundMcpOAuthService, "resolveAccessToken">;
  service?: SkillsStoreService;
  getConfig?: typeof getAuthConfig;
  limiter?: LoginRateLimiter;
  transactionGuard?: typeof assertInboundMcpSkillsAuthority;
} = {}) {
  const issuer = input.issuer ?? defaultInboundMcpOAuthConfiguration.issuer;
  const resource = new URL("/mcp/skills", issuer);
  const resourceMetadataUrl = inboundMcpProtectedResourceMetadataUrl(issuer, "/mcp/skills");
  const hostname = resource.hostname;
  const hosts = isLoopbackHostname(hostname) ? [...new Set([...localhostAllowedHostnames(), hostname])] : [hostname];
  const oauth = input.oauthService ?? defaultInboundMcpOAuthService;
  const limiter = input.limiter ?? defaultLimiter;
  const service = () => input.service ?? createSkillsStoreService(prisma, createS3StorageAdapter());
  const authenticate = requireBearerAuth({ resourceMetadataUrl, verifier: {
    async verifyAccessToken(token): Promise<AuthInfo> {
      const resolved = await oauth.resolveAccessToken(token, resource.toString());
      if (!resolved || resolved.capability !== "skills:store" || !resolved.scopes?.includes("skills:read")) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
      }
      return { token, resource, scopes: [...resolved.scopes], clientId: resolved.clientId,
        expiresAt: Math.floor(resolved.expiresAt.getTime() / 1_000), extra: { authorization: resolved } };
    }
  } });
  function authority(auth: AuthInfo): SkillsStoreAuthority {
    const snapshot = auth.extra!.authorization as InboundMcpSkillsAuthorization;
    return {
      userId: snapshot.userId, clientId: snapshot.clientId,
      async assertActive(access) {
        if (!auth.scopes.includes(access === "write" ? "skills:write" : "skills:read")) throw new SkillsStoreError("insufficient_scope");
        const current = await oauth.resolveAccessToken(auth.token, resource.toString());
        if (!current || current.capability !== "skills:store" || current.userId !== snapshot.userId ||
          current.clientId !== snapshot.clientId || current.grantId !== snapshot.grantId ||
          current.grantRevision !== snapshot.grantRevision || current.familyId !== snapshot.familyId ||
          !current.scopes?.includes(access === "write" ? "skills:write" : "skills:read")) {
          throw new SkillsStoreError("authorization_required");
        }
      },
      async assertTransaction(tx, access) {
        if (!auth.scopes.includes(access === "write" ? "skills:write" : "skills:read")) throw new SkillsStoreError("insufficient_scope");
        if (!await (input.transactionGuard ?? assertInboundMcpSkillsAuthority)(tx, snapshot, access)) throw new SkillsStoreError("authorization_required");
      }
    };
  }
  async function authorize(request: Request): Promise<AuthInfo | Response> {
    const host = hostHeaderValidationResponse(request, hosts); if (host) return host;
    const origin = originValidationResponse(request, hosts); if (origin) return origin;
    if ((request.headers.get("authorization")?.length ?? 0) > 512) return bearerAuthChallengeResponse(
      new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token"), { resourceMetadataUrl });
    const identity = resolveLoginRateLimitIdentity(request, (input.getConfig ?? getAuthConfig)());
    if (identity.status === "unavailable") return json({ error: "temporarily_unavailable" }, 503);
    const callerDecision = await limiter.check(`inbound-skills:caller:${identity.status === "available" ? identity.key : "installation"}`);
    if (!callerDecision.allowed) return json({ error: "temporarily_unavailable" }, 429, { "retry-after": String(callerDecision.retryAfterSeconds) });
    const auth = await authenticate(request); if (auth instanceof Response) return auth;
    const snapshot = auth.extra!.authorization as InboundMcpSkillsAuthorization;
    const decision = await limiter.check(`inbound-skills:principal:${hashToken(`${snapshot.userId}:${snapshot.clientId}`)}`);
    return decision.allowed ? auth : json({ error: "temporarily_unavailable" }, 429, { "retry-after": String(decision.retryAfterSeconds) });
  }
  const mcp = createMcpHandler((context) => createSkillsMcpServer({ service: service(), authority: authority(context.authInfo!) }),
    { legacy: "stateless", responseMode: "json" });
  async function MCP(request: Request): Promise<Response> {
    const auth = await authorize(request); if (auth instanceof Response) return auth;
    const release = acquire(auth, false); if (!release) return json({ error: "temporarily_unavailable" }, 429, { "retry-after": "1" });
    try {
      if (request.method === "GET") return releaseWithResponse(await mcp.fetch(request, { authInfo: auth }), release, request.signal);
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        release(); return json({ error: "unsupported_media_type" }, 415);
      }
      const bytes = await readBoundedRequestBody(request, { maxBytes: SKILLS_MCP_TOOL_MAX_BYTES,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) });
      let parsedBody: unknown;
      try { parsedBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new SkillsStoreError("invalid_arguments"); }
      if (Array.isArray(parsedBody)) throw new SkillsStoreError("invalid_arguments");
      return releaseWithResponse(await mcp.fetch(request, { authInfo: auth, parsedBody }), release, request.signal);
    } catch (error) { release(); return errorResponse(error); }
  }
  return {
    GET: MCP, POST: MCP,
    async download(request: Request): Promise<Response> {
      const auth = await authorize(request); if (auth instanceof Response) return auth;
      const release = acquire(auth, true); if (!release) return json({ error: "temporarily_unavailable" }, 429, { "retry-after": "1" });
      try {
        const query = new URL(request.url).searchParams;
        if ([...query.keys()].some((key) => !["skillId", "version"].includes(key)) || query.getAll("skillId").length !== 1 || query.getAll("version").length !== 1) {
          throw new SkillsStoreError("invalid_arguments");
        }
        const parsed = downloadSkillSchema.safeParse({ skillId: query.get("skillId"), version: Number(query.get("version")) });
        if (!parsed.success) throw new SkillsStoreError("invalid_arguments");
        const value = await service().archive(authority(auth), parsed.data.skillId, parsed.data.version);
        return releaseWithResponse(new Response(new Uint8Array(value.bytes), { headers: {
          "cache-control": "no-store", "content-type": "application/zip", "x-content-type-options": "nosniff",
          "content-disposition": 'attachment; filename="skill.zip"', "content-length": String(value.bytes.length),
          "content-digest": `sha-256=:${Buffer.from(value.descriptor.archive.sha256, "hex").toString("base64")}:`
        } }), release, request.signal);
      } catch (error) { release(); return errorResponse(error); }
    },
    async upload(request: Request): Promise<Response> {
      const auth = await authorize(request); if (auth instanceof Response) return auth;
      const principal = authority(auth);
      try { await principal.assertActive("write"); } catch (error) { return errorResponse(error); }
      const release = acquire(auth, true); if (!release) return json({ error: "temporarily_unavailable" }, 429, { "retry-after": "1" });
      try {
        if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return json({ error: "unsupported_media_type" }, 415);
        const bytes = await readBoundedRequestBody(request, { maxBytes: SKILLS_MCP_TRANSFER_MAX_BYTES,
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]) });
        let raw: unknown;
        try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new SkillsStoreError("invalid_arguments"); }
        const decoded = transferWriteSchema.safeParse(raw);
        if (!decoded.success) throw new SkillsStoreError("invalid_arguments");
        const data = decoded.data;
        return json(await service().write(principal, { action: data.operation, operationKey: data.operationKey,
          ...(data.operation === "update" ? { skillId: data.skillId, expectedVersion: data.expectedVersion } : {}), bundle: decodeTransferBundle(data.files) }));
      } catch (error) { return errorResponse(error); } finally { release(); }
    }
  };
}

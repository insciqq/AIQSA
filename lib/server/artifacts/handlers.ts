import { ARTIFACT_LIMITS } from "@/lib/contracts/artifacts";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "@/lib/server/http/requestBody";
import type { ArtifactService } from "./service";

type Deps = { resolveAuth: RequestAuthResolver; service: ArtifactService };

async function session(request: Request, resolveAuth: RequestAuthResolver) {
  const value = await resolveAuth(request);
  return value ? { session: value, response: null } : { session: null, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
}

function errorResponse(error: unknown): Response {
  const code = error instanceof Error ? error.message : "artifact_unavailable";
  const safe = /^artifact_[a-z0-9_]+$/u.test(code) ? code : "artifact_unavailable";
  const status = safe === "artifact_not_found" || safe === "artifact_version_not_found" ? 404
    : safe === "artifact_version_conflict" ? 409 : 400;
  return Response.json({ error: safe }, { status, headers: { "cache-control": "private, no-store, max-age=0" } });
}

export function createArtifactListHandler(deps: Deps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const artifacts = await deps.service.list(auth.session.userId, new URL(request.url).searchParams.get("archived") === "true");
    return Response.json({ artifacts: artifacts.map((artifact) => ({
      id: artifact.id, kind: artifact.kind, title: artifact.title, currentVersionId: artifact.currentVersionId,
      archivedAt: artifact.archivedAt?.toISOString() ?? null,
      publicationCount: artifact._count.publications,
      updatedAt: artifact.updatedAt.toISOString(), version: artifact.versions[0] ? {
        id: artifact.versions[0].id, status: artifact.versions[0].status,
        versionNumber: artifact.versions[0].versionNumber
      } : null
    })) }, { headers: { "cache-control": "private, no-store, max-age=0" } });
  };
}

export function createArtifactVersionHandler(deps: Deps) {
  return async function POST(request: Request): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    try {
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("artifact_operation_invalid");
      const input = body as Record<string, unknown>;
      const operation = input.operation;
      const artifactId = input.artifactId === undefined ? undefined : String(input.artifactId);
      const result = await deps.service.createVersion({
        artifactId,
        operation: operation as never,
        ownerUserId: auth.session.userId,
        ...(typeof input.sourceChatId === "string" ? { sourceChatId: input.sourceChatId } : {})
      });
      return Response.json({ version: result }, { status: 201, headers: { "cache-control": "private, no-store, max-age=0" } });
    } catch (error) { return errorResponse(error); }
  };
}

export function createArtifactDetailHandler(deps: Deps) {
  return async function GET(_request: Request, context: { params: Promise<{ artifactId: string }> | { artifactId: string } }): Promise<Response> {
    const auth = await session(_request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const params = await context.params;
    const artifact = await deps.service.detail(auth.session.userId, params.artifactId);
    return artifact
      ? Response.json({ artifact }, { headers: { "cache-control": "private, no-store, max-age=0" } })
      : Response.json({ error: "artifact_not_found" }, { status: 404, headers: { "cache-control": "private, no-store, max-age=0" } });
  };
}

export function createArtifactEditHandler(deps: Deps) {
  return async function POST(request: Request, context: { params: Promise<{ artifactId: string }> }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    try {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("artifact_operation_invalid");
      const input = body as Record<string, unknown>;
      if (typeof input.versionId !== "string" || input.chatId !== undefined && typeof input.chatId !== "string") throw new Error("artifact_operation_invalid");
      const { artifactId } = await context.params;
      return Response.json(await deps.service.prepareEdit({ artifactId, ownerUserId: auth.session.userId, versionId: input.versionId,
        ...(typeof input.chatId === "string" ? { chatId: input.chatId } : {}) }), { headers: { "cache-control": "private, no-store" } });
    } catch (error) { return errorResponse(error); }
  };
}

export function createArtifactRenameHandler(deps: Deps) {
  return async function PATCH(request: Request, context: { params: Promise<{ artifactId: string }> }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    try {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("artifact_operation_invalid");
      const { artifactId } = await context.params;
      if (typeof (body as Record<string, unknown>).archived === "boolean") {
        return Response.json(await deps.service.setArchived({ artifactId, ownerUserId: auth.session.userId, archived: (body as { archived: boolean }).archived }), { headers: { "cache-control": "private, no-store" } });
      }
      if (typeof (body as Record<string, unknown>).title !== "string") throw new Error("artifact_title_invalid");
      return Response.json(await deps.service.rename({ artifactId, ownerUserId: auth.session.userId, title: (body as { title: string }).title }),
        { headers: { "cache-control": "private, no-store" } });
    } catch (error) { return errorResponse(error); }
  };
}

export function createArtifactSourceHandler(deps: Deps) {
  return async function GET(request: Request, context: { params: Promise<{ artifactId: string; versionId: string }> }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    try {
      const params = await context.params;
      const source = await deps.service.source({ ...params, ownerUserId: auth.session.userId });
      if (!source) throw new Error("artifact_not_found");
      return Response.json(source, { headers: { "cache-control": "private, no-store" } });
    } catch (error) { return errorResponse(error); }
  };
}

export function createArtifactRestoreHandler(deps: Deps) {
  return async function POST(request: Request, context: { params: Promise<{ artifactId: string; versionId: string }> | { artifactId: string; versionId: string } }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const params = await context.params;
    try {
      const version = await deps.service.restoreVersion({ ownerUserId: auth.session.userId, artifactId: params.artifactId, versionId: params.versionId });
      if (!version) throw new Error("artifact_not_found");
      return Response.json({ version }, { headers: { "cache-control": "private, no-store, max-age=0" } });
    } catch (error) { return errorResponse(error); }
  };
}

export function createArtifactContentHandler(deps: Deps) {
  return async function GET(request: Request, context: { params: Promise<{ artifactId: string; versionId: string }> | { artifactId: string; versionId: string } }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const params = await context.params;
    try {
      const result = new URL(request.url).searchParams.get("download") === "zip"
        ? await deps.service.getPrivateZip({ artifactId: params.artifactId, ownerUserId: auth.session.userId, versionId: params.versionId })
        : await deps.service.getPrivateBundle({ artifactId: params.artifactId, ownerUserId: auth.session.userId, versionId: params.versionId });
      if (!result) return Response.json({ error: "artifact_not_found" }, { status: 404 });
      const headers = new Headers({ "cache-control": "private, no-store, max-age=0", "content-type": result.contentType, "content-length": String(result.body.byteLength), "x-content-type-options": "nosniff" });
      headers.set("content-security-policy", "sandbox allow-scripts; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; connect-src 'none'; child-src 'none'; object-src 'none'; worker-src 'none'");
      headers.set("content-disposition", `attachment; filename="${result.fileName}"`);
      return new Response(result.body, { headers });
    } catch (error) { return errorResponse(error); }
  };
}

export function createArtifactPublishHandler(deps: Deps) {
  return async function POST(request: Request, context: { params: Promise<{ artifactId: string }> | { artifactId: string } }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    try {
      if (typeof body !== "object" || body === null || Array.isArray(body) || typeof (body as Record<string, unknown>).versionId !== "string") throw new Error("artifact_version_invalid");
      const params = await context.params;
      const input = body as Record<string, unknown>;
      if (input.expiresInDays !== undefined && (!Number.isInteger(input.expiresInDays) || Number(input.expiresInDays) < 1 || Number(input.expiresInDays) > ARTIFACT_LIMITS.maxPublicationDays)) throw new Error("artifact_expiry_invalid");
      const result = await deps.service.publish({ artifactId: params.artifactId, ownerUserId: auth.session.userId, versionId: input.versionId as string,
        ...(input.expiresInDays !== undefined ? { expiresAt: new Date(Date.now() + Number(input.expiresInDays) * 86_400_000) } : {}) });
      return Response.json({ publication: result }, { status: 201, headers: { "cache-control": "private, no-store, max-age=0" } });
    } catch (error) { return errorResponse(error); }
  };
}

export function createArtifactRevokeHandler(deps: Deps) {
  return async function POST(request: Request, context: { params: Promise<{ publicationId: string }> | { publicationId: string } }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const params = await context.params;
    const revoked = await deps.service.revoke({ ownerUserId: auth.session.userId, publicationId: params.publicationId });
    return revoked ? Response.json({ revoked: true }, { headers: { "cache-control": "private, no-store, max-age=0" } }) : Response.json({ error: "artifact_publication_not_found" }, { status: 404 });
  };
}

export function createArtifactDeleteHandler(deps: Deps) {
  return async function DELETE(request: Request, context: { params: Promise<{ artifactId: string }> | { artifactId: string } }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const params = await context.params;
    const deleted = await deps.service.remove({ artifactId: params.artifactId, ownerUserId: auth.session.userId });
    return deleted
      ? Response.json({ deleted: true }, { headers: { "cache-control": "private, no-store, max-age=0" } })
      : Response.json({ error: "artifact_not_found" }, { status: 404 });
  };
}

export function createPublicArtifactHandler(service: ArtifactService) {
  return async function GET(request: Request, context: { params: Promise<{ artifactToken: string }> | { artifactToken: string } }): Promise<Response> {
    const params = await context.params;
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(params.artifactToken)) return publicNotFound();
    try {
      const result = new URL(request.url).searchParams.get("download") === "zip"
        ? await service.publicZip(params.artifactToken)
        : await service.publicBundle(params.artifactToken);
      if (!result) return publicNotFound();
      const headers = new Headers({ "cache-control": "private, no-store, max-age=0", "content-type": result.contentType, "content-length": String(result.body.byteLength), "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow, noarchive" });
      headers.set("content-disposition", `attachment; filename="${result.fileName}"`);
      headers.set("content-security-policy", "sandbox allow-scripts; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; connect-src 'none'; child-src 'none'; object-src 'none'; worker-src 'none'");
      return new Response(result.body, { headers });
    } catch { return publicNotFound(); }
  };
}

function publicNotFound(): Response {
  return Response.json({ error: "artifact_not_found" }, { status: 404, headers: { "cache-control": "private, no-store, max-age=0", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow, noarchive" } });
}

import { ArtifactPublicBusyError } from "./objects";
import { artifactDownloadDisposition } from "./downloadName";
import { ARTIFACT_PUBLIC_VERSION_HEADER, decodeArtifactPublicVersion, decodeArtifactPublicationCreate,
  decodeArtifactPublicationMutation, decodeArtifactPublicationRevision } from "@/lib/contracts/artifacts";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "@/lib/server/http/requestBody";
import type { ArtifactService } from "./service";
import { ARTIFACT_RESPONSE_CSP } from "./contentSecurity";

type Deps = { resolveAuth: RequestAuthResolver; service: ArtifactService };

async function session(request: Request, resolveAuth: RequestAuthResolver) {
  const value = await resolveAuth(request);
  return value ? { session: value, response: null } : { session: null, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
}

function errorResponse(error: unknown): Response {
  const code = error instanceof Error ? error.message : "artifact_unavailable";
  const safe = /^artifact_[a-z0-9_]+$/u.test(code) ? code : "artifact_unavailable";
  const status = safe === "artifact_not_found" || safe === "artifact_version_not_found" || safe === "artifact_publication_not_found" ? 404
    : ["artifact_version_conflict", "artifact_publication_conflict", "artifact_publication_default_required", "artifact_publication_empty"].includes(safe) ? 409 : 400;
  return Response.json({ error: safe }, { status, headers: { "cache-control": "private, no-store, max-age=0" } });
}

export function createArtifactListHandler(deps: Deps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const artifacts = await deps.service.list(auth.session.userId, new URL(request.url).searchParams.get("archived") === "true");
    return Response.json({ artifacts: artifacts.map((artifact) => ({
      id: artifact.id, kind: artifact.kind, title: artifact.title, currentVersionId: artifact.currentVersionId,
      sourceChatId: artifact.sourceChatId,
      byteSize: artifact.versions[0]?.byteSize,
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
        signal: request.signal,
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
        : await deps.service.getPrivateBundle({ artifactId: params.artifactId, ownerUserId: auth.session.userId, versionId: params.versionId,
            ...(new URL(request.url).searchParams.get("download") === "file" ? { mainFile: true } : {}) });
      if (!result) return Response.json({ error: "artifact_not_found" }, { status: 404 });
      const headers = new Headers({ "cache-control": "private, no-store, max-age=0", "content-type": result.contentType, "content-length": String(result.body.byteLength), "x-content-type-options": "nosniff" });
      headers.set("content-security-policy", ARTIFACT_RESPONSE_CSP);
      headers.set("content-disposition", artifactDownloadDisposition(result.title, result.fileName.split(".").at(-1)!));
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
      const input = decodeArtifactPublicationCreate(body);
      if (!input) throw new Error("artifact_publication_invalid");
      const params = await context.params;
      const identity = { artifactId: params.artifactId, ownerUserId: auth.session.userId,
        ...(input.expiresInDays !== undefined ? { expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000) } : {}) };
      const result = input.mode === "version_set"
        ? await deps.service.publishSet({ ...identity, versionIds: input.versionIds, defaultVersionId: input.defaultVersionId })
        : await deps.service.publish({ ...identity, versionId: input.versionId });
      return Response.json({ publication: publicationWithPath(result) }, { status: 201, headers: { "cache-control": "private, no-store, max-age=0" } });
    } catch (error) { return errorResponse(error); }
  };
}

function publicationWithPath<T extends { shareToken: string }>(value: T): Omit<T, "shareToken"> {
  const { shareToken: _token, ...projection } = value;
  void _token;
  return projection;
}

export function createArtifactRevokeHandler(deps: Deps) {
  return async function POST(request: Request, context: { params: Promise<{ publicationId: string }> | { publicationId: string } }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    try {
      let revision: { expectedRevision: number } | undefined;
      if (request.body !== null) {
        const body = await readJsonBodyOrNull(request, "json");
        const bodyError = requestBodyErrorResponse(body);
        if (bodyError) return bodyError;
        revision = decodeArtifactPublicationRevision(body) ?? undefined;
        if (!revision) throw new Error("artifact_publication_invalid");
      }
      const params = await context.params;
      const revoked = await deps.service.revoke({ ownerUserId: auth.session.userId, publicationId: params.publicationId, ...revision });
      if (!revoked) throw new Error("artifact_publication_not_found");
      return Response.json({ revoked: true }, { headers: { "cache-control": "private, no-store, max-age=0" } });
    } catch (error) { return errorResponse(error); }
  };
}

export function createArtifactPublicationHandler(deps: Deps) {
  return async function GET(request: Request, context: { params: Promise<{ publicationId: string }> | { publicationId: string } }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    try {
      const params = await context.params;
      const publication = await deps.service.publication(auth.session.userId, params.publicationId);
      if (!publication) throw new Error("artifact_publication_not_found");
      return Response.json({ publication }, { headers: { "cache-control": "private, no-store, max-age=0" } });
    } catch (error) { return errorResponse(error); }
  };
}
export function createArtifactPublicationMutationHandler(deps: Deps) {
  return async function PATCH(request: Request, context: { params: Promise<{ publicationId: string }> | { publicationId: string } }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    try {
      const mutation = decodeArtifactPublicationMutation(body);
      if (!mutation) throw new Error("artifact_publication_invalid");
      const params = await context.params;
      const publication = await deps.service.mutatePublication({ ownerUserId: auth.session.userId, publicationId: params.publicationId, mutation });
      return Response.json({ publication }, { headers: { "cache-control": "private, no-store, max-age=0" } });
    } catch (error) { return errorResponse(error); }
  };
}
export function createArtifactPublicationReissueHandler(deps: Deps) {
  return async function POST(request: Request, context: { params: Promise<{ publicationId: string }> | { publicationId: string } }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    try {
      const revision = decodeArtifactPublicationRevision(body);
      if (!revision) throw new Error("artifact_publication_invalid");
      const params = await context.params;
      const publication = await deps.service.reissue({ ownerUserId: auth.session.userId, publicationId: params.publicationId, ...revision });
      return Response.json({ publication: publicationWithPath(publication) }, { headers: { "cache-control": "private, no-store, max-age=0" } });
    } catch (error) { return errorResponse(error); }
  };
}
export function createArtifactOwnerPageHandler(deps: Deps, kind: "versions" | "publications") {
  return async function GET(request: Request, context: { params: Promise<{ artifactId: string }> | { artifactId: string } }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    try {
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some(key => !["cursor", "limit", ...(kind === "versions" ? ["versionId"] : [])].includes(key) || query.getAll(key).length !== 1)) throw new Error("artifact_page_invalid");
      const limit = query.get("limit");
      if (limit !== null && !/^[1-9][0-9]{0,2}$/u.test(limit)) throw new Error("artifact_page_invalid");
      const input = { ...(query.has("cursor") ? { cursor: query.get("cursor")! } : {}),
        ...(query.has("versionId") ? { versionId: query.get("versionId")! } : {}), ...(limit === null ? {} : { limit: Number(limit) }) };
      const { artifactId } = await context.params;
      const result = kind === "versions" ? await deps.service.versionPage(auth.session.userId, artifactId, input)
        : await deps.service.publicationPage(auth.session.userId, artifactId, input);
      if (!result) throw new Error("artifact_not_found");
      return Response.json(result, { headers: { "cache-control": "private, no-store, max-age=0" } });
    } catch (error) { return errorResponse(error); }
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
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some(key => key !== "download" || query.getAll(key).length !== 1) ||
        query.has("download") && !["zip", "file"].includes(query.get("download")!)) return publicNotFound();
      const selector = request.headers.get(ARTIFACT_PUBLIC_VERSION_HEADER);
      const versionNumber = decodeArtifactPublicVersion(selector);
      if (selector !== null && versionNumber === null) return publicNotFound();
      const result = query.get("download") === "zip"
        ? await service.publicZip(params.artifactToken, versionNumber ?? undefined)
        : await service.publicBundle(params.artifactToken, query.get("download") === "file", versionNumber ?? undefined);
      if (!result) return publicNotFound();
      const headers = new Headers({ "cache-control": "private, no-store, max-age=0", "content-type": result.contentType, "content-length": String(result.body.byteLength), "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow, noarchive" });
      headers.set("content-disposition", artifactDownloadDisposition(result.title, result.fileName.split(".").at(-1)!));
      headers.set("content-security-policy", ARTIFACT_RESPONSE_CSP);
      headers.set(ARTIFACT_PUBLIC_VERSION_HEADER, String(result.versionNumber));
      return new Response(result.body, { headers });
    } catch (error) {
      if (error instanceof ArtifactPublicBusyError) return Response.json({ error: "rate_limit_exceeded" }, { status: 429, headers: { "cache-control": "private, no-store", "retry-after": "1", "x-robots-tag": "noindex, nofollow, noarchive", "referrer-policy": "no-referrer" } });
      return publicNotFound();
    }
  };
}

export function createPublicArtifactManifestHandler(service: ArtifactService) {
  return async function GET(request: Request, context: { params: Promise<{ artifactToken: string }> | { artifactToken: string } }): Promise<Response> {
    const { artifactToken } = await context.params;
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(artifactToken) || new URL(request.url).searchParams.size) return publicNotFound();
    try {
      const publication = await service.publicManifest(artifactToken);
      if (!publication) return publicNotFound();
      return Response.json({ publication }, { headers: { "cache-control": "private, no-store, max-age=0", "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow, noarchive" } });
    } catch (error) {
      if (error instanceof ArtifactPublicBusyError) return Response.json({ error: "rate_limit_exceeded" }, { status: 429,
        headers: { "cache-control": "private, no-store", "retry-after": "1", "x-robots-tag": "noindex, nofollow, noarchive", "referrer-policy": "no-referrer" } });
      return publicNotFound();
    }
  };
}

function publicNotFound(): Response {
  return Response.json({ error: "artifact_not_found" }, { status: 404, headers: { "cache-control": "private, no-store, max-age=0", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow, noarchive" } });
}

export function createArtifactDuplicateHandler(deps: Deps) {
  return async function POST(request: Request, context: { params: Promise<{ artifactId: string }> }): Promise<Response> {
    const auth = await session(request, deps.resolveAuth);
    if (!auth.session) return auth.response!;
    try {
      const { artifactId } = await context.params;
      const artifact = await deps.service.duplicate({ artifactId, ownerUserId: auth.session.userId });
      return Response.json({ artifact }, { status: 201, headers: { "cache-control": "private, no-store" } });
    } catch (error) { return errorResponse(error); }
  };
}

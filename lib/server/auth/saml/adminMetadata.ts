import {
  SAML_METADATA_XML_MAX_LENGTH,
  type AdminSamlMetadataErrorCode,
  type AdminSamlMetadataErrorResponse,
  type AdminSamlMetadataResponse
} from "@/lib/contracts/samlSignIn";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import type { RequestAuthResolver } from "../requestAuth";
import { inspectSamlCertificate, parseSamlIdpMetadata, samlMetadataFetchFailure } from "./metadata";
import type { SamlMetadataFetcher } from "./method";

/** The import's own deadline, inside a browser request's patience. */
const METADATA_IMPORT_TIMEOUT_MS = 15_000;

function errorJson(error: AdminSamlMetadataErrorCode, status: number): Response {
  return Response.json({ error } satisfies AdminSamlMetadataErrorResponse, { status });
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || contentType.endsWith("+json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Exactly one of `metadataUrl` or `metadataXml`, bounded. */
function metadataSource(value: unknown): { url: string } | { xml: string } | null {
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  if (typeof value.metadataUrl === "string" && value.metadataUrl.length <= 2_048) return { url: value.metadataUrl.trim() };
  if (typeof value.metadataXml === "string" && value.metadataXml.length <= SAML_METADATA_XML_MAX_LENGTH) {
    return { xml: value.metadataXml };
  }
  return null;
}

/**
 * `POST /api/admin/sign-in/saml/metadata`: parses pasted IdP metadata, or fetches it from the
 * administrator's URL through the bounded DNS-pinned transport, and returns the entity id, the
 * HTTP-Redirect SSO URL and the signing certificates for the administrator to review and save.
 * Nothing is stored; failures are stable codes, never the document or a transport message.
 */
export function createAdminSamlMetadataHandler(deps: {
  fetchMetadata: SamlMetadataFetcher;
  now?: () => Date;
  resolveAuth: RequestAuthResolver;
  timeoutMs?: number;
}) {
  return async function POST(request: Request): Promise<Response> {
    if (!hasJsonContentType(request)) return errorJson("json_required", 415);
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    if (session.user.status !== "active" || session.user.role !== "admin") return errorJson("forbidden", 403);
    const value = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(value);
    if (bodyError) return bodyError;
    const source = metadataSource(value);
    if (!source) return errorJson("metadata_request_invalid", 400);

    let xml: string;
    if ("url" in source) {
      const deadline = AbortSignal.timeout(deps.timeoutMs ?? METADATA_IMPORT_TIMEOUT_MS);
      try {
        xml = await deps.fetchMetadata(source.url, { signal: AbortSignal.any([request.signal, deadline]) });
      } catch (error) {
        return errorJson(samlMetadataFetchFailure(error), 422);
      }
    } else {
      xml = source.xml;
    }

    const metadata = parseSamlIdpMetadata(xml);
    if (!metadata) return errorJson("metadata_invalid", 422);
    const ssoUrl = metadata.ssoUrls[0];
    if (!ssoUrl) return errorJson("sso_url_invalid", 422);
    const now = deps.now?.() ?? new Date();
    // Expired certificates stay in the list with their date, so the administrator sees them.
    const certificates = metadata.certificates.flatMap((pem) => {
      const { validTo } = inspectSamlCertificate(pem, now);
      return validTo ? [{ pem, validTo: validTo.toISOString() }] : [];
    });
    if (!certificates.length) return errorJson("certificate_invalid", 422);
    return Response.json({ metadata: { certificates, entityId: metadata.entityId, ssoUrl } } satisfies AdminSamlMetadataResponse);
  };
}

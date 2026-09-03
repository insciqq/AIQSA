import type { KnowledgeSourceViewerResponse } from "@/lib/contracts/knowledgeCitations";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import {
  readKnowledgeViewerOriginal,
  resolveKnowledgeSourceViewer
} from "@/lib/server/knowledge/citationViewer";
import { renderKnowledgeSourcePdfPage } from "@/lib/server/knowledge/citationPdfPage";
import { defaultKnowledgeStorage } from "@/lib/server/knowledge/defaultIngestion";
import { getKnowledgeExtractionConfig } from "@/lib/server/knowledge/knowledgeExtractionConfig";
import { prisma } from "@/lib/server/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<{ sourceId: string }> | { sourceId: string };
}>;

const privateHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff"
} as const;

function notAvailable(): Response {
  return Response.json(
    { error: "knowledge_reference_not_available" },
    { headers: privateHeaders, status: 404 }
  );
}

function contentDisposition(fileName: string, disposition: "attachment" | "inline" = "inline"): string {
  const encoded = encodeURIComponent(fileName).replace(/['()]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="knowledge-source"; filename*=UTF-8''${encoded}`;
}

function canRenderOriginalInline(mimeType: string): boolean {
  return mimeType === "application/pdf" || new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp"
  ]).has(mimeType);
}

type ViewerRequest =
  | Readonly<{ asset: "metadata" }>
  | Readonly<{ asset: "original" }>
  | Readonly<{ asset: "page"; page: number }>;

function viewerRequest(search: URLSearchParams, maxPages: number): ViewerRequest | null {
  if ([...search.keys()].some((key) => key !== "asset" && key !== "page")) return null;
  const assetValues = search.getAll("asset");
  const pageValues = search.getAll("page");
  if (assetValues.length > 1 || pageValues.length > 1) return null;
  const asset = assetValues[0];
  if (asset === undefined) return pageValues.length === 0 ? { asset: "metadata" } : null;
  if (asset === "original") return pageValues.length === 0 ? { asset } : null;
  if (asset !== "page" || pageValues.length !== 1 || !/^\d+$/u.test(pageValues[0]!)) return null;
  const page = Number(pageValues[0]);
  return Number.isSafeInteger(page) && page >= 1 && page <= maxPages && String(page) === pageValues[0]
    ? { asset, page }
    : null;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
  const search = new URL(request.url).searchParams;
  const extractionConfig = getKnowledgeExtractionConfig();
  const viewer = viewerRequest(search, extractionConfig.maxPages);
  if (!viewer) return notAvailable();
  const { sourceId } = await context.params;
  const resolved = await prisma.$transaction(
    (tx) => resolveKnowledgeSourceViewer(tx, defaultKnowledgeStorage, {
      sourceId,
      userId: auth.userId
    }),
    { isolationLevel: "RepeatableRead" }
  );
  if (!resolved) return notAvailable();

  if (viewer.asset === "original") {
    if (!resolved.original) return notAvailable();
    try {
      const body = await readKnowledgeViewerOriginal(
        defaultKnowledgeStorage,
        resolved.original,
        request.signal
      );
      return new Response(new Uint8Array(body), {
        headers: {
          ...privateHeaders,
          "content-disposition": contentDisposition(
            resolved.original.fileName,
            canRenderOriginalInline(resolved.original.mimeType) ? "inline" : "attachment"
          ),
          "content-length": String(body.byteLength),
          "content-type": resolved.original.mimeType
        }
      });
    } catch {
      return notAvailable();
    }
  }

  if (viewer.asset === "page") {
    if (!resolved.original || resolved.original.mimeType !== "application/pdf" ||
      viewer.page > resolved.pageCount) return notAvailable();
    try {
      const body = await readKnowledgeViewerOriginal(
        defaultKnowledgeStorage,
        resolved.original,
        request.signal
      );
      const rendered = await renderKnowledgeSourcePdfPage({
        bytes: body,
        maxPages: extractionConfig.maxPages,
        page: viewer.page,
        signal: request.signal
      });
      return new Response(new Uint8Array(rendered), {
        headers: {
          ...privateHeaders,
          "content-disposition": contentDisposition(`${resolved.original.fileName}-page-${viewer.page}.png`),
          "content-length": String(rendered.byteLength),
          "content-type": "image/png"
        }
      });
    } catch {
      return notAvailable();
    }
  }

  return Response.json(
    { source: resolved.source } satisfies KnowledgeSourceViewerResponse,
    { headers: privateHeaders }
  );
}

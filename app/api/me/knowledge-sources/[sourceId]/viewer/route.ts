import type { KnowledgeSourceViewerResponse } from "@/lib/contracts/knowledgeCitations";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import {
  readKnowledgeViewerOriginal,
  resolveKnowledgeSourceViewer
} from "@/lib/server/knowledge/citationViewer";
import { defaultKnowledgeStorage } from "@/lib/server/knowledge/defaultIngestion";
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

function inlineFileName(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="knowledge-source"; filename*=UTF-8''${encoded}`;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
  const search = new URL(request.url).searchParams;
  const assetValues = search.getAll("asset");
  if ([...search.keys()].some((key) => key !== "asset") || assetValues.length > 1 ||
    (assetValues.length === 1 && assetValues[0] !== "original")) return notAvailable();
  const { sourceId } = await context.params;
  const resolved = await prisma.$transaction(
    (tx) => resolveKnowledgeSourceViewer(tx, defaultKnowledgeStorage, {
      sourceId,
      userId: auth.userId
    }),
    { isolationLevel: "RepeatableRead" }
  );
  if (!resolved) return notAvailable();

  if (assetValues[0] === "original") {
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
          "content-disposition": inlineFileName(resolved.original.fileName),
          "content-length": String(body.byteLength),
          "content-type": resolved.original.mimeType
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

import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { resolveProjectKnowledgeCitation } from "@/lib/server/projects/knowledgeCitation";
import type { ProjectKnowledgeCitationResponseWire } from "@/lib/contracts/projects";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = {
  params:
    | Promise<{ chatId: string; handle: string; messageId: string; projectId: string }>
    | { chatId: string; handle: string; messageId: string; projectId: string };
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (new URL(request.url).search.length > 0) {
    return Response.json({ error: "project_citation_not_found" }, { status: 404 });
  }
  const params = await context.params;
  const citation = await prisma.$transaction(
    (tx) => resolveProjectKnowledgeCitation(tx, {
      assistantMessageId: params.messageId,
      chatId: params.chatId,
      handle: params.handle,
      projectId: params.projectId,
      userId: auth.userId
    }),
    { isolationLevel: "RepeatableRead" }
  );
  if (!citation) {
    return Response.json(
      { error: "project_citation_not_found" },
      { headers: { "cache-control": "private, no-store" }, status: 404 }
    );
  }
  return Response.json(
    { citation } satisfies ProjectKnowledgeCitationResponseWire,
    { headers: { "cache-control": "private, no-store" } }
  );
}

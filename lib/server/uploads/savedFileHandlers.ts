import type { RequestAuthResolver } from "../auth/requestAuth";
import { serializeAttachmentLifecycle, type AttachmentLifecycleRecord } from "./lifecycleHandlers";

export type SavedFileRepository = Readonly<{
  copy(input: { attachmentId: string; save: boolean; userId: string }): Promise<AttachmentLifecycleRecord | null>;
  remove(input: { attachmentId: string; userId: string }): Promise<boolean>;
}>;

type Context = { params: Promise<{ attachmentId: string }> | { attachmentId: string } };
type Dependencies = Readonly<{
  kickProcessing?: () => void;
  repository: SavedFileRepository;
  resolveAuth: RequestAuthResolver;
}>;

async function resolveInput(deps: Dependencies, request: Request, context: Context): Promise<
  { response: Response } | { attachmentId: string; userId: string }
> {
  const auth = await deps.resolveAuth(request);
  if (!auth) return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  const { attachmentId } = await context.params;
  if (typeof attachmentId !== "string" || !attachmentId || attachmentId.length > 128) {
    return { response: Response.json({ error: "attachment_not_found" }, { status: 404 }) };
  }
  return { attachmentId, userId: auth.userId };
}

export function createSaveFileHandler(deps: Dependencies, save: boolean) {
  return async function POST(request: Request, context: Context): Promise<Response> {
    const input = await resolveInput(deps, request, context);
    if ("response" in input) return input.response;
    const attachment = await deps.repository.copy({
      attachmentId: input.attachmentId, save, userId: input.userId
    });
    if (!attachment) return Response.json({ error: "attachment_not_found" }, { status: 404 });
    if (attachment.status === "processing") {
      try { deps.kickProcessing?.(); } catch {
        // The durable processing job is committed and can be resumed later.
      }
    }
    return Response.json({ attachment: serializeAttachmentLifecycle(attachment) }, {
      headers: { "cache-control": "no-store" }
    });
  };
}

export function createRemoveSavedFileHandler(deps: Dependencies) {
  return async function DELETE(request: Request, context: Context): Promise<Response> {
    const input = await resolveInput(deps, request, context);
    if ("response" in input) return input.response;
    const removed = await deps.repository.remove({ attachmentId: input.attachmentId, userId: input.userId });
    return removed
      ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
      : Response.json({ error: "attachment_not_found" }, { status: 404 });
  };
}

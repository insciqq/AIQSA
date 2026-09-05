import type {
  AttachmentLibraryItemWire,
  AttachmentLibraryResponseWire
} from "../../contracts/uploads";
import type { RequestAuthResolver } from "../auth/requestAuth";

export type AttachmentLibraryRecord = Readonly<{
  byteSize: number;
  chatId: string | null;
  chatTitle: string | null;
  createdAt: Date | string;
  fileName: string;
  id: string;
  messageId: string | null;
  savedAt: Date | string | null;
  status: "failed" | "processing" | "ready";
}>;

export type AttachmentLibraryRepository = Readonly<{
  listSent(input: { cursor?: string | null; limit: number; userId: string }): Promise<AttachmentLibraryRecord[]>;
}>;

function serializeFile(record: AttachmentLibraryRecord): AttachmentLibraryItemWire {
  return {
    byteSize: record.byteSize,
    chatId: record.chatId,
    chatTitle: record.chatTitle,
    createdAt: new Date(record.createdAt).toISOString(),
    fileName: record.fileName,
    id: record.id,
    messageId: record.messageId,
    savedAt: record.savedAt ? new Date(record.savedAt).toISOString() : null,
    status: record.status
  };
}

/**
 * Lists saved personal files and active message attachments. Project files have a
 * different owner and remain available through their Project surfaces.
 */
export function createAttachmentLibraryHandler(input: Readonly<{
  repository: AttachmentLibraryRepository;
  resolveAuth: RequestAuthResolver;
}>) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor !== null && (!cursor || cursor.length > 128)) return Response.json({ error: "invalid_request" }, { status: 400 });
    const records = await input.repository.listSent({ cursor, limit: 201, userId: auth.userId });
    const files = records.slice(0, 200);
    const body: AttachmentLibraryResponseWire = {
      files: files.map(serializeFile), nextCursor: records.length > 200 ? files.at(-1)!.id : null
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  };
}

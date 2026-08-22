import type {
  AttachmentLibraryItemWire,
  AttachmentLibraryResponseWire
} from "../../contracts/uploads";
import type { RequestAuthResolver } from "../auth/requestAuth";

export type AttachmentLibraryRecord = Readonly<{
  byteSize: number;
  chatId: string;
  chatTitle: string;
  createdAt: Date | string;
  fileName: string;
  id: string;
  messageId: string;
  status: "failed" | "processing" | "ready";
}>;

export type AttachmentLibraryRepository = Readonly<{
  listSent(input: { limit: number; userId: string }): Promise<AttachmentLibraryRecord[]>;
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
    status: record.status
  };
}

/**
 * Lists only message-bound personal uploads. Project attachments have a
 * different owner and remain available through their Project surfaces.
 */
export function createAttachmentLibraryHandler(input: Readonly<{
  repository: AttachmentLibraryRepository;
  resolveAuth: RequestAuthResolver;
}>) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
    const files = await input.repository.listSent({ limit: 200, userId: auth.userId });
    const body: AttachmentLibraryResponseWire = { files: files.map(serializeFile) };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  };
}

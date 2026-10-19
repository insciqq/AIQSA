import { createUploadHandler } from "@/lib/server/uploads/handlers";
import { defaultUploadHandlerDeps } from "@/lib/server/uploads/defaultUploadHandlerDeps";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createAttachmentLibraryHandler } from "@/lib/server/uploads/libraryHandlers";
import { attachmentLibraryRepository } from "@/lib/server/uploads/libraryRepository";

export const runtime = "nodejs";

export const GET = createAttachmentLibraryHandler({
  repository: attachmentLibraryRepository,
  resolveAuth: resolveRequestAuth
});

export const POST = createUploadHandler({ ...defaultUploadHandlerDeps, resolveAuth: resolveRequestAuth });

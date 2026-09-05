import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createChatPdfPreviewHandler } from "@/lib/server/uploads/chatPdfPreviewHandler";

export const runtime = "nodejs";
export const POST = createChatPdfPreviewHandler({ prisma, resolveAuth: resolveRequestAuth });

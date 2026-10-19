import { getAuthConfig } from "../../auth/config";
import { prisma } from "../../prisma";
import { transcriptionHandlerDeps } from "../../speechToText/defaults";
import { transcribeUserAudio } from "../../speechToText/transcribeUserAudio";
import { defaultUploadHandlerDeps } from "../../uploads/defaultUploadHandlerDeps";
import { createUploadHandler } from "../../uploads/handlers";
import { defaultUploadMaxBytes } from "../../uploads/validation";
import { telegramRequestAuth } from "../bridge/requestAuth";
import type { TelegramAccessResolver } from "../control/access";
import type { TelegramMediaServices } from "./index";

/**
 * Media's AIQSA side in this process: the dictation route's Speech to text
 * path (role, budget, rate window, usage row, signature check) and the upload
 * route's composition, both as the linked user whose account and Telegram
 * access are re-read on every request, and the user's own attachment status.
 */
export function createDefaultTelegramMediaServices(deps: Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
}>): TelegramMediaServices {
  return Object.freeze({
    transcribe: ({ audio, userId }) => transcribeUserAudio(transcriptionHandlerDeps, { audio, userId }),
    upload: ({ request, userId }) => createUploadHandler({ ...defaultUploadHandlerDeps, resolveAuth: telegramRequestAuth(deps.access, userId) })(request),
    async attachmentStatus({ attachmentId, userId }) {
      const attachment = await prisma.attachment.findFirst({ select: { status: true }, where: { id: attachmentId, userId } });
      return attachment?.status ?? null;
    },
    uploadMaxBytes: () => defaultUploadMaxBytes(),
    appBaseUrl: () => getAuthConfig().appBaseUrl
  } satisfies TelegramMediaServices);
}

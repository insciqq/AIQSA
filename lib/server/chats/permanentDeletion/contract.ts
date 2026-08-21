import type {
  ChatPermanentDeleteAuthorizationRequest,
  ChatPermanentDeleteRequest
} from "./internalContract";
import { memorySha256 } from "../../memory/persistence/lexical";

export const PERMANENT_CHAT_DELETION_MANIFEST_VERSION =
  "memory-chat-delete-v1" as const;
export const PERMANENT_CHAT_DELETION_TARGET_TYPE =
  `CHAT@${PERMANENT_CHAT_DELETION_MANIFEST_VERSION}` as const;

type PermanentChatDeletionPayload = Pick<
  ChatPermanentDeleteAuthorizationRequest | ChatPermanentDeleteRequest,
  | "alsoForgetOriginMemories"
  | "expectedActiveLeafMessageId"
  | "expectedChatRevision"
> & Readonly<{ chatId: string }>;

export function permanentChatDeletionPayloadHash(
  input: PermanentChatDeletionPayload
): string {
  return memorySha256({
    alsoForgetOriginMemories: input.alsoForgetOriginMemories,
    chatId: input.chatId,
    domain: "aiqsa.chat.permanent-delete.authorization",
    expectedActiveLeafMessageId: input.expectedActiveLeafMessageId,
    expectedChatRevision: input.expectedChatRevision,
    targetType: PERMANENT_CHAT_DELETION_TARGET_TYPE,
    version: "v1"
  });
}

import type {
  ChatPermanentDeleteAuthorizationRequestWire,
  ChatPermanentDeleteRequestWire
} from "../../../contracts/chats";
import type { MemoryDeletionClaim } from "../../memory/coordinator/types";
import { memorySha256 } from "../../memory/persistence/lexical";

export const PERMANENT_CHAT_DELETION_MANIFEST_VERSION =
  "memory-p8-chat-delete-v1" as const;
export const PERMANENT_CHAT_DELETION_TARGET_TYPE =
  `CHAT@${PERMANENT_CHAT_DELETION_MANIFEST_VERSION}` as const;

type PermanentChatDeletionPayload = Pick<
  ChatPermanentDeleteAuthorizationRequestWire | ChatPermanentDeleteRequestWire,
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

export type PermanentChatDeletionClaim = MemoryDeletionClaim & Readonly<{
  admissionAuthorizationId: string;
  admittedChatSourceRevision: number;
  alsoForgetOriginMemories: boolean;
  targetType: typeof PERMANENT_CHAT_DELETION_TARGET_TYPE;
}>;

export function parsePermanentChatDeletionClaim(
  claim: MemoryDeletionClaim
): PermanentChatDeletionClaim | null {
  return claim.operation === "SOURCE_PURGE" &&
    claim.targetType === PERMANENT_CHAT_DELETION_TARGET_TYPE &&
    typeof claim.admissionAuthorizationId === "string" &&
    claim.admissionAuthorizationId.length > 0 &&
    Number.isSafeInteger(claim.admittedChatSourceRevision) &&
    claim.admittedChatSourceRevision! >= 0 &&
    typeof claim.alsoForgetOriginMemories === "boolean"
    ? claim as PermanentChatDeletionClaim
    : null;
}

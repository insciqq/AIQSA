import type { MemoryDeletionClaim } from "../coordinator/types";

export const ACCOUNT_MEMORY_DELETION_MANIFEST_VERSION =
  "memory-account-delete-v1" as const;
export const ACCOUNT_MEMORY_DELETION_TARGET_TYPE =
  `ACCOUNT@${ACCOUNT_MEMORY_DELETION_MANIFEST_VERSION}` as const;

export type AccountMemoryDeletionClaim = MemoryDeletionClaim & Readonly<{
  operation: "ACCOUNT_MEMORY_DELETE";
  targetType: typeof ACCOUNT_MEMORY_DELETION_TARGET_TYPE;
}>;

function validOwnerId(value: string): boolean {
  return value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

export function parseAccountMemoryDeletionClaim(
  claim: MemoryDeletionClaim
): AccountMemoryDeletionClaim | null {
  return claim.operation === "ACCOUNT_MEMORY_DELETE" &&
    claim.targetType === ACCOUNT_MEMORY_DELETION_TARGET_TYPE &&
    claim.targetId === claim.userId &&
    validOwnerId(claim.userId) &&
    claim.admissionAuthorizationId === null &&
    claim.admittedChatSourceRevision === null &&
    claim.admittedActiveLeafMessageId === null &&
    claim.alsoForgetOriginMemories === null
    ? claim as AccountMemoryDeletionClaim
    : null;
}

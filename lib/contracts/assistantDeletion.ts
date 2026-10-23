/** What deleting an owned Assistant will change, for the owner's confirmation.
 * Only names the owner may currently see are listed; everything else is a count. */
export type AssistantDeletionConsequences = Readonly<{
  audiences: Readonly<{
    groupNames: readonly string[];
    installation: boolean;
  }>;
  /** Chats that stay open and report the deleted Assistant. */
  chatCount: number;
  pendingListingRequest: boolean;
  /** The definition version these consequences were read at. */
  version: number;
}>;

export type AssistantDeletionConsequencesResponse = Readonly<{
  consequences: AssistantDeletionConsequences;
}>;

export type AssistantDeleteRequest = Readonly<{ expectedVersion: number }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function decodeAssistantDeleteRequest(value: unknown): AssistantDeleteRequest | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "expectedVersion") ||
    !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1) {
    return null;
  }
  return { expectedVersion: Number(value.expectedVersion) };
}

export function decodeAssistantDeletionConsequences(value: unknown): AssistantDeletionConsequences | null {
  if (
    !isRecord(value) ||
    !isRecord(value.audiences) ||
    typeof value.audiences.installation !== "boolean" ||
    !Array.isArray(value.audiences.groupNames) ||
    !value.audiences.groupNames.every(nonEmptyString) ||
    !count(value.chatCount) ||
    typeof value.pendingListingRequest !== "boolean" ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  ) {
    return null;
  }
  return {
    audiences: {
      groupNames: [...value.audiences.groupNames],
      installation: value.audiences.installation
    },
    chatCount: value.chatCount,
    pendingListingRequest: value.pendingListingRequest,
    version: Number(value.version)
  };
}

export function decodeAssistantDeletionConsequencesResponse(
  value: unknown
): AssistantDeletionConsequencesResponse | null {
  if (!isRecord(value)) return null;
  const consequences = decodeAssistantDeletionConsequences(value.consequences);
  return consequences ? { consequences } : null;
}

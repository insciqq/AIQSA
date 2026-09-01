export const ACCOUNT_DISPLAY_NAME_MAX_LENGTH = 80;

/** The literal a client sends only after the user confirmed the named consequence. */
export const DELETE_ALL_PERSONAL_CHATS_CONFIRMATION = "delete all personal chats";

export type AccountProfileWire = Readonly<{
  displayName: string;
  email: string | null;
  /** False for accounts that sign in only through an external identity provider. */
  hasPassword: boolean;
  role: string;
}>;

export type DeleteAllPersonalChatsResponse = Readonly<{
  archived: number;
  permanentDeletionAvailable: boolean;
  scheduled: number;
  skipped: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function decodeAccountProfileResponse(value: unknown): AccountProfileWire | null {
  if (!isRecord(value) || !isRecord(value.user)) {
    return null;
  }
  const user = value.user;
  if (
    typeof user.displayName !== "string" ||
    (user.email !== null && typeof user.email !== "string") ||
    typeof user.role !== "string" ||
    (user.hasPassword !== undefined && typeof user.hasPassword !== "boolean")
  ) {
    return null;
  }
  return {
    displayName: user.displayName,
    email: user.email ?? null,
    hasPassword: user.hasPassword ?? false,
    role: user.role
  };
}

export function decodeDeleteAllPersonalChatsResponse(
  value: unknown
): DeleteAllPersonalChatsResponse | null {
  if (
    !isRecord(value) ||
    !isCount(value.archived) ||
    typeof value.permanentDeletionAvailable !== "boolean" ||
    !isCount(value.scheduled) ||
    !isCount(value.skipped)
  ) {
    return null;
  }
  return {
    archived: value.archived,
    permanentDeletionAvailable: value.permanentDeletionAvailable,
    scheduled: value.scheduled,
    skipped: value.skipped
  };
}

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 && trimmed.length <= ACCOUNT_DISPLAY_NAME_MAX_LENGTH ? trimmed : null;
}

import { SKILL_REVIEW_NOTE_MAX_LENGTH } from "./skills";

/**
 * Listing asks an administrator to publish one exact Assistant definition
 * version to everyone in the installation. A request is "outdated" while it is
 * pending but the definition has changed since; it can no longer be decided.
 */
export const ASSISTANT_LISTING_REQUEST_STATES = ["pending", "approved", "rejected", "withdrawn", "superseded"] as const;
export type AssistantListingRequestState = typeof ASSISTANT_LISTING_REQUEST_STATES[number];
export const ASSISTANT_LISTING_REVIEW_NOTE_MAX_LENGTH = SKILL_REVIEW_NOTE_MAX_LENGTH;
export const ASSISTANT_FEATURED_LIMIT = 8;
export const ASSISTANT_CHAT_COUNT_WINDOW_DAYS = 30;

export type AssistantListingRequestSummary = {
  id: string;
  state: AssistantListingRequestState;
  definitionVersion: number;
  /** Pending while the definition version differs from the requested one. */
  outdated: boolean;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
};

/** The owner's view of listing for everyone; other viewers never receive it. */
export type AssistantListingStatus = {
  listed: boolean;
  request: AssistantListingRequestSummary | null;
  canRequest: boolean;
  canWithdraw: boolean;
};

export type AssistantListingRequestCreate = { expectedVersion: number };
export type AssistantListingStatusResponse = { listing: AssistantListingStatus };

const MAX_ID_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function decodeAssistantListingRequestSummary(value: unknown): AssistantListingRequestSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length < 1 || value.id.length > MAX_ID_LENGTH ||
    !ASSISTANT_LISTING_REQUEST_STATES.includes(value.state as AssistantListingRequestState) ||
    !Number.isSafeInteger(value.definitionVersion) || Number(value.definitionVersion) < 1 ||
    typeof value.outdated !== "boolean" || (value.outdated && value.state !== "pending") ||
    !isTimestamp(value.createdAt) || !(value.reviewedAt === null || isTimestamp(value.reviewedAt)) ||
    !(value.reviewNote === null || (typeof value.reviewNote === "string" &&
      [...value.reviewNote].length <= ASSISTANT_LISTING_REVIEW_NOTE_MAX_LENGTH))) {
    return null;
  }
  return {
    id: value.id,
    state: value.state as AssistantListingRequestState,
    definitionVersion: Number(value.definitionVersion),
    outdated: value.outdated,
    createdAt: value.createdAt,
    reviewedAt: value.reviewedAt as string | null,
    reviewNote: value.reviewNote as string | null
  };
}

export function decodeAssistantListingStatus(value: unknown): AssistantListingStatus | null {
  if (!isRecord(value) || typeof value.listed !== "boolean" ||
    typeof value.canRequest !== "boolean" || typeof value.canWithdraw !== "boolean") {
    return null;
  }
  const request = value.request === null ? null : decodeAssistantListingRequestSummary(value.request);
  if (value.request !== null && !request) return null;
  if (value.canWithdraw && request?.state !== "pending") return null;
  return { listed: value.listed, request, canRequest: value.canRequest, canWithdraw: value.canWithdraw };
}

export function decodeAssistantListingStatusResponse(value: unknown): AssistantListingStatusResponse | null {
  if (!isRecord(value)) return null;
  const listing = decodeAssistantListingStatus(value.listing);
  return listing ? { listing } : null;
}

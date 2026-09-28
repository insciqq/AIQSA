import type { AssistantListingRequestSummary } from "./assistantListing";
import type { AssistantAvatarRecipe, AssistantRows } from "./assistants";

/**
 * Control Center > Assistants. Listed rows are installation publications, which
 * every user can already see. Request rows exist only while the owner's
 * request is pending; the full definition is readable only while that request
 * can still be decided. No chat content, per-user data, or private ids.
 */
export const ADMIN_ASSISTANT_LIST_STATES = ["listed", "requests"] as const;
export type AdminAssistantListState = typeof ADMIN_ASSISTANT_LIST_STATES[number];

export type AdminListedAssistant = {
  assistantId: string;
  name: string;
  avatar: AssistantAvatarRecipe | null;
  ownerDisplayName: string;
  updatedAt: string;
  listedAt: string;
  /** Position among Featured Assistants, starting at 0; null when not Featured. */
  featuredOrder: number | null;
  /** Distinct chats with a run of this Assistant in the last 30 days. */
  chatCount30Days: number;
};

export type AdminAssistantListingRequestSummary = AssistantListingRequestSummary & {
  assistantId: string;
  name: string;
  avatar: AssistantAvatarRecipe | null;
  ownerDisplayName: string;
  updatedAt: string;
  canReview: boolean;
};

export type AdminAssistantResourceName = { id: string; name: string };

/**
 * Display names of the resources that the review `rows` identify, one list
 * per resource kind. An identified resource without a name here reads as one
 * the administrator cannot access.
 */
export type AdminAssistantReviewNames = {
  knowledgeBases: AdminAssistantResourceName[];
  knowledgeSources: AdminAssistantResourceName[];
  mcpServers: AdminAssistantResourceName[];
  models: AdminAssistantResourceName[];
  searchOptions: AdminAssistantResourceName[];
  skills: AdminAssistantResourceName[];
};

/** Read-only review copy of the definition that the owner asked to list. */
export type AdminAssistantDefinitionReview = {
  version: number;
  name: string;
  description: string;
  category: string | null;
  avatar: AssistantAvatarRecipe | null;
  instructions: string;
  answerRules: string;
  responseReminder: string;
  starterPrompts: string[];
  /**
   * The six rows projected for the administrator as the viewer, exactly as a
   * consumer's detail projects them: only resources in the administrator's
   * own catalog are identified; the rest are counted in `hiddenCount`, and a
   * model outside it is `modelId: null`. Approval rechecks that every linked
   * Skill already reaches everyone.
   */
  rows: AssistantRows;
  names: AdminAssistantReviewNames;
};

export type AdminAssistantListingRequestDetail = AdminAssistantListingRequestSummary & {
  definition: AdminAssistantDefinitionReview | null;
};

export type AdminAssistantListResponse =
  | { state: "listed"; assistants: AdminListedAssistant[]; nextCursor: string | null; pendingCount: number }
  | { state: "requests"; requests: AdminAssistantListingRequestSummary[]; nextCursor: string | null; pendingCount: number };
export type AdminAssistantListingRequestDetailResponse = { request: AdminAssistantListingRequestDetail };
export type AdminAssistantListingDecision = { action: "approve" | "reject"; note?: string };
export type AdminAssistantListingDecisionResponse = { request: AdminAssistantListingRequestSummary };
/** Position among Featured Assistants (0 is first); null removes Featured. */
export type AdminAssistantFeaturedUpdate = { order: number | null };
export type AdminAssistantFeaturedResponse = { featured: Array<{ assistantId: string; featuredOrder: number }> };

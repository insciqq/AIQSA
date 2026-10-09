import type {
  AdminAssistantDefinitionReview,
  AdminAssistantFeaturedResponse,
  AdminAssistantListingDecision,
  AdminAssistantListingRequestDetail,
  AdminAssistantListingRequestSummary,
  AdminAssistantListResponse,
  AdminAssistantListState,
  AdminAssistantResourceName,
  AdminAssistantReviewNames,
  AdminListedAssistant
} from "@/lib/contracts/adminAssistants";
import { ASSISTANT_FEATURED_LIMIT, decodeAssistantListingRequestSummary } from "@/lib/contracts/assistantListing";
import { decodeAssistantAvatarRecipe, decodeAssistantRows, type AssistantAvatarRecipe } from "@/lib/contracts/assistants";

/** A failed administrator call: the stable server code plus the blocking Skills of an audience mismatch. */
export class AdminAssistantsRequestError extends Error {
  constructor(readonly code: string, readonly status: number, readonly skillNames: readonly string[] = []) {
    super(code);
    this.name = "AdminAssistantsRequestError";
  }
}

const PAGE_SIZE = 30;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === "string";
const timestamp = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Absent avatars stay null; a present but malformed recipe makes the whole response invalid. */
function avatar(value: unknown): { ok: true; value: AssistantAvatarRecipe | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  const recipe = decodeAssistantAvatarRecipe(value);
  return recipe ? { ok: true, value: recipe } : { ok: false };
}

function listed(value: unknown): AdminListedAssistant | null {
  if (!record(value) || !text(value.assistantId) || !text(value.name) || !text(value.ownerDisplayName) ||
    !timestamp(value.updatedAt) || !timestamp(value.listedAt) || !count(value.chatCount30Days) ||
    !(value.featuredOrder === null || (count(value.featuredOrder) && Number(value.featuredOrder) < ASSISTANT_FEATURED_LIMIT))) return null;
  const image = avatar(value.avatar);
  if (!image.ok) return null;
  return { assistantId: value.assistantId, name: value.name, avatar: image.value, ownerDisplayName: value.ownerDisplayName,
    updatedAt: value.updatedAt, listedAt: value.listedAt, featuredOrder: value.featuredOrder as number | null,
    chatCount30Days: Number(value.chatCount30Days) };
}

function requestSummary(value: unknown): AdminAssistantListingRequestSummary | null {
  const summary = decodeAssistantListingRequestSummary(record(value) ? {
    id: value.id, state: value.state, definitionVersion: value.definitionVersion, outdated: value.outdated,
    createdAt: value.createdAt, reviewedAt: value.reviewedAt, reviewNote: value.reviewNote
  } : null);
  if (!summary || !record(value) || !text(value.assistantId) || !text(value.name) || !text(value.ownerDisplayName) ||
    !timestamp(value.updatedAt) || typeof value.canReview !== "boolean" || (value.canReview && (summary.state !== "pending" || summary.outdated))) return null;
  const image = avatar(value.avatar);
  if (!image.ok) return null;
  return { ...summary, assistantId: value.assistantId, name: value.name, avatar: image.value,
    ownerDisplayName: value.ownerDisplayName, updatedAt: value.updatedAt, canReview: value.canReview };
}

const REVIEW_NAME_KINDS = ["knowledgeBases", "knowledgeSources", "mcpServers", "models", "searchOptions", "skills"] as const;

function resourceNames(value: unknown): AdminAssistantResourceName[] | null {
  if (!Array.isArray(value)) return null;
  const names = value.map((item) => record(item) && Object.keys(item).length === 2 && text(item.id) && text(item.name)
    ? { id: item.id, name: item.name } : null);
  return names.every((item) => item !== null) ? names as AdminAssistantResourceName[] : null;
}

function reviewNames(value: unknown): AdminAssistantReviewNames | null {
  if (!record(value) || Object.keys(value).length !== REVIEW_NAME_KINDS.length) return null;
  const names: Partial<AdminAssistantReviewNames> = {};
  for (const kind of REVIEW_NAME_KINDS) {
    const list = resourceNames(value[kind]);
    if (!list) return null;
    names[kind] = list;
  }
  return names as AdminAssistantReviewNames;
}

function definition(value: unknown): AdminAssistantDefinitionReview | null {
  if (!record(value) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || !text(value.name) ||
    !text(value.description) || !(value.category === null || text(value.category)) || !text(value.instructions) ||
    !text(value.answerRules) || !text(value.responseReminder) || !Array.isArray(value.starterPrompts) ||
    !value.starterPrompts.every(text)) return null;
  // Rows are a projection: resources outside the administrator's catalog arrive only as counts.
  const rows = decodeAssistantRows(value.rows, "projection");
  const names = reviewNames(value.names);
  const image = avatar(value.avatar);
  if (!rows.ok || !names || !image.ok) return null;
  return {
    version: Number(value.version), name: value.name, description: value.description, category: value.category as string | null,
    avatar: image.value, instructions: value.instructions, answerRules: value.answerRules, responseReminder: value.responseReminder,
    starterPrompts: [...value.starterPrompts as string[]], rows: rows.rows, names
  };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/admin${path}`, init);
  if (response.status === 204) return null;
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = record(value) && text(value.error) ? value.error : "admin_assistants_request_failed";
    const skills = record(value) && Array.isArray(value.skills) ? value.skills.filter(text) : [];
    throw new AdminAssistantsRequestError(code, response.status, skills);
  }
  return value;
}

const invalid = () => new AdminAssistantsRequestError("admin_assistants_response_invalid", 200);
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export async function loadAdminAssistants(state: AdminAssistantListState, cursor?: string, signal?: AbortSignal, limit = PAGE_SIZE): Promise<AdminAssistantListResponse> {
  const query = new URLSearchParams({ state, limit: String(limit), ...(cursor ? { cursor } : {}) });
  const value = await request(`/assistants?${query}`, { signal });
  if (!record(value) || value.state !== state || !(value.nextCursor === null || text(value.nextCursor)) || !count(value.pendingCount)) throw invalid();
  const pendingCount = Number(value.pendingCount), nextCursor = value.nextCursor as string | null;
  if (state === "listed") {
    const assistants = Array.isArray(value.assistants) ? value.assistants.map(listed) : null;
    if (!assistants || assistants.some((item) => item === null)) throw invalid();
    return { state, assistants: assistants as AdminListedAssistant[], nextCursor, pendingCount };
  }
  const requests = Array.isArray(value.requests) ? value.requests.map(requestSummary) : null;
  if (!requests || requests.some((item) => item === null)) throw invalid();
  return { state, requests: requests as AdminAssistantListingRequestSummary[], nextCursor, pendingCount };
}

/** Requests an administrator can decide now; outdated ones wait for their owner. */
export async function loadAdminAssistantsPendingCount(signal?: AbortSignal): Promise<number> {
  return (await loadAdminAssistants("requests", undefined, signal, 1)).pendingCount;
}

export async function loadAdminAssistantRequest(id: string, signal?: AbortSignal): Promise<AdminAssistantListingRequestDetail> {
  const value = await request(`/assistant-listing-requests/${encodeURIComponent(id)}`, { signal });
  const summary = record(value) ? requestSummary(value.request) : null;
  const detail = record(value) && record(value.request) ? value.request : null;
  if (!summary || !detail || !("definition" in detail)) throw invalid();
  const review = detail.definition === null ? null : definition(detail.definition);
  if (detail.definition !== null && !review) throw invalid();
  return { ...summary, definition: review };
}

export async function decideAdminAssistantRequest(id: string, decision: AdminAssistantListingDecision): Promise<AdminAssistantListingRequestSummary> {
  const value = await request(`/assistant-listing-requests/${encodeURIComponent(id)}/decision`, post(decision));
  const summary = record(value) ? requestSummary(value.request) : null;
  if (!summary) throw invalid();
  return summary;
}

/** Places the Assistant at `order` (0 is first) among Featured Assistants, or removes it with null. */
export async function setAdminAssistantFeatured(assistantId: string, order: number | null): Promise<AdminAssistantFeaturedResponse["featured"]> {
  const value = await request(`/assistants/${encodeURIComponent(assistantId)}/featured`, post({ order }));
  if (!record(value) || !Array.isArray(value.featured) || !value.featured.every((item) => record(item) && text(item.assistantId) &&
    count(item.featuredOrder) && Number(item.featuredOrder) < ASSISTANT_FEATURED_LIMIT)) throw invalid();
  return (value.featured as Array<{ assistantId: string; featuredOrder: number }>)
    .map(({ assistantId: id, featuredOrder }) => ({ assistantId: id, featuredOrder }));
}

export async function unlistAdminAssistant(assistantId: string): Promise<void> {
  await request(`/assistants/${encodeURIComponent(assistantId)}/publications/installation`, { method: "DELETE" });
}

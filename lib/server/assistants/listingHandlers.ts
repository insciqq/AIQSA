import { ADMIN_ASSISTANT_LIST_STATES, type AdminAssistantListState } from "../../contracts/adminAssistants";
import { ASSISTANT_FEATURED_LIMIT, ASSISTANT_LISTING_REVIEW_NOTE_MAX_LENGTH } from "../../contracts/assistantListing";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { ListedAssistantService } from "./listedAssistants";
import type { AssistantListingService } from "./listingRequests";
import { AssistantListingError } from "./listingShared";

export type AssistantListingHandlerDeps = {
  resolveAuth: RequestAuthResolver;
  requests: AssistantListingService;
  listed: ListedAssistantService;
};
type Context = { params: Promise<Record<string, string>> | Record<string, string> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "private, no-store", vary: "Cookie" } });
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const invalid = () => json({ error: "assistant_listing_invalid" }, 400);
const completed = (code: string) => logEvent("service_operation", { subsystem: "admin", stage: "write", outcome: "completed", code });

function failure(error: unknown) {
  if (error instanceof AssistantListingError) {
    return json(error.skillNames ? { error: error.code, skills: error.skillNames,
      message: "Share every included Skill with everyone before listing the Assistant." } : { error: error.code }, error.status);
  }
  logEvent("service_operation", { subsystem: "admin", stage: "write", outcome: "failed", code: "assistant_listing_failed", prisma_code: databaseFailureCode(error) });
  return json({ error: "assistant_listing_failed" }, 503);
}

type Cursor = { id: string; createdAt: Date; featuredOrder?: number | null };
function decodeCursor(raw: string, state: AdminAssistantListState): Cursor | null {
  if (!raw || raw.length > 512) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const keys = state === "listed" ? ["id", "createdAt", "featuredOrder"] : ["id", "createdAt"];
    if (!record(decoded) || Object.keys(decoded).length !== keys.length || keys.some((key) => !(key in decoded)) ||
      !identifier(decoded.id) || typeof decoded.createdAt !== "string") return null;
    const createdAt = new Date(decoded.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== decoded.createdAt) return null;
    if (state === "requests") return { id: decoded.id, createdAt };
    const order = decoded.featuredOrder;
    if (order !== null && (!Number.isSafeInteger(order) || Number(order) < 0)) return null;
    return { id: decoded.id, createdAt, featuredOrder: order as number | null };
  } catch { return null; }
}

export function createAssistantListingHandlers(deps: AssistantListingHandlerDeps) {
  async function auth(request: Request, admin = false) {
    const session = await deps.resolveAuth(request);
    if (!session) return { error: json({ error: "unauthorized" }, 401) };
    if (session.user.status !== "active" || admin && session.user.role !== "admin") return { error: json({ error: "forbidden" }, 403) };
    return { session };
  }
  async function body(request: Request) {
    const value = await readJsonBodyOrNull(request, "json");
    return { value, error: requestBodyErrorResponse(value) };
  }
  async function ownerStatus(userId: string, assistantId: string, isAdmin: boolean) {
    const listing = await deps.requests.status(userId, assistantId, isAdmin);
    return listing ? json({ listing }) : json({ error: "assistant_not_available" }, 404);
  }
  return {
    async request(request: Request, context: Context) {
      const access = await auth(request);
      if (access.error) return access.error;
      const { assistantId } = await context.params;
      if (!identifier(assistantId)) return invalid();
      const input = await body(request);
      if (input.error) return input.error;
      if (!record(input.value) || Object.keys(input.value).some((key) => key !== "expectedVersion") ||
        !Number.isSafeInteger(input.value.expectedVersion) || Number(input.value.expectedVersion) < 1) return invalid();
      try {
        await deps.requests.request(access.session.userId, assistantId, Number(input.value.expectedVersion));
        return await ownerStatus(access.session.userId, assistantId, access.session.user.role === "admin");
      } catch (error) { return failure(error); }
    },
    async withdraw(request: Request, context: Context) {
      const access = await auth(request);
      if (access.error) return access.error;
      const { assistantId, requestId } = await context.params;
      if (!identifier(assistantId) || !identifier(requestId)) return invalid();
      try {
        await deps.requests.withdraw(access.session.userId, assistantId, requestId);
        return await ownerStatus(access.session.userId, assistantId, access.session.user.role === "admin");
      } catch (error) { return failure(error); }
    },
    async list(request: Request) {
      const access = await auth(request, true);
      if (access.error) return access.error;
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some((key) => !["state", "limit", "cursor"].includes(key)) || ["state", "limit", "cursor"].some((key) => query.getAll(key).length > 1)) return invalid();
      const state = query.get("state") ?? "listed", rawLimit = query.get("limit") ?? "30", limit = Number(rawLimit);
      if (!ADMIN_ASSISTANT_LIST_STATES.includes(state as AdminAssistantListState) || !/^[1-9][0-9]*$/u.test(rawLimit) || limit > 50) return invalid();
      const cursor = query.has("cursor") ? decodeCursor(query.get("cursor")!, state as AdminAssistantListState) : undefined;
      if (cursor === null) return invalid();
      try {
        return json(state === "listed"
          ? await deps.listed.list(access.session.userId, { limit, cursor: cursor && { ...cursor, featuredOrder: cursor.featuredOrder ?? null } })
          : await deps.requests.listRequests(access.session.userId, { limit, cursor }));
      } catch (error) { return failure(error); }
    },
    async detail(request: Request, context: Context) {
      const access = await auth(request, true);
      if (access.error) return access.error;
      const { requestId } = await context.params;
      if (!identifier(requestId)) return invalid();
      try { return json({ request: await deps.requests.detail(access.session.userId, requestId) }); }
      catch (error) { return failure(error); }
    },
    async decide(request: Request, context: Context) {
      const access = await auth(request, true);
      if (access.error) return access.error;
      const { requestId } = await context.params;
      if (!identifier(requestId)) return invalid();
      const input = await body(request);
      if (input.error) return input.error;
      const value = input.value;
      if (!record(value) || Object.keys(value).some((key) => !["action", "note"].includes(key)) ||
        !["approve", "reject"].includes(String(value.action)) || value.note !== undefined &&
        (typeof value.note !== "string" || [...value.note].length > ASSISTANT_LISTING_REVIEW_NOTE_MAX_LENGTH || /[\u0000\uD800-\uDFFF]/u.test(value.note))) return invalid();
      try {
        const action = value.action as "approve" | "reject";
        const result = await deps.requests.decide(access.session.userId, requestId, action, typeof value.note === "string" ? value.note.trim() || null : null);
        completed(action === "approve" ? "assistant_listing_request_approved" : "assistant_listing_request_rejected");
        return json({ request: result });
      } catch (error) { return failure(error); }
    },
    async featured(request: Request, context: Context) {
      const access = await auth(request, true);
      if (access.error) return access.error;
      const { assistantId } = await context.params;
      if (!identifier(assistantId)) return invalid();
      const input = await body(request);
      if (input.error) return input.error;
      const value = input.value;
      if (!record(value) || Object.keys(value).length !== 1 || !("order" in value) || value.order !== null &&
        (!Number.isSafeInteger(value.order) || Number(value.order) < 0 || Number(value.order) >= ASSISTANT_FEATURED_LIMIT)) return invalid();
      try {
        const featured = await deps.listed.setFeatured(access.session.userId, assistantId, value.order as number | null);
        completed("assistant_featured_updated");
        return json({ featured });
      } catch (error) { return failure(error); }
    },
    async unlist(request: Request, context: Context) {
      const access = await auth(request, true);
      if (access.error) return access.error;
      const { assistantId } = await context.params;
      if (!identifier(assistantId)) return invalid();
      try {
        await deps.listed.unlist(access.session.userId, assistantId);
        completed("assistant_unlisted");
        return new Response(null, { status: 204, headers: { "cache-control": "private, no-store", vary: "Cookie" } });
      } catch (error) { return failure(error); }
    }
  };
}

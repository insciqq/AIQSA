import {
  announcementId, decodeAnnouncementContent, decodeAnnouncementCursor, decodeAnnouncementVersion,
  type AnnouncementSummary, type UserAnnouncementSummary
} from "@/lib/contracts/announcements";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { AnnouncementRepositoryError, type AnnouncementsRepository } from "./repository";

const reply = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "cache-control": "private, no-store" }
});
type Action = "list" | "detail" | "create" | "update" | "delete" | "read" | "count";

function userSummary(value: AnnouncementSummary): UserAnnouncementSummary {
  if (!value.published || !value.publishedAt) throw new AnnouncementRepositoryError("announcement_not_found");
  return { id: value.id, title: value.title, excerpt: value.excerpt, publishedAt: value.publishedAt, read: value.read };
}

export function createAnnouncementsHandlers(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  repository: AnnouncementsRepository;
}>) {
  return async function handle(request: Request, action: Action, admin = false, id?: string): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return reply({ error: "unauthorized" }, 401);
    if (auth.user.status !== "active" || admin && auth.user.role !== "admin") return reply({ error: "forbidden" }, 403);
    if (["create", "update", "delete"].includes(action) && !admin) return reply({ error: "forbidden" }, 403);
    if (id !== undefined && !announcementId(id)) return reply({ error: "announcement_not_found" }, 404);
    const scope = { userId: auth.userId, admin };
    try {
      if (action === "count") return reply({ unreadCount: await input.repository.unreadCount(auth.userId) });
      if (action === "list") {
        const query = new URL(request.url).searchParams;
        const raw = query.get("cursor");
        const cursor = decodeAnnouncementCursor(raw);
        if (raw !== null && !cursor) return reply({ error: "announcement_input_invalid" }, 400);
        const page = await input.repository.list(scope, cursor);
        return reply({ items: admin ? page.items : page.items.map(userSummary), nextCursor: page.nextCursor, unreadCount: page.unreadCount });
      }
      if (action === "detail") {
        const value = id ? await input.repository.detail(scope, id) : null;
        return value ? reply(admin ? value : { ...userSummary(value), body: value.body }) : reply({ error: "announcement_not_found" }, 404);
      }
      const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (type !== "application/json" && !type?.endsWith("+json")) return reply({ error: "json_required" }, 415);
      const body = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(body);
      if (bodyError) return bodyError;
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "announcement_input_invalid" }, 400);
      const data = body as Record<string, unknown>;
      const keys = Object.keys(data);
      const invalid = () => reply({ error: "announcement_input_invalid" }, 400);
      if (action === "read") {
        if (keys.length !== 1 || !(data.id === null || announcementId(data.id))) return invalid();
        return reply({ unreadCount: await input.repository.markRead(auth.userId, data.id) });
      }
      if (action === "delete") {
        if (!id || keys.length !== 1 || !decodeAnnouncementVersion(data.expectedVersion)) return invalid();
        await input.repository.deleteUnpublished(id, data.expectedVersion);
        return reply({ ok: true });
      }
      const content = decodeAnnouncementContent(data);
      if (!content) return invalid();
      if (action === "create") {
        if (!(keys.length === 2 || keys.length === 3 && typeof data.published === "boolean")) return invalid();
        return reply(await input.repository.create(content, data.published === true), 201);
      }
      if (!id || keys.length !== 4 || !decodeAnnouncementVersion(data.expectedVersion) || typeof data.published !== "boolean") return invalid();
      const result = await input.repository.update(id, { ...content, expectedVersion: data.expectedVersion, published: data.published });
      return reply(result);
    } catch (error) {
      if (error instanceof AnnouncementRepositoryError) return reply({ error: error.code }, error.code === "announcement_not_found" ? 404 : 409);
      console.error("announcements_action_failed");
      return reply({ error: "announcements_unavailable" }, 503);
    }
  };
}

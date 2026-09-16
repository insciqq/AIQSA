import {
  decodeAnnouncementDetail, decodeAnnouncementPage, decodeUserAnnouncementDetail, decodeUserAnnouncementPage, decodeAnnouncementUnreadCount,
  type AnnouncementContent, type AnnouncementDetail, type AnnouncementPage, type UserAnnouncementDetail, type UserAnnouncementPage
} from "@/lib/contracts/announcements";

export class AnnouncementRequestError extends Error {
  constructor(readonly code: string) { super(announcementErrorMessage(code)); }
}
export function announcementErrorMessage(code: string): string {
  switch (code) {
    case "unauthorized": return "Your session has expired. Sign in again.";
    case "forbidden": return "Your account no longer has access to announcements.";
    case "announcement_conflict": return "This announcement changed in another session. Reload it before saving.";
    case "announcement_not_found": return "This announcement is no longer available.";
    case "announcement_input_invalid": return "Check the title and message before saving.";
    case "announcement_delete_published": return "Unpublish this announcement before deleting it.";
    default: return "Announcements could not be reached. Please try again.";
  }
}

async function request<T>(url: string, decode: (value: unknown) => T | null, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  } catch { throw new AnnouncementRequestError("network_error"); }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
      ? value.error : "announcements_unavailable";
    throw new AnnouncementRequestError(code);
  }
  const result = decode(value);
  if (result === null) throw new AnnouncementRequestError("announcements_unavailable");
  return result;
}
const root = (admin: boolean) => admin ? "/api/admin/announcements" : "/api/announcements";
const json = (method: string, data: unknown): RequestInit => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(data)
});
const decodeOk = (value: unknown) => typeof value === "object" && value !== null && "ok" in value && value.ok === true ? true : null;

export function listAnnouncements(admin: true, cursor?: string | null, signal?: AbortSignal): Promise<AnnouncementPage>;
export function listAnnouncements(admin?: false, cursor?: string | null, signal?: AbortSignal): Promise<UserAnnouncementPage>;
export function listAnnouncements(admin = false, cursor: string | null = null, signal?: AbortSignal): Promise<AnnouncementPage | UserAnnouncementPage> {
  const url = `${root(admin)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
  return admin ? request(url, decodeAnnouncementPage, { signal }) : request(url, decodeUserAnnouncementPage, { signal });
}
export function getAnnouncement(id: string, admin: true, signal?: AbortSignal): Promise<AnnouncementDetail>;
export function getAnnouncement(id: string, admin?: false, signal?: AbortSignal): Promise<UserAnnouncementDetail>;
export function getAnnouncement(id: string, admin = false, signal?: AbortSignal): Promise<AnnouncementDetail | UserAnnouncementDetail> {
  const url = `${root(admin)}/${encodeURIComponent(id)}`;
  return admin ? request(url, decodeAnnouncementDetail, { signal }) : request(url, decodeUserAnnouncementDetail, { signal });
}
export function saveAnnouncement(content: AnnouncementContent, existing?: Readonly<{ id: string; version: number; published: boolean }>, publishNew = false) {
  return existing
    ? request(`${root(true)}/${encodeURIComponent(existing.id)}`, decodeAnnouncementDetail,
      json("PATCH", { ...content, expectedVersion: existing.version, published: existing.published }))
    : request(root(true), decodeAnnouncementDetail, json("POST", { ...content, published: publishNew }));
}
export function discardAnnouncement(id: string, expectedVersion: number) {
  return request(`${root(true)}/${encodeURIComponent(id)}`, decodeOk, json("DELETE", { expectedVersion }));
}
export function markAnnouncementsRead(id: string | null, signal?: AbortSignal) {
  return request(`${root(false)}/read`, decodeAnnouncementUnreadCount, { ...json("POST", { id }), signal });
}
export function getAnnouncementUnreadCount(signal?: AbortSignal) {
  return request(`${root(false)}/unread-count`, decodeAnnouncementUnreadCount, { signal });
}

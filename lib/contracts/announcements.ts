export const ANNOUNCEMENT_TITLE_LIMIT = 160;
export const ANNOUNCEMENT_BODY_LIMIT = 20_000;
export const ANNOUNCEMENT_PAGE_SIZE = 20;

export type AnnouncementContent = Readonly<{ title: string; body: string }>;
export type AnnouncementSummary = Readonly<{
  id: string;
  title: string;
  excerpt: string;
  publishedAt: string | null;
  createdAt: string;
  published: boolean;
  read: boolean;
}>;
export type AnnouncementDetail = AnnouncementSummary & AnnouncementContent & Readonly<{ version: number }>;
export type UserAnnouncementSummary = Pick<AnnouncementSummary, "id" | "title" | "excerpt" | "read"> & Readonly<{ publishedAt: string }>;
export type UserAnnouncementDetail = UserAnnouncementSummary & AnnouncementContent;
export type AnnouncementPage = Readonly<{
  items: readonly AnnouncementSummary[];
  nextCursor: string | null;
  unreadCount: number;
}>;
export type AnnouncementCursor = Readonly<{ at: string; id: string }>;
export type UserAnnouncementPage = Omit<AnnouncementPage, "items"> & Readonly<{ items: readonly UserAnnouncementSummary[] }>;

export function announcementId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

export function decodeAnnouncementContent(value: unknown): AnnouncementContent | null {
  if (!record(value) || typeof value.title !== "string" || typeof value.body !== "string") return null;
  const title = value.title.trim();
  const body = value.body.trim();
  if (!title || title.length > ANNOUNCEMENT_TITLE_LIMIT || /[\r\n\u0000\uD800-\uDFFF]/u.test(title) ||
    !body || body.length > ANNOUNCEMENT_BODY_LIMIT || /[\u0000\uD800-\uDFFF]/u.test(body)) return null;
  return { title, body };
}

export function decodeAnnouncementVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 2_147_483_647;
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function decodeAnnouncementCursor(value: string | null): AnnouncementCursor | null {
  if (!value || value.length > 125) return null;
  const [at, id, extra] = value.split("|");
  return extra === undefined && isoDate(at) && announcementId(id) ? { at, id } : null;
}

function decodeSummary(value: unknown, extraKeys: readonly string[] = []): AnnouncementSummary | null {
  if (!record(value) || !announcementId(value.id) || typeof value.title !== "string" ||
    !exactKeys(value, ["id", "title", "excerpt", "publishedAt", "createdAt", "published", "read", ...extraKeys]) ||
    !value.title.trim() || value.title.length > ANNOUNCEMENT_TITLE_LIMIT || /[\r\n\u0000]/u.test(value.title) ||
    typeof value.excerpt !== "string" || value.excerpt.length > 180 || value.excerpt.includes("\u0000") ||
    !isoDate(value.createdAt) || !(value.publishedAt === null || isoDate(value.publishedAt)) ||
    typeof value.published !== "boolean" || typeof value.read !== "boolean") return null;
  return { id: value.id, title: value.title, excerpt: value.excerpt, createdAt: value.createdAt,
    publishedAt: value.publishedAt, published: value.published, read: value.read };
}

export function decodeAnnouncementDetail(value: unknown): AnnouncementDetail | null {
  const summary = decodeSummary(value, ["body", "version"]);
  const content = decodeAnnouncementContent(value);
  if (!summary || !content || !record(value) || !decodeAnnouncementVersion(value.version)) return null;
  return { ...summary, ...content, version: value.version };
}

export function decodeAnnouncementPage(value: unknown): AnnouncementPage | null {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > ANNOUNCEMENT_PAGE_SIZE ||
    !exactKeys(value, ["items", "nextCursor", "unreadCount"]) ||
    !(value.nextCursor === null || typeof value.nextCursor === "string" && decodeAnnouncementCursor(value.nextCursor)) ||
    !Number.isSafeInteger(value.unreadCount) || Number(value.unreadCount) < 0) return null;
  const items = value.items.map(item => decodeSummary(item));
  if (items.some((item) => !item)) return null;
  return { items: items as AnnouncementSummary[], nextCursor: value.nextCursor as string | null,
    unreadCount: Number(value.unreadCount) };
}

function decodeUserSummary(value: unknown, extraKeys: readonly string[] = []): UserAnnouncementSummary | null {
  if (!record(value) || !exactKeys(value, ["id", "title", "excerpt", "publishedAt", "read", ...extraKeys]) ||
    !announcementId(value.id) || typeof value.title !== "string" || !value.title.trim() ||
    value.title.length > ANNOUNCEMENT_TITLE_LIMIT || /[\r\n\u0000]/u.test(value.title) ||
    typeof value.excerpt !== "string" || value.excerpt.length > 180 || value.excerpt.includes("\u0000") ||
    !isoDate(value.publishedAt) || typeof value.read !== "boolean") return null;
  return { id: value.id, title: value.title, excerpt: value.excerpt, publishedAt: value.publishedAt, read: value.read };
}

export function decodeUserAnnouncementDetail(value: unknown): UserAnnouncementDetail | null {
  const summary = decodeUserSummary(value, ["body"]);
  const content = decodeAnnouncementContent(value);
  return summary && content ? { ...summary, ...content } : null;
}

export function decodeUserAnnouncementPage(value: unknown): UserAnnouncementPage | null {
  if (!record(value) || !exactKeys(value, ["items", "nextCursor", "unreadCount"]) ||
    !Array.isArray(value.items) || value.items.length > ANNOUNCEMENT_PAGE_SIZE ||
    !(value.nextCursor === null || typeof value.nextCursor === "string" && decodeAnnouncementCursor(value.nextCursor)) ||
    !Number.isSafeInteger(value.unreadCount) || Number(value.unreadCount) < 0) return null;
  const items = value.items.map(item => decodeUserSummary(item));
  if (items.some(item => !item)) return null;
  return { items: items as UserAnnouncementSummary[], nextCursor: value.nextCursor as string | null, unreadCount: Number(value.unreadCount) };
}

export function decodeAnnouncementUnreadCount(value: unknown): number | null {
  return record(value) && exactKeys(value, ["unreadCount"]) && Number.isSafeInteger(value.unreadCount) && Number(value.unreadCount) >= 0
    ? Number(value.unreadCount) : null;
}

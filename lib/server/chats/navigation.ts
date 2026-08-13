import { createHash } from "node:crypto";
import { Prisma, type ModelRunStatus } from "@prisma/client";
import {
  CHAT_NAVIGATION_CURSOR_MAX_LENGTH,
  CHAT_NAVIGATION_DEFAULT_PAGE_SIZE,
  CHAT_NAVIGATION_MAX_PAGE_SIZE,
  CHAT_NAVIGATION_QUERY_MAX_LENGTH,
  type ChatNavigationErrorResponse,
  type ChatNavigationFolderWire,
  type ChatNavigationPageWire,
  type ChatNavigationSummaryWire
} from "../../contracts/chats";
import type { AuthenticatedSession, RequestAuthResolver } from "../auth/requestAuth";
import { prisma } from "../prisma";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";
const ACTIVE_RUN_STATUSES: ModelRunStatus[] = [
  "preparing",
  "queued",
  "streaming",
  "in_progress"
];

type NavigationCursor = Readonly<{
  id: string;
  scope: string;
  updatedAt: string;
  v: 1;
}>;

export type ChatNavigationPageRecord = Readonly<{
  chats: readonly ChatNavigationSummaryWire[];
  folders: readonly ChatNavigationFolderWire[];
  nextCursor: string | null;
}>;

export type ChatNavigationPageResult =
  | Readonly<{ kind: "cursor_invalid" }>
  | Readonly<{ kind: "ok"; page: ChatNavigationPageRecord }>;

export type ChatNavigationRepository = Readonly<{
  listPage(input: {
    cursor: string | null;
    limit: number;
    userId: string;
  }): Promise<ChatNavigationPageResult>;
  searchPage(input: {
    cursor: string | null;
    limit: number;
    query: string;
    userId: string;
  }): Promise<ChatNavigationPageResult>;
}>;

export type ChatNavigationHandlerDeps = Readonly<{
  repository: ChatNavigationRepository;
  resolveAuth: RequestAuthResolver;
}>;

function normalizedQuery(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function encodeCursor(cursor: NavigationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function cursorScope(userId: string, query: string | null): string {
  return createHash("sha256").update(userId).update("\0").update(query ?? "").digest("base64url");
}

function decodeCursor(
  value: string,
  query: string | null,
  userId: string
): NavigationCursor | null {
  if (
    !value ||
    value.length > CHAT_NAVIGATION_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) return null;
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("|") !== "id|scope|updatedAt|v" ||
      record.v !== 1 ||
      typeof record.id !== "string" ||
      !record.id ||
      record.scope !== cursorScope(userId, query) ||
      typeof record.updatedAt !== "string" ||
      new Date(record.updatedAt).toISOString() !== record.updatedAt
    ) {
      return null;
    }
    return record as NavigationCursor;
  } catch {
    return null;
  }
}

async function page(
  prismaClient: typeof prisma,
  input: {
    cursor: string | null;
    limit: number;
    query: string | null;
    userId: string;
  }
): Promise<ChatNavigationPageResult> {
  const queryIdentity = input.query === null ? null : normalizedQuery(input.query);
  const cursor = input.cursor ? decodeCursor(input.cursor, queryIdentity, input.userId) : null;
  if (input.cursor && !cursor) return { kind: "cursor_invalid" };

  const cursorWhere: Prisma.ChatWhereInput = cursor
    ? {
        OR: [
          { updatedAt: { lt: new Date(cursor.updatedAt) } },
          { id: { lt: cursor.id }, updatedAt: new Date(cursor.updatedAt) }
        ]
      }
    : {};
  const queryWhere: Prisma.ChatWhereInput = input.query === null
    ? {}
    : {
        OR: [
          { title: { contains: queryIdentity!, mode: "insensitive" } },
          {
            folder: {
              is: {
                name: { contains: queryIdentity!, mode: "insensitive" },
                userId: input.userId
              }
            }
          }
        ]
      };

  const [folders, rows] = await Promise.all([
    prismaClient.folder.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, parentId: true },
      where: { userId: input.userId }
    }),
    prismaClient.chat.findMany({
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        folderId: true,
        id: true,
        modelRuns: {
          select: { id: true },
          take: 1,
          where: { status: { in: ACTIVE_RUN_STATUSES } }
        },
        title: true,
        updatedAt: true
      },
      take: input.limit + 1,
      where: {
        AND: [cursorWhere, queryWhere],
        archived: false,
        memoryMode: { not: "TEMPORARY" },
        permanentDeletionAt: null,
        userId: input.userId
      }
    })
  ]);

  const hasMore = rows.length > input.limit;
  const visible = hasMore ? rows.slice(0, input.limit) : rows;
  const final = visible.at(-1);
  return {
    kind: "ok",
    page: {
      chats: visible.map((row) => ({
        activeRun: row.modelRuns.length > 0,
        folderId: row.folderId,
        id: row.id,
        title: row.title,
        updatedAt: row.updatedAt.toISOString()
      })),
      folders,
      nextCursor: hasMore && final
          ? encodeCursor({
            id: final.id,
            scope: cursorScope(input.userId, queryIdentity),
            updatedAt: final.updatedAt.toISOString(),
            v: 1
          })
        : null
    }
  };
}

export function createPrismaChatNavigationRepository(
  prismaClient = prisma
): ChatNavigationRepository {
  return {
    listPage: (input) => page(prismaClient, { ...input, query: null }),
    searchPage: (input) => page(prismaClient, input)
  };
}

function json(body: ChatNavigationPageWire | ChatNavigationErrorResponse, status = 200) {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function queryValues(
  request: Request,
  allowed: readonly string[]
): Record<string, string> | null {
  const params = new URL(request.url).searchParams;
  const allowedSet = new Set(allowed);
  const values: Record<string, string> = {};
  for (const key of new Set(params.keys())) {
    const entries = params.getAll(key);
    if (!allowedSet.has(key) || entries.length !== 1) return null;
    values[key] = entries[0]!;
  }
  return values;
}

function pageLimit(value: string | undefined): number | null {
  if (value === undefined) return CHAT_NAVIGATION_DEFAULT_PAGE_SIZE;
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= CHAT_NAVIGATION_MAX_PAGE_SIZE
    ? parsed
    : null;
}

async function authenticated(
  request: Request,
  deps: ChatNavigationHandlerDeps
): Promise<{ session: AuthenticatedSession } | { response: Response }> {
  const session = await deps.resolveAuth(request);
  return session
    ? { session }
    : { response: json({ error: "unauthorized" }, 401) };
}

async function respond(
  result: ChatNavigationPageResult
): Promise<Response> {
  return result.kind === "cursor_invalid"
    ? json({ error: "chat_navigation_cursor_invalid" }, 400)
    : json({
        chats: [...result.page.chats],
        folders: [...result.page.folders],
        nextCursor: result.page.nextCursor
      });
}

export function createListChatNavigationHandler(deps: ChatNavigationHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await authenticated(request, deps);
    if (!("session" in auth)) return auth.response;
    const values = queryValues(request, ["cursor", "limit"]);
    const limit = values ? pageLimit(values.limit) : null;
    if (!values || limit === null || values.cursor === "") {
      return json({ error: "chat_navigation_query_invalid" }, 400);
    }
    return respond(await deps.repository.listPage({
      cursor: values.cursor ?? null,
      limit,
      userId: auth.session.userId
    }));
  };
}

export function createSearchChatNavigationHandler(deps: ChatNavigationHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await authenticated(request, deps);
    if (!("session" in auth)) return auth.response;
    const values = queryValues(request, ["cursor", "limit", "q"]);
    const limit = values ? pageLimit(values.limit) : null;
    const query = normalizedQuery(values?.q ?? "");
    if (
      !values ||
      limit === null ||
      values.cursor === "" ||
      !query ||
      query.length > CHAT_NAVIGATION_QUERY_MAX_LENGTH
    ) {
      return json({ error: "chat_navigation_query_invalid" }, 400);
    }
    return respond(await deps.repository.searchPage({
      cursor: values.cursor ?? null,
      limit,
      query,
      userId: auth.session.userId
    }));
  };
}

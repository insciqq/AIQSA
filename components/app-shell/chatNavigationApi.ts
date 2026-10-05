import { shellFetch } from "@/components/app-shell/shellApi";
import {
  CHAT_NAVIGATION_DEFAULT_PAGE_SIZE,
  decodeChatMessageMatchPage,
  decodeChatNavigationPage,
  type ChatMessageMatchPageWire,
  type ChatNavigationPageWire
} from "@/lib/contracts/chats";

export class ChatNavigationApiError extends Error {
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "ChatNavigationApiError";
    this.status = status;
  }
}

type PageInput = Readonly<{
  cursor?: string | null;
  limit?: number;
  query?: string;
  signal?: AbortSignal;
}>;

async function page<Page>(
  path: "/api/chats/compact" | "/api/chats/search" | "/api/chats/search/messages",
  input: PageInput,
  decode: (value: unknown) => Page | null
): Promise<Page> {
  const query = new URLSearchParams();
  if (input.cursor) query.set("cursor", input.cursor);
  query.set("limit", String(input.limit ?? CHAT_NAVIGATION_DEFAULT_PAGE_SIZE));
  if (input.query !== undefined) query.set("q", input.query);
  const response = await shellFetch(`${path}?${query.toString()}`, {
    cache: "no-store",
    credentials: "same-origin",
    signal: input.signal
  });
  let value: unknown = null;
  try {
    value = await response.json();
  } catch {
    // The stable client error below deliberately does not expose a response body.
  }
  if (!response.ok) {
    const code = value && typeof value === "object" && !Array.isArray(value) &&
      typeof (value as { error?: unknown }).error === "string"
      ? (value as { error: string }).error
      : "chat_navigation_failed";
    throw new ChatNavigationApiError(code, response.status);
  }
  const decoded = decode(value);
  if (!decoded) throw new ChatNavigationApiError("chat_navigation_response_invalid", 502);
  return decoded;
}

export function listChatNavigation(input: {
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<ChatNavigationPageWire> {
  return page("/api/chats/compact", input, decodeChatNavigationPage);
}

/** Title and folder results only; message matches arrive separately. */
export function searchChatNavigation(input: {
  cursor?: string | null;
  limit?: number;
  query: string;
  signal?: AbortSignal;
}): Promise<ChatNavigationPageWire> {
  return page("/api/chats/search", input, decodeChatNavigationPage);
}

/** Chats whose message text matches: the first page, or the next one by its cursor. */
export function searchChatMessageMatches(input: {
  cursor?: string | null;
  limit?: number;
  query: string;
  signal?: AbortSignal;
}): Promise<ChatMessageMatchPageWire> {
  return page("/api/chats/search/messages", input, decodeChatMessageMatchPage);
}

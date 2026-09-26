import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configured: true,
  findUser: vi.fn(),
  redirect: vi.fn((location: string): never => {
    throw new Error(`NEXT_REDIRECT ${location}`);
  }),
  resolveAuthToken: vi.fn()
}));

vi.mock("@/lib/server/auth/config", () => ({ getAuthConfig: () => ({ configured: mocks.configured }) }));
vi.mock("@/lib/server/auth/defaultAuth", () => ({ authSessionStore: {} }));
vi.mock("@/lib/server/auth/requestAuth", () => ({ resolveAuthToken: mocks.resolveAuthToken }));
vi.mock("@/lib/server/prisma", () => ({ prisma: { user: { findUnique: mocks.findUser } } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "session-token" }) }) }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import NewChatPage from "./page";
import ChatPage from "./c/[chatId]/page";
import ProjectChatPage from "./p/[projectId]/c/[chatId]/page";
import { loadChatViewer } from "./viewer";

function signedIn(status = "active") {
  mocks.resolveAuthToken.mockResolvedValue({ userId: "user-1" });
  mocks.findUser.mockResolvedValue({ displayName: "Owner", email: "owner@example.test", role: "admin", status });
}

const search = (value: Record<string, string | string[]>) => Promise.resolve(value);

afterEach(() => {
  mocks.configured = true;
  vi.clearAllMocks();
});

describe("chat pages", () => {
  it("render nothing for a signed-in viewer and never look up the chat", async () => {
    signedIn();
    await expect(ChatPage({ params: Promise.resolve({ chatId: "chat-1" }), searchParams: search({}) })).resolves.toBeNull();
    await expect(NewChatPage({ searchParams: search({}) })).resolves.toBeNull();
    expect(mocks.findUser).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "user-1" } }));
    expect(mocks.redirect).not.toHaveBeenCalled();
    await expect(loadChatViewer()).resolves.toEqual({
      accountDisplayName: "Owner",
      accountEmail: "owner@example.test",
      accountId: "user-1",
      adminEntryVisible: true
    });
  });

  it("returns a stale session to the exact chat address after sign-in", async () => {
    mocks.resolveAuthToken.mockResolvedValue(null);
    await expect(ProjectChatPage({
      params: Promise.resolve({ chatId: "chat 1", projectId: "project-1" }),
      searchParams: search({ message: "message-1" })
    })).rejects.toThrow("NEXT_REDIRECT");
    const location = new URL(mocks.redirect.mock.calls[0]![0], "https://aiqsa.invalid");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/p/project-1/c/chat%201?message=message-1");

    signedIn("disabled");
    await expect(NewChatPage({ searchParams: search({}) })).rejects.toThrow("NEXT_REDIRECT /login");
  });

  it("redirects legacy query links to the path form before rendering the new chat", async () => {
    await expect(NewChatPage({ searchParams: search({ chat: "chat-1", keep: ["a", "b"], message: "m" }) }))
      .rejects.toThrow("NEXT_REDIRECT /c/chat-1?keep=a&keep=b&message=m");
    await expect(NewChatPage({ searchParams: search({ chat: "chat-1", project: "project-1" }) }))
      .rejects.toThrow("NEXT_REDIRECT /p/project-1/c/chat-1");
    expect(mocks.resolveAuthToken).not.toHaveBeenCalled();
  });

  it("sends an unconfigured installation to sign-in", async () => {
    mocks.configured = false;
    await expect(ChatPage({ params: Promise.resolve({ chatId: "chat-1" }), searchParams: search({}) }))
      .rejects.toThrow("NEXT_REDIRECT /login");
  });
});

import { describe, expect, it } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import {
  createGetPublicShareHandler,
  createListChatSharesHandler,
  createRevokeShareHandler,
  createShareChatHandler,
  type CreatedShareRecord,
  type ShareRepository
} from "./handlers";
import { hashShareToken } from "./tokens";
import { buildPublicShareSnapshot } from "../../domain/shareSnapshot";
import { PUBLIC_SHARE_CACHE_CONTROL, PUBLIC_SHARE_ROBOTS_POLICY } from "./privacy";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({
  user: {
    id: config.bootstrapUserId
  }
});

function authCookie() {
  return auth.cookie;
}

function expectPublicSharePrivacyHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe(PUBLIC_SHARE_CACHE_CONTROL);
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("X-Robots-Tag")).toBe(PUBLIC_SHARE_ROBOTS_POLICY);
}

function createMemoryRepository() {
  const shares = new Map<
    string,
    CreatedShareRecord & { chatId: string; revoked?: boolean; slugHash: string }
  >();
  let nextShareNumber = 1;
  const repository: ShareRepository = {
    createChatShare: async ({ activeLeafMessageId, chatId, shareToken, slugHash, userId }) => {
      if (chatId !== "chat-1" || userId !== config.bootstrapUserId) {
        return null;
      }

      if (activeLeafMessageId === "grounded-message") {
        return {
          error: "grounded_content_not_shareable"
        };
      }

      if (activeLeafMessageId !== "message-1") {
        return {
          error: "invalid_active_leaf"
        };
      }

      const share = {
        chatId,
        createdAt: new Date("2026-06-06T00:00:00.000Z"),
        id: `share-${nextShareNumber}`,
        shareToken,
        slugHash,
        snapshot: {
          messages: [
            {
              content: {
                blocks: [{ text: "Public branch", type: "text" as const }]
              },
              role: "user" as const
            }
          ],
          title: "Shared Chat",
          version: 1 as const
        },
        title: "Shared Chat"
      };
      nextShareNumber += 1;
      shares.set(slugHash, share);

      return share;
    },
    findPublicShare: async (slugHash) => {
      const share = shares.get(slugHash);
      if (!share || share.revoked) {
        return null;
      }

      return share;
    },
    listChatShares: async ({ chatId, userId }) => {
      if (userId !== config.bootstrapUserId) {
        return [];
      }

      return Array.from(shares.values())
        .filter((candidate) => candidate.chatId === chatId && !candidate.revoked)
        .map((candidate) => ({
          createdAt: candidate.createdAt ?? new Date(0),
          id: candidate.id
        }));
    },
    revokeShare: async ({ shareId }) => {
      const share = Array.from(shares.values()).find((candidate) => candidate.id === shareId);
      if (!share) {
        return false;
      }

      share.revoked = true;

      return true;
    }
  };

  return {
    repository,
    shares
  };
}

describe("share route handlers", () => {
  it("creates an authenticated anonymous share", async () => {
    const { repository } = createMemoryRepository();
    const POST = createShareChatHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/share", {
        body: JSON.stringify({
          activeLeafMessageId: "message-1"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { share: { publicPath: string; shareToken: string } };

    expect(body.share.publicPath).toBe(`/s/${body.share.shareToken}`);
    expect(body.share.shareToken.length).toBeGreaterThan(32);
  });

  it("rejects shares for archived chats using the normal not-found response", async () => {
    const { repository } = createMemoryRepository();
    const POST = createShareChatHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-archived/share", {
        body: JSON.stringify({
          activeLeafMessageId: "message-1"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-archived"
        }
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "chat_not_found_or_empty_branch"
    });
  });

  it("rejects a share whose visible branch contains live-only grounded content", async () => {
    const { repository } = createMemoryRepository();
    const POST = createShareChatHandler({ repository, resolveAuth: auth.resolveAuth });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/share", {
        body: JSON.stringify({ activeLeafMessageId: "grounded-message" }),
        headers: { cookie: authCookie() },
        method: "POST"
      }),
      { params: { chatId: "chat-1" } }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "grounded_content_not_shareable" });
  });

  it.each([
    ["leaf from another chat", "other-chat-message"],
    ["nonexistent leaf", "missing-message"]
  ])("returns a validation error for a %s", async (_label, activeLeafMessageId) => {
    const { repository } = createMemoryRepository();
    const POST = createShareChatHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/share", {
        body: JSON.stringify({
          activeLeafMessageId
        }),
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_active_leaf"
    });
  });

  it("opens and revokes a public share by token", async () => {
    const { repository, shares } = createMemoryRepository();
    const token = "test-token";
    await repository.createChatShare({
      activeLeafMessageId: "message-1",
      chatId: "chat-1",
      shareToken: token,
      slugHash: hashShareToken(token),
      userId: config.bootstrapUserId
    });

    const GET = createGetPublicShareHandler({ repository });
    const openResponse = await GET(new Request("http://app.local/api/public-shares/test-token"), {
      params: {
        shareToken: token
      }
    });

    expect(openResponse.status).toBe(200);
    expectPublicSharePrivacyHeaders(openResponse);
    await expect(openResponse.json()).resolves.toMatchObject({
      share: {
        snapshot: {
          messages: [
            {
              content: {
                blocks: [{ text: "Public branch", type: "text" }]
              }
            }
          ]
        }
      }
    });

    const POST = createRevokeShareHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const revokeResponse = await POST(
      new Request("http://app.local/api/shares/share-1/revoke", {
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          shareId: "share-1"
        }
      }
    );

    expect(revokeResponse.status).toBe(200);
    expect(Array.from(shares.values())[0].revoked).toBe(true);

    const revokedResponse = await GET(new Request("http://app.local/api/public-shares/test-token"), {
      params: {
        shareToken: token
      }
    });
    expect(revokedResponse.status).toBe(404);
    expectPublicSharePrivacyHeaders(revokedResponse);
  });

  it.each(["expired", "unknown"])(
    "keeps an unavailable %s share response private and uncached",
    async () => {
      const repository: ShareRepository = {
        createChatShare: vi.fn(),
        findPublicShare: vi.fn(async () => null),
        listChatShares: vi.fn(async () => []),
        revokeShare: vi.fn()
      };
      const GET = createGetPublicShareHandler({ repository });

      const response = await GET(new Request("http://app.local/api/public-shares/unavailable"), {
        params: { shareToken: "unavailable" }
      });

      expect(response.status).toBe(404);
      expectPublicSharePrivacyHeaders(response);
    }
  );

  it("lists only the chat's live links and drops revoked ones", async () => {
    const { repository } = createMemoryRepository();
    await repository.createChatShare({
      activeLeafMessageId: "message-1",
      chatId: "chat-1",
      shareToken: "token-a",
      slugHash: hashShareToken("token-a"),
      userId: config.bootstrapUserId
    });
    await repository.createChatShare({
      activeLeafMessageId: "message-1",
      chatId: "chat-1",
      shareToken: "token-b",
      slugHash: hashShareToken("token-b"),
      userId: config.bootstrapUserId
    });

    const GET = createListChatSharesHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const listResponse = await GET(
      new Request("http://app.local/api/chats/chat-1/share", {
        headers: { cookie: authCookie() }
      }),
      { params: { chatId: "chat-1" } }
    );
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { shares: { createdAt: string; id: string }[] };
    expect(listBody.shares.map((share) => share.id)).toEqual(["share-1", "share-2"]);
    expect(listBody.shares[0]?.createdAt).toBe("2026-06-06T00:00:00.000Z");
    expect(JSON.stringify(listBody)).not.toContain("token-");

    await repository.revokeShare({ shareId: "share-1", userId: config.bootstrapUserId });
    const afterRevoke = await GET(
      new Request("http://app.local/api/chats/chat-1/share", {
        headers: { cookie: authCookie() }
      }),
      { params: { chatId: "chat-1" } }
    );
    const afterBody = (await afterRevoke.json()) as { shares: { id: string }[] };
    expect(afterBody.shares.map((share) => share.id)).toEqual(["share-2"]);

    const unauthenticated = await GET(
      new Request("http://app.local/api/chats/chat-1/share"),
      { params: { chatId: "chat-1" } }
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("serves neutral attachment markers without source attachment metadata", async () => {
    const snapshot = buildPublicShareSnapshot({
      activeLeafMessageId: "message-private",
      messages: [
        {
          content: {
            blocks: [
              { text: "Public text", type: "text" },
              {
                alt: "Sensitive image alt text",
                attachmentId: "private-image-id",
                storageKey: "private/image-key",
                type: "image",
                url: "https://storage.example/private-image"
              },
              {
                attachmentId: "private-file-id",
                fileName: "quarterly-layoffs-confidential.pdf",
                metadata: { object: "private-object-metadata" },
                storageKey: "private/file-key",
                type: "file",
                url: "https://storage.example/private-file"
              }
            ]
          },
          id: "message-private",
          parentMessageId: null,
          role: "user"
        }
      ],
      title: "Shared"
    });
    const repository: ShareRepository = {
      createChatShare: vi.fn(),
      findPublicShare: vi.fn(async () => ({
        id: "share-public",
        snapshot,
        title: "Shared"
      })),
      listChatShares: vi.fn(async () => []),
      revokeShare: vi.fn()
    };
    const GET = createGetPublicShareHandler({ repository });

    const response = await GET(new Request("http://app.local/api/public-shares/token"), {
      params: { shareToken: "token" }
    });
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      share: {
        snapshot: {
          messages: [
            {
              content: {
                blocks: [
                  { text: "Public text", type: "text" },
                  { text: "[Image attachment omitted]", type: "text" },
                  { text: "[Attachment omitted]", type: "text" }
                ]
              }
            }
          ]
        }
      }
    });
    for (const privateValue of [
      "Sensitive image alt text",
      "private-image-id",
      "private-file-id",
      "quarterly-layoffs-confidential.pdf",
      "private-object-metadata",
      "private/image-key",
      "private/file-key",
      "https://storage.example/private-image",
      "https://storage.example/private-file",
      "message-private"
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("re-projects stored JSON with extra private fields before the anonymous response", async () => {
    const privateValues = [
      "private-personal-context",
      "private-binding-id",
      "private-version-id",
      "private-source-id",
      "private-attempt-execution-event-tool-receipt"
    ];
    const repository: ShareRepository = {
      createChatShare: vi.fn(),
      findPublicShare: vi.fn(async () => ({
        id: "share-extra-fields",
        snapshot: {
          attempts: privateValues[4],
          messages: [{
            content: {
              bindings: privateValues[1],
              blocks: [{
                sourceId: privateValues[3],
                text: "Visible answer prose",
                type: "text",
                versionId: privateValues[2]
              }],
              personalContext: privateValues[0]
            },
            memoryReceipt: privateValues[4],
            role: "assistant"
          }],
          title: "Sanitized",
          version: 1
        } as never,
        title: "Sanitized"
      })),
      listChatShares: vi.fn(async () => []),
      revokeShare: vi.fn()
    };
    const GET = createGetPublicShareHandler({ repository });
    const response = await GET(new Request("http://app.local/api/public-shares/extra-fields"), {
      params: { shareToken: "extra-fields" }
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.share.snapshot).toEqual({
      messages: [{
        content: { blocks: [{ text: "Visible answer prose", type: "text" }] },
        role: "assistant"
      }],
      title: "Sanitized",
      version: 1
    });
    for (const privateValue of privateValues) {
      expect(JSON.stringify(body)).not.toContain(privateValue);
    }
  });
});

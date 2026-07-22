import { describe, expect, it } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import {
  createGetPublicShareHandler,
  createRevokeShareHandler,
  createShareChatHandler,
  type CreatedShareRecord,
  type ShareRepository
} from "./handlers";
import { hashShareToken } from "./tokens";
import { buildPublicShareSnapshot } from "../../domain/shareSnapshot";

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

function createMemoryRepository() {
  const shares = new Map<string, CreatedShareRecord & { revoked?: boolean; slugHash: string }>();
  const repository: ShareRepository = {
    createChatShare: async ({ activeLeafMessageId, chatId, shareToken, slugHash, userId }) => {
      if (chatId !== "chat-1" || userId !== config.bootstrapUserId) {
        return null;
      }

      if (activeLeafMessageId !== "message-1") {
        return {
          error: "invalid_active_leaf"
        };
      }

      const share = {
        createdAt: new Date("2026-06-06T00:00:00.000Z"),
        id: "share-1",
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
});

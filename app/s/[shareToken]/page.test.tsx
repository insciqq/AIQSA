import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PublicSharePage, { dynamic, metadata, revalidate } from "./page";

const shareMocks = vi.hoisted(() => ({
  findPublicShare: vi.fn(),
  hashShareToken: vi.fn(),
  noStore: vi.fn(),
  notFound: vi.fn()
}));

vi.mock("next/cache", () => ({
  unstable_noStore: shareMocks.noStore
}));

vi.mock("next/navigation", () => ({
  notFound: shareMocks.notFound
}));

vi.mock("@/lib/server/shares/prismaRepository", () => ({
  createPrismaShareRepository: () => ({
    findPublicShare: shareMocks.findPublicShare
  })
}));

vi.mock("@/lib/server/shares/tokens", () => ({
  hashShareToken: shareMocks.hashShareToken
}));

describe("PublicSharePage", () => {
  beforeEach(() => {
    shareMocks.findPublicShare.mockReset();
    shareMocks.hashShareToken.mockReset();
    shareMocks.noStore.mockReset();
    shareMocks.notFound.mockReset();
  });

  it("publishes an uncached, non-indexable route contract", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(revalidate).toBe(0);
    expect(metadata.title).toBe("Shared research");
    expect(metadata.robots).toEqual({
      follow: false,
      index: false,
      nocache: true
    });
  });

  it("hashes the secret token, performs the public lookup, and renders only the sanitized snapshot", async () => {
    shareMocks.hashShareToken.mockReturnValue("hashed-share-token");
    shareMocks.findPublicShare.mockResolvedValue({
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      id: "private-share-row-id",
      snapshot: {
        messages: [
          {
            content: { blocks: [{ text: "Sanitized answer", type: "text" }] },
            role: "assistant"
          }
        ],
        title: "Snapshot copy",
        version: 1
      },
      title: "Public title"
    });

    render(await PublicSharePage({ params: Promise.resolve({ shareToken: "raw-secret-token" }) }));

    expect(shareMocks.noStore).toHaveBeenCalledTimes(1);
    expect(shareMocks.hashShareToken).toHaveBeenCalledWith("raw-secret-token");
    expect(shareMocks.findPublicShare).toHaveBeenCalledWith("hashed-share-token", expect.any(Date));
    expect(screen.getByRole("heading", { level: 1, name: "Public title" })).toBeVisible();
    expect(screen.getByText("Sanitized answer")).toBeVisible();
    expect(screen.getByTestId("public-share-view")).not.toHaveTextContent("private-share-row-id");
  });

  it("uses the same not-found path for any unavailable token", async () => {
    const notFoundSignal = new Error("NEXT_NOT_FOUND");
    shareMocks.hashShareToken.mockReturnValue("missing-token-hash");
    shareMocks.findPublicShare.mockResolvedValue(null);
    shareMocks.notFound.mockImplementation(() => {
      throw notFoundSignal;
    });

    await expect(PublicSharePage({ params: { shareToken: "missing-token" } })).rejects.toBe(
      notFoundSignal
    );

    expect(shareMocks.noStore).toHaveBeenCalledTimes(1);
    expect(shareMocks.hashShareToken).toHaveBeenCalledWith("missing-token");
    expect(shareMocks.findPublicShare).toHaveBeenCalledWith("missing-token-hash", expect.any(Date));
    expect(shareMocks.notFound).toHaveBeenCalledTimes(1);
  });
});

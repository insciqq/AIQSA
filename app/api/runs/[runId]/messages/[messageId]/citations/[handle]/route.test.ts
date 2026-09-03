// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readOriginal: vi.fn(),
  renderCitationPage: vi.fn(),
  renderSourcePage: vi.fn(),
  resolveAuth: vi.fn(),
  resolveViewer: vi.fn(),
  storage: {},
  transaction: vi.fn()
}));

vi.mock("@/lib/server/auth/defaultAuth", () => ({
  resolveRequestAuth: mocks.resolveAuth
}));

vi.mock("@/lib/server/knowledge/citationViewer", () => ({
  readKnowledgeViewerOriginal: mocks.readOriginal,
  resolveKnowledgeCitationViewer: mocks.resolveViewer
}));

vi.mock("@/lib/server/knowledge/defaultIngestion", () => ({
  defaultKnowledgeStorage: mocks.storage
}));

vi.mock("@/lib/server/knowledge/citationPdfPage", () => ({
  renderKnowledgeCitationPdfPage: mocks.renderCitationPage,
  renderKnowledgeSourcePdfPage: mocks.renderSourcePage
}));

vi.mock("@/lib/server/knowledge/knowledgeExtractionConfig", () => ({
  getKnowledgeExtractionConfig: () => ({ maxPages: 50 })
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { $transaction: mocks.transaction }
}));

import { GET } from "./route";

const context = {
  params: Promise.resolve({ handle: "K1", messageId: "message-1", runId: "run-1" })
};

const available = {
  citation: {
    blocks: [],
    excerpt: "Accepted evidence",
    excerptTruncated: false,
    handle: "K1",
    headingPath: [],
    libraryAvailable: true,
    locator: { boundingBoxes: [], pageEnd: 1, pageStart: 1 },
    originalKind: null,
    source: {
      baseName: "Product docs",
      fileName: "guide.txt",
      mimeType: "text/plain",
      name: "Guide",
      statuses: [],
      versionNumber: 1
    },
    state: "available",
    visual: null,
    workbook: null
  },
  librarySourceId: "source-1",
  original: null
};

function request(query = ""): Request {
  return new Request(
    `https://aiqsa.example/api/runs/run-1/messages/message-1/citations/K1${query}`
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAuth.mockResolvedValue({ userId: "user-1" });
  mocks.transaction.mockImplementation(async (operation: (client: unknown) => unknown) =>
    operation("transaction-client"));
  mocks.resolveViewer.mockResolvedValue(available);
});

describe("Knowledge citation viewer route", () => {
  it("reauthorizes and returns only the canonical Library source target", async () => {
    const response = await GET(request("?asset=library"), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ sourceId: "source-1" });
    expect(mocks.resolveViewer).toHaveBeenCalledWith(
      "transaction-client",
      mocks.storage,
      {
        assistantMessageId: "message-1",
        handle: "K1",
        runId: "run-1",
        userId: "user-1"
      }
    );
  });

  it("fails closed when the citation no longer has a Library destination", async () => {
    mocks.resolveViewer.mockResolvedValue({ ...available, librarySourceId: null });

    const response = await GET(request("?asset=library"), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "knowledge_reference_not_available" });
  });

  it("serves an authorized non-visual original as a download", async () => {
    const original = {
      byteSize: 18,
      checksum: "checksum",
      fileName: "guide.md",
      mimeType: "text/markdown",
      storageKey: "private/guide.md"
    };
    mocks.resolveViewer.mockResolvedValue({ ...available, original });
    mocks.readOriginal.mockResolvedValue(Buffer.from("# Accepted guide"));
    const sourceRequest = request("?asset=original");

    const response = await GET(sourceRequest, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("text/markdown");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/u);
    expect(mocks.readOriginal).toHaveBeenCalledWith(mocks.storage, original, sourceRequest.signal);
  });

  it.each([
    "?asset=library&page=1",
    "?asset=library&asset=original",
    "?asset=unknown",
    "?privateKey=value"
  ])("rejects malformed asset requests before repository access: %s", async (query) => {
    const response = await GET(request(query), context);

    expect(response.status).toBe(404);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.resolveViewer).not.toHaveBeenCalled();
  });

  it("requires authentication before resolving a private citation", async () => {
    mocks.resolveAuth.mockResolvedValue(null);

    const response = await GET(request("?asset=library"), context);

    expect(response.status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

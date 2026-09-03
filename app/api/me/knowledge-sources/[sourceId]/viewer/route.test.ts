// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  extractionConfig: vi.fn(),
  readOriginal: vi.fn(),
  renderPage: vi.fn(),
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
  resolveKnowledgeSourceViewer: mocks.resolveViewer
}));

vi.mock("@/lib/server/knowledge/citationPdfPage", () => ({
  renderKnowledgeSourcePdfPage: mocks.renderPage
}));

vi.mock("@/lib/server/knowledge/defaultIngestion", () => ({
  defaultKnowledgeStorage: mocks.storage
}));

vi.mock("@/lib/server/knowledge/knowledgeExtractionConfig", () => ({
  getKnowledgeExtractionConfig: mocks.extractionConfig
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { $transaction: mocks.transaction }
}));

import { GET } from "./route";

const original = {
  byteSize: 12,
  checksum: "checksum",
  fileName: "private.pdf",
  mimeType: "application/pdf",
  storageKey: "private/object"
};

const resolved = {
  original,
  pageCount: 2,
  source: { state: "available" }
};

function request(query = ""): Request {
  return new Request(`https://aiqsa.example/api/me/knowledge-sources/source-1/viewer${query}`);
}

const context = { params: Promise.resolve({ sourceId: "source-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAuth.mockResolvedValue({ userId: "user-1" });
  mocks.extractionConfig.mockReturnValue({ maxPages: 5 });
  mocks.transaction.mockImplementation(async (operation: (client: unknown) => unknown) =>
    operation("transaction-client"));
  mocks.resolveViewer.mockResolvedValue(resolved);
  mocks.readOriginal.mockResolvedValue(Buffer.from("%PDF-private"));
  mocks.renderPage.mockResolvedValue(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

describe("Knowledge Source viewer route", () => {
  it("renders an authorized, in-range PDF page as a private PNG", async () => {
    const sourceRequest = request("?asset=page&page=2");
    const response = await GET(sourceRequest, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("8");
    expect(mocks.resolveViewer).toHaveBeenCalledWith("transaction-client", mocks.storage, {
      sourceId: "source-1",
      userId: "user-1"
    });
    expect(mocks.readOriginal).toHaveBeenCalledWith(mocks.storage, original, sourceRequest.signal);
    expect(mocks.renderPage).toHaveBeenCalledWith({
      bytes: Buffer.from("%PDF-private"),
      maxPages: 5,
      page: 2,
      signal: sourceRequest.signal
    });
  });

  it.each([
    "?asset=page",
    "?asset=page&page=0",
    "?asset=page&page=1.5",
    "?asset=page&page=01",
    "?asset=page&page=1&page=2",
    "?asset=original&page=1",
    "?page=1",
    "?asset=page&page=1&privateKey=value"
  ])("rejects malformed page requests before repository or object I/O: %s", async (query) => {
    const response = await GET(request(query), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "knowledge_reference_not_available" });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.readOriginal).not.toHaveBeenCalled();
    expect(mocks.renderPage).not.toHaveBeenCalled();
  });

  it("fails closed when the requested page exceeds the normalized document", async () => {
    const response = await GET(request("?asset=page&page=3"), context);

    expect(response.status).toBe(404);
    expect(mocks.resolveViewer).toHaveBeenCalledOnce();
    expect(mocks.readOriginal).not.toHaveBeenCalled();
    expect(mocks.renderPage).not.toHaveBeenCalled();
  });

  it("keeps metadata and original reads intact without accepting stray page input", async () => {
    const metadata = await GET(request(), context);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toEqual({ source: resolved.source });

    const originalResponse = await GET(request("?asset=original"), context);
    expect(originalResponse.status).toBe(200);
    expect(originalResponse.headers.get("content-type")).toBe("application/pdf");
    expect(mocks.renderPage).not.toHaveBeenCalled();
  });

  it("serves a non-visual original as an attachment while its normalized preview stays in-app", async () => {
    const markdown = {
      ...original,
      fileName: "private.md",
      mimeType: "text/markdown"
    };
    mocks.resolveViewer.mockResolvedValue({ ...resolved, original: markdown });
    mocks.readOriginal.mockResolvedValue(Buffer.from("# Private"));

    const sourceRequest = request("?asset=original");
    const response = await GET(sourceRequest, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/u);
    expect(mocks.readOriginal).toHaveBeenCalledWith(mocks.storage, markdown, sourceRequest.signal);
  });

  it("does not expose a non-PDF original through the page renderer", async () => {
    mocks.resolveViewer.mockResolvedValue({
      ...resolved,
      original: { ...original, mimeType: "image/png" }
    });

    const response = await GET(request("?asset=page&page=1"), context);

    expect(response.status).toBe(404);
    expect(mocks.readOriginal).not.toHaveBeenCalled();
    expect(mocks.renderPage).not.toHaveBeenCalled();
  });
});
